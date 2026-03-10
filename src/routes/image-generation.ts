import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Bindings } from '../types/bindings'
import { buildImagePrompt, buildR2Key, composeStyledPrompt } from '../utils/image-prompt-builder'
import {
  createJob, fetchAndLockJob, completeJob, failJob, handleRateLimit,
  getJobProgress, areAllJobsDone, recordProviderMetric,
  type JobRow,
} from '../utils/job-queue'
import {
  generateImageWithRetry as sharedGenerateImage,
  GEMINI_IMAGE_MODEL,
  type GeminiReferenceImage,
  type GeminiImageOptions,
  type GeminiImageResult,
} from '../utils/gemini-image-client'
import { decryptApiKey } from '../utils/crypto'
import { getOutputPreset } from '../utils/output-presets'
import { fetchWorldSettings, fetchSceneCharacters, enhancePromptWithWorldAndCharacters } from '../utils/world-character-helper'
import { fetchSceneStyleSettings, fetchStylePreset, composeFinalPrompt, getEffectiveStylePresetId } from '../utils/style-prompt-composer'
import { getSceneReferenceImages } from '../utils/character-reference-helper'

/**
 * P1-5: generating スタックのタイムアウト閾値（統一: 3分）
 * status endpoint と batch の両方でこの値を使用する
 */
const STUCK_GENERATING_TIMEOUT_MINUTES = 3

// ===== Constants =====
/**
 * プロンプトの最大長（Gemini API推奨上限）
 * 長すぎるプロンプトはトークン制限に達する可能性がある
 */
const MAX_PROMPT_LENGTH = 8000;

/**
 * R2アップロードの最大リトライ回数
 */
const MAX_R2_RETRIES = 3;

/**
 * R2アップロードの初期待機時間（ミリ秒）
 */
const R2_RETRY_BASE_DELAY_MS = 1000;

/**
 * R2に画像をアップロード（リトライ機構付き）
 * 指数バックオフでリトライ: 1s, 2s, 4s
 * 
 * @param r2 - R2 Bucket インスタンス
 * @param key - R2 オブジェクトキー
 * @param data - アップロードするデータ
 * @param maxRetries - 最大リトライ回数（デフォルト: MAX_R2_RETRIES）
 * @returns アップロード結果
 */
async function uploadToR2WithRetry(
  r2: R2Bucket,
  key: string,
  data: ArrayBuffer,
  maxRetries: number = MAX_R2_RETRIES
): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await r2.put(key, data);
      console.log(`[R2 Upload] Success: ${key} (attempt ${attempt + 1})`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown R2 error';
      console.warn(`[R2 Upload] Attempt ${attempt + 1}/${maxRetries} failed for ${key}: ${errorMessage}`);
      
      if (attempt < maxRetries - 1) {
        // 指数バックオフ: 1s, 2s, 4s
        const waitTime = R2_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[R2 Upload] Retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        // 最終試行も失敗
        console.error(`[R2 Upload] All retries failed for ${key}`);
        return { 
          success: false, 
          error: `R2 upload failed after ${maxRetries} attempts: ${errorMessage}` 
        };
      }
    }
  }
  
  // このコードには到達しないはずだが、TypeScriptの型チェックのため
  return { success: false, error: 'Unexpected error in R2 upload' };
}

/**
 * 参照画像の型定義（キャラクター一貫性用）
 */
interface ReferenceImage {
  base64Data: string
  mimeType: string
  characterName?: string
}

// ===== Validation Helpers =====
/**
 * プロンプトの安全な取得（null/undefined対応、長さ制限）
 * @param prompt - 元のプロンプト
 * @returns サニタイズされたプロンプト
 */
function sanitizePrompt(prompt: string | null | undefined): string {
  if (!prompt) return '';
  const trimmed = prompt.trim();
  if (trimmed.length > MAX_PROMPT_LENGTH) {
    console.warn(`[Image Gen] Prompt truncated: ${trimmed.length} -> ${MAX_PROMPT_LENGTH} chars`);
    return trimmed.slice(0, MAX_PROMPT_LENGTH);
  }
  return trimmed;
}

/**
 * プロジェクトIDの安全なパース
 * @param id - 文字列のID
 * @returns 数値のID、または無効な場合はnull
 */
