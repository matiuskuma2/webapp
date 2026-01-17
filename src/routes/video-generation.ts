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
// Helper: Get user's API key
// ====================================================================

async function getUserApiKey(
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

function buildSignedImageUrl(r2Key: string, origin: string): string {
  // AWS Worker が取得できる署名付きURL (TTL 10分)
  // /images/signed/{r2_key} 形式
  return `${origin}/images/signed/${encodeURIComponent(r2Key)}`;
}

// ====================================================================
// POST /api/scenes/:sceneId/generate-video
// ====================================================================

videoGeneration.post('/scenes/:sceneId/generate-video', async (c) => {
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
  
  // 6. 認証情報取得
  // TODO: sponsor判定（現時点ではユーザー自身のキーを使用）
  const billingSource: BillingSource = 'user';
  const executorUserId = scene.owner_user_id;
  const billingUserId = scene.owner_user_id;
  
  let apiKey: string | null = null;
  let vertexSaJson: string | null = null;
  let vertexProjectId: string | null = null;
  let vertexLocation: string | null = null;
  
  if (videoEngine === 'veo2') {
    apiKey = await getUserApiKey(c.env.DB, executorUserId, 'gemini');
    if (!apiKey) {
      return c.json({
        error: {
          code: 'MISSING_GEMINI_KEY',
          message: 'Gemini API key not configured. Please add it in settings.',
          redirect: '/settings?focus=gemini',
        },
      }, 400);
    }
  } else {
    // Veo3: Vertex SA JSON
    vertexSaJson = await getUserApiKey(c.env.DB, executorUserId, 'vertex');
    if (!vertexSaJson) {
      return c.json({
        error: {
          code: 'MISSING_VERTEX_SA',
          message: 'Vertex AI Service Account not configured. Please add it in settings.',
          redirect: '/settings?focus=vertex',
        },
      }, 400);
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
  
  const origin = new URL(c.req.url).origin;
  const imageUrl = buildSignedImageUrl(activeImage.r2_key, origin);
  
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

videoGeneration.get('/scenes/:sceneId/videos', async (c) => {
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
  
  // generating中でjob_idがある場合はAWSに問い合わせ
  if (video.status === 'generating' && video.job_id) {
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

export default videoGeneration;
