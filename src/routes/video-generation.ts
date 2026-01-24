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
import { logVideoBuildRender } from '../utils/usage-logger';

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
// Helper: Cost estimation for video generation
// ====================================================================
// 
// Video API pricing (as of 2024):
// - Google Veo 2: ~$0.35/sec (generate mode), ~$0.10/sec (extend mode)
// - Veo 2 minimum is typically 5 seconds ($1.75)
// - Imagen 3 Video: Similar pricing
// 
// Remotion Lambda pricing:
// - AWS Lambda: ~$0.0001 per GB-second
// - Typical 30-sec video render: ~$0.002-0.005

function estimateVideoCost(model: string, durationSec: number): number {
  // Veo 2 pricing: approximately $0.35 per second
  // This is an estimate - actual pricing may vary
  const veoRatePerSecond = 0.35;
  
  switch (model?.toLowerCase()) {
    case 'veo-2':
    case 'veo2':
    case 'veo-002':
      return durationSec * veoRatePerSecond;
    case 'imagen-3-video':
    case 'imagen3':
      return durationSec * 0.30; // Slightly cheaper estimate
    default:
      // Default to Veo 2 pricing as fallback
      return durationSec * veoRatePerSecond;
  }
}

// Remotion/video build cost estimate
function estimateRemotionBuildCost(totalDurationSec: number, sceneCount: number): number {
  // Remotion Lambda approximate costs:
  // - Base cost per render: ~$0.005
  // - Per second of output: ~$0.001
  // - This is very rough - actual costs depend on Lambda memory/duration
  const baseCost = 0.005;
  const perSecondCost = 0.001;
  return baseCost + (totalDurationSec * perSecondCost);
}