function parseProjectId(id: string | null | undefined): number | null {
  if (!id) return null;
  const parsed = parseInt(id, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * シーンIDの安全なパース
 * @param id - 文字列のID
 * @returns 数値のID、または無効な場合はnull
 */
function parseSceneId(id: string | null | undefined): number | null {
  if (!id) return null;
  const parsed = parseInt(id, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

const imageGeneration = new Hono<{ Bindings: Bindings }>()

// ===== Image Generation Logging =====
interface ImageGenerationLogParams {
  env: Bindings;
  userId?: number;
  projectId?: number;
  sceneId?: number;
  characterKey?: string;
  generationType: 'scene_image' | 'character_preview' | 'character_reference';
  provider: string;
  model: string;
  apiKeySource: 'user' | 'system' | 'sponsor';
  sponsorUserId?: number;
  promptLength?: number;
  imageCount?: number;
  imageSize?: string;
  imageQuality?: string;
  status: 'success' | 'failed' | 'quota_exceeded';
  errorMessage?: string;
  errorCode?: string;
  referenceImageCount?: number;
}

// コスト推定関数（画像生成）
// 2026-02-26 Google 公式レート:
//
// ★ Nano Banana 2 (gemini-3.1-flash-image-preview):
//   1K (1024x1024): $0.067/image
//   2K (2048x2048): $0.101/image
//   4K (4096x4096): $0.151/image
//
// ★ Nano Banana Pro (gemini-3-pro-image-preview): [deprecated, replaced by Nano Banana 2]
//   $0.134/image (1K/2K), $0.24/image (4K)
//
// ★ Imagen 4: $0.02 (fast) / $0.04 (standard) / $0.06 (ultra) per image
// ★ OpenAI DALL-E 3: ~$0.04/image (1024x1024)
function estimateImageGenerationCost(provider: string, model: string, imageCount: number = 1): number {
  if (provider === 'gemini') {
    // Nano Banana 2 (gemini-3.1-flash-image-preview) — default model
    if (model.includes('3.1-flash-image') || model.includes('3-1-flash-image')) {
      return 0.067 * imageCount;  // 1K resolution (default)
    }
    // Legacy: Nano Banana Pro (gemini-3-pro-image-preview)
    if (model.includes('gemini-3') || model.includes('3-pro-image')) {
      return 0.134 * imageCount;
    }
    // Imagen models
    if (model.includes('imagen')) return 0.04 * imageCount;
    // Nano Banana (gemini-2.5-flash-image) and other Gemini image models
    return 0.067 * imageCount;  // Default to Nano Banana 2 rate
  }
  if (provider === 'openai') {
    if (model.includes('dall-e-3')) return 0.04 * imageCount;
  }
  // Unknown provider: assume ~$0.067/image (Nano Banana 2 rate)
  return 0.067 * imageCount;
}

// 画像生成ログ記録
async function logImageGeneration(params: ImageGenerationLogParams): Promise<void> {
  try {
    const estimatedCost = estimateImageGenerationCost(params.provider, params.model, params.imageCount);
    
    await params.env.DB.prepare(`
      INSERT INTO image_generation_logs (
        user_id, project_id, scene_id, character_key,
        generation_type, provider, model,
        api_key_source, sponsor_user_id,
        prompt_length, image_count, image_size, image_quality,
        estimated_cost_usd, billing_unit, billing_amount,
        status, error_message, error_code,
        reference_image_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      params.userId ?? 1, // デフォルトユーザー
      params.projectId ?? null,
      params.sceneId ?? null,
      params.characterKey ?? null,
      params.generationType,
      params.provider,
      params.model,
      params.apiKeySource,
      params.sponsorUserId ?? null,
      params.promptLength ?? null,
      params.imageCount ?? 1,
      params.imageSize ?? null,
      params.imageQuality ?? null,
      estimatedCost,
      'image', // billing_unit
      params.imageCount ?? 1, // billing_amount
      params.status,
      params.errorMessage ?? null,
      params.errorCode ?? null,
      params.referenceImageCount ?? 0
    ).run();
    
    console.log(`[Image Generation] Logged: type=${params.generationType}, scene=${params.sceneId}, keySource=${params.apiKeySource}, cost=$${estimatedCost.toFixed(4)}, status=${params.status}`);
  } catch (error) {
    // ログ記録の失敗は無視（本体処理に影響させない）
    console.error('[Image Generation] Failed to log:', error);
  }
}

// ===== API Key Management =====
interface ApiKeyResult {
  apiKey: string;
  source: 'user' | 'system';
  userId?: number;
}

/**
 * APIキー取得（優先順位: ユーザーキー → システムキー）
 * クォータ超過時のフォールバックもサポート
 */
async function getApiKey(
  c: { env: Bindings; req?: any },
  options?: { skipUserKey?: boolean }
): Promise<ApiKeyResult | null> {
  // Step 1: ユーザーAPIキーを試行（skipUserKey でなければ）
  if (!options?.skipUserKey) {
    try {
      const sessionId = typeof c.req !== 'undefined' ? getCookie(c as any, 'session') : null;
      
      if (sessionId) {
        const session = await c.env.DB.prepare(`
          SELECT user_id FROM sessions WHERE id = ? AND expires_at > datetime('now')
        `).bind(sessionId).first<{ user_id: number }>();
        
        if (session) {
          const keyRecord = await c.env.DB.prepare(`
            SELECT encrypted_key FROM user_api_keys
            WHERE user_id = ? AND provider = 'google'
          `).bind(session.user_id).first<{ encrypted_key: string }>();
          
          if (keyRecord?.encrypted_key) {
            try {
              const apiKey = await decryptApiKey(keyRecord.encrypted_key, c.env.ENCRYPTION_KEY);
              console.log(`[Image Gen] Using USER API key for user_id=${session.user_id}`);
              return { apiKey, source: 'user', userId: session.user_id };
            } catch (decryptError) {
              console.warn('[Image Gen] Failed to decrypt user API key:', decryptError);
            }
          }
        }
      }
    } catch (error) {
      console.warn('[Image Gen] Error getting user API key:', error);
    }
  }
  
  // Step 2: システムAPIキーにフォールバック
  if (c.env.GEMINI_API_KEY) {
    console.log(`[Image Gen] Using SYSTEM GEMINI_API_KEY`);
    return { apiKey: c.env.GEMINI_API_KEY, source: 'system' };
  }
  
  // Step 3: キーなし
  console.error('[Image Gen] No API key available');
  return null;
}

/**
 * 画像生成（クォータ超過時のフォールバック付き）
 * ユーザーキーでクォータ超過 → システムキーで再試行
 * 
 * @param c - Hono Context
 * @param prompt - 画像生成プロンプト
 * @param referenceImages - キャラクター参照画像
 * @param options - 生成オプション（アスペクト比、指示スキップ）
 */
async function generateImageWithFallback(
  c: { env: Bindings; req?: any },
  prompt: string,
  referenceImages: ReferenceImage[],
  options: ImageGenerationOptions = {}
): Promise<{
  success: boolean;
  imageData?: ArrayBuffer;
  error?: string;
  apiKeySource: 'user' | 'system';
  userId?: number;
  durationMs?: number;
}> {
  // Step 1: APIキー取得
  const preferSystem = options.preferSystemKey && c.env.GEMINI_API_KEY;
  
  let keyResult: ApiKeyResult | null;
  if (preferSystem) {
    keyResult = { apiKey: c.env.GEMINI_API_KEY!, source: 'system' };
    console.log(`[Image Gen] Using SYSTEM key (preferSystemKey=true)`);
  } else {
    keyResult = await getApiKey(c);
  }
  
  console.log(`[Image Gen] API Key Status: source=${keyResult?.source}, systemKeyConfigured=${!!c.env.GEMINI_API_KEY}`);
  
  if (!keyResult) {
    return {
      success: false,
      error: 'No API key configured. Please configure your Google API key in Settings, or contact admin to configure system GEMINI_API_KEY.',
      apiKeySource: 'system'
    };
  }
  
  // Convert ReferenceImage → GeminiReferenceImage
  const geminiRefs: GeminiReferenceImage[] = referenceImages.map(r => ({
    base64Data: r.base64Data,
    mimeType: r.mimeType,
    characterName: r.characterName,
  }));
  
  const geminiOpts: GeminiImageOptions = {
    aspectRatio: options.aspectRatio,
    skipDefaultInstructions: options.skipDefaultInstructions,
    maxRetries: 3,
  };
  
  // Step 2: 最初の試行 (★ SSOT: sharedGenerateImage 使用)
  console.log(`[Image Gen] Attempting with ${keyResult.source} API key, aspectRatio: ${options.aspectRatio || '16:9'}`);
  const result = await sharedGenerateImage(prompt, keyResult.apiKey, geminiRefs, geminiOpts);
  
  // Step 3: 成功 → そのまま返却
  if (result.success) {
    return { ...result, apiKeySource: keyResult.source, userId: keyResult.userId };
  }
  
  // Step 4: クォータ超過時のフォールバック
  const isQuotaError = result.error?.toLowerCase().includes('quota') || 
                       result.error?.toLowerCase().includes('resource_exhausted') ||
                       result.error?.includes('429') ||
                       result.error?.includes('RATE_LIMIT_429');
  
  console.log(`[Image Gen] Failed. source=${keyResult.source}, isQuotaError=${isQuotaError}, error=${result.error?.substring(0, 150)}`);
  
  // ユーザーキー → システムキーフォールバック
  if (keyResult.source === 'user' && isQuotaError && c.env.GEMINI_API_KEY) {
    console.log(`[Image Gen] User key quota exceeded, falling back to SYSTEM key`);
    const systemResult = await sharedGenerateImage(
      prompt, c.env.GEMINI_API_KEY, geminiRefs, { ...geminiOpts, maxRetries: 3 }
    );
    if (systemResult.success) console.log(`[Image Gen] SUCCESS with SYSTEM key fallback`);
    return { ...systemResult, apiKeySource: 'system', userId: keyResult.userId };
  }
  
  // システムキー → ユーザーキーフォールバック
  if (keyResult.source === 'system' && isQuotaError) {
    const userKeyResult = await getApiKey(c, { skipUserKey: false });
    if (userKeyResult && userKeyResult.source === 'user' && userKeyResult.apiKey !== keyResult.apiKey) {
      console.log(`[Image Gen] System key quota exceeded, trying USER key`);
      const userResult = await sharedGenerateImage(
        prompt, userKeyResult.apiKey, geminiRefs, { ...geminiOpts, maxRetries: 3 }
      );
      if (userResult.success) {
        return { ...userResult, apiKeySource: 'user', userId: userKeyResult.userId };
      }
    }
    console.log(`[Image Gen] No alternative key available`);
  }
  
  return { ...result, apiKeySource: keyResult.source, userId: keyResult.userId };
}

// POST /api/projects/:id/generate-images - バッチ画像生成
// ★ DEPRECATED: Legacy endpoint — internally redirects to generate-all-images (job_queue)
// フロントエンドの updateProgressBar がこのAPIをポーリングしているため、
// 互換性のため残すが、内部的に generate-all-images と同じロジックを使用
imageGeneration.post('/projects/:id/generate-images', async (c) => {
  try {
    const projectIdRaw = c.req.param('id')
    const projectId = parseProjectId(projectIdRaw)
    if (!projectId) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid project ID' } }, 400)
    }

    // プロジェクト情報取得
    const project = await c.env.DB.prepare(`
      SELECT id, status, output_preset, user_id FROM projects WHERE id = ?
    `).bind(projectId).first<{ id: number; status: string; output_preset: string | null; user_id: number }>()

    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404)
    }

    const outputPreset = getOutputPreset(project.output_preset)
    const aspectRatio = outputPreset.aspect_ratio

    // ステータスチェック
    const allowedStatuses = ['formatted', 'generating_images', 'completed']
    if (!allowedStatuses.includes(project.status as string)) {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot generate images for project with status: ${project.status}`,
          details: { current_status: project.status, allowed_statuses: allowedStatuses }
        }
      }, 400)
    }

    // ★ DEPRECATED: Legacy endpoint — 内部的に generate-all-images と同じロジックに委譲
    // フロントエンドの互換性のため残すが、mode='pending' で pending シーンのみ処理
    console.log(`[Legacy→JQ] /generate-images called for project ${projectId}, delegating to generate-all-images logic (mode=pending)`);

    // ステータスを 'generating_images' に
    if (project.status === 'formatted') {
      await c.env.DB.prepare(`
        UPDATE projects SET status = 'generating_images', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(projectId).run()
    }

    // ★ P1-5: スタック generating レコードのタイムアウト処理 (統一定数使用)
    await cleanupStuckGenerations(c.env.DB, projectId);

    // ★ Job Queue: pending シーンのジョブを作成
    const { results: pendingScenes } = await c.env.DB.prepare(`
      SELECT s.id, s.idx, s.image_prompt, s.is_prompt_customized
      FROM scenes s
      LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
      WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL) AND ig.id IS NULL
      ORDER BY s.idx ASC
    `).bind(projectId).all()

    if (pendingScenes.length === 0) {
      // 全scenes処理済み → status を 'completed' に
      await c.env.DB.prepare(`
        UPDATE projects SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(projectId).run()
      const stats = await getImageGenerationStats(c.env.DB, String(projectId))
      return c.json({ project_id: projectId, status: 'completed', ...stats, message: 'All images generated' }, 200)
    }

    // Create jobs for pending scenes
    for (const scene of pendingScenes) {
      await createJob(c.env.DB, {
        userId: project.user_id || 1,
        projectId,
        jobType: 'generate_image',
        provider: 'gemini_image',
        entityType: 'scene',
        entityId: scene.id as number,
        payload: {
          sceneId: scene.id,
          sceneIdx: scene.idx,
          imagePrompt: scene.image_prompt || '',
          aspectRatio,
          isPromptCustomized: scene.is_prompt_customized === 1,
          mode: 'pending',
        },
      })
    }

    // ★ Process ONE job immediately via shared helper
    const { successCount, failedCount } = await processOneImageJob(c, projectId, aspectRatio)

    // Return stats compatible with legacy format
    const stats = await getImageGenerationStats(c.env.DB, String(projectId))
    return c.json({
      project_id: projectId,
      status: 'generating_images',
      batch_processed: successCount,
      batch_failed: failedCount,
      ...stats
    }, 200)

  } catch (error) {
    console.error('Batch image generation error:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate images' } }, 500)
  }
})

