/**
 * Video Generation Routes
 * 
 * I2V (Image-to-Video) 機能のAPI
 * - POST /api/scenes/:sceneId/generate-video - 動画生成開始
 * - GET /api/scenes/:sceneId/videos - シーンの動画一覧
 * - GET /api/videos/:videoId/status - 動画ステータス確認
 * - POST /api/videos/:videoId/activate - 動画採用
 * - DELETE /api/videos/:videoId - 動画削除
 * 
 * 安全要件:
 * - completed の r2_url が null なら failed に戻す
 * - 同一 scene_id で generating 中は 409
 * - active は最大1件
 */

import { Hono } from 'hono';
import type { Bindings } from '../types/bindings';
import { createAwsVideoClient, type VideoEngine, type BillingSource } from '../utils/aws-video-client';
import { decryptApiKey } from '../utils/crypto';
import { generateSignedImageUrl } from '../utils/signed-url';

const videoGeneration = new Hono<{ Bindings: Bindings }>();

// ====================================================================
// Types
// ====================================================================

interface GenerateVideoRequest {
  provider?: 'google';
  model?: string;           // veo-2.0-generate-001 or veo-3.0-generate-preview
  video_engine?: VideoEngine;
  duration_sec?: 5 | 8 | 10;
  prompt?: string;
}

// ====================================================================
// Helper: Get user's encrypted API key from DB
// ====================================================================

async function getEncryptedApiKey(
  db: D1Database,
  userId: number,
  provider: string
): Promise<string | null> {
  const result = await db.prepare(`
    SELECT encrypted_key FROM user_api_keys
    WHERE user_id = ? AND provider = ? AND is_active = 1
  `).bind(userId, provider).first<{ encrypted_key: string }>();
  
  return result?.encrypted_key || null;
}

// ====================================================================
// Helper: Get and decrypt user's API key
// Returns: { key: string } on success, { error: string } on failure
// ====================================================================

type ApiKeyResult = { key: string } | { error: string };

async function getUserApiKey(
  db: D1Database,
  userId: number,
  provider: string,
  encryptionKey?: string
): Promise<ApiKeyResult> {
  const encryptedKey = await getEncryptedApiKey(db, userId, provider);
  
  if (!encryptedKey) {
    return { error: `No API key found for provider '${provider}'` };
  }
  
  // Encryption key is required for decryption
  if (!encryptionKey) {
    return { error: 'ENCRYPTION_KEY not configured on server' };
  }
  
  try {
    const decrypted = await decryptApiKey(encryptedKey, encryptionKey);
    return { key: decrypted };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { error: `Failed to decrypt API key: ${message}` };
  }
}

// ====================================================================
// Helper: Determine billing source (user or sponsor)
// ====================================================================

async function determineBillingSource(
  db: D1Database,
  projectId: number,
  userId: number
): Promise<{ billingSource: BillingSource; sponsorUserId: number | null }> {
  // Check if project has a sponsor configured
  const sponsor = await db.prepare(`
    SELECT ss.value as sponsor_user_id 
    FROM system_settings ss
    WHERE ss.key = 'default_sponsor_user_id'
  `).first<{ sponsor_user_id: string }>();
  
  // TODO: Per-project sponsor設定、ユーザーのsponsor eligibility確認
  // 現時点では system_settings.default_sponsor_user_id があればsponsor
  if (sponsor?.sponsor_user_id) {
    return {
      billingSource: 'sponsor',
      sponsorUserId: parseInt(sponsor.sponsor_user_id, 10),
    };
  }
  
  return { billingSource: 'user', sponsorUserId: null };
}

// ====================================================================
// Helper: Get system setting
// ====================================================================

async function getSystemSetting(
  db: D1Database,
  key: string
): Promise<string | null> {
  const result = await db.prepare(`
    SELECT value FROM system_settings WHERE key = ?
  `).bind(key).first<{ value: string }>();
  
  return result?.value || null;
}

// ====================================================================
// Helper: Get scene's active image
// ====================================================================

async function getSceneActiveImage(
  db: D1Database,
  sceneId: number
): Promise<{ r2_key: string; r2_url: string } | null> {
  const result = await db.prepare(`
    SELECT r2_key, r2_url FROM image_generations
    WHERE scene_id = ? AND is_active = 1 AND status = 'completed'
  `).bind(sceneId).first<{ r2_key: string; r2_url: string }>();
  
  return result || null;
}