// Image generation cost estimate
function estimateImageCost(provider: string, model: string): number {
  switch (provider?.toLowerCase()) {
    case 'gemini':
      // Gemini Imagen 3: $0.04 per image (1024x1024)
      // Gemini 2.0 Flash experimental: Free during preview
      if (model?.includes('imagen')) {
        return 0.04;
      }
      // Gemini experimental models are currently free
      return 0.0;
    case 'openai':
      // DALL-E 3: $0.04-0.12 per image depending on size
      return 0.04;
    default:
      return 0.0;
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
  // - estimated_cost_usd: Veo 2 pricing (~$0.35/sec for generate mode)
  const estimatedCostUsd = estimateVideoCost(model, durationSec);
  
  await c.env.DB.prepare(`
    INSERT INTO api_usage_logs (
      user_id, project_id, api_type, provider, model, video_engine, 
      estimated_cost_usd, duration_seconds,
      sponsored_by_user_id, metadata_json
    ) VALUES (?, ?, 'video_generation', 'google', ?, ?, ?, ?, ?, ?)
  `).bind(
    executorUserId,
    scene.project_id,
    model,
    videoEngine,
    estimatedCostUsd,
    durationSec,
    billingSource === 'sponsor' ? billingUserId : null,
    JSON.stringify({ 
      scene_id: sceneId, 
      duration_sec: durationSec, 
      job_id: awsResponse.job_id,
      billing_source: billingSource,
      billing_user_id: billingUserId,
      executor_user_id: executorUserId,
      owner_user_id: scene.owner_user_id,
      estimated_cost_usd: estimatedCostUsd
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
    
    // Count active builds AND get details for UI display
    const activeBuildDetails = await c.env.DB.prepare(`
      SELECT 
        vb.id,
        vb.project_id,
        vb.status,
        vb.progress_percent,
        vb.progress_stage,
        vb.progress_message,
        vb.created_at,
        vb.updated_at,
        p.title as project_title
      FROM video_builds vb
      LEFT JOIN projects p ON vb.project_id = p.id
      WHERE vb.executor_user_id = ? 
        AND vb.status IN ('queued', 'validating', 'submitted', 'rendering', 'uploading')
      ORDER BY vb.created_at DESC
      LIMIT 5
    `).bind(userId).all<{
      id: number;
      project_id: number;
      status: string;
      progress_percent: number;
      progress_stage: string;
      progress_message: string;
      created_at: string;
      updated_at: string;
      project_title: string;
    }>();
    
    const activeBuilds = activeBuildDetails.results || [];
    
    // Count monthly builds (for UI display)
    const monthlyBuilds = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM video_builds
      WHERE executor_user_id = ? 
      AND created_at >= datetime('now', 'start of month')
    `).bind(userId).first<{ count: number }>();
    
    return c.json({
      // Legacy format for frontend compatibility
      monthly_builds: monthlyBuilds?.count || 0,
      concurrent_builds: activeBuilds.length,
      // New detailed format
      daily_limit: dailyLimit,
      daily_used: todayBuilds?.count || 0,
      daily_remaining: Math.max(0, dailyLimit - (todayBuilds?.count || 0)),
      concurrent_limit: concurrentLimit,
      concurrent_active: activeBuilds.length,
      can_start: (todayBuilds?.count || 0) < dailyLimit && activeBuilds.length < concurrentLimit,
      // ID57: 処理中のビルド詳細情報を追加
      active_builds: activeBuilds.map(b => ({
        build_id: b.id,
        project_id: b.project_id,
        project_title: b.project_title || `プロジェクト #${b.project_id}`,
        status: b.status,
        progress_percent: b.progress_percent || 0,
        progress_stage: b.progress_stage || 'Unknown',
        progress_message: b.progress_message || '',
        created_at: b.created_at,
        updated_at: b.updated_at
      }))
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
    // R2: display_asset_type, text_render_mode を取得
    const { results: rawScenes } = await c.env.DB.prepare(`
      SELECT id, idx, role, title, dialogue, comic_data, display_asset_type, text_render_mode
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
    
    // R3-A: BGM有無を確認
    const activeBgm = await c.env.DB.prepare(`
      SELECT id FROM project_audio_tracks
      WHERE project_id = ? AND track_type = 'bgm' AND is_active = 1
      LIMIT 1
    `).bind(projectId).first();
    const hasBgm = activeBgm != null;
    
    // Output Preset: プロジェクトの出力プリセットを取得
    const { getOutputPreset } = await import('../utils/output-presets');
    const projectPreset = await c.env.DB.prepare(`
      SELECT output_preset FROM projects WHERE id = ?
    `).bind(projectId).first<{ output_preset: string | null }>();
    const outputPresetId = projectPreset?.output_preset || 'yt_long';
    const outputPreset = getOutputPreset(outputPresetId);
    
    // R3-B: SFX有無を確認（いずれかのシーンにSFXがあるか）
    const sfxCheck = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM scene_audio_cues sac
      JOIN scenes s ON sac.scene_id = s.id
      WHERE s.project_id = ? AND sac.is_active = 1
    `).bind(projectId).first<{ count: number }>();
    const hasSfx = (sfxCheck?.count || 0) > 0;
    
    // バルーン表示ポリシーのサマリーを取得（display_policy SSOT）
    const { results: balloonPolicyRows } = await c.env.DB.prepare(`
      SELECT 
        COALESCE(sb.display_policy, 'voice_window') as policy,
        COUNT(*) as count
      FROM scene_balloons sb
      JOIN scenes s ON sb.scene_id = s.id
      WHERE s.project_id = ?
      GROUP BY COALESCE(sb.display_policy, 'voice_window')
    `).bind(projectId).all<{ policy: string; count: number }>();
    
    const balloonPolicySummary = {
      always_on: 0,
      voice_window: 0,
      manual_window: 0,
    };
    for (const row of balloonPolicyRows) {
      if (row.policy === 'always_on') balloonPolicySummary.always_on = row.count;
      else if (row.policy === 'manual_window') balloonPolicySummary.manual_window = row.count;
      else balloonPolicySummary.voice_window = row.count;
    }
    const totalBalloons = balloonPolicySummary.always_on + balloonPolicySummary.voice_window + balloonPolicySummary.manual_window;
    
    // 全体の判定: 素材OKなら生成可能（utterances は警告のみ）
    // 必須条件: 素材がある
    // 推奨条件: 音声パーツがある、BGMがある
    const canGenerate = assetValidation.is_ready;
    
    // 警告を「必須」と「推奨」に分類
    // 必須エラー（赤・生成停止）: 素材不足
    const requiredErrors = assetValidation.missing.map(m => ({
      type: 'ASSET_MISSING' as const,
      level: 'error' as const,
      scene_id: m.scene_id,
      scene_idx: m.scene_idx,
      message: `シーン${m.scene_idx}：${m.required_asset === 'active_comic.r2_url' ? '漫画画像' : '画像'}がありません`,
    }));
    
    // 推奨警告（黄・生成は止めない）: 音声パーツ関連
    const recommendedWarnings = utteranceValidation.errors.map(e => ({
      ...e,
      level: 'warning' as const,
      // BGMがある場合はメッセージを調整
      message: hasBgm && e.type === 'NO_UTTERANCES'
        ? e.message.replace('（ボイスなしでも生成可）', '（BGMで再生されます）')
        : e.message,
    }));
    
    // 素材の警告も推奨として追加
    const assetWarnings = assetValidation.warnings.map(w => ({
      type: 'ASSET_WARNING' as const,
      level: 'warning' as const,
      scene_id: w.scene_id,
      scene_idx: w.scene_idx,
      message: w.message,
    }));
    
    return c.json({
      // 後方互換: is_ready は素材のみの判定
      is_ready: assetValidation.is_ready,
      ready_count: assetValidation.ready_count,
      total_count: assetValidation.total_count,
      missing: assetValidation.missing,
      warnings: assetValidation.warnings,
      // R1.6: utterances 検証結果（後方互換）
      can_generate: canGenerate,
      utterance_errors: utteranceValidation.errors,
      utterance_summary: utteranceValidation.summary,
      // R3-A/B: 新しい分類（フロントエンドで使いやすい形式）
      validation: {
        can_generate: canGenerate,
        has_bgm: hasBgm,
        has_sfx: hasSfx,
        // 音ありの判定（BGM/SFX/Voice のいずれかがある）
        // Voice判定: 有効なutteranceを持つシーン数 > 無効なシーン数 = 少なくとも1シーンに音声あり
        has_audio: hasBgm || hasSfx || (utteranceValidation.summary.total_scenes > utteranceValidation.summary.invalid_scenes),
        // 必須エラー（赤・生成停止）
        errors: requiredErrors,
        // 推奨警告（黄・生成可能）
        warnings: [...recommendedWarnings, ...assetWarnings],
        // サマリー
        summary: {
          total_scenes: assetValidation.total_count,
          ready_scenes: assetValidation.ready_count,
          error_count: requiredErrors.length,
          warning_count: recommendedWarnings.length + assetWarnings.length,
          has_voice: utteranceValidation.summary.total_scenes > utteranceValidation.summary.invalid_scenes,
        },
      },
      // Output Preset 情報
      output_preset: {
        id: outputPreset.id,
        label: outputPreset.label,
        description: outputPreset.description,
        aspect_ratio: outputPreset.aspect_ratio,
        resolution: outputPreset.resolution,
        balloon_policy_default: outputPreset.balloon_policy_default,
      },
      // バルーン表示ポリシーのサマリー（UI表示用）
      balloon_policy_summary: {
        ...balloonPolicySummary,
        total: totalBalloons,
      },
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error('[VideoBuild] Preflight error:', errorMessage, errorStack);
    return c.json({ 
      is_ready: false,
      can_generate: false,
      error: { 
        code: 'INTERNAL_ERROR', 
        message: 'Failed to run preflight check',
        detail: errorMessage  // エラー詳細を返す
      }
    }, 500);
  }
});

/**
 * GET /api/projects/:projectId/video-builds/preview-json
 * Preview project.json without starting a build (for debugging)
 * 
 * Query params:
 *   - scene_id: Filter to specific scene (optional)
 */
videoGeneration.get('/projects/:projectId/video-builds/preview-json', async (c) => {
  const { buildProjectJson } = await import('../utils/video-build-helpers');
  
  try {
    const projectId = parseInt(c.req.param('projectId'), 10);
    const sceneIdFilter = c.req.query('scene_id') ? parseInt(c.req.query('scene_id')!, 10) : null;
    
    // Get project
    const project = await c.env.DB.prepare(`
      SELECT * FROM projects WHERE id = ?
    `).bind(projectId).first();
    
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
    }
    
    // Get scenes (optionally filtered)
    let scenesQuery = `
      SELECT s.id, s.idx, s.role, s.title, s.dialogue, s.display_asset_type, s.text_render_mode,
             s.duration_override_ms
      FROM scenes s
      WHERE s.project_id = ?
    `;
    const queryParams: any[] = [projectId];
    
    if (sceneIdFilter) {
      scenesQuery += ' AND s.id = ?';
      queryParams.push(sceneIdFilter);
    }
    scenesQuery += ' ORDER BY s.idx ASC';
    
    const { results: rawScenes } = await c.env.DB.prepare(scenesQuery).bind(...queryParams).all();
    
    if (!rawScenes || rawScenes.length === 0) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'No scenes found' } }, 404);
    }
    
    // Build full scene data with assets, utterances, balloons
    const scenes = await Promise.all(rawScenes.map(async (scene: any) => {
      // Active image
      const activeImage = await c.env.DB.prepare(`
        SELECT id, r2_key, r2_url FROM image_generations
        WHERE scene_id = ? AND is_active = 1 AND (asset_type = 'ai' OR asset_type IS NULL)
        LIMIT 1
      `).bind(scene.id).first();
      
      // Active comic
      const activeComic = await c.env.DB.prepare(`
        SELECT id, r2_key, r2_url FROM image_generations
        WHERE scene_id = ? AND is_active = 1 AND asset_type = 'comic'
        LIMIT 1
      `).bind(scene.id).first();
      
      // Utterances
      const { results: utterances } = await c.env.DB.prepare(`
        SELECT su.*, ag.r2_url as audio_r2_url, ag.duration_ms as audio_duration_ms, ag.status as audio_status
        FROM scene_utterances su
        LEFT JOIN audio_generations ag ON su.audio_generation_id = ag.id
        WHERE su.scene_id = ?
        ORDER BY su.order_no ASC
      `).bind(scene.id).all();
      
      // Balloons
      const { results: balloons } = await c.env.DB.prepare(`
        SELECT * FROM scene_balloons WHERE scene_id = ? ORDER BY z_index ASC, id ASC
      `).bind(scene.id).all();
      
      // R3-B: SFX
      const { results: sfxRows } = await c.env.DB.prepare(`
        SELECT id, name, r2_url, duration_ms, volume, start_ms, end_ms, loop, fade_in_ms, fade_out_ms
        FROM scene_audio_cues
        WHERE scene_id = ? AND is_active = 1
        ORDER BY start_ms ASC
      `).bind(scene.id).all();
      
      // Map data for buildProjectJson
      return {
        ...scene,
        active_image: activeImage ? { r2_key: activeImage.r2_key, r2_url: activeImage.r2_url } : null,
        active_comic: activeComic ? { r2_key: activeComic.r2_key, r2_url: activeComic.r2_url } : null,
        utterances: utterances?.map((u: any) => ({
          id: u.id,
          role: u.role,
          character_key: u.character_key,
          text: u.text,
          audio_url: u.audio_r2_url,
          duration_ms: u.audio_duration_ms || u.duration_ms,
        })) || [],
        balloons: balloons?.map((b: any) => ({
          id: b.id,
          utterance_id: b.utterance_id,
          display_mode: b.display_mode,
          position: { x: b.x, y: b.y },
          size: { w: b.w, h: b.h },
          shape: b.shape,
          tail: { enabled: b.tail_enabled === 1, tip_x: b.tail_tip_x, tip_y: b.tail_tip_y },
          style: {
            writing_mode: b.writing_mode,
            text_align: b.text_align,
            font_family: b.font_family,
            font_weight: b.font_weight,
            font_size: b.font_size,
            line_height: b.line_height,
            padding: b.padding,
            bg_color: b.bg_color,
            text_color: b.text_color,
            border_color: b.border_color,
            border_width: b.border_width,
          },
          z_index: b.z_index,
          bubble_r2_url: b.bubble_r2_url,
          bubble_width_px: b.bubble_width_px,
          bubble_height_px: b.bubble_height_px,
        })) || [],
        // R3-B: SFX
        sfx: sfxRows?.map((cue: any) => ({
          id: cue.id,
          name: cue.name || 'SFX',
          r2_url: cue.r2_url,
          duration_ms: cue.duration_ms,
          volume: cue.volume,
          start_ms: cue.start_ms,
          end_ms: cue.end_ms,
          loop: cue.loop === 1,
          fade_in_ms: cue.fade_in_ms,
          fade_out_ms: cue.fade_out_ms,
        })) || [],
      };
    }));
    
    // R3-A: アクティブBGMを取得
    const activeBgm = await c.env.DB.prepare(`
      SELECT id, r2_key, r2_url, duration_ms, volume, loop, 
             fade_in_ms, fade_out_ms, ducking_enabled, ducking_volume,
             ducking_attack_ms, ducking_release_ms
      FROM project_audio_tracks
      WHERE project_id = ? AND track_type = 'bgm' AND is_active = 1
      LIMIT 1
    `).bind(projectId).first<{
      id: number;
      r2_url: string | null;
      volume: number;
      loop: number;
      fade_in_ms: number;
      fade_out_ms: number;
      ducking_enabled: number;
      ducking_volume: number;
      ducking_attack_ms: number;
      ducking_release_ms: number;
    }>();
    
    const DEFAULT_SITE_URL = 'https://webapp-c7n.pages.dev';
    const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;
    
    // Build project.json with BGM settings
    const projectJson = buildProjectJson(
      project as any,
      scenes,
      {
        preset: 'default',
        aspect_ratio: '16:9',
        fps: 30,
        transition_type: 'fade',
        transition_duration_ms: 500,
        // R3-A: BGM設定
        bgm: activeBgm ? {
          enabled: true,
          url: activeBgm.r2_url?.startsWith('/') 
            ? `${siteUrl}${activeBgm.r2_url}` 
            : activeBgm.r2_url || undefined,
          volume: activeBgm.volume,
          loop: activeBgm.loop === 1,
          fade_in_ms: activeBgm.fade_in_ms,
          fade_out_ms: activeBgm.fade_out_ms,
          ducking: activeBgm.ducking_enabled === 1 ? {
            enabled: true,
            volume: activeBgm.ducking_volume,
            attack_ms: activeBgm.ducking_attack_ms,
            release_ms: activeBgm.ducking_release_ms,
          } : undefined,
        } : undefined,
      }
    );
    
    return c.json(projectJson);
    
  } catch (error) {
    console.error('[Video Build Preview JSON] Error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate preview JSON' } }, 500);
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
    
    // Get project info (including output_preset)
    const project = await c.env.DB.prepare(`
      SELECT id, user_id, title, output_preset FROM projects WHERE id = ?
    `).bind(projectId).first<{ id: number; user_id: number; title: string; output_preset: string | null }>();
    
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
        
        // R1.5: scene_utterances から音声パーツを取得（SSOT）
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
        
        // R2-A/A案 baked: scene_balloons を取得（utterance と同期で表示）
        // A案 baked: bubble_r2_url/key/size を含めて取得
        const { results: balloonRows } = await c.env.DB.prepare(`
          SELECT 
            id, utterance_id, x, y, w, h,
            shape, display_mode, start_ms, end_ms,
            tail_enabled, tail_tip_x, tail_tip_y,
            writing_mode, text_align,
            font_family, font_weight, font_size, line_height,
            padding, bg_color, text_color, border_color, border_width,
            z_index,
            bubble_r2_key, bubble_r2_url, bubble_width_px, bubble_height_px
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
          // A案 baked
          bubble_r2_key: string | null;
          bubble_r2_url: string | null;
          bubble_width_px: number | null;
          bubble_height_px: number | null;
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
          // A案 baked: バブル画像（絶対URLに変換）
          bubble_r2_key: b.bubble_r2_key,
          bubble_r2_url: b.bubble_r2_url ? toAbsoluteUrl(b.bubble_r2_url, siteUrl) : null,
          bubble_width_px: b.bubble_width_px,
          bubble_height_px: b.bubble_height_px,
        }));
        
        // R3-B: scene_audio_cues を取得（SFX/効果音）
        const { results: sfxRows } = await c.env.DB.prepare(`
          SELECT 
            id, name, r2_key, r2_url, duration_ms,
            volume, start_ms, end_ms, loop, fade_in_ms, fade_out_ms
          FROM scene_audio_cues
          WHERE scene_id = ? AND is_active = 1
          ORDER BY start_ms ASC
        `).bind(scene.id).all<{
          id: number;
          name: string | null;
          r2_key: string | null;
          r2_url: string | null;
          duration_ms: number | null;
          volume: number;
          start_ms: number;
          end_ms: number | null;
          loop: number;
          fade_in_ms: number;
          fade_out_ms: number;
        }>();
        
        const sfx = sfxRows.map(cue => ({
          id: cue.id,
          name: cue.name || 'SFX',
          r2_url: cue.r2_url ? toAbsoluteUrl(cue.r2_url, siteUrl) : null,
          duration_ms: cue.duration_ms,
          volume: cue.volume,
          start_ms: cue.start_ms,
          end_ms: cue.end_ms,
          loop: cue.loop,
          fade_in_ms: cue.fade_in_ms,
          fade_out_ms: cue.fade_out_ms,
        })).filter(cue => cue.r2_url); // URL がないものは除外
        
        // R2-C: scene_motion を取得（モーションプリセット）
        const motionRow = await c.env.DB.prepare(`
          SELECT sm.motion_preset_id, mp.motion_type, mp.params
          FROM scene_motion sm
          JOIN motion_presets mp ON sm.motion_preset_id = mp.id
          WHERE sm.scene_id = ?
        `).bind(scene.id).first<{
          motion_preset_id: string;
          motion_type: string;
          params: string;
        }>();
        
        let motionData = null;
        if (motionRow) {
          try {
            const params = JSON.parse(motionRow.params || '{}');
            motionData = {
              preset_id: motionRow.motion_preset_id,
              motion_type: motionRow.motion_type as 'none' | 'zoom' | 'pan' | 'combined',
              params: params,
            };
          } catch (e) {
            console.warn(`Failed to parse motion params for scene ${scene.id}:`, e);
          }
        }
        
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
          // R3-B: sfx（効果音）
          sfx: sfx.length > 0 ? sfx : null,
          // R2-C: motion（モーションプリセット）
          motion: motionData,
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
    
    // 5. R3-A: プロジェクトオーディオトラック（通しBGM）を取得
    const activeBgm = await c.env.DB.prepare(`
      SELECT id, r2_key, r2_url, duration_ms, volume, loop, 
             fade_in_ms, fade_out_ms, ducking_enabled, ducking_volume,
             ducking_attack_ms, ducking_release_ms
      FROM project_audio_tracks
      WHERE project_id = ? AND track_type = 'bgm' AND is_active = 1
      LIMIT 1
    `).bind(projectId).first<{
      id: number;
      r2_key: string | null;
      r2_url: string | null;
      duration_ms: number | null;
      volume: number;
      loop: number;
      fade_in_ms: number;
      fade_out_ms: number;
      ducking_enabled: number;
      ducking_volume: number;
      ducking_attack_ms: number;
      ducking_release_ms: number;
    }>();
    
    // 5. Settings構築（Output preset 情報を含む）
    // Output preset から設定を取得
    const { getOutputPreset } = await import('../utils/output-presets');
    const outputPresetConfig = getOutputPreset(project.output_preset);
    
    const buildSettings = {
      // Output preset 情報（SSOT記録）
      output_preset: outputPresetConfig.id,
      output_preset_config: {
        label: outputPresetConfig.label,
        aspect_ratio: outputPresetConfig.aspect_ratio,
        resolution: outputPresetConfig.resolution,
        fps: outputPresetConfig.fps,
        text_scale: outputPresetConfig.text_scale,
        safe_zones: outputPresetConfig.safe_zones,
        motion_default: outputPresetConfig.motion_default,
        telop_style: outputPresetConfig.telop_style,
      },
      captions: {
        enabled: body.captions?.enabled ?? body.include_captions ?? true,
        position: body.captions?.position || 'bottom',
        show_speaker: body.captions?.show_speaker ?? true,
      },
      bgm: {
        // R3-A: project_audio_tracks のアクティブBGMを優先使用
        enabled: activeBgm ? true : (body.bgm?.enabled ?? body.include_bgm ?? false),
        url: activeBgm?.r2_url ? toAbsoluteUrl(activeBgm.r2_url, siteUrl) : body.bgm?.url,
        track: body.bgm?.track,
        volume: activeBgm?.volume ?? body.bgm?.volume ?? outputPresetConfig.bgm_volume_default,
        loop: activeBgm ? activeBgm.loop === 1 : (body.bgm?.loop ?? true),
        fade_in_ms: activeBgm?.fade_in_ms ?? body.bgm?.fade_in_ms ?? 800,
        fade_out_ms: activeBgm?.fade_out_ms ?? body.bgm?.fade_out_ms ?? 800,
        // R3-B: ダッキング設定（preset から ducking_enabled を反映）
        ducking: {
          enabled: activeBgm ? activeBgm.ducking_enabled === 1 : (body.bgm?.ducking?.enabled ?? outputPresetConfig.ducking_enabled),
          volume: activeBgm?.ducking_volume ?? body.bgm?.ducking?.volume ?? 0.12,
          attack_ms: activeBgm?.ducking_attack_ms ?? body.bgm?.ducking?.attack_ms ?? 120,
          release_ms: activeBgm?.ducking_release_ms ?? body.bgm?.ducking?.release_ms ?? 220,
        },
      },
      motion: {
        preset: body.motion?.preset ?? outputPresetConfig.motion_default ?? 'none',
        transition: body.motion?.transition || 'crossfade',
      },
    };
    
    // 6. project.json生成
    // Output preset から aspect_ratio / resolution / fps を取得（body で上書き可能）
    const projectJson = buildProjectJson(
      { id: project.id, title: project.title, user_id: ownerUserId },
      scenesWithAssets,
      buildSettings,
      {
        aspectRatio: body.aspect_ratio || outputPresetConfig.aspect_ratio,
        resolution: body.resolution || outputPresetConfig.resolution,
        fps: body.fps || outputPresetConfig.fps,
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
    // Calculate estimated cost based on total duration and scene count
    const totalDurationSec = projectJson.summary?.total_duration_ms 
      ? projectJson.summary.total_duration_ms / 1000 
      : scenes.length * 5; // Fallback: 5 sec per scene
    const remotionEstimatedCost = estimateRemotionBuildCost(totalDurationSec, scenes.length);
    
    await c.env.DB.prepare(`
      INSERT INTO api_usage_logs (
        user_id, project_id, api_type, provider, model, 
        estimated_cost_usd, duration_seconds, metadata_json
      ) VALUES (?, ?, 'video_build', 'remotion-lambda', 'remotion', ?, ?, ?)
    `).bind(
      userId,
      projectId,
      remotionEstimatedCost,
      totalDurationSec,
      JSON.stringify({
        billing_source: 'platform',
        video_build_id: videoBuildId,
        owner_user_id: ownerUserId,
        executor_user_id: userId,
        is_delegation: ownerUserId !== userId,
        status: 'submitted',
        scene_count: scenes.length,
        total_duration_sec: totalDurationSec,
        estimated_cost_usd: remotionEstimatedCost
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
      
      // === Safe Chat v1: video_build_render ログ記録（完了時のみ、1回だけ） ===
      try {
        // 現在のビルド情報を取得（render_usage_logged フラグと settings_json）
        const buildForLog = await c.env.DB.prepare(`
          SELECT vb.id, vb.project_id, vb.owner_user_id, vb.render_usage_logged, 
                 vb.settings_json, vb.total_scenes, vb.total_duration_ms, 
                 vb.remotion_render_id, vb.project_json_hash,
                 p.user_id as project_owner_id
          FROM video_builds vb
          LEFT JOIN projects p ON vb.project_id = p.id
          WHERE vb.id = ?
        `).bind(buildId).first<{
          id: number;
          project_id: number;
          owner_user_id: number | null;
          render_usage_logged: number;
          settings_json: string | null;
          total_scenes: number | null;
          total_duration_ms: number | null;
          remotion_render_id: string | null;
          project_json_hash: string | null;
          project_owner_id: number | null;
        }>();
        
        // まだログ未記録の場合のみ処理（二重計上防止）
        if (buildForLog && buildForLog.render_usage_logged === 0) {
          // userId を確実に決定（owner_user_id → project.user_id の順でフォールバック）
          const resolvedUserId = buildForLog.owner_user_id || buildForLog.project_owner_id;
          
          if (!resolvedUserId) {
            // user_id が決定できない場合はログせずにエラー記録
            console.error(`[VideoBuild] Cannot determine user_id for build=${buildId}, skipping usage log`);
            // フラグは立てない（後で回収可能にする）
          } else {
            // 先にフラグを立てる（二重計上の完全防止）
            const lockResult = await c.env.DB.prepare(`
              UPDATE video_builds 
              SET render_usage_logged = 1 
              WHERE id = ? AND render_usage_logged = 0
            `).bind(buildId).run();
            
            // 自分が初回フラグを取れた場合のみログを書く
            if (lockResult.meta.changes === 1) {
              // settings_json から fps/resolution/aspect_ratio を取得
              let fps = 30;
              let aspectRatio = '9:16';
              let resolution = '1080p';
              try {
                if (buildForLog.settings_json) {
                  const settings = JSON.parse(buildForLog.settings_json);
                  fps = settings.fps ?? 30;
                  aspectRatio = settings.aspect_ratio ?? '9:16';
                  resolution = settings.resolution ?? '1080p';
                }
              } catch { /* ignore parse error */ }
              
              const durationMs = awsResponse.output.duration_ms || buildForLog.total_duration_ms || 0;
              const totalScenes = buildForLog.total_scenes || 0;
              
              await logVideoBuildRender(c.env.DB, {
                userId: resolvedUserId,
                projectId: buildForLog.project_id,
                videoBuildId: buildId,
                totalScenes,
                totalDurationMs: durationMs,
                fps,
                renderTimeMs: null, // 後で計算可能
                status: 'success',
              });
              
              console.log(`[VideoBuild] Render usage logged: build=${buildId}, user=${resolvedUserId}, duration=${durationMs}ms, scenes=${totalScenes}`);
            }
          }
        }
      } catch (logError) {
        // ログ記録の失敗はビルド完了自体には影響させない
        console.error('[VideoBuild] Failed to log render usage:', logError);
      }
      
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
      
      // === Safe Chat v1: video_build_render 失敗ログ記録（失敗時も1回だけ） ===
      try {
        const buildForLog = await c.env.DB.prepare(`
          SELECT vb.id, vb.project_id, vb.owner_user_id, vb.render_usage_logged, 
                 vb.total_scenes, vb.total_duration_ms,
                 p.user_id as project_owner_id
          FROM video_builds vb
          LEFT JOIN projects p ON vb.project_id = p.id
          WHERE vb.id = ?
        `).bind(buildId).first<{
          id: number;
          project_id: number;
          owner_user_id: number | null;
          render_usage_logged: number;
          total_scenes: number | null;
          total_duration_ms: number | null;
          project_owner_id: number | null;
        }>();
        
        if (buildForLog && buildForLog.render_usage_logged === 0) {
          // userId を確実に決定
          const resolvedUserId = buildForLog.owner_user_id || buildForLog.project_owner_id;
          
          if (!resolvedUserId) {
            console.error(`[VideoBuild] Cannot determine user_id for failed build=${buildId}, skipping usage log`);
          } else {
            const lockResult = await c.env.DB.prepare(`
              UPDATE video_builds 
              SET render_usage_logged = 1 
              WHERE id = ? AND render_usage_logged = 0
            `).bind(buildId).run();
            
            if (lockResult.meta.changes === 1) {
              await logVideoBuildRender(c.env.DB, {
                userId: resolvedUserId,
                projectId: buildForLog.project_id,
                videoBuildId: buildId,
                totalScenes: buildForLog.total_scenes || 0,
                totalDurationMs: buildForLog.total_duration_ms || 0,
                status: 'failed',
                errorCode: awsResponse.error?.code || 'RENDER_FAILED',
                errorMessage: awsResponse.error?.message || 'Video rendering failed',
              });
              
              console.log(`[VideoBuild] Render failure logged: build=${buildId}, user=${resolvedUserId}`);
            }
          }
        }
      } catch (logError) {
        console.error('[VideoBuild] Failed to log render failure:', logError);
      }
      
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

// ====================================================================
// R2-A: Render Kit API
// シーンの描画に必要な全データを一括取得
// ====================================================================

videoGeneration.get('/:sceneId/render-kit', async (c) => {
  const sceneId = parseInt(c.req.param('sceneId'), 10);
  if (isNaN(sceneId)) {
    return c.json({ error: { code: 'INVALID_SCENE_ID', message: 'Invalid scene ID' } }, 400);
  }

  // Auth check
  const { getCookie } = await import('hono/cookie');
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);
  }

  const session = await c.env.DB.prepare(`
    SELECT u.id as user_id FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sessionId).first<{ user_id: number }>();

  if (!session) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401);
  }

  // Get scene basic info with R2 fields
  const scene = await c.env.DB.prepare(`
    SELECT s.id, s.idx, s.role, s.title, s.dialogue, s.display_asset_type,
           s.text_render_mode, s.motion_preset, s.motion_params_json,
           p.id as project_id, p.user_id as project_user_id
    FROM scenes s
    JOIN projects p ON s.project_id = p.id
    WHERE s.id = ?
  `).bind(sceneId).first<{
    id: number;
    idx: number;
    role: string;
    title: string;
    dialogue: string;
    display_asset_type: string;
    text_render_mode: string;
    motion_preset: string;
    motion_params_json: string | null;
    project_id: number;
    project_user_id: number;
  }>();

  if (!scene) {
    return c.json({ error: { code: 'SCENE_NOT_FOUND', message: 'Scene not found' } }, 404);
  }

  // Permission check
  if (scene.project_user_id !== session.user_id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  const siteUrl = c.env.SITE_URL || DEFAULT_SITE_URL;

  // Get utterances with timing calculation
  const { results: rawUtterances } = await c.env.DB.prepare(`
    SELECT 
      su.id, su.order_no, su.role, su.character_key, su.text,
      su.audio_generation_id,
      ag.r2_url as audio_url,
      ag.duration_ms,
      pcm.display_name as character_name
    FROM scene_utterances su
    LEFT JOIN audio_generations ag ON su.audio_generation_id = ag.id AND ag.status = 'completed'
    LEFT JOIN project_character_models pcm ON su.character_key = pcm.character_key AND pcm.project_id = ?
    WHERE su.scene_id = ?
    ORDER BY su.order_no ASC
  `).bind(scene.project_id, sceneId).all<{
    id: number;
    order_no: number;
    role: string;
    character_key: string | null;
    text: string;
    audio_generation_id: number | null;
    audio_url: string | null;
    duration_ms: number | null;
    character_name: string | null;
  }>();

  // Calculate start_ms / end_ms for each utterance
  let currentMs = 0;
  const utterances = (rawUtterances || []).map((u) => {
    const duration = u.duration_ms || Math.max(2000, (u.text?.length || 0) * 300);
    const start_ms = currentMs;
    const end_ms = currentMs + duration;
    currentMs = end_ms;

    return {
      id: u.id,
      order_no: u.order_no,
      role: u.role,
      character_key: u.character_key,
      character_name: u.character_name,
      text: u.text,
      audio_generation_id: u.audio_generation_id,
      audio_url: toAbsoluteUrl(u.audio_url, siteUrl),
      duration_ms: duration,
      start_ms,
      end_ms,
    };
  });

  // Get balloons
  const { results: rawBalloons } = await c.env.DB.prepare(`
    SELECT 
      id, utterance_id, display_mode,
      x, y, w, h, shape,
      tail_enabled, tail_tip_x, tail_tip_y,
      writing_mode, text_align, font_family, font_weight,
      font_size, line_height, padding,
      bg_color, text_color, border_color, border_width,
      start_ms, end_ms, z_index
    FROM scene_balloons
    WHERE scene_id = ?
    ORDER BY z_index ASC
  `).bind(sceneId).all<{
    id: number;
    utterance_id: number | null;
    display_mode: string;
    x: number;
    y: number;
    w: number;
    h: number;
    shape: string;
    tail_enabled: number;
    tail_tip_x: number;
    tail_tip_y: number;
    writing_mode: string;
    text_align: string;
    font_family: string;
    font_weight: number;
    font_size: number;
    line_height: number;
    padding: number;
    bg_color: string;
    text_color: string;
    border_color: string;
    border_width: number;
    start_ms: number | null;
    end_ms: number | null;
    z_index: number;
  }>();

  const balloons = (rawBalloons || []).map((b) => ({
    id: b.id,
    utterance_id: b.utterance_id,
    display_mode: b.display_mode,
    position: { x: b.x, y: b.y },
    size: { w: b.w, h: b.h },
    shape: b.shape,
    tail: {
      enabled: b.tail_enabled === 1,
      tip_x: b.tail_tip_x,
      tip_y: b.tail_tip_y,
    },
    style: {
      writing_mode: b.writing_mode,
      text_align: b.text_align,
      font_family: b.font_family,
      font_weight: b.font_weight,
      font_size: b.font_size,
      line_height: b.line_height,
      padding: b.padding,
      bg_color: b.bg_color,
      text_color: b.text_color,
      border_color: b.border_color,
      border_width: b.border_width,
    },
    timing: b.display_mode === 'manual_window' ? { start_ms: b.start_ms, end_ms: b.end_ms } : null,
    z_index: b.z_index,
  }));

  // Get telops (R2-B)
  const { results: telops } = await c.env.DB.prepare(`
    SELECT * FROM scene_telops WHERE scene_id = ? ORDER BY order_no ASC
  `).bind(sceneId).all();

  // Get motion (R2-C)
  const motion = await c.env.DB.prepare(`
    SELECT * FROM scene_motion WHERE scene_id = ?
  `).bind(sceneId).first();

  // Orphan check
  const utteranceIds = new Set(utterances.map((u) => u.id));
  const balloonUtteranceIds = new Set(balloons.filter((b) => b.utterance_id).map((b) => b.utterance_id));

  const balloonsWithoutUtterance = balloons
    .filter((b) => b.utterance_id && !utteranceIds.has(b.utterance_id))
    .map((b) => b.id);

  const utterancesWithoutBalloon = utterances
    .filter((u) => !balloonUtteranceIds.has(u.id))
    .map((u) => u.id);

  return c.json({
    scene: {
      id: scene.id,
      idx: scene.idx,
      role: scene.role,
      title: scene.title,
      dialogue: scene.dialogue,
      display_asset_type: scene.display_asset_type,
      text_render_mode: scene.text_render_mode || 'remotion',
      motion_preset: scene.motion_preset || 'kenburns',
    },
    utterances,
    balloons,
    telops: telops || [],
    motion: motion || null,
    orphaned: {
      balloons_without_utterance: balloonsWithoutUtterance,
      utterances_without_balloon: utterancesWithoutBalloon,
    },
  });
});

