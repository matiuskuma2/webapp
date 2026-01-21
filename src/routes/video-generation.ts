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

/**
 * Default SITE_URL for webapp
 * This is used as fallback when SITE_URL is not configured in environment
 */
const DEFAULT_SITE_URL = 'https://webapp-c7n.pages.dev';

/**
 * Convert relative R2 URL to absolute URL using SITE_URL
 * For Remotion Lambda to access R2 content via webapp
 * 
 * CRITICAL: Remotion Lambda cannot resolve relative URLs and will append them
 * to its own S3 bucket URL, causing 404 errors.
 */
function toAbsoluteUrl(relativeUrl: string | null | undefined, siteUrl: string | undefined): string | null {
  if (!relativeUrl) return null;
  // Already absolute URL
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
    return relativeUrl;
  }
  // Relative path - prefix with SITE_URL (with fallback)
  const baseUrl = (siteUrl || DEFAULT_SITE_URL).replace(/\/$/, ''); // Remove trailing slash
  const path = relativeUrl.startsWith('/') ? relativeUrl : `/${relativeUrl}`;
  const absoluteUrl = `${baseUrl}${path}`;
  
  // Log for debugging if using fallback
  if (!siteUrl) {
    console.warn('[Video Build] SITE_URL not configured, using fallback:', DEFAULT_SITE_URL);
  }
  
  return absoluteUrl;
}

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
    // Note: Table uses 'key' and 'value' columns (not 'setting_key' and 'setting_value')
    const settings = await c.env.DB.prepare(`
      SELECT key, value FROM system_settings
      WHERE key IN ('video_build_daily_limit', 'video_build_concurrent_limit')
    `).all();
    
    const settingsMap = new Map(
      (settings.results || []).map((r: any) => [r.key, r.value])
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
    
    // Count monthly builds (for UI display)
    const monthlyBuilds = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM video_builds
      WHERE executor_user_id = ? 
      AND created_at >= datetime('now', 'start of month')
    `).bind(userId).first<{ count: number }>();
    
    return c.json({
      // Legacy format for frontend compatibility
      monthly_builds: monthlyBuilds?.count || 0,
      concurrent_builds: activeBuilds?.count || 0,
      // New detailed format
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
 * GET /api/projects/:projectId/video-builds/preflight
 * Preflight check for video build (素材検証 + R1.6 utterances検証)
 * 
 * ビルド開始前にUIがこのエンドポイントを呼び出して、
 * 素材が揃っているか、utterances に音声があるかを確認する
 * 
 * R1.6 追加チェック:
 * - 各シーンに utterances が存在するか
 * - 各 utterance に text があるか
 * - 各 utterance に音声が生成済みか
 */
videoGeneration.get('/projects/:projectId/video-builds/preflight', async (c) => {
  const { validateProjectAssets, validateUtterancesPreflight } = await import('../utils/video-build-helpers');
  
  try {
    const projectId = parseInt(c.req.param('projectId'), 10);
    
    // シーンデータ取得
    // Note: display_asset_type は一部のDBに存在しない可能性があるため、
    // コード側でデフォルト値を設定
    const { results: rawScenes } = await c.env.DB.prepare(`
      SELECT id, idx, role, title, dialogue, comic_data
      FROM scenes
      WHERE project_id = ?
      ORDER BY idx ASC
    `).bind(projectId).all();
    
    if (!rawScenes || rawScenes.length === 0) {
      return c.json({
        is_ready: false,
        can_generate: false,
        ready_count: 0,
        total_count: 0,
        missing: [],
        warnings: [],
        utterance_errors: [],
        message: 'プロジェクトにシーンがありません',
      });
    }
    
    // シーンごとに素材情報 + utterances を取得
    const scenesWithAssets = await Promise.all(
      rawScenes.map(async (scene: any) => {
        // アクティブAI画像
        const activeImage = await c.env.DB.prepare(`
          SELECT r2_key, r2_url FROM image_generations
          WHERE scene_id = ? AND is_active = 1 AND (asset_type = 'ai' OR asset_type IS NULL)
          LIMIT 1
        `).bind(scene.id).first();
        
        // アクティブ漫画画像
        const activeComic = await c.env.DB.prepare(`
          SELECT id, r2_key, r2_url FROM image_generations
          WHERE scene_id = ? AND is_active = 1 AND asset_type = 'comic'
          LIMIT 1
        `).bind(scene.id).first();
        
        // アクティブ動画
        const activeVideo = await c.env.DB.prepare(`
          SELECT id, status, r2_url, model, duration_sec
          FROM video_generations
          WHERE scene_id = ? AND is_active = 1 AND status = 'completed' AND r2_url IS NOT NULL
          LIMIT 1
        `).bind(scene.id).first();
        
        // アクティブ音声（Preflight用: 存在確認のみ）
        const activeAudioRaw = await c.env.DB.prepare(`
          SELECT id, r2_url, text
          FROM audio_generations
          WHERE scene_id = ? AND is_active = 1 AND status = 'completed' AND r2_url IS NOT NULL
          LIMIT 1
        `).bind(scene.id).first<{ id: number; r2_url: string; text: string }>();
        
        // 音声がある場合は、テキスト長から推定duration_msを計算（日本語: 約300ms/文字）
        // IMPORTANT: Convert relative R2 URL to absolute URL for Remotion Lambda access
        const siteUrl = c.env.SITE_URL;
        const activeAudio = activeAudioRaw ? {
          id: activeAudioRaw.id,
          audio_url: toAbsoluteUrl(activeAudioRaw.r2_url, siteUrl),
          duration_ms: Math.max(2000, (activeAudioRaw.text?.length || 0) * 300), // 最低2秒
        } : null;
        
        // comic_dataのパース
        let comicData = null;
        try {
          if (scene.comic_data) {
            comicData = JSON.parse(scene.comic_data);
          }
        } catch (e) {
          // ignore
        }
        
        // R1.6: scene_utterances を取得（audio_generations の status を含む）
        const { results: utteranceRows } = await c.env.DB.prepare(`
          SELECT 
            u.id,
            u.order_no,
            u.role,
            u.text,
            u.audio_generation_id,
            ag.status as audio_status
          FROM scene_utterances u
          LEFT JOIN audio_generations ag ON u.audio_generation_id = ag.id
          WHERE u.scene_id = ?
          ORDER BY u.order_no ASC
        `).bind(scene.id).all<{
          id: number;
          order_no: number;
          role: string;
          text: string;
          audio_generation_id: number | null;
          audio_status: string | null;
        }>();
        
        return {
          id: scene.id,
          idx: scene.idx,
          role: scene.role || '',
          title: scene.title || '',
          dialogue: scene.dialogue || '',
          display_asset_type: scene.display_asset_type || 'image',
          // Convert all R2 URLs to absolute URLs for consistency
          active_image: activeImage ? { r2_key: activeImage.r2_key, r2_url: toAbsoluteUrl(activeImage.r2_url, siteUrl) } : null,
          active_comic: activeComic ? { id: activeComic.id, r2_key: activeComic.r2_key, r2_url: toAbsoluteUrl(activeComic.r2_url, siteUrl) } : null,
          active_video: activeVideo ? { 
            id: activeVideo.id, 
            status: activeVideo.status, 
            r2_url: toAbsoluteUrl(activeVideo.r2_url, siteUrl),
            model: activeVideo.model,
            duration_sec: activeVideo.duration_sec
          } : null,
          active_audio: activeAudio,
          comic_data: comicData,
          // R1.6: utterances with audio_status
          utterances: utteranceRows.map(u => ({
            id: u.id,
            text: u.text,
            audio_generation_id: u.audio_generation_id,
            audio_status: u.audio_status || null,
          })),
        };
      })
    );
    
    // 素材 Preflight検証（画像/漫画/動画）
    const assetValidation = validateProjectAssets(scenesWithAssets);
    
    // R1.6: Utterances Preflight検証
    const utteranceValidation = validateUtterancesPreflight(scenesWithAssets);
    
    // 全体の判定: 素材OK AND utterances OK
    const canGenerate = assetValidation.is_ready && utteranceValidation.can_generate;
    
    return c.json({
      // 後方互換: is_ready は素材のみの判定
      is_ready: assetValidation.is_ready,
      ready_count: assetValidation.ready_count,
      total_count: assetValidation.total_count,
      missing: assetValidation.missing,
      warnings: assetValidation.warnings,
      // R1.6: utterances 検証結果
      can_generate: canGenerate,
      utterance_errors: utteranceValidation.errors,
      utterance_summary: utteranceValidation.summary,
    });
    
  } catch (error) {
    console.error('[VideoBuild] Preflight error:', error);
    return c.json({ 
      is_ready: false,
      can_generate: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to run preflight check' }
    }, 500);
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
 * 
 * フロー:
 * 1. 認証確認
 * 2. 二重実行防止（同一プロジェクトでアクティブなビルドがある場合は拒否）
 * 3. シーンデータ取得（display_asset_type + 素材情報）
 * 4. Preflight検証（validateProjectAssets）
 * 5. project.json生成（buildProjectJson）
 * 6. R2にproject.jsonを保存
 * 7. video_buildsレコード作成（status='validating'）
 * 8. AWS Orchestratorへstart呼び出し
 * 9. レスポンス更新（status='submitted', aws_job_id等）
 */
videoGeneration.post('/projects/:projectId/video-builds', async (c) => {
  const { getCookie } = await import('hono/cookie');
  
  // Helper imports
  const { validateProjectAssets, buildProjectJson, hashProjectJson } = await import('../utils/video-build-helpers');
  const { startVideoBuild, createVideoBuildClientConfig, DEFAULT_OUTPUT_BUCKET, getDefaultOutputKey } = await import('../utils/aws-video-build-client');
  
  try {
    const projectId = parseInt(c.req.param('projectId'), 10);
    const body = await c.req.json();
    
    // 1. 認証確認
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
    
    // Get project info
    const project = await c.env.DB.prepare(`
      SELECT id, user_id, title FROM projects WHERE id = ?
    `).bind(projectId).first<{ id: number; user_id: number; title: string }>();
    
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
    }
    
    // owner_user_id: project.user_id が null の場合はセッションユーザーをフォールバック
    const ownerUserId = project.user_id || userId;
    
    // 2. 二重実行防止（アクティブなビルドがある場合は拒否）
    const activeStatuses = ['queued', 'validating', 'submitted', 'rendering', 'uploading'];
    const activeBuild = await c.env.DB.prepare(`
      SELECT id, status FROM video_builds
      WHERE project_id = ? AND status IN (${activeStatuses.map(() => '?').join(',')})
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(projectId, ...activeStatuses).first<{ id: number; status: string }>();
    
    if (activeBuild) {
      return c.json({
        error: {
          code: 'BUILD_IN_PROGRESS',
          message: `このプロジェクトには既にビルドが進行中です（ID: ${activeBuild.id}, ステータス: ${activeBuild.status}）`,
          details: { active_build_id: activeBuild.id, active_build_status: activeBuild.status }
        }
      }, 409);
    }
    
    // 3. シーンデータ取得（display_asset_type + R2 text_render_mode + 素材情報）
    const { results: rawScenes } = await c.env.DB.prepare(`
      SELECT id, idx, role, title, dialogue, display_asset_type, comic_data, text_render_mode
      FROM scenes
      WHERE project_id = ?
      ORDER BY idx ASC
    `).bind(projectId).all();
    
    if (!rawScenes || rawScenes.length === 0) {
      return c.json({
        error: { code: 'NO_SCENES', message: 'プロジェクトにシーンがありません' }
      }, 400);
    }
    
    // シーンごとに素材情報を取得
    const scenesWithAssets = await Promise.all(
      rawScenes.map(async (scene: any) => {
        // アクティブAI画像
        const activeImage = await c.env.DB.prepare(`
          SELECT r2_key, r2_url FROM image_generations
          WHERE scene_id = ? AND is_active = 1 AND (asset_type = 'ai' OR asset_type IS NULL)
          LIMIT 1
        `).bind(scene.id).first();
        
        // アクティブ漫画画像
        const activeComic = await c.env.DB.prepare(`
          SELECT id, r2_key, r2_url FROM image_generations
          WHERE scene_id = ? AND is_active = 1 AND asset_type = 'comic'
          LIMIT 1
        `).bind(scene.id).first();
        
        // アクティブ動画
        const activeVideo = await c.env.DB.prepare(`
          SELECT id, status, r2_url, model, duration_sec
          FROM video_generations
          WHERE scene_id = ? AND is_active = 1 AND status = 'completed' AND r2_url IS NOT NULL
          LIMIT 1
        `).bind(scene.id).first();
        
        // アクティブ音声（シーン単位）
        // Note: duration_ms は現在DBに保存されていないため、null または推定値を使用
        const activeAudioRaw = await c.env.DB.prepare(`
          SELECT id, r2_url, text
          FROM audio_generations
          WHERE scene_id = ? AND is_active = 1 AND status = 'completed' AND r2_url IS NOT NULL
          LIMIT 1
        `).bind(scene.id).first<{ id: number; r2_url: string; text: string }>();
        
        // 音声がある場合は、テキスト長から推定duration_msを計算（日本語: 約300ms/文字）
        // IMPORTANT: Convert relative R2 URL to absolute URL for Remotion Lambda access
        const siteUrl = c.env.SITE_URL;
        const activeAudio = activeAudioRaw ? {
          id: activeAudioRaw.id,
          audio_url: toAbsoluteUrl(activeAudioRaw.r2_url, siteUrl),
          duration_ms: Math.max(2000, (activeAudioRaw.text?.length || 0) * 300), // 最低2秒
        } : null;
        
        // comic_dataのパース
        let comicData = null;
        try {
          if (scene.comic_data) {
            comicData = JSON.parse(scene.comic_data);
          }
        } catch (e) {
          console.warn(`Failed to parse comic_data for scene ${scene.id}:`, e);
        }
        
        // R1.5: scene_utterances から発話を取得（SSOT）
        const { results: utteranceRows } = await c.env.DB.prepare(`
          SELECT 
            u.id,
            u.order_no,
            u.role,
            u.character_key,
            u.text,
            u.audio_generation_id,
            u.duration_ms,
            ag.r2_url as audio_url,
            pcm.character_name
          FROM scene_utterances u
          LEFT JOIN audio_generations ag ON u.audio_generation_id = ag.id AND ag.status = 'completed'
          LEFT JOIN project_character_models pcm ON u.character_key = pcm.character_key AND pcm.project_id = ?
          WHERE u.scene_id = ?
          ORDER BY u.order_no ASC
        `).bind(project.id, scene.id).all<{
          id: number;
          order_no: number;
          role: string;
          character_key: string | null;
          text: string;
          audio_generation_id: number | null;
          duration_ms: number | null;
          audio_url: string | null;
          character_name: string | null;
        }>();
        
        // Convert R2 URLs to absolute URLs
        const utterances = utteranceRows.map(u => ({
          id: u.id,
          order_no: u.order_no,
          role: u.role as 'narration' | 'dialogue',
          character_key: u.character_key,
          character_name: u.character_name,
          text: u.text,
          audio_generation_id: u.audio_generation_id,
          duration_ms: u.duration_ms,
          audio_url: u.audio_url ? toAbsoluteUrl(u.audio_url, siteUrl) : null,
        }));
        
        // R2-A: scene_balloons を取得（utterance と同期で表示）
        const { results: balloonRows } = await c.env.DB.prepare(`
          SELECT 
            id, utterance_id, x, y, w, h,
            shape, display_mode, start_ms, end_ms,
            tail_enabled, tail_tip_x, tail_tip_y,
            writing_mode, text_align,
            font_family, font_weight, font_size, line_height,
            padding, bg_color, text_color, border_color, border_width,
            z_index
          FROM scene_balloons
          WHERE scene_id = ?
          ORDER BY z_index ASC, id ASC
        `).bind(scene.id).all<{
          id: number;
          utterance_id: number | null;
          x: number;
          y: number;
          w: number;
          h: number;
          shape: string;
          display_mode: string;
          start_ms: number | null;
          end_ms: number | null;
          tail_enabled: number;
          tail_tip_x: number | null;
          tail_tip_y: number | null;
          writing_mode: string;
          text_align: string;
          font_family: string | null;
          font_weight: number | null;
          font_size: number | null;
          line_height: number | null;
          padding: number | null;
          bg_color: string | null;
          text_color: string | null;
          border_color: string | null;
          border_width: number | null;
          z_index: number;
        }>();
        
        const balloons = balloonRows.map(b => ({
          id: b.id,
          utterance_id: b.utterance_id,
          position: { x: b.x, y: b.y },
          size: { w: b.w, h: b.h },
          shape: b.shape as 'round' | 'square' | 'thought' | 'shout' | 'caption',
          display_mode: b.display_mode as 'voice_window' | 'manual_window',
          timing: b.display_mode === 'manual_window' 
            ? { start_ms: b.start_ms, end_ms: b.end_ms }
            : null, // voice_window の場合は utterance から取得
          tail: {
            enabled: b.tail_enabled === 1,
            tip_x: b.tail_tip_x ?? 0.5,
            tip_y: b.tail_tip_y ?? 1.2,
          },
          style: {
            writing_mode: b.writing_mode || 'horizontal',
            text_align: b.text_align || 'center',
            font_family: b.font_family || 'sans-serif',
            font_weight: b.font_weight || 700,
            font_size: b.font_size || 24,
            line_height: b.line_height || 1.4,
            padding: b.padding || 12,
            bg_color: b.bg_color || '#FFFFFF',
            text_color: b.text_color || '#000000',
            border_color: b.border_color || '#000000',
            border_width: b.border_width || 2,
          },
          z_index: b.z_index,
        }));
        
        return {
          id: scene.id,
          idx: scene.idx,
          role: scene.role || '',
          title: scene.title || '',
          dialogue: scene.dialogue || '',
          display_asset_type: scene.display_asset_type || 'image',
          // R2: text_render_mode（remotion / baked / none）
          text_render_mode: scene.text_render_mode || 'remotion',
          // Convert all R2 URLs to absolute URLs for Remotion Lambda
          active_image: activeImage ? { r2_key: activeImage.r2_key, r2_url: toAbsoluteUrl(activeImage.r2_url, siteUrl) } : null,
          active_comic: activeComic ? { id: activeComic.id, r2_key: activeComic.r2_key, r2_url: toAbsoluteUrl(activeComic.r2_url, siteUrl) } : null,
          active_video: activeVideo ? { 
            id: activeVideo.id, 
            status: activeVideo.status, 
            r2_url: toAbsoluteUrl(activeVideo.r2_url, siteUrl),
            model: activeVideo.model,
            duration_sec: activeVideo.duration_sec
          } : null,
          active_audio: activeAudio,
          comic_data: comicData,
          // R1.5: utterances（SSOT）
          utterances: utterances.length > 0 ? utterances : null,
          // R2-A: balloons（utterance 連動）
          balloons: balloons.length > 0 ? balloons : null,
        };
      })
    );
    
    // 4. Preflight検証
    const validation = validateProjectAssets(scenesWithAssets);
    
    if (!validation.is_ready) {
      return c.json({
        error: {
          code: 'PREFLIGHT_FAILED',
          message: `素材が不足しています（${validation.ready_count}/${validation.total_count}シーン準備完了）`,
          details: {
            ready_count: validation.ready_count,
            total_count: validation.total_count,
            missing: validation.missing,
            warnings: validation.warnings,
          }
        }
      }, 400);
    }
    
    // 5. Settings構築
    const buildSettings = {
      captions: {
        enabled: body.captions?.enabled ?? body.include_captions ?? true,
        position: body.captions?.position || 'bottom',
        show_speaker: body.captions?.show_speaker ?? true,
      },
      bgm: {
        enabled: body.bgm?.enabled ?? body.include_bgm ?? false,
        track: body.bgm?.track,
        volume: body.bgm?.volume ?? 0.5,
      },
      motion: {
        preset: body.motion?.preset ?? (body.include_motion ? 'gentle-zoom' : 'none'),
        transition: body.motion?.transition || 'crossfade',
      },
    };
    
    // 6. project.json生成
    const projectJson = buildProjectJson(
      { id: project.id, title: project.title, user_id: ownerUserId },
      scenesWithAssets,
      buildSettings,
      {
        aspectRatio: body.aspect_ratio || '9:16',
        resolution: body.resolution || '1080p',
        fps: body.fps || 30,
      }
    );
    
    const projectJsonHash = await hashProjectJson(projectJson);
    const projectJsonString = JSON.stringify(projectJson);
    
    // 7. video_buildsレコード作成（status='validating'）
    const insertResult = await c.env.DB.prepare(`
      INSERT INTO video_builds (
        project_id, owner_user_id, executor_user_id, 
        settings_json, status, progress_stage, progress_message,
        total_scenes, total_duration_ms, project_json_version, project_json_hash
      ) VALUES (?, ?, ?, ?, 'validating', 'Preparing', '素材検証完了、ビルド準備中...', ?, ?, '1.1', ?)
    `).bind(
      projectId,
      ownerUserId,
      userId,
      JSON.stringify(buildSettings),
      scenesWithAssets.length,
      projectJson.summary?.total_duration_ms ?? (projectJson as any).total_duration_ms ?? 0,
      projectJsonHash
    ).run();
    
    const videoBuildId = insertResult.meta.last_row_id as number;
    
    // 8. R2にproject.jsonを保存
    const r2Key = `video-builds/${videoBuildId}/project.json`;
    try {
      await c.env.R2.put(r2Key, projectJsonString, {
        httpMetadata: { contentType: 'application/json' },
      });
      
      // Update with R2 key
      await c.env.DB.prepare(`
        UPDATE video_builds SET project_json_r2_key = ? WHERE id = ?
      `).bind(r2Key, videoBuildId).run();
    } catch (r2Error) {
      console.error('[VideoBuild] R2 save error:', r2Error);
      // Continue even if R2 save fails - the JSON is in settings_json
    }
    
    // 9. AWS Orchestrator呼び出し
    const clientConfig = createVideoBuildClientConfig(c.env);
    
    if (!clientConfig) {
      // AWS credentials not configured
      await c.env.DB.prepare(`
        UPDATE video_builds 
        SET status = 'failed', error_code = 'AWS_NOT_CONFIGURED', error_message = 'AWS credentials or Orchestrator URL not configured'
        WHERE id = ?
      `).bind(videoBuildId).run();
      
      return c.json({
        error: {
          code: 'AWS_NOT_CONFIGURED',
          message: 'Video Build サービスが設定されていません（AWS認証情報が不足）'
        }
      }, 500);
    }
    
    // Call AWS Orchestrator (SigV4 署名付き)
    const awsResponse = await startVideoBuild(clientConfig, {
      video_build_id: videoBuildId,
      project_id: projectId,
      owner_user_id: ownerUserId,
      executor_user_id: userId,
      is_delegation: ownerUserId !== userId,
      project_json: projectJson,
      build_settings: buildSettings,
    });
    
    if (!awsResponse.success) {
      // AWS call failed
      await c.env.DB.prepare(`
        UPDATE video_builds 
        SET status = 'failed', 
            error_code = ?, 
            error_message = ?,
            error_details_json = ?
        WHERE id = ?
      `).bind(
        awsResponse.error?.code || 'AWS_START_FAILED',
        awsResponse.error?.message || awsResponse.message || 'Failed to start video build',
        JSON.stringify(awsResponse.error || {}),
        videoBuildId
      ).run();
      
      return c.json({
        error: {
          code: awsResponse.error?.code || 'AWS_START_FAILED',
          message: awsResponse.error?.message || 'Video Build の開始に失敗しました',
        }
      }, 500);
    }
    
    // 10. Update with AWS response
    const s3Bucket = awsResponse.output?.bucket || DEFAULT_OUTPUT_BUCKET;
    const s3OutputKey = awsResponse.output?.key || getDefaultOutputKey(ownerUserId, videoBuildId);
    
    await c.env.DB.prepare(`
      UPDATE video_builds 
      SET status = 'submitted',
          aws_job_id = ?,
          remotion_render_id = ?,
          remotion_site_name = ?,
          s3_bucket = ?,
          s3_output_key = ?,
          progress_stage = 'Submitted',
          progress_message = 'AWS に送信しました',
          render_started_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      awsResponse.aws_job_id || null,
      awsResponse.remotion?.render_id || null,
      awsResponse.remotion?.site_name || null,
      s3Bucket,
      s3OutputKey,
      videoBuildId
    ).run();
    
    // api_usage_logs 記録
    await c.env.DB.prepare(`
      INSERT INTO api_usage_logs (
        user_id, project_id, api_type, provider, model, estimated_cost_usd, metadata_json
      ) VALUES (?, ?, 'video_build', 'remotion-lambda', 'remotion', 0.0001, ?)
    `).bind(
      userId,
      projectId,
      JSON.stringify({
        billing_source: 'platform',
        video_build_id: videoBuildId,
        owner_user_id: ownerUserId,
        executor_user_id: userId,
        is_delegation: ownerUserId !== userId,
        status: 'submitted',
      })
    ).run();
    
    // Fetch final build record
    const build = await c.env.DB.prepare(`
      SELECT * FROM video_builds WHERE id = ?
    `).bind(videoBuildId).first();
    
    return c.json({
      success: true,
      build,
      preflight: {
        ready_count: validation.ready_count,
        total_count: validation.total_count,
        warnings: validation.warnings,
      }
    }, 201);
    
  } catch (error) {
    console.error('[VideoBuild] Create error:', error);
    return c.json({ 
      error: { 
        code: 'INTERNAL_ERROR', 
        message: error instanceof Error ? error.message : 'Failed to create build' 
      } 
    }, 500);
  }
});

/**
 * POST /api/video-builds/:buildId/refresh
 * Refresh video build status from AWS
 * 
 * フロー:
 * 1. 認証確認
 * 2. ビルドレコード取得
 * 3. AWS Orchestrator に status 問い合わせ（aws_job_id または remotion_render_id を使用）
 * 4. ステータス更新（completed の場合は download_url も更新）
 */
videoGeneration.post('/video-builds/:buildId/refresh', async (c) => {
  const { getCookie } = await import('hono/cookie');
  const { getVideoBuildStatus, createVideoBuildClientConfig } = await import('../utils/aws-video-build-client');
  
  try {
    const buildId = parseInt(c.req.param('buildId'), 10);
    
    // 1. 認証確認
    const sessionId = getCookie(c, 'session');
    if (!sessionId) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }
    
    // 2. ビルドレコード取得
    const build = await c.env.DB.prepare(`
      SELECT * FROM video_builds WHERE id = ?
    `).bind(buildId).first<{
      id: number;
      status: string;
      aws_job_id: string | null;
      remotion_render_id: string | null;
      s3_output_key: string | null;
      project_id: number;
    }>();
    
    if (!build) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Build not found' } }, 404);
    }
    
    // 完了済み/失敗済みのビルドはAWS問い合わせ不要（presigned URL再取得のみ）
    const skipAwsStatuses = ['completed', 'failed', 'cancelled'];
    const shouldQueryAws = !skipAwsStatuses.includes(build.status);
    
    // 3. AWS Orchestrator に status 問い合わせ
    const clientConfig = createVideoBuildClientConfig(c.env);
    
    if (!clientConfig) {
      return c.json({
        build,
        warning: 'AWS credentials or Orchestrator URL not configured'
      });
    }
    
    if (!build.aws_job_id && !build.remotion_render_id) {
      return c.json({
        build,
        warning: 'No AWS job ID or Remotion render ID available'
      });
    }
    
    const awsResponse = await getVideoBuildStatus(
      clientConfig,
      build.aws_job_id || buildId,
      {
        render_id: build.remotion_render_id || undefined,
        output_key: build.s3_output_key || undefined,
      }
    );
    
    if (!awsResponse.success) {
      console.warn('[VideoBuild] AWS status check failed:', awsResponse.error);
      return c.json({
        build,
        warning: awsResponse.error?.message || 'Failed to get status from AWS'
      });
    }
    
    // 4. ステータス更新
    const awsStatus = awsResponse.status;
    const progressPercent = awsResponse.progress?.percent ?? 0;
    const progressStage = awsResponse.progress?.stage || '';
    const progressMessage = awsResponse.progress?.message || '';
    
    // ステータスマッピング（AWS → D1）
    const statusMap: Record<string, string> = {
      'queued': 'queued',
      'rendering': 'rendering',
      'completed': 'completed',
      'failed': 'failed',
    };
    const newStatus = statusMap[awsStatus || ''] || build.status;
    
    if (awsStatus === 'completed' && awsResponse.output?.presigned_url) {
      // 完了: download_url を更新
      await c.env.DB.prepare(`
        UPDATE video_builds 
        SET status = 'completed',
            progress_percent = 100,
            progress_stage = 'Completed',
            progress_message = '動画生成完了',
            download_url = ?,
            s3_output_size_bytes = ?,
            total_duration_ms = ?,
            render_completed_at = CURRENT_TIMESTAMP,
            render_duration_sec = CAST((julianday(CURRENT_TIMESTAMP) - julianday(render_started_at)) * 86400 AS INTEGER),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        awsResponse.output.presigned_url,
        awsResponse.output.size_bytes || null,
        awsResponse.output.duration_ms || null,
        buildId
      ).run();
      
    } else if (awsStatus === 'failed') {
      // 失敗: エラー情報を更新
      await c.env.DB.prepare(`
        UPDATE video_builds 
        SET status = 'failed',
            progress_stage = 'Failed',
            progress_message = ?,
            error_code = ?,
            error_message = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        awsResponse.error?.message || 'Build failed',
        awsResponse.error?.code || 'RENDER_FAILED',
        awsResponse.error?.message || 'Video rendering failed',
        buildId
      ).run();
      
    } else if (shouldQueryAws) {
      // 進行中: プログレス更新
      await c.env.DB.prepare(`
        UPDATE video_builds 
        SET status = ?,
            progress_percent = ?,
            progress_stage = ?,
            progress_message = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        newStatus,
        progressPercent,
        progressStage,
        progressMessage,
        buildId
      ).run();
    }
    
    // 更新後のビルドを取得
    const updatedBuild = await c.env.DB.prepare(`
      SELECT * FROM video_builds WHERE id = ?
    `).bind(buildId).first();
    
    return c.json({
      success: true,
      build: updatedBuild,
      aws_response: {
        status: awsStatus,
        progress: awsResponse.progress,
        has_download_url: !!awsResponse.output?.presigned_url,
      }
    });
    
  } catch (error) {
    console.error('[VideoBuild] Refresh error:', error);
    return c.json({ 
      error: { 
        code: 'INTERNAL_ERROR', 
        message: error instanceof Error ? error.message : 'Failed to refresh build' 
      } 
    }, 500);
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
