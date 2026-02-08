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
import { createAwsVideoClient, toCloudFrontUrl, s3ToCloudFrontUrl, generateS3PresignedUrl, CLOUDFRONT_VIDEO_DOMAIN, CLOUDFRONT_RENDERS_DOMAIN, type VideoEngine, type BillingSource } from '../utils/aws-video-client';
import { decryptWithKeyRing } from '../utils/crypto';
import { generateSignedImageUrl } from '../utils/signed-url';
import { logApiError, createApiErrorLogger } from '../utils/error-logger';
import { logVideoBuildRender } from '../utils/usage-logger';
// PR-A1/A2: video-build-helpers を静的importに統一（動的importはコスト・追跡性の問題）
import { 
  validateProjectAssets, 
  validateUtterancesPreflight, 
  validateVisualAssets,
  validateVisualAssetsAsync,
  buildProjectJson, 
  hashProjectJson,
  validateProjectJson,
  validateRenderInputs,
  type RenderInputScene,
  type VisualAssetError,
} from '../utils/video-build-helpers';

/**
 * Default SITE_URL for webapp
 * This is used as fallback when SITE_URL is not configured in environment
 */
const DEFAULT_SITE_URL = 'https://app.marumuviai.com';

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

/**
 * Convert presigned S3 URL to public S3 URL
 * 
 * Presigned URLs expire (typically 1 hour from Lambda STS session),
 * so we extract bucket/key and construct a permanent public URL.
 * 
 * Prerequisites: S3 bucket must have public read access for renders/* path
 * (configured via bucket policy)
 * 
 * Input formats:
 * - Presigned: https://bucket.s3.region.amazonaws.com/key?X-Amz-...
 * - Already public: https://bucket.s3.region.amazonaws.com/key
 * 
 * Output: https://bucket.s3.region.amazonaws.com/key (no query params)
 */
/**
 * [DEPRECATED] toPublicS3Url → toCloudFrontUrl に移行済み
 * 
 * video_builds の download_url 用に CloudFront URL を生成
 * S3バケットは非公開のため、CloudFront OAC 経由でアクセス
 */