// ====================================================================
// PATCH /api/scenes/:sceneId/render-settings
// text_render_mode と motion_preset を更新
// ====================================================================

videoGeneration.patch('/:sceneId/render-settings', async (c) => {
  const sceneId = parseInt(c.req.param('sceneId'), 10);
  if (isNaN(sceneId)) {
    return c.json({ error: { code: 'INVALID_SCENE_ID', message: 'Invalid scene ID' } }, 400);
  }

  // Auth check
  const { getCookie } = await import('hono/cookie');
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);
  }

  const session = await c.env.DB.prepare(`
    SELECT u.id as user_id FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sessionId).first<{ user_id: number }>();

  if (!session) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401);
  }

  // Permission check
  const scene = await c.env.DB.prepare(`
    SELECT p.user_id FROM scenes s
    JOIN projects p ON s.project_id = p.id
    WHERE s.id = ?
  `).bind(sceneId).first<{ user_id: number }>();

  if (!scene) {
    return c.json({ error: { code: 'SCENE_NOT_FOUND', message: 'Scene not found' } }, 404);
  }

  if (scene.user_id !== session.user_id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  const body = await c.req.json<{
    text_render_mode?: 'remotion' | 'baked' | 'none';
    motion_preset?: 'none' | 'kenburns' | 'pan' | 'parallax';
  }>();

  const updates: string[] = [];
  const values: any[] = [];

  if (body.text_render_mode) {
    if (!['remotion', 'baked', 'none'].includes(body.text_render_mode)) {
      return c.json({ error: { code: 'INVALID_TEXT_RENDER_MODE', message: 'Invalid text_render_mode' } }, 400);
    }
    updates.push('text_render_mode = ?');
    values.push(body.text_render_mode);
  }

  if (body.motion_preset) {
    if (!['none', 'kenburns', 'pan', 'parallax'].includes(body.motion_preset)) {
      return c.json({ error: { code: 'INVALID_MOTION_PRESET', message: 'Invalid motion_preset' } }, 400);
    }
    updates.push('motion_preset = ?');
    values.push(body.motion_preset);
  }

  if (updates.length === 0) {
    return c.json({ error: { code: 'NO_UPDATES', message: 'No valid fields to update' } }, 400);
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(sceneId);

  await c.env.DB.prepare(`
    UPDATE scenes SET ${updates.join(', ')} WHERE id = ?
  `).bind(...values).run();

  return c.json({ success: true });
});

// ====================================================================
// R2-A: Balloons CRUD API
// ====================================================================

// POST /api/scenes/:sceneId/balloons - 吹き出し作成
videoGeneration.post('/:sceneId/balloons', async (c) => {
  const sceneId = parseInt(c.req.param('sceneId'), 10);
  if (isNaN(sceneId)) {
    return c.json({ error: { code: 'INVALID_SCENE_ID', message: 'Invalid scene ID' } }, 400);
  }

  // Auth check
  const { getCookie } = await import('hono/cookie');
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);
  }

  const session = await c.env.DB.prepare(`
    SELECT u.id as user_id FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sessionId).first<{ user_id: number }>();

  if (!session) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401);
  }

  // Permission check
  const scene = await c.env.DB.prepare(`
    SELECT p.user_id FROM scenes s
    JOIN projects p ON s.project_id = p.id
    WHERE s.id = ?
  `).bind(sceneId).first<{ user_id: number }>();

  if (!scene) {
    return c.json({ error: { code: 'SCENE_NOT_FOUND', message: 'Scene not found' } }, 404);
  }

  if (scene.user_id !== session.user_id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  const body = await c.req.json<{
    utterance_id?: number | null;
    display_mode?: 'voice_window' | 'manual_window';
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    shape?: string;
    tail_enabled?: boolean;
    tail_tip_x?: number;
    tail_tip_y?: number;
    style?: {
      writing_mode?: string;
      text_align?: string;
      font_family?: string;
      font_weight?: number;
      font_size?: number;
      line_height?: number;
      padding?: number;
      bg_color?: string;
      text_color?: string;
      border_color?: string;
      border_width?: number;
    };
    start_ms?: number | null;
    end_ms?: number | null;
    z_index?: number;
  }>();

  // Validation
  const displayMode = body.display_mode || 'voice_window';

  if (displayMode === 'voice_window' && !body.utterance_id) {
    return c.json({ error: { code: 'UTTERANCE_REQUIRED', message: 'utterance_id is required for voice_window mode' } }, 400);
  }

  if (displayMode === 'manual_window' && (body.start_ms == null || body.end_ms == null)) {
    return c.json({ error: { code: 'TIMING_REQUIRED', message: 'start_ms and end_ms are required for manual_window mode' } }, 400);
  }

  // Validate utterance belongs to scene
  if (body.utterance_id) {
    const utterance = await c.env.DB.prepare(`
      SELECT id FROM scene_utterances WHERE id = ? AND scene_id = ?
    `).bind(body.utterance_id, sceneId).first();

    if (!utterance) {
      return c.json({ error: { code: 'INVALID_UTTERANCE', message: 'Utterance not found in this scene' } }, 400);
    }
  }

  // Validate coordinates
  const x = body.x ?? 0.5;
  const y = body.y ?? 0.5;
  const w = body.w ?? 0.3;
  const h = body.h ?? 0.2;

  if (x < 0 || x > 1 || y < 0 || y > 1 || w < 0 || w > 1 || h < 0 || h > 1) {
    return c.json({ error: { code: 'INVALID_COORDINATES', message: 'Coordinates must be between 0 and 1' } }, 400);
  }

  // Validate shape
  const validShapes = ['round', 'square', 'thought', 'shout', 'caption', 'speech_round', 'speech_oval', 'thought_oval', 'mono_box_v', 'telop_bar'];
  const shape = body.shape || 'round';
  if (!validShapes.includes(shape)) {
    return c.json({ error: { code: 'INVALID_SHAPE', message: 'Invalid shape' } }, 400);
  }

  const style = body.style || {};

  const result = await c.env.DB.prepare(`
    INSERT INTO scene_balloons (
      scene_id, utterance_id, display_mode,
      x, y, w, h, shape,
      tail_enabled, tail_tip_x, tail_tip_y,
      writing_mode, text_align, font_family, font_weight,
      font_size, line_height, padding,
      bg_color, text_color, border_color, border_width,
      start_ms, end_ms, z_index
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    sceneId,
    body.utterance_id || null,
    displayMode,
    x, y, w, h,
    shape,
    body.tail_enabled !== false ? 1 : 0,
    body.tail_tip_x ?? 0,
    body.tail_tip_y ?? 0.3,
    style.writing_mode || 'horizontal',
    style.text_align || 'center',
    style.font_family || 'gothic',
    style.font_weight ?? 700,
    style.font_size ?? 24,
    style.line_height ?? 1.4,
    style.padding ?? 12,
    style.bg_color || '#FFFFFF',
    style.text_color || '#000000',
    style.border_color || '#000000',
    style.border_width ?? 2,
    body.start_ms ?? null,
    body.end_ms ?? null,
    body.z_index ?? 10
  ).run();

  return c.json({ success: true, balloon_id: result.meta.last_row_id }, 201);
});

// PUT /api/scenes/:sceneId/balloons/:balloonId - 吹き出し更新
videoGeneration.put('/:sceneId/balloons/:balloonId', async (c) => {
  const sceneId = parseInt(c.req.param('sceneId'), 10);
  const balloonId = parseInt(c.req.param('balloonId'), 10);

  if (isNaN(sceneId) || isNaN(balloonId)) {
    return c.json({ error: { code: 'INVALID_ID', message: 'Invalid scene or balloon ID' } }, 400);
  }

  // Auth check
  const { getCookie } = await import('hono/cookie');
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);
  }

  const session = await c.env.DB.prepare(`
    SELECT u.id as user_id FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sessionId).first<{ user_id: number }>();

  if (!session) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401);
  }

  // Permission & existence check
  const balloon = await c.env.DB.prepare(`
    SELECT b.id, p.user_id FROM scene_balloons b
    JOIN scenes s ON b.scene_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE b.id = ? AND b.scene_id = ?
  `).bind(balloonId, sceneId).first<{ id: number; user_id: number }>();

  if (!balloon) {
    return c.json({ error: { code: 'BALLOON_NOT_FOUND', message: 'Balloon not found' } }, 404);
  }

  if (balloon.user_id !== session.user_id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  const body = await c.req.json<{
    utterance_id?: number | null;
    display_mode?: 'voice_window' | 'manual_window';
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    shape?: string;
    tail_enabled?: boolean;
    tail_tip_x?: number;
    tail_tip_y?: number;
    style?: {
      writing_mode?: string;
      text_align?: string;
      font_family?: string;
      font_weight?: number;
      font_size?: number;
      line_height?: number;
      padding?: number;
      bg_color?: string;
      text_color?: string;
      border_color?: string;
      border_width?: number;
    };
    start_ms?: number | null;
    end_ms?: number | null;
    z_index?: number;
  }>();

  const updates: string[] = [];
  const values: any[] = [];

  // Build update query dynamically
  if (body.utterance_id !== undefined) {
    if (body.utterance_id !== null) {
      const utterance = await c.env.DB.prepare(`
        SELECT id FROM scene_utterances WHERE id = ? AND scene_id = ?
      `).bind(body.utterance_id, sceneId).first();
      if (!utterance) {
        return c.json({ error: { code: 'INVALID_UTTERANCE', message: 'Utterance not found in this scene' } }, 400);
      }
    }
    updates.push('utterance_id = ?');
    values.push(body.utterance_id);
  }

  if (body.display_mode) {
    updates.push('display_mode = ?');
    values.push(body.display_mode);
  }

  if (body.x !== undefined) { updates.push('x = ?'); values.push(body.x); }
  if (body.y !== undefined) { updates.push('y = ?'); values.push(body.y); }
  if (body.w !== undefined) { updates.push('w = ?'); values.push(body.w); }
  if (body.h !== undefined) { updates.push('h = ?'); values.push(body.h); }
  if (body.shape !== undefined) { updates.push('shape = ?'); values.push(body.shape); }
  if (body.tail_enabled !== undefined) { updates.push('tail_enabled = ?'); values.push(body.tail_enabled ? 1 : 0); }
  if (body.tail_tip_x !== undefined) { updates.push('tail_tip_x = ?'); values.push(body.tail_tip_x); }
  if (body.tail_tip_y !== undefined) { updates.push('tail_tip_y = ?'); values.push(body.tail_tip_y); }

  if (body.style) {
    if (body.style.writing_mode) { updates.push('writing_mode = ?'); values.push(body.style.writing_mode); }
    if (body.style.text_align) { updates.push('text_align = ?'); values.push(body.style.text_align); }
    if (body.style.font_family) { updates.push('font_family = ?'); values.push(body.style.font_family); }
    if (body.style.font_weight !== undefined) { updates.push('font_weight = ?'); values.push(body.style.font_weight); }
    if (body.style.font_size !== undefined) { updates.push('font_size = ?'); values.push(body.style.font_size); }
    if (body.style.line_height !== undefined) { updates.push('line_height = ?'); values.push(body.style.line_height); }
    if (body.style.padding !== undefined) { updates.push('padding = ?'); values.push(body.style.padding); }
    if (body.style.bg_color) { updates.push('bg_color = ?'); values.push(body.style.bg_color); }
    if (body.style.text_color) { updates.push('text_color = ?'); values.push(body.style.text_color); }
    if (body.style.border_color) { updates.push('border_color = ?'); values.push(body.style.border_color); }
    if (body.style.border_width !== undefined) { updates.push('border_width = ?'); values.push(body.style.border_width); }
  }

  if (body.start_ms !== undefined) { updates.push('start_ms = ?'); values.push(body.start_ms); }
  if (body.end_ms !== undefined) { updates.push('end_ms = ?'); values.push(body.end_ms); }
  if (body.z_index !== undefined) { updates.push('z_index = ?'); values.push(body.z_index); }

  if (updates.length === 0) {
    return c.json({ error: { code: 'NO_UPDATES', message: 'No valid fields to update' } }, 400);
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(balloonId);

  await c.env.DB.prepare(`
    UPDATE scene_balloons SET ${updates.join(', ')} WHERE id = ?
  `).bind(...values).run();

  return c.json({ success: true });
});