// ====================================================================
// Helper: Build signed image URL for AWS Worker
// ====================================================================
// 署名付きURL（TTL 10分）を生成
// 外部サービス（AWS Worker）からのアクセス用

async function buildSignedImageUrl(
  r2Key: string,
  origin: string,
  signingSecret: string
): Promise<string> {
  // TTL 10分（AWS Workerが画像を取得するのに十分な時間）
  return generateSignedImageUrl(r2Key, signingSecret, origin, 600);
}

// ====================================================================
// POST /api/scenes/:sceneId/generate-video
// ====================================================================

videoGeneration.post('/:sceneId/generate-video', async (c) => {
  const sceneIdParam = c.req.param('sceneId');
  const sceneId = parseInt(sceneIdParam, 10);
  
  if (isNaN(sceneId)) {
    return c.json({ error: { code: 'INVALID_SCENE_ID', message: 'Invalid scene ID' } }, 400);
  }
  
  // 1. Request body parse
  let body: GenerateVideoRequest = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body is OK
  }
  
  // 2. Scene存在確認 + project_id取得
  const scene = await c.env.DB.prepare(`
    SELECT s.id, s.project_id, s.dialogue, p.user_id as owner_user_id
    FROM scenes s
    JOIN projects p ON p.id = s.project_id
    WHERE s.id = ?
  `).bind(sceneId).first<{ id: number; project_id: number; dialogue: string; owner_user_id: number }>();
  
  if (!scene) {
    return c.json({ error: { code: 'SCENE_NOT_FOUND', message: 'Scene not found' } }, 404);
  }
  
  // 3. Active image 取得
  const activeImage = await getSceneActiveImage(c.env.DB, sceneId);
  if (!activeImage) {
    return c.json({
      error: {
        code: 'NO_ACTIVE_IMAGE',
        message: 'No active image for this scene. Generate and activate an image first.',
      },
    }, 400);
  }
  
  // 4. 競合チェック（generating中は409）
  const generating = await c.env.DB.prepare(`
    SELECT id FROM video_generations
    WHERE scene_id = ? AND status = 'generating'
  `).bind(sceneId).first();
  
  if (generating) {
    return c.json({
      error: {
        code: 'GENERATION_IN_PROGRESS',
        message: 'Video generation already in progress for this scene',
      },
    }, 409);
  }
  
  // 5. Video engine決定
  const videoEngine: VideoEngine = body.video_engine || 
    (body.model?.includes('veo-3') ? 'veo3' : 'veo2');
  
  // 5.5. Get logged-in user info (for superadmin check)
  const { getCookie } = await import('hono/cookie');
  const sessionId = getCookie(c, 'session');
  let loggedInUserId: number | null = null;
  let loggedInUserRole: string | null = null;
  
  if (sessionId) {
    const sessionUser = await c.env.DB.prepare(`
      SELECT s.user_id, u.role FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = ? AND s.expires_at > datetime('now')
    `).bind(sessionId).first<{ user_id: number; role: string }>();
    
    if (sessionUser) {
      loggedInUserId = sessionUser.user_id;
      loggedInUserRole = sessionUser.role;
    }
  }
  
  const isSuperadmin = loggedInUserRole === 'superadmin';
  
  // 6. 認証情報取得 - billing_source判定と鍵取得
  // Superadminの場合はシステムキーを使用
  let billingSource: BillingSource = 'user';
  let sponsorUserId: number | null = null;
  
  if (isSuperadmin) {
    // Superadmin uses system key, billing to superadmin
    billingSource = 'sponsor';
    sponsorUserId = loggedInUserId;
  } else {
    const billingInfo = await determineBillingSource(
      c.env.DB, scene.project_id, scene.owner_user_id
    );
    billingSource = billingInfo.billingSource;
    sponsorUserId = billingInfo.sponsorUserId;
  }
  
  // executorUserId: 実行者（ログインユーザー or プロジェクトオーナー）
  const executorUserId = loggedInUserId || scene.owner_user_id;
  const billingUserId = billingSource === 'sponsor' && sponsorUserId 
    ? sponsorUserId 
    : executorUserId;
  
  let apiKey: string | null = null;
  let vertexSaJson: string | null = null;
  let vertexProjectId: string | null = null;
  let vertexLocation: string | null = null;
  
  const encryptionKey = c.env.ENCRYPTION_KEY;
  
  if (videoEngine === 'veo2') {
    if (isSuperadmin || billingSource === 'sponsor') {
      // Superadmin or Sponsor mode: use system GEMINI_API_KEY
      if (!c.env.GEMINI_API_KEY) {
        // Try superadmin's own API key first
        if (isSuperadmin && loggedInUserId) {
          const keyResult = await getUserApiKey(c.env.DB, loggedInUserId, 'google', encryptionKey);
          if ('key' in keyResult) {
            apiKey = keyResult.key;
          }
        }
        
        if (!apiKey) {
          return c.json({
            error: {
              code: 'SPONSOR_KEY_NOT_CONFIGURED',
              message: isSuperadmin 
                ? 'システムAPIキーが設定されていません。設定画面でGoogle APIキーを設定するか、管理者にシステムキーの設定を依頼してください。'
                : 'Sponsor API key not configured on server.',
            },
          }, 500);
        }
      } else {
        apiKey = c.env.GEMINI_API_KEY;
      }
    } else {
      // User mode: user's own key required, decryption failure is error
      // Provider: 'google' for Veo2 (統一)
      const keyResult = await getUserApiKey(c.env.DB, executorUserId, 'google', encryptionKey);
      
      if ('error' in keyResult) {
        return c.json({
          error: {
            code: 'USER_KEY_ERROR',
            message: keyResult.error,
            redirect: '/settings?focus=google',
          },
        }, 400);
      }
      apiKey = keyResult.key;
    }
  } else {
    // Veo3: Vertex SA JSON
    if (isSuperadmin || billingSource === 'sponsor') {
      // Superadmin: Try user's own Vertex key first, then system
      if (isSuperadmin && loggedInUserId) {
        const keyResult = await getUserApiKey(c.env.DB, loggedInUserId, 'vertex', encryptionKey);
        if ('key' in keyResult) {
          vertexSaJson = keyResult.key;
        }
      }
      
      if (!vertexSaJson) {
        // TODO: Sponsor用のVertex SA JSONをsystem_settingsから取得
        return c.json({
          error: {
            code: 'SPONSOR_VERTEX_NOT_IMPLEMENTED',
            message: isSuperadmin
              ? 'Vertex APIキーが設定されていません。設定画面でVertex APIキーを設定してください。'
              : 'Sponsor mode for Veo3 not yet implemented.',
          },
        }, 501);
      }
    } else {
      // User mode: user's own Vertex SA JSON required
      const keyResult = await getUserApiKey(c.env.DB, executorUserId, 'vertex', encryptionKey);
      
      if ('error' in keyResult) {
        return c.json({
          error: {
            code: 'USER_KEY_ERROR',
            message: keyResult.error,
            redirect: '/settings?focus=vertex',
          },
        }, 400);
      }
      vertexSaJson = keyResult.key;
    }
    
    // Parse SA JSON to get project_id
    try {
      const sa = JSON.parse(vertexSaJson);
      vertexProjectId = sa.project_id;
    } catch {
      return c.json({
        error: { code: 'INVALID_VERTEX_SA', message: 'Invalid Vertex SA JSON format' },
      }, 400);
    }
    
    // Location from system settings or default
    vertexLocation = await getSystemSetting(c.env.DB, 'vertex_default_location') || 'us-central1';
  }
  
  // 7. D1にレコード作成（generating状態）
  const model = body.model || (videoEngine === 'veo3' ? 'veo-3.0-generate-preview' : 'veo-2.0-generate-001');
  const durationSec = body.duration_sec || (videoEngine === 'veo3' ? 8 : 5);
  const prompt = body.prompt || 'Camera slowly zooms in, maintaining the composition and style of the image.';
  
  const insertResult = await c.env.DB.prepare(`
    INSERT INTO video_generations (
      scene_id, user_id, provider, model, status, duration_sec, prompt, source_image_r2_key
    ) VALUES (?, ?, 'google_veo', ?, 'generating', ?, ?, ?)
  `).bind(
    sceneId,
    executorUserId,
    model,
    durationSec,
    prompt,
    activeImage.r2_key
  ).run();
  
  const videoGenerationId = insertResult.meta.last_row_id as number;
  
  // 8. AWS Video Proxy 呼び出し
  const awsClient = createAwsVideoClient(c.env);
  if (!awsClient) {
    // AWS credentials missing → rollback
    await c.env.DB.prepare(`
      UPDATE video_generations SET status = 'failed', error_message = 'AWS credentials not configured'
      WHERE id = ?
    `).bind(videoGenerationId).run();
    
    return c.json({
      error: { code: 'AWS_CONFIG_ERROR', message: 'AWS credentials not configured' },
    }, 500);
  }
  
  // 9. 署名付き画像URLを生成
  const signingSecret = c.env.IMAGE_URL_SIGNING_SECRET;
  if (!signingSecret) {
    await c.env.DB.prepare(`
      UPDATE video_generations SET status = 'failed', error_message = 'IMAGE_URL_SIGNING_SECRET not configured'
      WHERE id = ?
    `).bind(videoGenerationId).run();
    
    return c.json({
      error: { code: 'SERVER_CONFIG_ERROR', message: 'Image signing not configured' },
    }, 500);
  }
  
  const origin = new URL(c.req.url).origin;
  const imageUrl = await buildSignedImageUrl(activeImage.r2_key, origin, signingSecret);
  
  // 10. AWS Video Proxy 呼び出し
  const awsResponse = await awsClient.startVideo({
    project_id: scene.project_id,
    scene_id: sceneId,
    owner_user_id: scene.owner_user_id,
    executor_user_id: executorUserId,
    billing_user_id: billingUserId,
    billing_source: billingSource,
    provider: 'google',
    model,
    duration_sec: durationSec,
    prompt,
    image_url: imageUrl,
    video_engine: videoEngine,
    api_key: apiKey || undefined,
    vertex_sa_json: vertexSaJson || undefined,
    vertex_project_id: vertexProjectId || undefined,
    vertex_location: vertexLocation || undefined,
  });
  
  if (!awsResponse.success || !awsResponse.job_id) {
    // AWS call failed → mark as failed
    await c.env.DB.prepare(`
      UPDATE video_generations SET status = 'failed', error_message = ?
      WHERE id = ?
    `).bind(awsResponse.error?.message || 'AWS call failed', videoGenerationId).run();
    
    return c.json({
      error: awsResponse.error || { code: 'AWS_START_FAILED', message: 'Failed to start video generation' },
    }, 500);
  }
  
  // 9. job_id保存
  await c.env.DB.prepare(`
    UPDATE video_generations SET job_id = ? WHERE id = ?
  `).bind(awsResponse.job_id, videoGenerationId).run();
  
  // 10. api_usage_logs 記録
  await c.env.DB.prepare(`
    INSERT INTO api_usage_logs (
      user_id, project_id, api_type, provider, model, video_engine, metadata_json
    ) VALUES (?, ?, 'video_generation', 'google', ?, ?, ?)
  `).bind(
    executorUserId,
    scene.project_id,
    model,
    videoEngine,
    JSON.stringify({ scene_id: sceneId, duration_sec: durationSec, job_id: awsResponse.job_id })
  ).run();
  
  return c.json({
    video_generation: {
      id: videoGenerationId,
      scene_id: sceneId,
      status: 'generating',
      job_id: awsResponse.job_id,
      model,
      video_engine: videoEngine,
      duration_sec: durationSec,
    },
  }, 202);
});