function toPublicS3Url(
  presignedUrl: string | null | undefined,
  s3Bucket?: string | null,
  s3OutputKey?: string | null
): string | null {
  // キーが直接分かっている場合はCloudFront URLを生成
  if (s3OutputKey) {
    return toCloudFrontUrl(s3OutputKey, s3Bucket || undefined);
  }
  
  // presigned URL からキーを抽出してCloudFront URLに変換
  if (!presignedUrl) return null;
  
  const cfUrl = s3ToCloudFrontUrl(presignedUrl);
  return cfUrl || presignedUrl;
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
// Video API pricing (as of 2025-02):
// - Google Veo 2 (Gemini API): $0.35/sec
// - Google Veo 2 (Vertex AI): $0.50/sec
// - Google Veo 3 (Vertex AI): $0.50/sec (audio off), $0.75/sec (audio on)
// - Veo 3 Fast: $0.25/sec (audio off), $0.40/sec (audio on)
// - Veo minimum duration: 5 seconds
// 
// Remotion Lambda pricing:
// - AWS Lambda: ~$0.0001 per GB-second
// - Typical 30-sec video render: ~$0.002-0.005
// 
// SSOT: コスト追跡は api_usage_logs テーブルに記録

function estimateVideoCost(model: string, durationSec: number, hasAudio: boolean = false): number {
  const modelLower = model?.toLowerCase() || '';
  
  // Veo 3 pricing (Vertex AI) - 2025-02 rates
  if (modelLower.includes('veo-3') || modelLower.includes('veo3')) {
    // Veo 3: $0.50/sec (audio off), $0.75/sec (audio on)
    return durationSec * (hasAudio ? 0.75 : 0.50);
  }
  
  // Veo 2 pricing (Gemini API) - 2025-02 rates
  if (modelLower.includes('veo-2') || modelLower.includes('veo2') || modelLower.includes('veo-002')) {
    // Gemini API rate: $0.35/sec
    return durationSec * 0.35;
  }
  
  // Imagen 3 Video - similar to Veo 2
  if (modelLower.includes('imagen-3-video') || modelLower.includes('imagen3')) {
    return durationSec * 0.30;
  }
  
  // Default: assume Veo 2 pricing for unknown models
  return durationSec * 0.35;
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
  
  // 2.5. Access control check - ユーザーがこのシーンにアクセスできるか検証
  const { getCookie } = await import('hono/cookie');
  const sessionIdForAccess = getCookie(c, 'session');
  let accessUserId: number | null = null;
  let accessUserRole: string | null = null;
  
  if (sessionIdForAccess) {
    const sessionUser = await c.env.DB.prepare(`
      SELECT s.user_id, u.role FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = ? AND s.expires_at > datetime('now')
    `).bind(sessionIdForAccess).first<{ user_id: number; role: string }>();
    
    if (sessionUser) {
      accessUserId = sessionUser.user_id;
      accessUserRole = sessionUser.role;
    }
  }
  
  // アクセス制御: superadmin/adminは全プロジェクトにアクセス可能、それ以外はオーナーのみ
  const isPrivileged = accessUserRole === 'superadmin' || accessUserRole === 'admin';
  if (!isPrivileged && scene.owner_user_id !== accessUserId) {
    console.log(`[VideoGen] Access denied: project owner ${scene.owner_user_id} !== logged-in user ${accessUserId}`);
    await logError({
      sceneId: sceneId,
      projectId: scene.project_id,
      userId: accessUserId || undefined,
      errorCode: 'ACCESS_DENIED',
      errorMessage: `Access denied: user ${accessUserId} cannot access project owned by ${scene.owner_user_id}`,
      httpStatusCode: 403,
    });
    return c.json({
      error: {
        code: 'ACCESS_DENIED',
        message: 'このプロジェクトにアクセスする権限がありません',
      },
    }, 403);
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
  
  // 5.5. Use already-obtained session info from access control (avoid duplicate DB query)
  const loggedInUserId = accessUserId;
  const loggedInUserRole = accessUserRole;
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
      console.log(`[VideoGen/Veo3] Sponsor mode: isSuperadmin=${isSuperadmin}, billingSource=${billingSource}, sponsorUserId=${sponsorUserId}, keyRing.length=${keyRing.length}`);
      
      if (isSuperadmin && loggedInUserId) {
        const keyResult = await getUserApiKey(c.env.DB, loggedInUserId, 'vertex', keyRing);
        console.log(`[VideoGen/Veo3] Superadmin key result:`, 'key' in keyResult ? 'found' : keyResult.error);
        if ('key' in keyResult) {
          vertexApiKey = keyResult.key;
        }
      }
      
      // If superadmin has no key, try sponsor's key
      if (!vertexApiKey && sponsorUserId) {
        const keyResult = await getUserApiKey(c.env.DB, sponsorUserId, 'vertex', keyRing);
        console.log(`[VideoGen/Veo3] Sponsor (userId=${sponsorUserId}) key result:`, 'key' in keyResult ? 'found' : keyResult.error);
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
  // - estimated_cost_usd: Veo 2 ($0.35/sec), Veo 3 ($0.50/sec)
  // - hasAudio: Veo 3 with audio は $0.75/sec（現在未サポート）
  const hasAudio = false; // Veo 3 audio generation is not yet supported
  const estimatedCostUsd = estimateVideoCost(model, durationSec, hasAudio);
  
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
  
  // === S3 URL → CloudFront 永続URL 変換（動画一覧） ===
  // CloudFront CDN経由で配信（期限なし、OACでS3は非公開のまま）
  const resolvedVideos: any[] = [];
  for (const v of (videos || []) as any[]) {
    if (v.status === 'completed' && v.r2_key) {
      // r2_keyからCloudFront永続URLを生成
      const cfUrl = toCloudFrontUrl(v.r2_key);
      resolvedVideos.push({ ...v, r2_url: cfUrl });
    } else if (v.status === 'completed' && v.r2_url) {
      // r2_keyがない場合: 既存URLをCloudFrontに変換を試みる
      const cfUrl = s3ToCloudFrontUrl(v.r2_url);
      resolvedVideos.push({ ...v, r2_url: cfUrl || v.r2_url });
    } else {
      resolvedVideos.push(v);
    }
  }
  
  const activeVideo = resolvedVideos.find((v: any) => v.is_active === 1) || null;
  
  return c.json({
    video_generations: resolvedVideos,
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
    SELECT id, scene_id, status, job_id, r2_key, r2_url, error_message, updated_at
    FROM video_generations WHERE id = ?
  `).bind(videoId).first<{
    id: number;
    scene_id: number;
    status: string;
    job_id: string | null;
    r2_key: string | null;
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
          
          // Store s3_key for future presigned URL generation
          const s3Key = awsStatus.job.s3_key || null;
          
          // CloudFront永続URLを生成（期限なし）
          const cfUrl = s3Key ? toCloudFrontUrl(s3Key) : s3ToCloudFrontUrl(awsStatus.job.presigned_url);
          
          // Then, set this video as active and completed
          // Store s3_key in r2_key, CloudFront URL in r2_url
          await c.env.DB.prepare(`
            UPDATE video_generations 
            SET status = 'completed', r2_key = ?, r2_url = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(s3Key, cfUrl, videoId).run();
          
          console.log(`[VideoGen] Video ${videoId} completed: s3_key=${s3Key}, cf_url=${cfUrl?.substring(0, 80)}`);
          
          return c.json({
            status: 'completed',
            r2_url: cfUrl,
            s3_key: s3Key,
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
  
  // === S3 URL → CloudFront 永続URL 変換 ===
  let resolvedUrl2 = video.r2_url;
  if (video.status === 'completed' && video.r2_key) {
    resolvedUrl2 = toCloudFrontUrl(video.r2_key);
  } else if (video.status === 'completed' && video.r2_url) {
    resolvedUrl2 = s3ToCloudFrontUrl(video.r2_url) || video.r2_url;
  }
  
  return c.json({
    status: video.status,
    r2_url: resolvedUrl2,
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
    SELECT id, scene_id, status, job_id, r2_key, r2_url, error_message, updated_at
    FROM video_generations WHERE id = ?
  `).bind(videoId).first<{
    id: number;
    scene_id: number;
    status: string;
    job_id: string | null;
    r2_key: string | null;
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
          
          // CloudFront永続URLを生成
          const s3Key = awsStatus.job.s3_key || null;
          const cfUrl = s3Key ? toCloudFrontUrl(s3Key) : s3ToCloudFrontUrl(awsStatus.job.presigned_url);
          
          // Store s3_key in r2_key, CloudFront URL in r2_url
          await c.env.DB.prepare(`
            UPDATE video_generations 
            SET status = 'completed', r2_key = ?, r2_url = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(s3Key, cfUrl, videoId).run();
          
          console.log(`[VideoGen] Video ${videoId} completed (legacy): s3_key=${s3Key}, cf_url=${cfUrl?.substring(0, 80)}`);
          
          return c.json({
            video: {
              id: videoId,
              status: 'completed',
              r2_url: cfUrl,
              s3_key: s3Key,
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
  
  // === S3 URL → CloudFront 永続URL 変換（レガシーステータスエンドポイント） ===
  let resolvedUrl = video.r2_url;
  if (video.status === 'completed' && video.r2_key) {
    resolvedUrl = toCloudFrontUrl(video.r2_key);
  } else if (video.status === 'completed' && video.r2_url) {
    resolvedUrl = s3ToCloudFrontUrl(video.r2_url) || video.r2_url;
  }
  
  return c.json({
    video: {
      id: video.id,
      status: video.status,
      r2_url: resolvedUrl,
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
// POST /api/videos/:videoId/cancel
// Cancel a generating video (user can cancel their own)
// ====================================================================

videoGeneration.post('/videos/:videoId/cancel', async (c) => {
  const videoId = parseInt(c.req.param('videoId'), 10);
  if (isNaN(videoId)) {
    return c.json({ error: { code: 'INVALID_VIDEO_ID', message: 'Invalid video ID' } }, 400);
  }
  
  // Auth check
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
  
  if (!session) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401);
  }
  
  // Get video with project owner info
  const video = await c.env.DB.prepare(`
    SELECT vg.id, vg.scene_id, vg.status, vg.job_id, s.project_id, p.user_id as owner_user_id
    FROM video_generations vg
    JOIN scenes s ON vg.scene_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE vg.id = ?
  `).bind(videoId).first<{
    id: number;
    scene_id: number;
    status: string;
    job_id: string | null;
    project_id: number;
    owner_user_id: number;
  }>();
  
  if (!video) {
    return c.json({ error: { code: 'VIDEO_NOT_FOUND', message: 'Video generation not found' } }, 404);
  }
  
  // Permission check
  const isPrivileged = session.role === 'superadmin' || session.role === 'admin';
  if (!isPrivileged && video.owner_user_id !== session.user_id) {
    return c.json({ error: { code: 'ACCESS_DENIED', message: 'Access denied' } }, 403);
  }
  
  // Can only cancel if status is 'generating' or 'pending'
  if (video.status !== 'generating' && video.status !== 'pending') {
    return c.json({
      error: {
        code: 'CANNOT_CANCEL',
        message: `Cannot cancel video with status '${video.status}'. Only 'generating' or 'pending' can be cancelled.`
      }
    }, 400);
  }
  
  // Update status to cancelled
  await c.env.DB.prepare(`
    UPDATE video_generations 
    SET status = 'cancelled', error_message = 'Cancelled by user', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(videoId).run();
  
  console.log(`[VideoGen] Video ${videoId} cancelled by user ${session.user_id}`);
  
  return c.json({
    success: true,
    video_id: videoId,
    status: 'cancelled',
    message: '動画生成をキャンセルしました'
  });
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
  // PR-A2: video-build-helpers は静的importに移行済み
  const { createVideoBuildClientConfig } = await import('../utils/aws-video-build-client');
  
  try {
    const projectId = parseInt(c.req.param('projectId'), 10);
    
    // 環境変数チェック（警告用）
    const envWarnings: string[] = [];
    const awsConfigured = createVideoBuildClientConfig(c.env) !== null;
    const siteUrlConfigured = !!c.env.SITE_URL;
    
    if (!awsConfigured) {
      envWarnings.push('AWS Orchestrator が設定されていません（動画生成不可）');
    }
    if (!siteUrlConfigured) {
      envWarnings.push('SITE_URL が未設定です。デフォルト値が使用されます');
    }
    
    // シーンデータ取得
    // R2: display_asset_type, text_render_mode を取得
    // ⚠️ is_hidden = 0 で非表示シーンを除外（ソフトデリート対応）
    const { results: rawScenes } = await c.env.DB.prepare(`
      SELECT id, idx, role, title, dialogue, comic_data, display_asset_type, text_render_mode
      FROM scenes
      WHERE project_id = ? AND (is_hidden = 0 OR is_hidden IS NULL)
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
        
        // R1.6: scene_utterances を取得（audio_generations の status と r2_url を含む）
        // PR-A2: audio_url を取得してvalidateRenderInputsで検証
        const { results: utteranceRows } = await c.env.DB.prepare(`
          SELECT 
            u.id,
            u.order_no,
            u.role,
            u.text,
            u.audio_generation_id,
            ag.status as audio_status,
            ag.r2_url as audio_r2_url
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
          audio_r2_url: string | null;
        }>();
        
        // PR-A2: bakedモードのバルーン画像欠落数を取得（warning用）
        const { results: balloonMissingRows } = await c.env.DB.prepare(`
          SELECT COUNT(*) as cnt
          FROM scene_balloons
          WHERE scene_id = ? AND (bubble_r2_url IS NULL OR bubble_r2_url = '')
        `).bind(scene.id).all<{ cnt: number }>();
        const balloonMissingCount = balloonMissingRows?.[0]?.cnt || 0;
        
        return {
          id: scene.id,
          idx: scene.idx,
          role: scene.role || '',
          title: scene.title || '',
          dialogue: scene.dialogue || '',
          display_asset_type: scene.display_asset_type || 'image',
          // PR-A2: text_render_mode を追加（bakedバルーン警告用）
          text_render_mode: scene.text_render_mode || (scene.display_asset_type === 'comic' ? 'baked' : 'remotion'),
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
          // PR-A2: bakedモードのバルーン画像欠落数（warning用）
          balloon_missing_baked_image_count: balloonMissingCount,
          // R1.6/PR-A2: utterances with audio_status and audio_url
          utterances: utteranceRows.map(u => ({
            id: u.id,
            text: u.text,
            audio_generation_id: u.audio_generation_id,
            audio_status: u.audio_status || null,
            // PR-A2: audio_url を絶対URL化して追加（validateRenderInputsで検証）
            audio_url: u.audio_r2_url ? toAbsoluteUrl(u.audio_r2_url, siteUrl) : null,
          })),
        };
      })
    );
    
    // 素材 Preflight検証（画像/漫画/動画）
    const assetValidation = validateProjectAssets(scenesWithAssets);
    
    // ============================================================
    // C仕様: 視覚素材の赤エラー検証（Silent Fallback禁止）
    // VISUAL_VIDEO_MISSING, VISUAL_IMAGE_MISSING, VISUAL_COMIC_MISSING 等
    // これらが1件でもあれば Video Build ボタンは無効化される
    // 
    // D仕様: URL到達性検証（VISUAL_ASSET_URL_FORBIDDEN）
    // クエリパラメータ check_reachability=true で有効化（デフォルト: false）
    // 本番運用では有効化を推奨
    // ============================================================
    const checkReachability = c.req.query('check_reachability') === 'true';
    
    // 非同期版を使用してURL到達性検証を行う
    const visualValidation = await validateVisualAssetsAsync(scenesWithAssets, checkReachability);
    
    // デバッグログ: 視覚素材検証結果
    if (!visualValidation.is_valid) {
      console.log('[VideoBuild] Preflight: Visual validation failed', {
        projectId,
        checkReachability,
        errors: visualValidation.errors,
        debug_info: visualValidation.debug_info,
      });
    }
    
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
    
    // PR-A2: project.json最終ゲート相当（src完全性）を preflight でも実行
    // buildProjectJsonは重いので、preflightで組める最小入力から同一の検証関数（validateRenderInputs）を使う
    const siteUrlForBuild = c.env.SITE_URL || 'https://app.marumuviai.com';
    
    const renderInputs: RenderInputScene[] = scenesWithAssets.map((s: any) => {
      // 画像候補：comic → image（display_asset_typeに応じて選択）
      const displayType = s.display_asset_type || 'image';
      let imageRel: string | null = null;
      if (displayType === 'comic') {
        imageRel = s.active_comic?.r2_url || null;
      } else if (displayType === 'image') {
        imageRel = s.active_image?.r2_url || null;
      }
      // 既にtoAbsoluteUrl済みの場合はそのまま使う
      const imageAbs = imageRel;

      // 動画候補：active_video があるなら
      const videoRel = s.active_video?.r2_url || null;
      const videoAbs = videoRel;

      // voices：utterancesの audio_url（すでにabsolute化している想定）
      // 空文字や null は除外せず、validateRenderInputs で検証する
      const voiceUrls = Array.isArray(s.utterances)
        ? s.utterances
            .filter((u: any) => u.audio_url && u.audio_status === 'completed')
            .map((u: any) => u.audio_url)
        : [];

      return {
        idx: s.idx,
        image_url: imageAbs,
        video_url: videoAbs,
        voice_urls: voiceUrls,
        text_render_mode: s.text_render_mode,
        balloon_missing_baked_image_count: s.balloon_missing_baked_image_count || 0,
      };
    });

    const projectJsonValidation = validateRenderInputs(renderInputs);
    
    // ============================================================
    // canGenerate 判定 (SSOT)
    // C仕様: 視覚素材エラーが1件でもあればボタン無効化
    // ============================================================
    const canGenerate = 
      assetValidation.is_ready && 
      visualValidation.is_valid &&  // C仕様: Silent Fallback禁止
      awsConfigured && 
      projectJsonValidation.is_valid;
    
    // ============================================================
    // 警告を「必須」と「推奨」に分類
    // ============================================================
    
    // 必須エラー（赤・生成停止）: 視覚素材エラー + 素材不足 + project.json検証エラー
    const requiredErrors: Array<{
      type: string;
      code?: string;
      level: 'error';
      scene_id: number | null;
      scene_idx: number;
      display_asset_type?: string;
      message: string;
      action_hint?: string;
    }> = [
      // ============================================================
      // C仕様: 視覚素材エラー（VISUAL_VIDEO_MISSING等）
      // これらは UIフレンドリーなメッセージと action_hint を含む
      // ============================================================
      ...visualValidation.errors.map((e: VisualAssetError) => ({
        type: e.type,
        code: e.code,
        level: 'error' as const,
        scene_id: e.scene_id,
        scene_idx: e.scene_idx,
        display_asset_type: e.display_asset_type,
        message: e.message,
        action_hint: e.action_hint,
      })),
      // 素材不足エラー（後方互換用 - visualValidationと重複する可能性あり）
      ...assetValidation.missing
        .filter(m => !visualValidation.errors.some(e => e.scene_id === m.scene_id))  // 重複排除
        .map(m => ({
          type: 'ASSET_MISSING' as const,
          level: 'error' as const,
          scene_id: m.scene_id,
          scene_idx: m.scene_idx,
          message: `シーン${m.scene_idx}：${m.required_asset === 'active_comic.r2_url' ? '漫画画像' : m.required_asset === 'active_video.r2_url' ? '動画' : '画像'}がありません`,
        })),
      // PR-A2: project.json検証エラー
      ...projectJsonValidation.critical_errors.map(e => ({
        type: 'PROJECT_JSON_ERROR' as const,
        level: 'error' as const,
        scene_id: null as number | null,
        scene_idx: e.scene_idx,
        message: e.reason,
      })),
    ];
    
    // 推奨警告（黄・生成は止めない）: 音声パーツ関連 + project.json警告
    const recommendedWarnings = [
      // utterance 関連の警告
      ...utteranceValidation.errors.map(e => ({
        ...e,
        level: 'warning' as const,
        // BGMがある場合はメッセージを調整
        message: hasBgm && e.type === 'NO_UTTERANCES'
          ? e.message.replace('（ボイスなしでも生成可）', '（BGMで再生されます）')
          : e.message,
      })),
      // PR-A2: project.json警告（無音シーン、bakedバブル欠落等）
      ...projectJsonValidation.warnings.map(w => ({
        type: 'PROJECT_JSON_WARNING' as const,
        level: 'warning' as const,
        scene_id: null as number | null,
        scene_idx: w.scene_idx,
        message: w.message,
      })),
    ];
    
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
      // 環境設定状況（トラブルシュート用）
      config: {
        aws_configured: awsConfigured,
        site_url_configured: siteUrlConfigured,
        env_warnings: envWarnings,
      },
      // PR-A2: project.json最終ゲート検証結果（デバッグ/詳細表示用）
      project_json_validation: {
        is_valid: projectJsonValidation.is_valid,
        critical_errors: projectJsonValidation.critical_errors,
        warnings: projectJsonValidation.warnings,
      },
      // ============================================================
      // C仕様: 視覚素材検証結果（SSOT）
      // Silent Fallback禁止のための赤エラー検証
      // ============================================================
      visual_validation: {
        is_valid: visualValidation.is_valid,
        errors: visualValidation.errors,
        // デバッグ用: 各シーンの素材状態
        debug_info: visualValidation.debug_info,
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
  // PR-A2: buildProjectJson は静的importに移行済み
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
    // ⚠️ is_hidden = 0 で非表示シーンを除外（ソフトデリート対応）
    let scenesQuery = `
      SELECT s.id, s.idx, s.role, s.title, s.dialogue, s.display_asset_type, s.text_render_mode,
             s.duration_override_ms
      FROM scenes s
      WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
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
      
      // Active video (for display_asset_type='video')
      // job_idも取得して、署名付きURLの場合はリフレッシュ可能にする
      const activeVideo = await c.env.DB.prepare(`
        SELECT id, status, r2_url, r2_key, job_id, model, duration_sec
        FROM video_generations
        WHERE scene_id = ? AND is_active = 1 AND status = 'completed' AND r2_url IS NOT NULL
        LIMIT 1
      `).bind(scene.id).first<{
        id: number;
        status: string;
        r2_url: string;
        r2_key: string | null;
        job_id: string | null;
        model: string | null;
        duration_sec: number;
      }>();
      
      // CloudFront 永続URL 変換（presigned URL の期限切れ問題を根本解消）
      let refreshedVideoUrl: string | null = null;
      if (activeVideo) {
        if (activeVideo.r2_key) {
          // r2_keyからCloudFront永続URLを生成（最も信頼性が高い）
          refreshedVideoUrl = toCloudFrontUrl(activeVideo.r2_key);
          // DBのr2_urlもCloudFront URLに更新（非同期・fire-and-forget）
          if (refreshedVideoUrl !== activeVideo.r2_url) {
            c.env.DB.prepare(`
              UPDATE video_generations SET r2_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
            `).bind(refreshedVideoUrl, activeVideo.id).run().catch(() => {});
          }
        } else if (activeVideo.r2_url) {
          // r2_keyがない場合: 既存URLをCloudFrontに変換を試みる
          refreshedVideoUrl = s3ToCloudFrontUrl(activeVideo.r2_url) || activeVideo.r2_url;
        }
      }
      
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
        active_video: activeVideo ? { 
          id: activeVideo.id, 
          status: activeVideo.status, 
          r2_url: refreshedVideoUrl || activeVideo.r2_url,
          model: activeVideo.model,
          duration_sec: activeVideo.duration_sec
        } : null,
        utterances: utterances?.map((u: any) => ({
          id: u.id,
          role: u.role,
          character_key: u.character_key,
          text: u.text,
          audio_url: u.audio_r2_url,
          duration_ms: u.audio_duration_ms || u.duration_ms || (u.audio_r2_url ? Math.max(2000, (u.text?.length || 0) * 300) : null),
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
    
    // R3-A: アクティブBGMを取得（R4: タイムライン制御フィールド追加）
    const activeBgm = await c.env.DB.prepare(`
      SELECT id, r2_key, r2_url, duration_ms, volume, loop, 
             fade_in_ms, fade_out_ms, ducking_enabled, ducking_volume,
             ducking_attack_ms, ducking_release_ms,
             video_start_ms, video_end_ms, audio_offset_ms
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
      // R4: タイムライン制御フィールド
      video_start_ms: number;
      video_end_ms: number | null;
      audio_offset_ms: number;
    }>();
    
    const DEFAULT_SITE_URL = 'https://app.marumuviai.com';
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
        // R3-A: BGM設定（R4: タイムライン制御追加）
        bgm: activeBgm ? {
          enabled: true,
          url: activeBgm.r2_url?.startsWith('/') 
            ? `${siteUrl}${activeBgm.r2_url}` 
            : activeBgm.r2_url || undefined,
          volume: activeBgm.volume,
          loop: activeBgm.loop === 1,
          fade_in_ms: activeBgm.fade_in_ms,
          fade_out_ms: activeBgm.fade_out_ms,
          // R4: タイムライン制御
          video_start_ms: activeBgm.video_start_ms ?? 0,
          video_end_ms: activeBgm.video_end_ms ?? null,
          audio_offset_ms: activeBgm.audio_offset_ms ?? 0,
          ducking: activeBgm.ducking_enabled === 1 ? {
            enabled: true,
            volume: activeBgm.ducking_volume,
            attack_ms: activeBgm.ducking_attack_ms,
            release_ms: activeBgm.ducking_release_ms,
          } : undefined,
        } : undefined,
      },
      { siteUrl }  // Pass siteUrl for absolute URL conversion
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
  
  // PR-A2: video-build-helpers は静的importに移行済み
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
    // ⚠️ is_hidden = 0 で非表示シーンを除外（ソフトデリート対応）
    const { results: rawScenes } = await c.env.DB.prepare(`
      SELECT id, idx, role, title, dialogue, display_asset_type, comic_data, text_render_mode
      FROM scenes
      WHERE project_id = ? AND (is_hidden = 0 OR is_hidden IS NULL)
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
        // ★ FIX: ag.duration_ms を取得して音声の実際の長さを確実に使用
        //    scene_utterances.duration_ms はキャッシュ値で null の場合がある
        //    audio_generations.duration_ms が正確な音声長なので優先的に使用
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
            ag.duration_ms as audio_duration_ms,
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
          audio_duration_ms: number | null;
          character_name: string | null;
        }>();
        
        // Convert R2 URLs to absolute URLs
        // ★ FIX: duration_ms は audio_generations の値を優先（セリフ切れ防止の根本修正）
        //    優先順位: ag.duration_ms > u.duration_ms > テキストからの推定値
        const utterances = utteranceRows.map(u => ({
          id: u.id,
          order_no: u.order_no,
          role: u.role as 'narration' | 'dialogue',
          character_key: u.character_key,
          character_name: u.character_name,
          text: u.text,
          audio_generation_id: u.audio_generation_id,
          duration_ms: u.audio_duration_ms || u.duration_ms || (u.audio_url ? Math.max(2000, (u.text?.length || 0) * 300) : null),
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
        
        // ====================================================================
        // P0-1e: SFX取得 - 新SSOT優先・legacyフォールバック
        // ====================================================================
        // 優先順位:
        //   1. scene_audio_assignments (audio_type='sfx') - 新SSOT
        //   2. scene_audio_cues - legacy fallback
        // ====================================================================
        
        // 1. 新SSOT: scene_audio_assignments から SFX を取得
        const { results: sfxAssignments } = await c.env.DB.prepare(`
          SELECT 
            saa.id,
            saa.audio_library_type,
            saa.system_audio_id,
            saa.user_audio_id,
            saa.direct_r2_key,
            saa.direct_r2_url,
            saa.direct_name,
            saa.direct_duration_ms,
            saa.start_ms,
            saa.end_ms,
            saa.audio_offset_ms,
            saa.volume_override,
            saa.loop_override,
            saa.fade_in_ms_override,
            saa.fade_out_ms_override,
            -- system_audio_library からの情報
            sal.name as system_name,
            sal.file_url as system_url,
            sal.duration_ms as system_duration_ms,
            -- user_audio_library からの情報
            ual.name as user_name,
            ual.r2_url as user_url,
            ual.duration_ms as user_duration_ms,
            ual.default_volume as user_default_volume,
            ual.default_loop as user_default_loop,
            ual.default_fade_in_ms as user_default_fade_in_ms,
            ual.default_fade_out_ms as user_default_fade_out_ms
          FROM scene_audio_assignments saa
          LEFT JOIN system_audio_library sal ON saa.system_audio_id = sal.id
          LEFT JOIN user_audio_library ual ON saa.user_audio_id = ual.id
          WHERE saa.scene_id = ? AND saa.audio_type = 'sfx' AND saa.is_active = 1
          ORDER BY saa.start_ms ASC
        `).bind(scene.id).all<{
          id: number;
          audio_library_type: 'system' | 'user' | 'direct';
          system_audio_id: number | null;
          user_audio_id: number | null;
          direct_r2_key: string | null;
          direct_r2_url: string | null;
          direct_name: string | null;
          direct_duration_ms: number | null;
          start_ms: number;
          end_ms: number | null;
          audio_offset_ms: number;
          volume_override: number | null;
          loop_override: number | null;
          fade_in_ms_override: number | null;
          fade_out_ms_override: number | null;
          system_name: string | null;
          system_url: string | null;
          system_duration_ms: number | null;
          user_name: string | null;
          user_url: string | null;
          user_duration_ms: number | null;
          user_default_volume: number | null;
          user_default_loop: number | null;
          user_default_fade_in_ms: number | null;
          user_default_fade_out_ms: number | null;
        }>();
        
        let sfx: Array<{
          id: number;
          name: string;
          r2_url: string | null;
          duration_ms: number | null;
          volume: number;
          start_ms: number;
          end_ms: number | null;
          loop: number;
          fade_in_ms: number;
          fade_out_ms: number;
        }> = [];
        
        if (sfxAssignments && sfxAssignments.length > 0) {
          // 新SSOT から SFX を構築
          sfx = sfxAssignments.map(assignment => {
            let name = 'SFX';
            let r2_url: string | null = null;
            let duration_ms: number | null = null;
            let defaultVolume = 0.8;
            let defaultLoop = 0;
            let defaultFadeIn = 0;
            let defaultFadeOut = 0;
            
            if (assignment.audio_library_type === 'system' && assignment.system_url) {
              name = assignment.system_name || 'System SFX';
              r2_url = assignment.system_url;
              duration_ms = assignment.system_duration_ms;
            } else if (assignment.audio_library_type === 'user' && assignment.user_url) {
              name = assignment.user_name || 'User SFX';
              r2_url = assignment.user_url;
              duration_ms = assignment.user_duration_ms;
              defaultVolume = assignment.user_default_volume ?? 0.8;
              defaultLoop = assignment.user_default_loop ?? 0;
              defaultFadeIn = assignment.user_default_fade_in_ms ?? 0;
              defaultFadeOut = assignment.user_default_fade_out_ms ?? 0;
            } else if (assignment.audio_library_type === 'direct' && assignment.direct_r2_url) {
              name = assignment.direct_name || 'Direct SFX';
              r2_url = assignment.direct_r2_url;
              duration_ms = assignment.direct_duration_ms;
            }
            
            return {
              id: assignment.id,
              name,
              r2_url: r2_url ? toAbsoluteUrl(r2_url, siteUrl) : null,
              duration_ms,
              volume: assignment.volume_override ?? defaultVolume,
              start_ms: assignment.start_ms,
              end_ms: assignment.end_ms,
              loop: assignment.loop_override ?? defaultLoop,
              fade_in_ms: assignment.fade_in_ms_override ?? defaultFadeIn,
              fade_out_ms: assignment.fade_out_ms_override ?? defaultFadeOut,
            };
          }).filter(cue => cue.r2_url);
          
          console.log(`[VideoBuild] Scene ${scene.id}: Using ${sfx.length} SFX from scene_audio_assignments (new SSOT)`);
        } else {
          // 2. Legacy fallback: scene_audio_cues から取得
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
          
          sfx = sfxRows.map(cue => ({
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
          })).filter(cue => cue.r2_url);
          
          if (sfx.length > 0) {
            console.log(`[VideoBuild] Scene ${scene.id}: Using ${sfx.length} SFX from scene_audio_cues (legacy fallback)`);
          }
        }
        
        // ====================================================================
        // P5: シーン別BGM取得 - 新SSOT優先・legacyフォールバック
        // ====================================================================
        // 優先順位:
        //   1. scene_audio_assignments (audio_type='bgm', is_active=1) - 新SSOT
        //   2. 該当シーンにBGM割当がない場合は null（プロジェクト全体BGMを使用）
        // 
        // 仕様:
        //   - 1シーンにつきBGMは最大1件（audio_type='bgm' AND is_active=1）
        //   - シーン別BGMがある場合、そのシーンではプロジェクト全体BGMより優先
        //   - Remotion側でシーン別BGMとプロジェクト全体BGMの共存処理（duck/mute）
        // ====================================================================
        
        let sceneBgm: {
          id: number;
          name: string;
          url: string;
          duration_ms: number | null;
          volume: number;
          loop: boolean;
          fade_in_ms: number;
          fade_out_ms: number;
          start_ms: number;
          end_ms: number | null;
          source_type: 'system' | 'user' | 'direct';
        } | null = null;
        
        // 新SSOT: scene_audio_assignments から BGM を取得（1件のみ）
        const bgmAssignment = await c.env.DB.prepare(`
          SELECT 
            saa.id,
            saa.audio_library_type,
            saa.system_audio_id,
            saa.user_audio_id,
            saa.direct_r2_key,
            saa.direct_r2_url,
            saa.direct_name,
            saa.direct_duration_ms,
            saa.start_ms,
            saa.end_ms,
            saa.audio_offset_ms,
            saa.volume_override,
            saa.loop_override,
            saa.fade_in_ms_override,
            saa.fade_out_ms_override,
            -- system_audio_library からの情報
            sal.name as system_name,
            sal.file_url as system_url,
            sal.duration_ms as system_duration_ms,
            -- user_audio_library からの情報
            ual.name as user_name,
            ual.r2_url as user_url,
            ual.duration_ms as user_duration_ms,
            ual.default_volume as user_default_volume,
            ual.default_loop as user_default_loop,
            ual.default_fade_in_ms as user_default_fade_in_ms,
            ual.default_fade_out_ms as user_default_fade_out_ms
          FROM scene_audio_assignments saa
          LEFT JOIN system_audio_library sal ON saa.system_audio_id = sal.id
          LEFT JOIN user_audio_library ual ON saa.user_audio_id = ual.id
          WHERE saa.scene_id = ? AND saa.audio_type = 'bgm' AND saa.is_active = 1
          LIMIT 1
        `).bind(scene.id).first<{
          id: number;
          audio_library_type: 'system' | 'user' | 'direct';
          system_audio_id: number | null;
          user_audio_id: number | null;
          direct_r2_key: string | null;
          direct_r2_url: string | null;
          direct_name: string | null;
          direct_duration_ms: number | null;
          start_ms: number;
          end_ms: number | null;
          audio_offset_ms: number;
          volume_override: number | null;
          loop_override: number | null;
          fade_in_ms_override: number | null;
          fade_out_ms_override: number | null;
          system_name: string | null;
          system_url: string | null;
          system_duration_ms: number | null;
          user_name: string | null;
          user_url: string | null;
          user_duration_ms: number | null;
          user_default_volume: number | null;
          user_default_loop: number | null;
          user_default_fade_in_ms: number | null;
          user_default_fade_out_ms: number | null;
        }>();
        
        if (bgmAssignment) {
          let name = 'BGM';
          let url: string | null = null;
          let duration_ms: number | null = null;
          let defaultVolume = 0.25;
          let defaultLoop = true;
          let defaultFadeIn = 800;
          let defaultFadeOut = 800;
          
          if (bgmAssignment.audio_library_type === 'system' && bgmAssignment.system_url) {
            name = bgmAssignment.system_name || 'System BGM';
            url = bgmAssignment.system_url;
            duration_ms = bgmAssignment.system_duration_ms;
          } else if (bgmAssignment.audio_library_type === 'user' && bgmAssignment.user_url) {
            name = bgmAssignment.user_name || 'User BGM';
            url = bgmAssignment.user_url;
            duration_ms = bgmAssignment.user_duration_ms;
            defaultVolume = bgmAssignment.user_default_volume ?? 0.25;
            defaultLoop = (bgmAssignment.user_default_loop ?? 1) === 1;
            defaultFadeIn = bgmAssignment.user_default_fade_in_ms ?? 800;
            defaultFadeOut = bgmAssignment.user_default_fade_out_ms ?? 800;
          } else if (bgmAssignment.audio_library_type === 'direct' && bgmAssignment.direct_r2_url) {
            name = bgmAssignment.direct_name || 'Direct BGM';
            url = bgmAssignment.direct_r2_url;
            duration_ms = bgmAssignment.direct_duration_ms;
          }
          
          if (url) {
            sceneBgm = {
              id: bgmAssignment.id,
              name,
              url: toAbsoluteUrl(url, siteUrl) || url,
              duration_ms,
              volume: bgmAssignment.volume_override ?? defaultVolume,
              // ループはデフォルトOFF（シーン別BGMでループは基本使わない）
              loop: bgmAssignment.loop_override !== null ? bgmAssignment.loop_override === 1 : false,
              fade_in_ms: bgmAssignment.fade_in_ms_override ?? defaultFadeIn,
              fade_out_ms: bgmAssignment.fade_out_ms_override ?? defaultFadeOut,
              start_ms: bgmAssignment.start_ms,
              end_ms: bgmAssignment.end_ms,
              audio_offset_ms: bgmAssignment.audio_offset_ms ?? 0,  // BGMファイルの再生開始位置
              source_type: bgmAssignment.audio_library_type,
            };
            
            console.log(`[VideoBuild] Scene ${scene.id}: Using BGM from scene_audio_assignments (new SSOT): ${name}`);
          }
        }
        
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
          // P5: シーン別BGM（新SSOT優先）
          bgm: sceneBgm,
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
    
    // PR-5-1: 表現サマリーを集計（スナップショット保存用）
    let totalUtterancesWithAudio = 0;
    let totalBalloons = 0;
    let totalSfx = 0;
    const balloonPolicyCounts: Record<string, number> = {
      always: 0,      // 常時表示
      voice_window: 0, // 喋る時
      manual_window: 0 // 手動
    };
    
    for (const scene of scenesWithAssets) {
      // 音声付き utterance をカウント
      if (scene.utterances && Array.isArray(scene.utterances)) {
        totalUtterancesWithAudio += scene.utterances.filter((u: any) => u.audio_url).length;
      }
      // バルーンをカウント＋display_mode別集計
      if (scene.balloons && Array.isArray(scene.balloons)) {
        totalBalloons += scene.balloons.length;
        for (const b of scene.balloons as any[]) {
          const mode = b.display_mode || 'voice_window';
          if (balloonPolicyCounts[mode] !== undefined) {
            balloonPolicyCounts[mode]++;
          } else {
            balloonPolicyCounts['voice_window']++;
          }
        }
      }
      // SFXをカウント
      if (scene.sfx && Array.isArray(scene.sfx)) {
        totalSfx += scene.sfx.length;
      }
    }
    
    // 5. R3-A: プロジェクトオーディオトラック（通しBGM）を取得
    const activeBgm = await c.env.DB.prepare(`
      SELECT id, r2_key, r2_url, duration_ms, volume, loop, 
             fade_in_ms, fade_out_ms, ducking_enabled, ducking_volume,
             ducking_attack_ms, ducking_release_ms,
             video_start_ms, video_end_ms, audio_offset_ms
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
      // タイムライン制御フィールド
      video_start_ms: number;
      video_end_ms: number | null;
      audio_offset_ms: number;
    }>();
    
    // 5. Settings構築（Output preset 情報を含む）
    // Output preset から設定を取得
    const { getOutputPreset } = await import('../utils/output-presets');
    const outputPresetConfig = getOutputPreset(project.output_preset);
    
    // CRITICAL FIX: Define siteUrl in function scope for buildSettings
    const siteUrl = c.env.SITE_URL || 'https://app.marumuviai.com';
    
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
        // ループはデフォルトOFF
        loop: activeBgm ? activeBgm.loop === 1 : (body.bgm?.loop ?? false),
        fade_in_ms: activeBgm?.fade_in_ms ?? body.bgm?.fade_in_ms ?? 800,
        fade_out_ms: activeBgm?.fade_out_ms ?? body.bgm?.fade_out_ms ?? 800,
        // タイムライン制御（動画上の再生範囲・BGMファイル内のオフセット）
        video_start_ms: activeBgm?.video_start_ms ?? body.bgm?.video_start_ms ?? 0,
        video_end_ms: activeBgm?.video_end_ms ?? body.bgm?.video_end_ms ?? null,
        audio_offset_ms: activeBgm?.audio_offset_ms ?? body.bgm?.audio_offset_ms ?? 0,
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
      // PR-5-3a/b + Phase 1: テロップ表示設定
      telops: {
        enabled: body.telops?.enabled ?? true,  // デフォルトON
        // PR-5-3b: 位置・サイズプリセット（Safe Chatで変更可能）
        position_preset: body.telops?.position_preset ?? 'bottom',  // bottom | center | top
        size_preset: body.telops?.size_preset ?? 'md',  // sm | md | lg
        // Phase 1: スタイルプリセット (minimal/outline/band/pop/cinematic)
        style_preset: body.telops?.style_preset ?? 'outline',
      },
      // PR-5-1: 表現サマリー（スナップショット）
      expression_summary: {
        has_voice: totalUtterancesWithAudio > 0,
        has_bgm: activeBgm ? true : (body.bgm?.enabled ?? false),
        has_sfx: totalSfx > 0,
        balloon_count: totalBalloons,
        balloon_policy_summary: {
          always: balloonPolicyCounts.always,
          voice_window: balloonPolicyCounts.voice_window,
          manual_window: balloonPolicyCounts.manual_window,
          total: totalBalloons,
        },
        // 無音判定（音声・BGM・SFXすべてなし）
        is_silent: totalUtterancesWithAudio === 0 && !activeBgm && !(body.bgm?.enabled) && totalSfx === 0,
        // PR-5-3a: テロップ有無
        has_telops: (body.telops?.enabled ?? true),
        telops_enabled: (body.telops?.enabled ?? true),
      },
    };
    
    // SSOT Validation Log: telops settings propagation check
    console.log('[SSOT-TELOP] buildSettings.telops:', JSON.stringify(buildSettings.telops));
    
    // 6. project.json生成
    // Output preset から aspect_ratio / resolution / fps を取得（body で上書き可能）
    // CRITICAL: Pass siteUrl for absolute URL conversion (Remotion Lambda requires absolute URLs)
    const siteUrlForBuild = c.env.SITE_URL || 'https://app.marumuviai.com';
    const projectJson = buildProjectJson(
      { id: project.id, title: project.title, user_id: ownerUserId },
      scenesWithAssets,
      buildSettings,
      {
        aspectRatio: body.aspect_ratio || outputPresetConfig.aspect_ratio,
        resolution: body.resolution || outputPresetConfig.resolution,
        fps: body.fps || outputPresetConfig.fps,
        siteUrl: siteUrlForBuild,
      }
    );
    
    // 6.5. PR-A1: project.json の最終検証（src完全性チェック）
    // SSOT: この検証がレンダーに飛ばして良いかの最終ゲート
    // PR-A2: validateProjectJson は静的importに移行済み
    const projectJsonValidation = validateProjectJson(projectJson);
    
    if (!projectJsonValidation.is_valid) {
      // 必須エラーがあればレンダーに飛ばさない
      return c.json({
        error: {
          code: 'PROJECT_JSON_INVALID',
          message: `project.json に必須項目の不備があります（${projectJsonValidation.critical_errors.length}件のエラー）`,
          details: {
            critical_errors: projectJsonValidation.critical_errors,
            warnings: projectJsonValidation.warnings,
          }
        }
      }, 400);
    }
    
    // 警告があればログに出力（レンダーは続行）
    if (projectJsonValidation.warnings.length > 0) {
      console.log(`[VideoBuild] project.json warnings (project_id=${projectId}):`, projectJsonValidation.warnings);
    }
    
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
    
    // Merge render_config into settings_json for debugging "Too many functions" errors
    const renderConfig = (awsResponse as any).render_config;
    let updatedSettingsJson = buildSettings;
    if (renderConfig) {
      updatedSettingsJson = {
        ...buildSettings,
        render_config: renderConfig
      };
    }
    
    await c.env.DB.prepare(`
      UPDATE video_builds 
      SET status = 'submitted',
          aws_job_id = ?,
          remotion_render_id = ?,
          remotion_site_name = ?,
          s3_bucket = ?,
          s3_output_key = ?,
          settings_json = ?,
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
      JSON.stringify(updatedSettingsJson),
      videoBuildId
    ).run();
    
    // api_usage_logs 記録
    // Calculate estimated cost based on total duration and scene count
    const totalDurationSec = projectJson.summary?.total_duration_ms 
      ? projectJson.summary.total_duration_ms / 1000 
      : scenesWithAssets.length * 5; // Fallback: 5 sec per scene
    const remotionEstimatedCost = estimateRemotionBuildCost(totalDurationSec, scenesWithAssets.length);
    
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
        scene_count: scenesWithAssets.length,
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
      s3_bucket: string | null;
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
      // 完了: download_url にpresigned URLを保存
      // Remotion Lambda バケット (remotionlambda-*) はCloudFront未設定のため
      // AWSから返されたpresigned URLをそのまま使用
      const publicDownloadUrl = awsResponse.output.presigned_url;
      
      console.log(`[VideoBuild Refresh] Converting to CloudFront URL for build=${buildId}`);
      console.log(`[VideoBuild Refresh] CloudFront URL: ${publicDownloadUrl}`);
      
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
        publicDownloadUrl,
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
    `).bind(buildId).first<Record<string, any>>();
    
    if (!build) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Build not found' } }, 404);
    }
    
    // download_url が CloudFront URL で 403 になるケース対応:
    // Remotion Lambda バケット (remotionlambda-*) は CloudFront 未設定のため
    // s3_output_key + s3_bucket から presigned URL を動的生成
    if (build.status === 'completed' && build.download_url && build.s3_output_key) {
      const dlUrl = build.download_url as string;
      const isCloudFrontUrl = dlUrl.includes('.cloudfront.net');
      const isRemotionBucket = (build.s3_bucket as string || '').startsWith('remotionlambda-');
      
      if (isCloudFrontUrl && isRemotionBucket) {
        // CloudFront が Remotion Lambda バケットをカバーしていないため presigned URL を生成
        try {
          const freshUrl = await generateS3PresignedUrl(
            build.s3_output_key as string,
            c.env,
            { bucket: build.s3_bucket as string, expiresIn: 86400 }
          );
          if (freshUrl) {
            build.download_url = freshUrl;
            // DB も更新（fire-and-forget）
            c.env.DB.prepare(`
              UPDATE video_builds SET download_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
            `).bind(freshUrl, buildId).run().catch(() => {});
          }
        } catch (e) {
          console.error(`[VideoBuild] Presigned URL generation failed for build ${buildId}:`, e);
        }
      }
    }
    
    return c.json({ build });
  } catch (error) {
    console.error('[VideoBuild] Get error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get build' } }, 500);
  }
});

// ====================================================================
// PR-TL-1: GET /api/video-builds/:buildId/timeline
// ====================================================================
/**
 * GET /api/video-builds/:buildId/timeline
 * 
 * ビルド時点のタイムライン（シーン別 start_ms/duration_ms/end_ms）を返す
 * SSOT: R2に保存された project.json から取得（ビルド時点のスナップショット）
 * 
 * 用途:
 * - プレビュー再生位置 → 現在シーン特定
 * - チャット修正時の文脈設定
 * 
 * レスポンス:
 * {
 *   ok: true,
 *   build_id: 55,
 *   project_id: 69,
 *   project_json_hash: "a30f...",
 *   total_duration_ms: 131100,
 *   total_scenes: 6,
 *   scenes: [
 *     { idx: 1, scene_id: 660, title: "...", start_ms: 0, duration_ms: 9080, end_ms: 9080 },
 *     ...
 *   ]
 * }
 * 
 * エラーコード:
 * - NOT_FOUND: ビルドが存在しない
 * - PROJECT_JSON_NOT_FOUND: project_json_r2_key が null
 * - PROJECT_JSON_MISSING_IN_R2: R2にオブジェクトがない
 * - PROJECT_JSON_INVALID: JSONパース失敗
 * - TIMELINE_INVALID: scenes[].timing が欠損/NaN
 */
videoGeneration.get('/video-builds/:buildId/timeline', async (c) => {
  try {
    const buildId = parseInt(c.req.param('buildId'), 10);
    if (isNaN(buildId)) {
      return c.json({ ok: false, code: 'INVALID_BUILD_ID', message: 'Invalid build ID' }, 400);
    }
    
    // 1. video_builds からメタデータ取得
    const build = await c.env.DB.prepare(`
      SELECT id, project_id, project_json_r2_key, project_json_hash, total_duration_ms, total_scenes
      FROM video_builds WHERE id = ?
    `).bind(buildId).first<{
      id: number;
      project_id: number;
      project_json_r2_key: string | null;
      project_json_hash: string | null;
      total_duration_ms: number | null;
      total_scenes: number | null;
    }>();
    
    if (!build) {
      return c.json({ ok: false, code: 'NOT_FOUND', message: 'Build not found' }, 404);
    }
    
    // 2. project_json_r2_key の存在確認
    if (!build.project_json_r2_key) {
      return c.json({ 
        ok: false, 
        code: 'PROJECT_JSON_NOT_FOUND', 
        message: 'Project JSON was not saved for this build (project_json_r2_key is null)' 
      }, 404);
    }
    
    // 3. R2から project.json を取得
    let projectJsonObject;
    try {
      projectJsonObject = await c.env.R2.get(build.project_json_r2_key);
    } catch (r2Error) {
      console.error(`[Timeline] R2 get error for key ${build.project_json_r2_key}:`, r2Error);
      return c.json({ 
        ok: false, 
        code: 'PROJECT_JSON_MISSING_IN_R2', 
        message: 'Failed to retrieve project.json from R2' 
      }, 404);
    }
    
    if (!projectJsonObject) {
      return c.json({ 
        ok: false, 
        code: 'PROJECT_JSON_MISSING_IN_R2', 
        message: 'Project JSON object not found in R2' 
      }, 404);
    }
    
    // 4. JSONパース
    let projectJson: any;
    try {
      const jsonText = await projectJsonObject.text();
      projectJson = JSON.parse(jsonText);
    } catch (parseError) {
      console.error(`[Timeline] JSON parse error for build ${buildId}:`, parseError);
      return c.json({ 
        ok: false, 
        code: 'PROJECT_JSON_INVALID', 
        message: 'Failed to parse project.json' 
      }, 500);
    }
    
    // 5. scenes[].timing を抽出・検証
    const rawScenes = projectJson.scenes || [];
    if (!Array.isArray(rawScenes) || rawScenes.length === 0) {
      return c.json({ 
        ok: false, 
        code: 'TIMELINE_INVALID', 
        message: 'No scenes found in project.json' 
      }, 500);
    }
    
    const scenes: Array<{
      idx: number;
      scene_id: number | null;
      title: string;
      start_ms: number;
      duration_ms: number;
      end_ms: number;
    }> = [];
    
    for (let i = 0; i < rawScenes.length; i++) {
      const s = rawScenes[i];
      const timing = s.timing || {};
      
      // start_ms と duration_ms の検証
      const startMs = typeof timing.start_ms === 'number' && !isNaN(timing.start_ms) 
        ? timing.start_ms 
        : null;
      const durationMs = typeof timing.duration_ms === 'number' && !isNaN(timing.duration_ms) 
        ? timing.duration_ms 
        : null;
      
      if (startMs === null || durationMs === null) {
        console.warn(`[Timeline] Invalid timing for scene idx=${s.idx || i+1}: start_ms=${timing.start_ms}, duration_ms=${timing.duration_ms}`);
        return c.json({ 
          ok: false, 
          code: 'TIMELINE_INVALID', 
          message: `Invalid timing for scene ${s.idx || i+1}: start_ms or duration_ms is missing/NaN` 
        }, 500);
      }
      
      scenes.push({
        idx: s.idx || i + 1,
        scene_id: s.scene_id || s.id || null,  // project.json の構造により異なる可能性
        title: s.title || s.dialogue?.substring(0, 30) || `シーン ${s.idx || i + 1}`,
        start_ms: startMs,
        duration_ms: durationMs,
        end_ms: startMs + durationMs,
      });
    }
    
    // 6. 成功レスポンス
    return c.json({
      ok: true,
      build_id: build.id,
      project_id: build.project_id,
      project_json_hash: build.project_json_hash,
      total_duration_ms: build.total_duration_ms || scenes.reduce((sum, s) => sum + s.duration_ms, 0),
      total_scenes: scenes.length,
      scenes,
    });
    
  } catch (error) {
    console.error('[Timeline] Unexpected error:', error);
    return c.json({ 
      ok: false, 
      code: 'INTERNAL_ERROR', 
      message: 'Failed to get timeline' 
    }, 500);
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

// ====================================================================
// Issue 1: 動画プロンプト再編集 API
// ====================================================================

/**
 * PUT /api/video-generations/:id/prompt
 * 
 * プロンプトのみ更新（再生成しない）
 * 
 * ## SSOT
 * - video_generations.prompt がSSOT
 * - 更新後も status/r2_url は変更しない
 * - active の切替もしない
 * 
 * ## ユースケース
 * - 次回再生成用にプロンプトを事前に調整
 * - 誤ったプロンプトの修正（再生成なし）
 */
videoGeneration.put('/video-generations/:id/prompt', async (c) => {
  const { getCookie } = await import('hono/cookie');
  
  const videoId = parseInt(c.req.param('id'), 10);
  if (isNaN(videoId)) {
    return c.json({ error: { code: 'INVALID_ID', message: 'Invalid video generation ID' } }, 400);
  }
  
  // 認証確認
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
  
  const sessionUser = await c.env.DB.prepare(`
    SELECT s.user_id, u.role FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sessionId).first<{ user_id: number; role: string }>();
  
  if (!sessionUser) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401);
  }
  
  // リクエストボディ
  let body: { prompt?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'INVALID_BODY', message: 'Invalid JSON body' } }, 400);
  }
  
  if (!body.prompt || typeof body.prompt !== 'string') {
    return c.json({ error: { code: 'INVALID_PROMPT', message: 'Prompt is required' } }, 400);
  }
  
  // video_generation 取得
  const video = await c.env.DB.prepare(`
    SELECT vg.id, vg.scene_id, vg.prompt, vg.status, s.project_id, p.user_id as owner_user_id
    FROM video_generations vg
    JOIN scenes s ON vg.scene_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE vg.id = ?
  `).bind(videoId).first<{
    id: number;
    scene_id: number;
    prompt: string | null;
    status: string;
    project_id: number;
    owner_user_id: number;
  }>();
  
  if (!video) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Video generation not found' } }, 404);
  }
  
  // アクセス制御
  const isPrivileged = sessionUser.role === 'superadmin' || sessionUser.role === 'admin';
  if (!isPrivileged && video.owner_user_id !== sessionUser.user_id) {
    return c.json({ error: { code: 'ACCESS_DENIED', message: 'Access denied' } }, 403);
  }
  
  // プロンプト更新（statusやr2_urlは変更しない）
  await c.env.DB.prepare(`
    UPDATE video_generations 
    SET prompt = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(body.prompt.trim(), videoId).run();
  
  console.log(`[VideoGen] Prompt updated: video_id=${videoId}, old_prompt="${video.prompt?.substring(0, 50)}...", new_prompt="${body.prompt.substring(0, 50)}..."`);
  
  return c.json({
    success: true,
    video_generation: {
      id: videoId,
      scene_id: video.scene_id,
      prompt: body.prompt.trim(),
      status: video.status,
    },
    message: 'プロンプトを更新しました（再生成は別途実行してください）'
  });
});

/**
 * POST /api/scenes/:sceneId/video-regenerate
 * 
 * 動画を再生成（新しい video_generation を作成）
 * 
 * ## SSOT
 * - 新しい video_generations レコードを INSERT
 * - 成功時のみ is_active を切替
 * - 失敗時は旧 active を維持（事故防止）
 * 
 * ## フロー
 * 1. 新 video_generations を INSERT (is_active=0, status='generating')
 * 2. Veo API 呼び出し
 * 3. 成功時:
 *    - 新レコード is_active=1
 *    - 旧 active を is_active=0
 * 4. 失敗時:
 *    - 新レコード status='failed'
 *    - active 切替なし
 */
videoGeneration.post('/:sceneId/video-regenerate', async (c) => {
  const { getCookie } = await import('hono/cookie');
  
  const sceneId = parseInt(c.req.param('sceneId'), 10);
  if (isNaN(sceneId)) {
    return c.json({ error: { code: 'INVALID_SCENE_ID', message: 'Invalid scene ID' } }, 400);
  }
  
  // 認証確認
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
  
  const sessionUser = await c.env.DB.prepare(`
    SELECT s.user_id, u.role FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sessionId).first<{ user_id: number; role: string }>();
  
  if (!sessionUser) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401);
  }
  
  // リクエストボディ（prompt はオプション）
  let body: { prompt?: string; model?: string; duration_sec?: number } = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body is OK
  }
  
  // シーン + プロジェクト情報取得
  const scene = await c.env.DB.prepare(`
    SELECT s.id, s.project_id, s.dialogue, p.user_id as owner_user_id
    FROM scenes s
    JOIN projects p ON p.id = s.project_id
    WHERE s.id = ?
  `).bind(sceneId).first<{
    id: number;
    project_id: number;
    dialogue: string;
    owner_user_id: number;
  }>();
  
  if (!scene) {
    return c.json({ error: { code: 'SCENE_NOT_FOUND', message: 'Scene not found' } }, 404);
  }
  
  // アクセス制御
  const isPrivileged = sessionUser.role === 'superadmin' || sessionUser.role === 'admin';
  if (!isPrivileged && scene.owner_user_id !== sessionUser.user_id) {
    return c.json({ error: { code: 'ACCESS_DENIED', message: 'Access denied' } }, 403);
  }
  
  // 現在の active_video からプロンプトを取得（上書きされていなければ）
  const currentActive = await c.env.DB.prepare(`
    SELECT id, prompt, model, duration_sec, source_image_r2_key
    FROM video_generations
    WHERE scene_id = ? AND is_active = 1
    ORDER BY id DESC
    LIMIT 1
  `).bind(sceneId).first<{
    id: number;
    prompt: string | null;
    model: string | null;
    duration_sec: number;
    source_image_r2_key: string;
  }>();
  
  // プロンプト決定: body.prompt > currentActive.prompt > scene.dialogue
  const finalPrompt = body.prompt?.trim() || currentActive?.prompt || scene.dialogue || '';
  
  if (!finalPrompt) {
    return c.json({ 
      error: { code: 'NO_PROMPT', message: 'Prompt is required for video regeneration' } 
    }, 400);
  }
  
  // Active image 取得（再生成に必要）
  const activeImage = await getSceneActiveImage(c.env.DB, sceneId);
  if (!activeImage) {
    return c.json({
      error: {
        code: 'NO_ACTIVE_IMAGE',
        message: 'No active image for this scene. Generate and activate an image first.',
      },
    }, 400);
  }
  
  // 競合チェック
  await detectAndMarkStuckJobs(c.env.DB, sceneId);
  
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
  
  // モデルとduration決定
  const model = body.model || currentActive?.model || 'veo-2.0-generate-001';
  const durationSec = body.duration_sec || currentActive?.duration_sec || 5;
  const videoEngine: VideoEngine = model.includes('veo-3') ? 'veo3' : 'veo2';
  
  // 課金判定（既存ロジックを再利用）
  const isSuperadmin = sessionUser.role === 'superadmin';
  let billingSource: BillingSource = 'user';
  let sponsorUserId: number | null = null;
  
  if (isSuperadmin) {
    billingSource = 'sponsor';
    sponsorUserId = sessionUser.user_id;
  } else {
    const billingInfo = await determineBillingSource(
      c.env.DB, scene.project_id, scene.owner_user_id
    );
    billingSource = billingInfo.billingSource;
    sponsorUserId = billingInfo.sponsorUserId;
  }
  
  const executorUserId = sessionUser.user_id;
  const billingUserId = billingSource === 'sponsor' && sponsorUserId 
    ? sponsorUserId 
    : executorUserId;
  
  console.log(`[VideoRegenerate] Starting: scene_id=${sceneId}, prompt="${finalPrompt.substring(0, 50)}...", model=${model}, billing=${billingSource}`);
  
  // 新しい video_generation を作成（is_active=0）
  const insertResult = await c.env.DB.prepare(`
    INSERT INTO video_generations (
      scene_id, user_id, provider, model, status,
      duration_sec, prompt, source_image_r2_key, is_active
    ) VALUES (?, ?, 'google_veo', ?, 'generating', ?, ?, ?, 0)
  `).bind(
    sceneId,
    executorUserId,
    model,
    durationSec,
    finalPrompt,
    activeImage.r2_key
  ).run();
  
  const newVideoId = insertResult.meta.last_row_id as number;
  
  // Veo API 呼び出し（既存のgenerate-videoと同じロジック）
  // ここでは簡略化のため、generate-video エンドポイントを内部呼び出しするのではなく
  // 直接 AWS Video Proxy を呼び出す
  
  const keyRing = [
    c.env.ENCRYPTION_KEY,
    c.env.ENCRYPTION_KEY_OLD_1,
    c.env.ENCRYPTION_KEY_OLD_2
  ].filter(Boolean) as string[];
  
  let apiKey: string | null = null;
  let vertexSaJson: string | null = null;
  let vertexProjectId: string | null = null;
  let vertexLocation: string | null = null;
  
  if (videoEngine === 'veo2') {
    if (isSuperadmin || billingSource === 'sponsor') {
      apiKey = c.env.GEMINI_API_KEY || null;
    } else {
      const keyResult = await getUserApiKeyWithKeyRing(
        c.env.DB, billingUserId, 'google_gemini', keyRing
      );
      if (keyResult.key) {
        apiKey = keyResult.key;
      }
    }
  } else {
    // veo3: Vertex AI
    if (isSuperadmin || billingSource === 'sponsor') {
      vertexSaJson = c.env.VERTEX_SA_JSON || null;
      vertexProjectId = c.env.VERTEX_PROJECT_ID || null;
      vertexLocation = c.env.VERTEX_LOCATION || 'us-central1';
    } else {
      const saResult = await getUserApiKeyWithKeyRing(
        c.env.DB, billingUserId, 'google_vertex_sa', keyRing
      );
      if (saResult.key) {
        try {
          const parsed = JSON.parse(saResult.key);
          vertexSaJson = saResult.key;
          vertexProjectId = parsed.project_id;
        } catch {}
      }
      const locationResult = await getUserApiKeyWithKeyRing(
        c.env.DB, billingUserId, 'google_vertex_location', keyRing
      );
      if (locationResult.key) {
        vertexLocation = locationResult.key;
      }
    }
  }
  
  // API呼び出し
  const awsVideoProxyUrl = c.env.AWS_VIDEO_PROXY_URL;
  if (!awsVideoProxyUrl) {
    await c.env.DB.prepare(`
      UPDATE video_generations SET status = 'failed', error_message = 'AWS Video Proxy URL not configured'
      WHERE id = ?
    `).bind(newVideoId).run();
    
    return c.json({
      error: { code: 'CONFIG_ERROR', message: 'Video generation service not configured' }
    }, 500);
  }
  
  // Signed URL for source image
  const signedImageUrl = await generateSignedImageUrl(
    c.env.R2, activeImage.r2_key, c.env.IMAGE_SIGNING_KEY, 3600
  );
  
  if (!signedImageUrl) {
    await c.env.DB.prepare(`
      UPDATE video_generations SET status = 'failed', error_message = 'Failed to generate signed URL for source image'
      WHERE id = ?
    `).bind(newVideoId).run();
    
    return c.json({
      error: { code: 'IMAGE_ERROR', message: 'Failed to access source image' }
    }, 500);
  }
  
  // AWS Video Proxy Client
  const awsClient = createAwsVideoClient({
    baseUrl: awsVideoProxyUrl,
    apiKey: apiKey || undefined,
    vertexSaJson: vertexSaJson || undefined,
    vertexProjectId: vertexProjectId || undefined,
    vertexLocation: vertexLocation || undefined,
    accessKeyId: c.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY || '',
  });
  
  try {
    const result = await awsClient.generateVideo({
      image_url: signedImageUrl,
      prompt: finalPrompt,
      duration_sec: durationSec,
      video_engine: videoEngine,
      model: model,
    });
    
    if (!result.job_id) {
      throw new Error('No job_id returned from video generation service');
    }
    
    // job_id を保存
    await c.env.DB.prepare(`
      UPDATE video_generations SET job_id = ? WHERE id = ?
    `).bind(result.job_id, newVideoId).run();
    
    console.log(`[VideoRegenerate] Started: video_id=${newVideoId}, job_id=${result.job_id}`);
    
    return c.json({
      success: true,
      video_generation: {
        id: newVideoId,
        scene_id: sceneId,
        prompt: finalPrompt,
        model: model,
        status: 'generating',
        job_id: result.job_id,
      },
      message: '動画生成を開始しました（完了後に自動でアクティブになります）'
    }, 201);
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    await c.env.DB.prepare(`
      UPDATE video_generations SET status = 'failed', error_message = ?
      WHERE id = ?
    `).bind(errorMessage.substring(0, 500), newVideoId).run();
    
    console.error(`[VideoRegenerate] Failed: video_id=${newVideoId}, error=${errorMessage}`);
    
    return c.json({
      error: {
        code: 'GENERATION_FAILED',
        message: '動画生成の開始に失敗しました',
        details: errorMessage,
      }
    }, 500);
  }
});

export default videoGeneration;
