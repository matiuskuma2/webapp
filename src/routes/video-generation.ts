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
import { decryptWithKeyRing } from '../utils/crypto';
import { generateSignedImageUrl } from '../utils/signed-url';
import { logApiError, createApiErrorLogger } from '../utils/error-logger';

const videoGeneration = new Hono<{ Bindings: Bindings }>();

// ====================================================================
// Constants
// ====================================================================

// Stuck job detection: mark as failed if generating for more than 15 minutes
const STUCK_JOB_THRESHOLD_MINUTES = 15;

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
// Helper: Get and decrypt user's API key (Key-Ring対応)
// Returns: { key: string } on success, { error: string } on failure
// ====================================================================
// 
// Key-Ring: 複数の鍵を順番に試して復号
// - 動画生成時はDB更新しない（読み取りのみ）
// - 自動移行は settings.ts の test エンドポイントで行う
//

type ApiKeyResult = { key: string } | { error: string };

async function getUserApiKey(
  db: D1Database,
  userId: number,
  provider: string,
  keyRing: string[]  // [現行鍵, 旧鍵1, 旧鍵2, ...]
): Promise<ApiKeyResult> {
  const encryptedKey = await getEncryptedApiKey(db, userId, provider);
  
  if (!encryptedKey) {
    return { error: `No API key found for provider '${provider}'` };
  }
  
  // At least one key is required for decryption
  if (keyRing.length === 0) {
    return { error: 'ENCRYPTION_KEY not configured on server' };
  }
  
  try {
    const { decrypted, keyIndex } = await decryptWithKeyRing(encryptedKey, keyRing);
    
    // 旧鍵で復号された場合はログ出力（移行が必要だが、ここではDB更新しない）
    if (keyIndex > 0) {
      console.log(`[VideoGen] API key for user ${userId} provider ${provider} needs migration (keyIndex=${keyIndex})`);
    }
    
    return { key: decrypted };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { error: `Failed to decrypt API key: ${message}` };
  }
}

// ====================================================================
// Helper: Determine billing source (user or sponsor)
// ====================================================================
// 
// スポンサー判定のSSOT: users.api_sponsor_id
// - api_sponsor_id が設定されている → sponsor課金（api_sponsor_idのユーザーが支払う）
// - api_sponsor_id が NULL → user課金（本人が支払う）
// 
// ※ superadmin操作時の優先は呼び出し側で処理（isSuperadmin判定）
// ※ system_settings.default_sponsor_user_id は廃止（全員スポンサー化の事故防止）