// ====================================================================
// GET /api/scenes/:sceneId/videos
// ====================================================================

videoGeneration.get('/:sceneId/videos', async (c) => {
  const sceneId = parseInt(c.req.param('sceneId'), 10);
  if (isNaN(sceneId)) {
    return c.json({ error: { code: 'INVALID_SCENE_ID', message: 'Invalid scene ID' } }, 400);
  }
  
  const { results: videos } = await c.env.DB.prepare(`
    SELECT id, scene_id, provider, model, status, duration_sec, prompt,
           source_image_r2_key, r2_key, r2_url, error_message, is_active, job_id,
           created_at, updated_at
    FROM video_generations
    WHERE scene_id = ?
    ORDER BY created_at DESC
  `).bind(sceneId).all();
  
  const activeVideo = videos?.find((v: any) => v.is_active === 1) || null;
  
  return c.json({
    video_generations: videos || [],
    active_video: activeVideo,
  });
});

// ====================================================================
// GET /api/videos/:videoId/status
// ====================================================================

videoGeneration.get('/videos/:videoId/status', async (c) => {
  const videoId = parseInt(c.req.param('videoId'), 10);
  if (isNaN(videoId)) {
    return c.json({ error: { code: 'INVALID_VIDEO_ID', message: 'Invalid video ID' } }, 400);
  }
  
  const video = await c.env.DB.prepare(`
    SELECT id, scene_id, status, job_id, r2_url, error_message, updated_at
    FROM video_generations WHERE id = ?
  `).bind(videoId).first<{
    id: number;
    scene_id: number;
    status: string;
    job_id: string | null;
    r2_url: string | null;
    error_message: string | null;
    updated_at: string;
  }>();
  
  if (!video) {
    return c.json({ error: { code: 'VIDEO_NOT_FOUND', message: 'Video generation not found' } }, 404);
  }
  
  // generating中 または completed（presigned URL refresh）でjob_idがある場合はAWSに問い合わせ
  if ((video.status === 'generating' || video.status === 'completed') && video.job_id) {
    const awsClient = createAwsVideoClient(c.env);
    if (awsClient) {
      const awsStatus = await awsClient.getStatus(video.job_id);
      
      if (awsStatus.success && awsStatus.job) {
        const jobStatus = awsStatus.job.status;
        
        if (jobStatus === 'completed' && awsStatus.job.presigned_url) {
          // TODO: presigned_url をR2にコピーしてr2_keyを取得
          // 暫定: presigned_urlを直接返す
          await c.env.DB.prepare(`
            UPDATE video_generations 
            SET status = 'completed', r2_url = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(awsStatus.job.presigned_url, videoId).run();
          
          return c.json({
            video: {
              id: videoId,
              status: 'completed',
              r2_url: awsStatus.job.presigned_url,
              progress_stage: 'completed',
            },
          });
        } else if (jobStatus === 'failed') {
          await c.env.DB.prepare(`
            UPDATE video_generations 
            SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(awsStatus.job.error_message || 'Generation failed', videoId).run();
          
          return c.json({
            video: {
              id: videoId,
              status: 'failed',
              error_message: awsStatus.job.error_message,
            },
          });
        } else {
          // Still processing
          return c.json({
            video: {
              id: videoId,
              status: 'generating',
              progress_stage: awsStatus.job.progress_stage || 'processing',
            },
          });
        }
      }
    }
  }
  
  return c.json({
    video: {
      id: video.id,
      status: video.status,
      r2_url: video.r2_url,
      error_message: video.error_message,
    },
  });
});

// ====================================================================
// POST /api/videos/:videoId/activate
// ====================================================================

videoGeneration.post('/videos/:videoId/activate', async (c) => {
  const videoId = parseInt(c.req.param('videoId'), 10);
  if (isNaN(videoId)) {
    return c.json({ error: { code: 'INVALID_VIDEO_ID', message: 'Invalid video ID' } }, 400);
  }
  
  const video = await c.env.DB.prepare(`
    SELECT id, scene_id, status FROM video_generations WHERE id = ?
  `).bind(videoId).first<{ id: number; scene_id: number; status: string }>();
  
  if (!video) {
    return c.json({ error: { code: 'VIDEO_NOT_FOUND', message: 'Video generation not found' } }, 404);
  }
  
  if (video.status !== 'completed') {
    return c.json({
      error: { code: 'NOT_COMPLETED', message: 'Only completed videos can be activated' },
    }, 400);
  }
  
  // Deactivate all, then activate this one
  await c.env.DB.prepare(`
    UPDATE video_generations SET is_active = 0 WHERE scene_id = ?
  `).bind(video.scene_id).run();
  
  await c.env.DB.prepare(`
    UPDATE video_generations SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(videoId).run();
  
  return c.json({ success: true, video_id: videoId, is_active: true });
});

// ====================================================================
// DELETE /api/videos/:videoId
// ====================================================================

videoGeneration.delete('/videos/:videoId', async (c) => {
  const videoId = parseInt(c.req.param('videoId'), 10);
  if (isNaN(videoId)) {
    return c.json({ error: { code: 'INVALID_VIDEO_ID', message: 'Invalid video ID' } }, 400);
  }
  
  const video = await c.env.DB.prepare(`
    SELECT id, is_active, r2_key FROM video_generations WHERE id = ?
  `).bind(videoId).first<{ id: number; is_active: number; r2_key: string | null }>();
  
  if (!video) {
    return c.json({ error: { code: 'VIDEO_NOT_FOUND', message: 'Video generation not found' } }, 404);
  }
  
  if (video.is_active === 1) {
    return c.json({
      error: { code: 'CANNOT_DELETE_ACTIVE', message: 'Cannot delete active video. Activate another video first.' },
    }, 400);
  }
  
  // Delete from R2 if exists
  if (video.r2_key) {
    try {
      await c.env.R2.delete(video.r2_key);
    } catch (err) {
      console.warn('Failed to delete R2 object:', err);
    }
  }
  
  await c.env.DB.prepare(`DELETE FROM video_generations WHERE id = ?`).bind(videoId).run();
  
  return c.json({ success: true, deleted_id: videoId });
});

// ====================================================================
// Video Build API (Full video rendering)
// ====================================================================

/**
 * GET /api/video-builds/usage
 * Get current user's video build usage stats
 */
videoGeneration.get('/video-builds/usage', async (c) => {
  try {
    const { getCookie } = await import('hono/cookie');
    const sessionId = getCookie(c, 'session');
    if (!sessionId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }
    
    const session = await c.env.DB.prepare(`
      SELECT user_id FROM sessions WHERE id = ? AND expires_at > datetime('now')
    `).bind(sessionId).first<{ user_id: number }>();
    
    if (!session) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401);
    }
    
    const userId = session.user_id;
    
    // Get usage stats from system settings
    const settings = await c.env.DB.prepare(`
      SELECT setting_key, setting_value FROM system_settings
      WHERE setting_key IN ('video_build_daily_limit', 'video_build_concurrent_limit')
    `).all();
    
    const settingsMap = new Map(
      (settings.results || []).map((r: any) => [r.setting_key, r.setting_value])
    );
    
    const dailyLimit = parseInt(settingsMap.get('video_build_daily_limit') || '3', 10);
    const concurrentLimit = parseInt(settingsMap.get('video_build_concurrent_limit') || '1', 10);
    
    // Count today's builds
    const todayBuilds = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM video_builds
      WHERE executor_user_id = ? AND DATE(created_at) = DATE('now')
    `).bind(userId).first<{ count: number }>();
    
    // Count active builds
    const activeBuilds = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM video_builds
      WHERE executor_user_id = ? AND status IN ('queued', 'validating', 'submitted', 'rendering', 'uploading')
    `).bind(userId).first<{ count: number }>();
    
    return c.json({
      daily_limit: dailyLimit,
      daily_used: todayBuilds?.count || 0,
      daily_remaining: Math.max(0, dailyLimit - (todayBuilds?.count || 0)),
      concurrent_limit: concurrentLimit,
      concurrent_active: activeBuilds?.count || 0,
      can_start: (todayBuilds?.count || 0) < dailyLimit && (activeBuilds?.count || 0) < concurrentLimit
    });
  } catch (error) {
    console.error('[VideoBuild] Usage error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get usage' } }, 500);
  }
});

/**
 * GET /api/projects/:projectId/video-builds
 * List video builds for a project
 */
videoGeneration.get('/projects/:projectId/video-builds', async (c) => {
  try {
    const projectId = parseInt(c.req.param('projectId'), 10);
    
    const { getCookie } = await import('hono/cookie');
    const sessionId = getCookie(c, 'session');
    if (!sessionId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }
    
    const session = await c.env.DB.prepare(`
      SELECT user_id FROM sessions WHERE id = ? AND expires_at > datetime('now')
    `).bind(sessionId).first<{ user_id: number }>();
    
    if (!session) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401);
    }
    
    const builds = await c.env.DB.prepare(`
      SELECT 
        vb.id, vb.project_id, vb.status, vb.progress_percent, vb.progress_stage,
        vb.progress_message, vb.settings_json, vb.total_scenes, vb.total_duration_ms,
        vb.render_started_at, vb.render_completed_at, vb.render_duration_sec,
        vb.estimated_cost_usd, vb.error_code, vb.error_message, vb.download_url,
        vb.created_at, vb.updated_at,
        u.name as executor_name
      FROM video_builds vb
      LEFT JOIN users u ON vb.executor_user_id = u.id
      WHERE vb.project_id = ?
      ORDER BY vb.created_at DESC
      LIMIT 50
    `).bind(projectId).all();
    
    return c.json({ builds: builds.results || [] });
  } catch (error) {
    console.error('[VideoBuild] List error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list builds' } }, 500);
  }
});

/**
 * POST /api/projects/:projectId/video-builds
 * Create a new video build
 */
videoGeneration.post('/projects/:projectId/video-builds', async (c) => {
  try {
    const projectId = parseInt(c.req.param('projectId'), 10);
    const body = await c.req.json();
    
    const { getCookie } = await import('hono/cookie');
    const sessionId = getCookie(c, 'session');
    if (!sessionId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }
    
    const session = await c.env.DB.prepare(`
      SELECT user_id FROM sessions WHERE id = ? AND expires_at > datetime('now')
    `).bind(sessionId).first<{ user_id: number }>();
    
    if (!session) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401);
    }
    
    const userId = session.user_id;
    
    // Get project owner
    const project = await c.env.DB.prepare(`
      SELECT id, user_id, title FROM projects WHERE id = ?
    `).bind(projectId).first<{ id: number; user_id: number; title: string }>();
    
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
    }
    
    // Settings
    const settings = {
      include_captions: body.include_captions ?? true,
      include_bgm: body.include_bgm ?? true,
      include_motion: body.include_motion ?? false,
      resolution: body.resolution || '1080p',
      aspect_ratio: body.aspect_ratio || '9:16'
    };
    
    // Create build record
    const result = await c.env.DB.prepare(`
      INSERT INTO video_builds (
        project_id, owner_user_id, executor_user_id, 
        settings_json, status
      ) VALUES (?, ?, ?, ?, 'queued')
    `).bind(
      projectId,
      project.user_id,
      userId,
      JSON.stringify(settings)
    ).run();
    
    const build = await c.env.DB.prepare(`
      SELECT * FROM video_builds WHERE id = ?
    `).bind(result.meta.last_row_id).first();
    
    // TODO: Trigger AWS Lambda for actual video build
    // This would normally call AWS to start the rendering process
    
    return c.json({ build }, 201);
  } catch (error) {
    console.error('[VideoBuild] Create error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create build' } }, 500);
  }
});

/**
 * POST /api/video-builds/:buildId/refresh
 * Refresh video build status from AWS
 */
videoGeneration.post('/video-builds/:buildId/refresh', async (c) => {
  try {
    const buildId = parseInt(c.req.param('buildId'), 10);
    
    const { getCookie } = await import('hono/cookie');
    const sessionId = getCookie(c, 'session');
    if (!sessionId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }
    
    const build = await c.env.DB.prepare(`
      SELECT * FROM video_builds WHERE id = ?
    `).bind(buildId).first();
    
    if (!build) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Build not found' } }, 404);
    }
    
    // TODO: Actually query AWS for status update
    // For now, just return current status
    
    return c.json({ build });
  } catch (error) {
    console.error('[VideoBuild] Refresh error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to refresh build' } }, 500);
  }
});

/**
 * GET /api/video-builds/:buildId
 * Get a single video build
 */
videoGeneration.get('/video-builds/:buildId', async (c) => {
  try {
    const buildId = parseInt(c.req.param('buildId'), 10);
    
    const build = await c.env.DB.prepare(`
      SELECT * FROM video_builds WHERE id = ?
    `).bind(buildId).first();
    
    if (!build) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Build not found' } }, 404);
    }
    
    return c.json({ build });
  } catch (error) {
    console.error('[VideoBuild] Get error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get build' } }, 500);
  }
});

export default videoGeneration;