// DELETE /api/scenes/:sceneId/balloons/:balloonId - 吹き出し削除
videoGeneration.delete('/:sceneId/balloons/:balloonId', async (c) => {
  const sceneId = parseInt(c.req.param('sceneId'), 10);
  const balloonId = parseInt(c.req.param('balloonId'), 10);

  if (isNaN(sceneId) || isNaN(balloonId)) {
    return c.json({ error: { code: 'INVALID_ID', message: 'Invalid scene or balloon ID' } }, 400);
  }

  // Auth check
  const { getCookie } = await import('hono/cookie');
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);
  }

  const session = await c.env.DB.prepare(`
    SELECT u.id as user_id FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sessionId).first<{ user_id: number }>();

  if (!session) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401);
  }

  // Permission check
  const balloon = await c.env.DB.prepare(`
    SELECT b.id, p.user_id FROM scene_balloons b
    JOIN scenes s ON b.scene_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE b.id = ? AND b.scene_id = ?
  `).bind(balloonId, sceneId).first<{ id: number; user_id: number }>();

  if (!balloon) {
    return c.json({ error: { code: 'BALLOON_NOT_FOUND', message: 'Balloon not found' } }, 404);
  }

  if (balloon.user_id !== session.user_id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  await c.env.DB.prepare(`
    DELETE FROM scene_balloons WHERE id = ?
  `).bind(balloonId).run();

  return c.json({ success: true });
});

// GET /api/scenes/:sceneId/balloons - 吹き出し一覧取得
videoGeneration.get('/:sceneId/balloons', async (c) => {
  const sceneId = parseInt(c.req.param('sceneId'), 10);
  if (isNaN(sceneId)) {
    return c.json({ error: { code: 'INVALID_SCENE_ID', message: 'Invalid scene ID' } }, 400);
  }

  // Auth check
  const { getCookie } = await import('hono/cookie');
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);
  }

  const session = await c.env.DB.prepare(`
    SELECT u.id as user_id FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sessionId).first<{ user_id: number }>();

  if (!session) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401);
  }

  // Permission check
  const scene = await c.env.DB.prepare(`
    SELECT p.user_id FROM scenes s
    JOIN projects p ON s.project_id = p.id
    WHERE s.id = ?
  `).bind(sceneId).first<{ user_id: number }>();

  if (!scene) {
    return c.json({ error: { code: 'SCENE_NOT_FOUND', message: 'Scene not found' } }, 404);
  }

  if (scene.user_id !== session.user_id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  const { results: balloons } = await c.env.DB.prepare(`
    SELECT 
      b.id, b.utterance_id, b.display_mode,
      b.x, b.y, b.w, b.h, b.shape,
      b.tail_enabled, b.tail_tip_x, b.tail_tip_y,
      b.writing_mode, b.text_align, b.font_family, b.font_weight,
      b.font_size, b.line_height, b.padding,
      b.bg_color, b.text_color, b.border_color, b.border_width,
      b.start_ms, b.end_ms, b.z_index,
      su.text as utterance_text
    FROM scene_balloons b
    LEFT JOIN scene_utterances su ON b.utterance_id = su.id
    WHERE b.scene_id = ?
    ORDER BY b.z_index ASC
  `).bind(sceneId).all();

  return c.json({ balloons: balloons || [] });
});

export default videoGeneration;