async function determineBillingSource(
  db: D1Database,
  projectId: number,
  userId: number
): Promise<{ billingSource: BillingSource; sponsorUserId: number | null }> {
  // Check user's api_sponsor_id (set by superadmin in admin panel)
  const user = await db.prepare(`
    SELECT api_sponsor_id FROM users WHERE id = ?
  `).bind(userId).first<{ api_sponsor_id: number | null }>();
  
  // If user has api_sponsor_id set, they are sponsored
  if (user?.api_sponsor_id) {
    console.log(`[BillingSource] User ${userId} is sponsored by ${user.api_sponsor_id}`);
    return {
      billingSource: 'sponsor',
      sponsorUserId: user.api_sponsor_id,
    };
  }
  
  // Otherwise, user pays for themselves
  console.log(`[BillingSource] User ${userId} pays for themselves (no sponsor)`);
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
// Helper: Detect and mark stuck jobs as failed
// ====================================================================

async function detectAndMarkStuckJobs(
  db: D1Database,
  sceneId?: number
): Promise<number> {
  // Find jobs that have been 'generating' for more than STUCK_JOB_THRESHOLD_MINUTES
  const thresholdMinutes = STUCK_JOB_THRESHOLD_MINUTES;
  
  let query = `
    UPDATE video_generations 
    SET status = 'failed', 
        error_message = 'Generation timed out (exceeded ${thresholdMinutes} minutes)',
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'generating' 
      AND datetime(updated_at) < datetime('now', '-${thresholdMinutes} minutes')
  `;
  
  if (sceneId) {
    query += ` AND scene_id = ${sceneId}`;
  }
  
  const result = await db.prepare(query).run();
  const updatedCount = result.meta.changes || 0;
  
  if (updatedCount > 0) {
    console.log(`[StuckDetector] Marked ${updatedCount} stuck job(s) as failed`);
  }
  
  return updatedCount;
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
  
  // Create error logger for this endpoint
  const logError = createApiErrorLogger(c.env.DB, 'video_generation', '/api/scenes/:sceneId/generate-video');
  
  if (isNaN(sceneId)) {
    await logError({
      errorCode: 'INVALID_SCENE_ID',
      errorMessage: `Invalid scene ID: ${sceneIdParam}`,
      httpStatusCode: 400,
    });
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
    await logError({
      sceneId: sceneId,
      errorCode: 'SCENE_NOT_FOUND',
      errorMessage: `Scene not found: ${sceneId}`,
      httpStatusCode: 404,
    });
    return c.json({ error: { code: 'SCENE_NOT_FOUND', message: 'Scene not found' } }, 404);
  }
  
  // 3. Active image 取得
  const activeImage = await getSceneActiveImage(c.env.DB, sceneId);
  if (!activeImage) {
    await logError({
      sceneId: sceneId,
      projectId: scene.project_id,
      userId: scene.owner_user_id,
      errorCode: 'NO_ACTIVE_IMAGE',
      errorMessage: 'No active image for this scene. Generate and activate an image first.',
      httpStatusCode: 400,
    });
    return c.json({
      error: {
        code: 'NO_ACTIVE_IMAGE',
        message: 'No active image for this scene. Generate and activate an image first.',
      },
    }, 400);
  }
  
  // 4. Stuck job detection (mark old generating jobs as failed)
  await detectAndMarkStuckJobs(c.env.DB, sceneId);
  
  // 5. 競合チェック（generating中は409）
  const generating = await c.env.DB.prepare(`
    SELECT id FROM video_generations
    WHERE scene_id = ? AND status = 'generating'
  `).bind(sceneId).first();
  
  if (generating) {
    await logError({
      sceneId: sceneId,
      projectId: scene.project_id,
      userId: scene.owner_user_id,
      errorCode: 'GENERATION_IN_PROGRESS',
      errorMessage: 'Video generation already in progress for this scene',
      httpStatusCode: 409,
      errorDetails: { existing_video_id: generating.id },
    });
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
  
  // ========================================================================
  // 6. 課金判定 - billing_source と APIキー選択
  // ========================================================================
  // 
  // 【APIキー選択の優先順位（SSOT）】
  // 1. executor が superadmin → superadminの動画化用API（運営キー）
  // 2. target user に api_sponsor_id がある → api_sponsor_id（=superadmin）の動画化用API
  // 3. それ以外 → target user の動画化用API
  // 
  // 【課金の責任】
  // - billing_source = 'sponsor' → api_sponsor_id のユーザー（または superadmin）が支払う
  // - billing_source = 'user' → 操作したユーザー本人が支払う
  // 
  // ========================================================================
  
  let billingSource: BillingSource = 'user';
  let sponsorUserId: number | null = null;
  
  if (isSuperadmin) {
    // Priority 1: Superadmin操作 → 必ず sponsor（運営キー使用）
    billingSource = 'sponsor';
    sponsorUserId = loggedInUserId;
    console.log(`[VideoGen] Superadmin operation: billing_source=sponsor, sponsor_id=${sponsorUserId}`);
  } else {
    // Priority 2/3: 通常ユーザー → users.api_sponsor_id を確認
    const billingInfo = await determineBillingSource(
      c.env.DB, scene.project_id, scene.owner_user_id
    );
    billingSource = billingInfo.billingSource;
    sponsorUserId = billingInfo.sponsorUserId;
  }
  
  // executorUserId: 実際に操作した人（ログが追跡に必要）
  const executorUserId = loggedInUserId || scene.owner_user_id;
  
  // billingUserId: 課金される人
  const billingUserId = billingSource === 'sponsor' && sponsorUserId 
    ? sponsorUserId 
    : executorUserId;
  
  // ログ出力（コスト追跡用）
  console.log(`[VideoGen] Billing decision: billing_source=${billingSource}, billing_user_id=${billingUserId}, executor_user_id=${executorUserId}, owner_user_id=${scene.owner_user_id}`);
  
  let apiKey: string | null = null;
  let vertexSaJson: string | null = null;
  let vertexProjectId: string | null = null;
  let vertexLocation: string | null = null;
  
  // Key-Ring: [現行鍵, 旧鍵1, 旧鍵2] (falsy values are filtered out)
  const keyRing = [
    c.env.ENCRYPTION_KEY,
    c.env.ENCRYPTION_KEY_OLD_1,
    c.env.ENCRYPTION_KEY_OLD_2
  ].filter(Boolean) as string[];
  
  if (videoEngine === 'veo2') {
    if (isSuperadmin || billingSource === 'sponsor') {
      // Superadmin or Sponsor mode: use system GEMINI_API_KEY
      if (!c.env.GEMINI_API_KEY) {
        // Try superadmin's own API key first
        if (isSuperadmin && loggedInUserId) {
          const keyResult = await getUserApiKey(c.env.DB, loggedInUserId, 'google', keyRing);
          if ('key' in keyResult) {
            apiKey = keyResult.key;
          }
        }
        
        if (!apiKey) {
          await logError({
            sceneId: sceneId,
            projectId: scene.project_id,
            userId: executorUserId,
            provider: 'google',
            videoEngine: 'veo2',
            errorCode: 'SPONSOR_KEY_NOT_CONFIGURED',
            errorMessage: 'システムAPIキーが設定されていません',
            httpStatusCode: 500,
            errorDetails: { isSuperadmin, billingSource },
          });
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
      const keyResult = await getUserApiKey(c.env.DB, executorUserId, 'google', keyRing);
      
      if ('error' in keyResult) {
        await logError({
          sceneId: sceneId,
          projectId: scene.project_id,
          userId: executorUserId,
          provider: 'google',
          videoEngine: 'veo2',
          errorCode: 'USER_KEY_ERROR',
          errorMessage: keyResult.error,
          httpStatusCode: 400,
          errorDetails: { billingSource },
        });
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
    // Veo3: Vertex AI API Key
    let vertexApiKey: string | null = null;
    
    if (isSuperadmin || billingSource === 'sponsor') {
      // Superadmin/Sponsor: Try user's own Vertex key first
      if (isSuperadmin && loggedInUserId) {
        const keyResult = await getUserApiKey(c.env.DB, loggedInUserId, 'vertex', keyRing);
        if ('key' in keyResult) {
          vertexApiKey = keyResult.key;
        }
      }
      
      // If superadmin has no key, try sponsor's key
      if (!vertexApiKey && sponsorUserId) {
        const keyResult = await getUserApiKey(c.env.DB, sponsorUserId, 'vertex', keyRing);
        if ('key' in keyResult) {
          vertexApiKey = keyResult.key;
        }
      }
      
      if (!vertexApiKey) {
        await logError({
          sceneId: sceneId,
          projectId: scene.project_id,
          userId: executorUserId,
          provider: 'vertex',
          videoEngine: 'veo3',
          errorCode: 'SPONSOR_VERTEX_NOT_CONFIGURED',
          errorMessage: 'Vertex APIキーが設定されていません',
          httpStatusCode: 400,
          errorDetails: { isSuperadmin, billingSource, sponsorUserId },
        });
        return c.json({
          error: {
            code: 'SPONSOR_VERTEX_NOT_CONFIGURED',
            message: isSuperadmin
              ? 'Vertex APIキーが設定されていません。設定画面でVertex APIキーを設定してください。'
              : 'スポンサーのVertex APIキーが設定されていません。',
            redirect: '/settings?focus=vertex',
          },
        }, 400);
      }
    } else {
      // User mode: user's own Vertex API key required
      const keyResult = await getUserApiKey(c.env.DB, executorUserId, 'vertex', keyRing);
      
      if ('error' in keyResult) {
        await logError({
          sceneId: sceneId,
          projectId: scene.project_id,
          userId: executorUserId,
          provider: 'vertex',
          videoEngine: 'veo3',
          errorCode: 'USER_KEY_ERROR',
          errorMessage: keyResult.error,
          httpStatusCode: 400,
          errorDetails: { billingSource },
        });
        return c.json({
          error: {
            code: 'USER_KEY_ERROR',
            message: keyResult.error,
            redirect: '/settings?focus=vertex',
          },
        }, 400);
      }
      vertexApiKey = keyResult.key;
    }
    
    // Store Vertex API key for AWS Worker
    // Note: vertexSaJson is reused to store API key for backward compatibility with AWS Worker
    vertexSaJson = vertexApiKey;
    
    // Project ID from system settings (required for Vertex AI endpoint URL)
    vertexProjectId = await getSystemSetting(c.env.DB, 'vertex_project_id') || null;
    
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
    
    await logError({
      sceneId: sceneId,
      projectId: scene.project_id,
      userId: executorUserId,
      videoEngine: videoEngine,
      errorCode: 'AWS_CONFIG_ERROR',
      errorMessage: 'AWS credentials not configured',
      httpStatusCode: 500,
      errorDetails: { videoGenerationId },
    });
    
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
    
    await logError({
      sceneId: sceneId,
      projectId: scene.project_id,
      userId: executorUserId,
      videoEngine: videoEngine,
      errorCode: 'SERVER_CONFIG_ERROR',
      errorMessage: 'IMAGE_URL_SIGNING_SECRET not configured',
      httpStatusCode: 500,
      errorDetails: { videoGenerationId },
    });
    
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
    const errorMessage = awsResponse.error?.message || 'AWS call failed';
    await c.env.DB.prepare(`
      UPDATE video_generations SET status = 'failed', error_message = ?
      WHERE id = ?
    `).bind(errorMessage, videoGenerationId).run();
    
    await logError({
      sceneId: sceneId,
      projectId: scene.project_id,
      userId: executorUserId,
      provider: videoEngine === 'veo3' ? 'vertex' : 'google',
      videoEngine: videoEngine,
      errorCode: awsResponse.error?.code || 'AWS_START_FAILED',
      errorMessage: errorMessage,
      httpStatusCode: 500,
      errorDetails: { 
        videoGenerationId, 
        billingSource, 
        billingUserId,
        awsError: awsResponse.error,
      },
    });
    
    return c.json({
      error: awsResponse.error || { code: 'AWS_START_FAILED', message: 'Failed to start video generation' },
    }, 500);
  }
  
  // 9. job_id保存
  await c.env.DB.prepare(`
    UPDATE video_generations SET job_id = ? WHERE id = ?
  `).bind(awsResponse.job_id, videoGenerationId).run();
  
  // 10. api_usage_logs 記録
  // - user_id: 実行者（executor）
  // - sponsored_by_user_id: スポンサー課金時は支払い者、user課金時はNULL
  await c.env.DB.prepare(`
    INSERT INTO api_usage_logs (
      user_id, project_id, api_type, provider, model, video_engine, 
      sponsored_by_user_id, metadata_json
    ) VALUES (?, ?, 'video_generation', 'google', ?, ?, ?, ?)
  `).bind(
    executorUserId,
    scene.project_id,
    model,
    videoEngine,
    billingSource === 'sponsor' ? billingUserId : null,
    JSON.stringify({ 
      scene_id: sceneId, 
      duration_sec: durationSec, 
      job_id: awsResponse.job_id,
      billing_source: billingSource,
      billing_user_id: billingUserId,
      executor_user_id: executorUserId,
      owner_user_id: scene.owner_user_id
    })
  ).run();
  
  return c.json({
    success: true,
    video_id: videoGenerationId,
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
  
  // Auto-detect and mark stuck jobs before listing
  await detectAndMarkStuckJobs(c.env.DB, sceneId);
  
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
// GET /api/scenes/:sceneId/videos/:videoId/status
// Frontend polls this endpoint for status updates
// ====================================================================

videoGeneration.get('/:sceneId/videos/:videoId/status', async (c) => {
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
          // First, deactivate all videos for this scene
          await c.env.DB.prepare(`
            UPDATE video_generations SET is_active = 0 WHERE scene_id = ?
          `).bind(video.scene_id).run();
          
          // Then, set this video as active and completed
          await c.env.DB.prepare(`
            UPDATE video_generations 
            SET status = 'completed', r2_url = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(awsStatus.job.presigned_url, videoId).run();
          
          return c.json({
            status: 'completed',
            r2_url: awsStatus.job.presigned_url,
            progress_stage: 'completed',
          });
        } else if (jobStatus === 'failed') {
          await c.env.DB.prepare(`
            UPDATE video_generations 
            SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(awsStatus.job.error_message || 'Generation failed', videoId).run();
          
          return c.json({
            status: 'failed',
            error: { message: awsStatus.job.error_message || 'Generation failed' },
          });
        } else {
          // Still processing
          return c.json({
            status: video.status,
            progress_stage: awsStatus.job.progress_stage || 'processing',
          });
        }
      }
    }
  }
  
  return c.json({
    status: video.status,
    r2_url: video.r2_url,
    error: video.error_message ? { message: video.error_message } : undefined,
  });
});

// ====================================================================
// GET /api/videos/:videoId/status (Legacy endpoint)
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
          // First, deactivate all videos for this scene
          await c.env.DB.prepare(`
            UPDATE video_generations SET is_active = 0 WHERE scene_id = ?
          `).bind(video.scene_id).run();
          
          // Then, set this video as active and completed
          await c.env.DB.prepare(`
            UPDATE video_generations 
            SET status = 'completed', r2_url = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
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
// Stuck Job Sweeper API (Manual trigger)
// ====================================================================

/**
 * POST /api/video-generations/sweep-stuck
 * Manually trigger stuck job detection and cleanup
 * Requires superadmin role
 */
videoGeneration.post('/sweep-stuck', async (c) => {
  try {
    const { getCookie } = await import('hono/cookie');
    const sessionId = getCookie(c, 'session');
    if (!sessionId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }
    
    const session = await c.env.DB.prepare(`
      SELECT s.user_id, u.role FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = ? AND s.expires_at > datetime('now')
    `).bind(sessionId).first<{ user_id: number; role: string }>();
    
    if (!session || session.role !== 'superadmin') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Superadmin access required' } }, 403);
    }
    
    // Run sweeper globally (no sceneId filter)
    const markedCount = await detectAndMarkStuckJobs(c.env.DB);
    
    return c.json({
      success: true,
      marked_as_failed: markedCount,
      threshold_minutes: STUCK_JOB_THRESHOLD_MINUTES,
    });
  } catch (error) {
    console.error('[StuckSweeper] Error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to run sweeper' } }, 500);
  }
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

// ====================================================================
// GET /api/scenes/:sceneId/error-logs
// Get error logs for a specific scene (admin only)
// ====================================================================

videoGeneration.get('/:sceneId/error-logs', async (c) => {
  const sceneId = parseInt(c.req.param('sceneId'), 10);
  if (isNaN(sceneId)) {
    return c.json({ error: { code: 'INVALID_SCENE_ID', message: 'Invalid scene ID' } }, 400);
  }
  
  // Auth check (admin only)
  const { getCookie } = await import('hono/cookie');
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);
  }
  
  const session = await c.env.DB.prepare(`
    SELECT u.role FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sessionId).first<{ role: string }>();
  
  if (!session || !['superadmin', 'admin'].includes(session.role)) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } }, 403);
  }
  
  // Get recent error logs for this scene
  const { results: errorLogs } = await c.env.DB.prepare(`
    SELECT id, user_id, project_id, scene_id, api_type, api_endpoint, 
           provider, video_engine, error_code, error_message, 
           error_details_json, http_status_code, created_at
    FROM api_error_logs
    WHERE scene_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(sceneId).all();
  
  return c.json({ error_logs: errorLogs || [] });
});

// ====================================================================
// GET /api/error-logs/recent
// Get recent error logs across all scenes (superadmin only)
// ====================================================================

videoGeneration.get('/error-logs/recent', async (c) => {
  // Auth check (superadmin only)
  const { getCookie } = await import('hono/cookie');
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);
  }
  
  const session = await c.env.DB.prepare(`
    SELECT u.role FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sessionId).first<{ role: string }>();
  
  if (!session || session.role !== 'superadmin') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Superadmin access required' } }, 403);
  }
  
  // Get recent error logs
  const { results: errorLogs } = await c.env.DB.prepare(`
    SELECT e.id, e.user_id, u.email as user_email, e.project_id, e.scene_id, 
           e.api_type, e.api_endpoint, e.provider, e.video_engine, 
           e.error_code, e.error_message, e.http_status_code, e.created_at
    FROM api_error_logs e
    LEFT JOIN users u ON e.user_id = u.id
    ORDER BY e.created_at DESC
    LIMIT 100
  `).all();
  
  return c.json({ error_logs: errorLogs || [] });
});

export default videoGeneration;