// GET /api/projects/:id/generate-images/status - 画像生成進捗取得
imageGeneration.get('/projects/:id/generate-images/status', async (c) => {
  try {
    const projectId = c.req.param('id')

    const project = await c.env.DB.prepare(`
      SELECT id, status FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (!project) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Project not found' }
      }, 404)
    }

    // ★ P1-5: Auto-cleanup stuck 'generating' records (統一: STUCK_GENERATING_TIMEOUT_MINUTES)
    try {
      await cleanupStuckGenerations(c.env.DB, parseInt(projectId));
    } catch (cleanupErr) {
      console.warn('[Image Status] Auto-cleanup failed:', cleanupErr)
    }

    const stats = await getImageGenerationStats(c.env.DB, projectId)

    return c.json({
      project_id: parseInt(projectId),
      status: project.status,
      ...stats
    })

  } catch (error) {
    console.error('Error getting image generation status:', error)
    return c.json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get status' }
    }, 500)
  }
})

// 画像生成統計を取得
async function getImageGenerationStats(db: any, projectId: string) {
  // Total scenes count (⚠️ is_hidden = 0 で非表示シーンを除外)
  const { results: scenesCount } = await db.prepare(`
    SELECT COUNT(*) as total FROM scenes WHERE project_id = ? AND (is_hidden = 0 OR is_hidden IS NULL)
  `).bind(projectId).all()

  const totalScenes = scenesCount[0]?.total || 0

  // Image generation stats
  // ⚠️ is_hidden = 0 で非表示シーンを除外（統計の整合性維持）
  const { results: imageStats } = await db.prepare(`
    SELECT ig.status, COUNT(*) as count
    FROM image_generations ig
    JOIN scenes s ON ig.scene_id = s.id
    WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL) AND ig.is_active = 1
    GROUP BY ig.status
  `).bind(projectId).all()

  const statusMap = new Map(imageStats.map((s: any) => [s.status, s.count]))
  const completed = statusMap.get('completed') || 0
  const failed = statusMap.get('failed') || 0
  const generating = statusMap.get('generating') || 0

  return {
    total_scenes: totalScenes,
    processed: completed,
    failed: failed,
    generating: generating,
    pending: totalScenes - completed - failed - generating
  }
}

// ===== Shared Helpers (P0-2, P0-3, P1-4, P1-5 統一) =====

/**
 * P1-5: スタック generating レコードのクリーンアップ (統一定数使用)
 * status endpoint と batch の両方から呼ばれる共通関数
 */
async function cleanupStuckGenerations(db: any, projectId: number): Promise<number> {
  const timeoutMinutes = `-${STUCK_GENERATING_TIMEOUT_MINUTES} minutes`
  const errorMsg = `Generation timeout (stuck for >${STUCK_GENERATING_TIMEOUT_MINUTES} minutes)`
  const cleanupResult = await db.prepare(`
    UPDATE image_generations
    SET status = 'failed',
        error_message = ?,
        ended_at = datetime('now')
    WHERE status = 'generating'
      AND scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
      AND COALESCE(started_at, created_at) < datetime('now', ?)
  `).bind(errorMsg, projectId, timeoutMinutes).run()

  if (cleanupResult.meta.changes > 0) {
    console.log(`[Image Gen] Auto-cleaned ${cleanupResult.meta.changes} stuck generating records (>${STUCK_GENERATING_TIMEOUT_MINUTES}min) for project ${projectId}`)
  }
  return cleanupResult.meta.changes || 0
}

/**
 * P0-2/P0-3: 1つのジョブを取得・実行する共通ヘルパー
 * Legacy batch と generate-all-images の両方から呼ばれる。
 * 
 * ★ P0-3: is_active=0 で INSERT → 成功時のみ is_active=1 に更新 (排他制御)
 * ★ P1-2: recordProviderMetric にモデル名を渡す
 * ★ P1-4: 全経路で ended_at を記録
 */
async function processOneImageJob(
  c: { env: Bindings; req?: any },
  projectId: number,
  aspectRatio: string
): Promise<{ successCount: number; failedCount: number }> {
  const job = await fetchAndLockJob(c.env.DB, 'gemini_image', projectId)
  let successCount = 0
  let failedCount = 0

  if (!job) {
    return { successCount, failedCount }
  }

  const payload = JSON.parse(job.payload_json) as {
    sceneId: number; sceneIdx: number; imagePrompt: string;
    aspectRatio: string; isPromptCustomized: boolean
  }

  try {
    // Build prompt
    let enhancedPrompt = buildImagePrompt(payload.imagePrompt)
    let referenceImages: ReferenceImage[] = []

    try {
      const characters = await fetchSceneCharacters(c.env.DB, payload.sceneId)
      if (!payload.isPromptCustomized) {
        const world = await fetchWorldSettings(c.env.DB, projectId)
        enhancedPrompt = enhancePromptWithWorldAndCharacters(enhancedPrompt, world, characters)
      }
      const refs = await getSceneReferenceImages(c.env.DB, c.env.R2, payload.sceneId, 5, c.env.DEBUG_REFERENCE_IMAGES === '1')
      referenceImages = refs.map(img => ({ base64Data: img.base64Data, mimeType: img.mimeType, characterName: img.characterName }))
    } catch (charError) {
      console.warn(`[Image Job] Failed to fetch characters for scene ${payload.sceneId}:`, charError)
    }

    const styleSettings = await fetchSceneStyleSettings(c.env.DB, payload.sceneId, projectId)
    const effectiveStyleId = getEffectiveStylePresetId(styleSettings)
    const stylePreset = await fetchStylePreset(c.env.DB, effectiveStyleId)
    const finalPrompt = composeFinalPrompt(enhancedPrompt, stylePreset)

    // ★ P0-3: is_active=0 で INSERT (成功時のみ activate)
    const insertResult = await c.env.DB.prepare(`
      INSERT INTO image_generations (scene_id, prompt, status, provider, model, is_active, started_at)
      VALUES (?, ?, 'generating', 'gemini', ?, 0, datetime('now'))
    `).bind(payload.sceneId, finalPrompt, GEMINI_IMAGE_MODEL).run()
    const generationId = insertResult.meta.last_row_id as number

    // Generate image (with fallback)
    const effectiveAspectRatio = payload.aspectRatio || aspectRatio
    const imageResult = await generateImageWithFallback(c, finalPrompt, referenceImages, {
      aspectRatio: effectiveAspectRatio as any,
      skipDefaultInstructions: payload.isPromptCustomized,
    })

    if (!imageResult.success) {
      // ★ P1-4: ended_at 記録
      await c.env.DB.prepare(`
        UPDATE image_generations SET status = 'failed', error_message = ?, ended_at = datetime('now') WHERE id = ?
      `).bind(imageResult.error || 'Unknown error', generationId).run()

      const isRateLimited = imageResult.error?.includes('429') || imageResult.error?.includes('RATE_LIMIT')
      if (isRateLimited) {
        await handleRateLimit(c.env.DB, job.id, 'gemini_image')
        await c.env.DB.prepare(`UPDATE image_generations SET is_active = 0 WHERE id = ?`).bind(generationId).run()
        // ★ P1-2: モデル名付きメトリクス記録
        await recordProviderMetric(c.env.DB, 'gemini_image', 'error_429', undefined, GEMINI_IMAGE_MODEL)
      } else {
        await failJob(c.env.DB, job.id, 'GENERATION_FAILED', (imageResult.error || 'Unknown').substring(0, 500), job.retry_count, job.max_retries)
        await recordProviderMetric(c.env.DB, 'gemini_image', 'error_other', undefined, GEMINI_IMAGE_MODEL)
      }

      await logImageGeneration({
        env: c.env, userId: imageResult.userId ?? 1, projectId,
        sceneId: payload.sceneId, generationType: 'scene_image', provider: 'gemini',
        model: GEMINI_IMAGE_MODEL, apiKeySource: imageResult.apiKeySource,
        promptLength: finalPrompt.length, referenceImageCount: referenceImages.length,
        status: isRateLimited ? 'quota_exceeded' : 'failed',
        errorMessage: imageResult.error || 'Unknown',
        errorCode: isRateLimited ? 'QUOTA_EXCEEDED' : 'GENERATION_FAILED'
      })

      failedCount++
    } else {
      // R2 upload
      const r2Key = buildR2Key(projectId, payload.sceneIdx, generationId)
      const r2UploadResult = await uploadToR2WithRetry(c.env.R2, r2Key, imageResult.imageData!)

      if (!r2UploadResult.success) {
        // ★ P1-4: ended_at 記録
        await c.env.DB.prepare(`
          UPDATE image_generations SET status = 'failed', error_message = ?, ended_at = datetime('now') WHERE id = ?
        `).bind(r2UploadResult.error || 'R2 upload failed', generationId).run()
        await failJob(c.env.DB, job.id, 'R2_UPLOAD_FAILED', r2UploadResult.error || 'R2 upload failed', job.retry_count, job.max_retries)
        await recordProviderMetric(c.env.DB, 'gemini_image', 'error_other', undefined, GEMINI_IMAGE_MODEL)
        failedCount++
      } else {
        // ★ P0-3: Deactivate old → activate new (排他制御パターン)
        await c.env.DB.prepare(`
          UPDATE image_generations SET is_active = 0 WHERE scene_id = ? AND id != ? AND is_active = 1
        `).bind(payload.sceneId, generationId).run()

        const r2Url = `/${r2Key}`
        // ★ P1-4: ended_at 記録
        await c.env.DB.prepare(`
          UPDATE image_generations SET status = 'completed', r2_key = ?, r2_url = ?, is_active = 1, ended_at = datetime('now') WHERE id = ?
        `).bind(r2Key, r2Url, generationId).run()

        await completeJob(c.env.DB, job.id, { generationId, r2Key })
        // ★ P1-2: モデル名付きメトリクス記録
        await recordProviderMetric(c.env.DB, 'gemini_image', 'success', undefined, GEMINI_IMAGE_MODEL)

        await logImageGeneration({
          env: c.env, userId: imageResult.userId ?? 1, projectId,
          sceneId: payload.sceneId, generationType: 'scene_image', provider: 'gemini',
          model: GEMINI_IMAGE_MODEL, apiKeySource: imageResult.apiKeySource,
          promptLength: finalPrompt.length, referenceImageCount: referenceImages.length, status: 'success'
        })

        successCount++
      }
    }
  } catch (sceneError) {
    console.error(`[Image Job] Job #${job.id} scene ${payload.sceneId} error:`, sceneError)
    await failJob(c.env.DB, job.id, 'UNEXPECTED_ERROR', String(sceneError).substring(0, 500), job.retry_count, job.max_retries)
    failedCount++
  }

  return { successCount, failedCount }
}

// POST /api/scenes/:id/generate-image - 単体画像生成
imageGeneration.post('/scenes/:id/generate-image', async (c) => {
  try {
    const sceneId = c.req.param('id')

    // 1. シーン情報取得（is_prompt_customizedも取得）
    const scene = await c.env.DB.prepare(`
      SELECT s.id, s.idx, s.image_prompt, s.project_id, s.is_prompt_customized
      FROM scenes s
      WHERE s.id = ?
    `).bind(sceneId).first()

    if (!scene) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Scene not found'
        }
      }, 404)
    }

    // 2. プロジェクト情報取得（output_preset を含む）
    const project = await c.env.DB.prepare(`
      SELECT id, status, output_preset FROM projects WHERE id = ?
    `).bind(scene.project_id).first<{ id: number; status: string; output_preset: string | null }>()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }
    
    // output_preset からアスペクト比を取得
    const outputPreset = getOutputPreset(project.output_preset)
    const aspectRatio = outputPreset.aspect_ratio
    console.log(`[Single Image Gen] Scene ${sceneId}: output_preset=${project.output_preset || 'default'}, aspectRatio=${aspectRatio}`)

    // 3. プロジェクトステータスチェック（formatted以降のみ許可）
    const allowedStatuses = ['formatted', 'generating_images', 'completed']
    if (!allowedStatuses.includes(project.status as string)) {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot generate image for project with status: ${project.status}`,
          details: {
            current_status: project.status,
            allowed_statuses: allowedStatuses
          }
        }
      }, 400)
    }

    // 4. 競合チェック: 既に生成中のレコードがないか確認
    const existingGenerating = await c.env.DB.prepare(`
      SELECT id FROM image_generations
      WHERE scene_id = ? AND status = 'generating'
    `).bind(sceneId).first()

    if (existingGenerating) {
      return c.json({
        error: {
          code: 'ALREADY_GENERATING',
          message: 'Image is already being generated for this scene. Please wait for completion.',
          details: {
            generation_id: existingGenerating.id
          }
        }
      }, 409)
    }

    // 5. スタイル設定取得（優先順位: シーン個別 > プロジェクトデフォルト > 未設定）
    
    const styleSettings = await fetchSceneStyleSettings(
      c.env.DB,
      parseInt(sceneId),
      scene.project_id as number
    )
    
    const effectiveStyleId = getEffectiveStylePresetId(styleSettings)
    const stylePreset = await fetchStylePreset(c.env.DB, effectiveStyleId)
    
    // 6. Phase X-2: Fetch world settings and character info (Optional - no error if missing)
    // Phase X-4: If prompt is customized, skip text enhancement but still load reference images
    // P-2: Support prompt_override from request body (chat-driven regeneration)
    // Phase C: Support reference_scene_id for background reuse with character swap
    let bodyPromptOverride: string | null = null;
    let referenceSceneId: number | null = null;
    try {
      const body = await c.req.json().catch(() => ({})) as {
        prompt_override?: string;
        regenerate?: boolean;
        reference_scene_id?: number;
      };
      if (body.prompt_override && typeof body.prompt_override === 'string') {
        bodyPromptOverride = body.prompt_override.trim();
        console.log(`[Image Gen] P-2: prompt_override received for scene ${sceneId}: "${bodyPromptOverride.substring(0, 100)}"`)
      }
      if (body.reference_scene_id && typeof body.reference_scene_id === 'number') {
        referenceSceneId = body.reference_scene_id;
        console.log(`[Image Gen] Phase C: reference_scene_id=${referenceSceneId} for scene ${sceneId} (background reuse mode)`)
      }
    } catch {}
    
    const isPromptCustomized = scene.is_prompt_customized === 1;
    // P-2: If prompt_override provided, append it as a modification instruction to the base prompt
    let enhancedPrompt = buildImagePrompt(scene.image_prompt as string);
    if (bodyPromptOverride) {
      enhancedPrompt = enhancedPrompt + '\n\n[User modification instruction]: ' + bodyPromptOverride;
    }
    let referenceImages: ReferenceImage[] = [];
    
    try {
      // P2-1: top-level import を使用（dynamic import 除去済み）
      
      const characters = await fetchSceneCharacters(c.env.DB, parseInt(sceneId));
      
      // Phase X-4: テキスト強化はカスタマイズされていない場合のみ
      if (!isPromptCustomized) {
        const world = await fetchWorldSettings(c.env.DB, scene.project_id as number);
        // Enhance prompt with world + character context
        enhancedPrompt = enhancePromptWithWorldAndCharacters(enhancedPrompt, world, characters);
      } else {
        console.log('[Image Gen] Phase X-4: Skipping text enhancement (prompt is customized)');
      }
      
      // SSOT: キャラクター参照画像取得（character-reference-helper使用）
      // ※ カスタムプロンプトでも参照画像は常に使用する（視覚的一貫性のため）
      const debugRefImages = c.env.DEBUG_REFERENCE_IMAGES === '1';
      const ssotReferenceImages = await getSceneReferenceImages(
        c.env.DB,
        c.env.R2,
        parseInt(sceneId),
        5,
        debugRefImages
      );
      
      // 型変換（characterKey → 省略）
      referenceImages = ssotReferenceImages.map(img => ({
        base64Data: img.base64Data,
        mimeType: img.mimeType,
        characterName: img.characterName
      }));
      
      console.log('[Image Gen] Phase X-2/X-3/X-4 enhancement:', {
        is_prompt_customized: isPromptCustomized,
        character_count: characters.length,
        reference_images_loaded: referenceImages.length,
        text_enhanced: !isPromptCustomized
      });
    } catch (error) {
      // Phase X-2: Fallback to original prompt if enhancement fails (no breaking change)
      console.warn('[Image Gen] Phase X-2 enhancement failed, using original prompt:', error);
    }
    
    // ===== Phase C: 背景再利用モード — 参照シーンの完成画像をリファレンスとして追加 =====
    let backgroundReferenceUsed = false;
    if (referenceSceneId) {
      try {
        // 参照シーンの最新完成画像を取得
        const refImage = await c.env.DB.prepare(`
          SELECT r2_key, r2_url FROM image_generations
          WHERE scene_id = ? AND is_active = 1 AND status = 'completed' AND r2_key IS NOT NULL
          ORDER BY id DESC LIMIT 1
        `).bind(referenceSceneId).first<{ r2_key: string; r2_url: string }>();
        
        if (refImage?.r2_key) {
          const r2Object = await c.env.R2.get(refImage.r2_key);
          if (r2Object) {
            const arrayBuffer = await r2Object.arrayBuffer();
            // ArrayBuffer to base64 (chunked for large files)
            const bytes = new Uint8Array(arrayBuffer);
            const CHUNK_SIZE = 0x8000;
            let binary = '';
            for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
              const chunk = bytes.subarray(i, i + CHUNK_SIZE);
              let chunkStr = '';
              for (let j = 0; j < chunk.length; j++) {
                chunkStr += String.fromCharCode(chunk[j]);
              }
              binary += chunkStr;
            }
            const base64Data = btoa(binary);
            const mimeType = r2Object.httpMetadata?.contentType || 'image/png';
            
            // 背景参照画像を先頭に追加（最も重要なリファレンス）
            referenceImages.unshift({
              base64Data,
              mimeType,
              characterName: '__background_reference__'
            });
            
            // プロンプトに背景維持指示を追加
            enhancedPrompt = `IMPORTANT INSTRUCTION: The first reference image shows the background/scene composition to MAINTAIN. Keep the same background, environment, lighting, and composition. Only change the characters as described below.\n\n${enhancedPrompt}`;
            backgroundReferenceUsed = true;
            
            console.log(`[Image Gen] Phase C: Background reference loaded from scene ${referenceSceneId} (${arrayBuffer.byteLength} bytes), total refs=${referenceImages.length}`);
          } else {
            console.warn(`[Image Gen] Phase C: R2 object not found for key ${refImage.r2_key}`);
          }
        } else {
          console.warn(`[Image Gen] Phase C: No completed image found for reference scene ${referenceSceneId}`);
        }
      } catch (bgError) {
        console.warn(`[Image Gen] Phase C: Background reference loading failed:`, bgError);
        // Continue without background reference (graceful degradation)
      }
    }
    
    // 7. 最終プロンプト生成（スタイル適用）
    const finalPrompt = composeFinalPrompt(enhancedPrompt, stylePreset)

    // 7. image_generationsレコード作成（pending状態, is_active=0 ★P0-3）
    const insertResult = await c.env.DB.prepare(`
      INSERT INTO image_generations (
        scene_id, prompt, status, provider, model, is_active
      ) VALUES (?, ?, 'pending', 'gemini', ?, 0)
    `).bind(sceneId, finalPrompt, GEMINI_IMAGE_MODEL).run()

    const generationId = insertResult.meta.last_row_id as number

    // 8. ステータスを 'generating' に更新（started_at追加でstuck detection対応）
    // ★ P1-4: started_at 記録
    await c.env.DB.prepare(`
      UPDATE image_generations SET status = 'generating', started_at = datetime('now') WHERE id = ?
    `).bind(generationId).run()

    // 9. Gemini APIで画像生成（クォータ超過時のフォールバック付き）
    // Phase X-4: カスタムプロンプトの場合は日本語指示をスキップ
    // R4-fix: ユーザーキー → システムキーの優先順位 + クォータ超過時フォールバック
    // output_preset のアスペクト比を使用
    const imageResult = await generateImageWithFallback(
      c,
      finalPrompt,
      referenceImages,
      { aspectRatio, skipDefaultInstructions: isPromptCustomized }
    )

    if (!imageResult.success) {
      // 生成失敗 → status = 'failed', error_message保存
      // ★ P1-4: ended_at を全失敗経路で記録
      await c.env.DB.prepare(`
        UPDATE image_generations 
        SET status = 'failed', error_message = ?, ended_at = datetime('now')
        WHERE id = ?
      `).bind(imageResult.error || 'Unknown error', generationId).run()

      // Log failed generation
      const isQuotaExceeded = imageResult.error?.toLowerCase().includes('quota');
      await logImageGeneration({
        env: c.env,
        userId: imageResult.userId ?? 1,
        projectId: scene.project_id as number,
        sceneId: parseInt(sceneId),
        generationType: 'scene_image',
        provider: 'gemini',
        model: GEMINI_IMAGE_MODEL,
        apiKeySource: imageResult.apiKeySource,
        promptLength: finalPrompt.length,
        referenceImageCount: referenceImages.length,
        status: isQuotaExceeded ? 'quota_exceeded' : 'failed',
        errorMessage: imageResult.error || 'Unknown error',
        errorCode: isQuotaExceeded ? 'QUOTA_EXCEEDED' : 'GENERATION_FAILED'
      });

      return c.json({
        error: {
          code: 'GENERATION_FAILED',
          message: imageResult.error || 'Failed to generate image',
          details: {
            api_key_source: imageResult.apiKeySource,
            system_key_configured: !!c.env.GEMINI_API_KEY
          }
        }
      }, 500)
    }

    // 10. R2に画像保存（リトライ機構付き）
    const r2Key = buildR2Key(
      scene.project_id as number,
      scene.idx as number,
      generationId
    )

    const r2UploadResult = await uploadToR2WithRetry(
      c.env.R2,
      r2Key,
      imageResult.imageData!
    );

    if (!r2UploadResult.success) {
      console.error(`[Single Gen] R2 upload failed for scene ${sceneId}: ${r2UploadResult.error}`);

      // ★ P1-4: ended_at を R2 失敗経路でも記録
      await c.env.DB.prepare(`
        UPDATE image_generations 
        SET status = 'failed', error_message = ?, ended_at = datetime('now')
        WHERE id = ?
      `).bind(r2UploadResult.error || 'R2 upload failed', generationId).run()

      return c.json({
        error: {
          code: 'STORAGE_FAILED',
          message: 'Failed to save image to storage after multiple retries'
        }
      }, 500)
    }

    // 11. 既存のアクティブ画像を無効化
    await c.env.DB.prepare(`
      UPDATE image_generations 
      SET is_active = 0 
      WHERE scene_id = ? AND id != ? AND is_active = 1
    `).bind(sceneId, generationId).run()

    // 12. 新しい画像をアクティブ化、status = 'completed'
    // r2_key がすでに "images/" で始まっているので、"/" だけ追加
    const r2Url = `/${r2Key}`
    
    // ★ P1-4: ended_at を成功経路でも記録
    const updateResult = await c.env.DB.prepare(`
      UPDATE image_generations 
      SET status = 'completed', r2_key = ?, r2_url = ?, is_active = 1, ended_at = datetime('now')
      WHERE id = ?
    `).bind(r2Key, r2Url, generationId).run()

    // ✅ DB更新失敗時の検証
    if (!updateResult.success) {
      console.error(`DB update failed for generation ${generationId}:`, updateResult)
      throw new Error('Failed to update image generation record')
    }

    // ✅ r2_url が null でないことを確認
    const verifyResult = await c.env.DB.prepare(`
      SELECT r2_url FROM image_generations WHERE id = ?
    `).bind(generationId).first()

    if (!verifyResult || !verifyResult.r2_url) {
      console.error(`r2_url is null after update for generation ${generationId}`)
      await c.env.DB.prepare(`
        UPDATE image_generations 
        SET status = 'failed', error_message = 'R2 URL update failed'
        WHERE id = ?
      `).bind(generationId).run()
      throw new Error('r2_url is null after DB update')
    }

    // 13. Log successful generation
    await logImageGeneration({
      env: c.env,
      userId: imageResult.userId ?? 1,
      projectId: scene.project_id as number,
      sceneId: parseInt(sceneId),
      generationType: 'scene_image',
      provider: 'gemini',
      model: GEMINI_IMAGE_MODEL,
      apiKeySource: imageResult.apiKeySource,
      promptLength: finalPrompt.length,
      referenceImageCount: referenceImages.length,
      status: 'success'
    });

    // 14. Auto-transition to 'completed' if all scenes now have active images
    // This handles the case where individual image regeneration completes the last scene
    if (project.status === 'formatted' || project.status === 'generating_images') {
      try {
        const missingCount = await c.env.DB.prepare(`
          SELECT COUNT(*) as cnt FROM scenes s
          LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1 AND ig.status = 'completed'
          WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL) AND ig.id IS NULL
        `).bind(scene.project_id).first<{ cnt: number }>()
        
        if (missingCount && missingCount.cnt === 0) {
          await c.env.DB.prepare(`
            UPDATE projects SET status = 'completed', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status IN ('formatted', 'generating_images')
          `).bind(scene.project_id).run()
          console.log(`[Single Image Gen] All scenes have images, project ${scene.project_id} → completed`)
        }
      } catch (autoTransitionErr) {
        console.warn('[Single Image Gen] Auto-transition check failed:', autoTransitionErr)
      }
    }

    // 15. レスポンス返却
    return c.json({
      scene_id: parseInt(sceneId),
      image_generation_id: generationId,
      status: 'completed',
      r2_key: r2Key,
      r2_url: r2Url,
      is_active: true
    }, 200)

  } catch (error) {
    console.error('Error in generate-image endpoint:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate image'
      }
    }, 500)
  }
})

// POST /api/projects/:id/generate-all-images - 一括画像生成 (job_queue ベース)
// ★ Rate-Limit-Aware: ジョブキュー経由で1リクエスト=1ジョブ実行
imageGeneration.post('/:id/generate-all-images', async (c) => {
  try {
    const projectId = c.req.param('id')
    const body = await c.req.json().catch(() => ({ mode: 'all' }))
    const mode = body.mode || 'all' // 'all' | 'pending' | 'failed'

    // 1. プロジェクト情報取得
    const project = await c.env.DB.prepare(`
      SELECT id, status, output_preset, user_id FROM projects WHERE id = ?
    `).bind(projectId).first<{ id: number; status: string; output_preset: string | null; user_id: number }>()

    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404)
    }
    
    const outputPreset = getOutputPreset(project.output_preset)
    const aspectRatio = outputPreset.aspect_ratio
    console.log(`[Batch All Image Gen] Project ${projectId}: output_preset=${project.output_preset || 'default'}, aspectRatio=${aspectRatio}`)

    // 2. ステータスチェック
    const allowedStatuses = ['formatted', 'generating_images', 'completed']
    if (!allowedStatuses.includes(project.status as string)) {
      return c.json({
        error: { code: 'INVALID_STATUS', message: `Cannot generate images for project with status: ${project.status}` }
      }, 400)
    }

    // 3. ステータスを 'generating_images' に更新
    if (project.status === 'formatted') {
      await c.env.DB.prepare(`
        UPDATE projects SET status = 'generating_images', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(projectId).run()
    }

    // 4. 対象シーン取得
    let targetScenes: any[] = []
    
    if (mode === 'all') {
      const { results } = await c.env.DB.prepare(`
        SELECT id, idx, image_prompt, is_prompt_customized FROM scenes
        WHERE project_id = ? AND (is_hidden = 0 OR is_hidden IS NULL) ORDER BY idx ASC
      `).bind(projectId).all()
      targetScenes = results
    } else if (mode === 'pending') {
      const { results } = await c.env.DB.prepare(`
        SELECT s.id, s.idx, s.image_prompt, s.is_prompt_customized
        FROM scenes s
        LEFT JOIN image_generations ig ON s.id = ig.scene_id AND ig.is_active = 1
        WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL) AND ig.id IS NULL ORDER BY s.idx ASC
      `).bind(projectId).all()
      targetScenes = results
    } else if (mode === 'failed') {
      const { results } = await c.env.DB.prepare(`
        SELECT s.id, s.idx, s.image_prompt, s.is_prompt_customized
        FROM scenes s
        INNER JOIN (SELECT scene_id, MAX(id) as max_id FROM image_generations GROUP BY scene_id) latest ON s.id = latest.scene_id
        INNER JOIN image_generations ig ON ig.id = latest.max_id
        WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL) AND ig.status = 'failed'
        ORDER BY s.idx ASC
      `).bind(projectId).all()
      targetScenes = results
    }

    const totalScenes = targetScenes.length

    if (totalScenes === 0) {
      return c.json({
        project_id: parseInt(projectId), total_scenes: 0, target_scenes: 0,
        mode, status: project.status, message: 'No scenes to generate'
      }, 200)
    }

    // 5. ★ Job Queue: Create jobs for all target scenes (dedup-checked)
    let jobsCreated = 0
    for (const scene of targetScenes) {
      const { jobId, created } = await createJob(c.env.DB, {
        userId: project.user_id || 1,
        projectId: parseInt(projectId),
        jobType: 'generate_image',
        provider: 'gemini_image',
        entityType: 'scene',
        entityId: scene.id as number,
        payload: {
          sceneId: scene.id,
          sceneIdx: scene.idx,
          imagePrompt: scene.image_prompt || '',
          aspectRatio,
          isPromptCustomized: scene.is_prompt_customized === 1,
          mode,
        },
      })
      if (created) jobsCreated++
    }

    console.log(`[Batch All Image Gen] Created ${jobsCreated} jobs for ${totalScenes} scenes (mode=${mode})`)

    // 6. ★ Process ONE job immediately via shared helper
    const { successCount, failedCount } = await processOneImageJob(c, parseInt(projectId), aspectRatio)

    // 7. Check overall progress
    const progress = await getJobProgress(c.env.DB, parseInt(projectId), 'generate_image')
    const allDone = progress.total > 0 && (progress.queued + progress.processing + progress.retryWait) === 0

    if (allDone && progress.failed === 0) {
      await c.env.DB.prepare(`
        UPDATE projects SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(projectId).run()
    }

    return c.json({
      project_id: parseInt(projectId),
      total_scenes: totalScenes,
      success_count: successCount,
      failed_count: failedCount,
      skipped_count: 0,
      batch_size: job ? 1 : 0,
      mode,
      status: allDone && progress.failed === 0 ? 'completed' : 'generating_images',
      // ★ New: job queue progress for frontend polling
      job_progress: {
        total: progress.total,
        completed: progress.completed,
        failed: progress.failed,
        queued: progress.queued,
        processing: progress.processing,
        retry_wait: progress.retryWait,
      },
    }, 200)

  } catch (error) {
    console.error('Error in generate-all-images endpoint:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate images' } }, 500)
  }
})

/**
 * 画像生成オプション (ローカル拡張 — generateImageWithFallback 用)
 */
interface ImageGenerationOptions {
  aspectRatio?: '16:9' | '9:16' | '1:1';
  skipDefaultInstructions?: boolean;
  /** 一括生成でユーザーキーがレート制限に達した場合、システムキーを優先 */
  preferSystemKey?: boolean;
}

export default imageGeneration
