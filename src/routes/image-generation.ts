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
import { IMAGE_GEN_ERROR, isQuotaError, isTimeoutError, isRateLimitError, classifyError } from '../utils/error-codes'

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
  
  // Step 4: クォータ超過時のフォールバック (★ Phase 0-B: 構造化された判定)
  const quotaError = isQuotaError(result.error);
  
  console.log(`[Image Gen] Failed. source=${keyResult.source}, isQuotaError=${quotaError}, errorClass=${classifyError(result.error)}, error=${result.error?.substring(0, 150)}`);
  
  // ユーザーキー → システムキーフォールバック (quota error のみ)
  if (keyResult.source === 'user' && quotaError && c.env.GEMINI_API_KEY) {
    console.log(`[Image Gen] User key quota exceeded, falling back to SYSTEM key`);
    const systemResult = await sharedGenerateImage(
      prompt, c.env.GEMINI_API_KEY, geminiRefs, { ...geminiOpts, maxRetries: 3 }
    );
    if (systemResult.success) console.log(`[Image Gen] SUCCESS with SYSTEM key fallback`);
    return { ...systemResult, apiKeySource: 'system', userId: keyResult.userId };
  }
  
  // ★ Phase 0-A: system→user 逆フォールバック廃止
  // 以前はシステムキーのquota超過時にユーザーキーに切り替えていたが、
  // ユーザーへの意図しない課金リスクがあるため削除。
  // システムキーで失敗した場合は同じキーでリトライするか、失敗として返す。
  if (keyResult.source === 'system' && quotaError) {
    console.log(`[Image Gen] System key quota exceeded. NOT falling back to user key (Phase 0-A: reverse fallback removed)`);
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

    // ★ Fix-1: waitUntil で追加ジョブをバックグラウンド実行 (Legacy endpoint)
    try {
      c.executionCtx.waitUntil(
        (async () => {
          const EXTRA_JOBS = 9  // 合計: 1同期 + 9非同期 = 10
          for (let i = 0; i < EXTRA_JOBS; i++) {
            try {
              const result = await processOneImageJob(c, projectId, aspectRatio)
              if (result.successCount === 0 && result.failedCount === 0) break
            } catch (err) {
              console.error(`[Legacy waitUntil] Extra job ${i + 1} error:`, err)
              break
            }
          }
        })()
      )
    } catch {}

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
    // ★ IMG-LOG: deprecated endpoint のエラー詳細も可視化
    const errMsg = error instanceof Error ? error.message : String(error)
    const errStack = error instanceof Error ? error.stack : undefined
    const errName = error instanceof Error ? error.name : typeof error
    console.error('[generate-images/legacy] Unhandled error:', {
      message: errMsg,
      name: errName,
      stack: errStack?.substring(0, 500),
      projectId: c.req.param('id'),
    })
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: `Failed to generate images: ${errMsg.substring(0, 200)}`,
        debug: { error_type: errName, error_message: errMsg.substring(0, 300) }
      }
    }, 500)
  }
})

// GET /api/projects/:id/generate-images/status - 画像生成進捗取得
// ★ Fix-1: ステータスポーリング時にも pending ジョブを waitUntil で処理
imageGeneration.get('/projects/:id/generate-images/status', async (c) => {
  try {
    const projectId = c.req.param('id')
    const parsedProjectId = parseInt(projectId)

    const project = await c.env.DB.prepare(`
      SELECT id, status, output_preset FROM projects WHERE id = ?
    `).bind(projectId).first<{ id: number; status: string; output_preset: string | null }>()

    if (!project) {
      return c.json({
        error: { code: 'NOT_FOUND', message: 'Project not found' }
      }, 404)
    }

    // ★ P1-5: Auto-cleanup stuck 'generating' records (統一: STUCK_GENERATING_TIMEOUT_MINUTES)
    try {
      await cleanupStuckGenerations(c.env.DB, parsedProjectId);
    } catch (cleanupErr) {
      console.warn('[Image Status] Auto-cleanup failed:', cleanupErr)
    }

    const stats = await getImageGenerationStats(c.env.DB, projectId)

    // ★ Fix-1: ポーリング時にも pending ジョブを waitUntil でバックグラウンド処理
    // フロントエンドが 3-5 秒間隔でポーリングするため、各ポーリング時に追加ジョブを処理
    if (stats.pending > 0 && ['generating_images', 'formatted'].includes(project.status as string)) {
      const outputPreset = getOutputPreset(project.output_preset)
      const aspectRatio = outputPreset.aspect_ratio
      try {
        c.executionCtx.waitUntil(
          (async () => {
            const POLL_ADVANCE_JOBS = 3  // ポーリング1回あたり処理するジョブ数
            let advanced = 0
            for (let i = 0; i < POLL_ADVANCE_JOBS; i++) {
              try {
                const result = await processOneImageJob(c, parsedProjectId, aspectRatio)
                if (result.successCount === 0 && result.failedCount === 0) break
                advanced += result.successCount + result.failedCount
              } catch (err) {
                console.error(`[Status Poll Advance] Job ${i + 1} error:`, err)
                break
              }
            }
            if (advanced > 0) {
              console.log(`[Status Poll Advance] Advanced ${advanced} jobs for project ${parsedProjectId}`)
              // 全完了チェック
              try {
                const missingCount = await c.env.DB.prepare(`
                  SELECT COUNT(*) as cnt FROM scenes s
                  LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1 AND ig.status = 'completed'
                  WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL) AND ig.id IS NULL
                `).bind(parsedProjectId).first<{ cnt: number }>()
                if (missingCount && missingCount.cnt === 0) {
                  await c.env.DB.prepare(`
                    UPDATE projects SET status = 'completed', updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND status IN ('formatted', 'generating_images')
                  `).bind(parsedProjectId).run()
                  console.log(`[Status Poll Advance] All scenes done, project ${parsedProjectId} → completed`)
                }
              } catch {}
            }
          })()
        )
      } catch (waitUntilErr) {
        // waitUntil が利用不可の環境（テスト等）
        console.warn('[Status Poll Advance] waitUntil unavailable:', waitUntilErr)
      }
    }

    return c.json({
      project_id: parsedProjectId,
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
 * ★ Phase 1-A: 単体生成も同じパスを通る (generationId, promptOverride, referenceSceneId 対応)
 * ★ Phase 1-C: リトライ時に参照画像を段階的に削減
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
    aspectRatio: string; isPromptCustomized: boolean;
    // Phase 1-A: 単体生成固有のペイロード
    generationId?: number;
    promptOverride?: string;
    referenceSceneId?: number;
    mode?: string;
  }

  try {
    // Build prompt
    let enhancedPrompt = buildImagePrompt(payload.imagePrompt)
    
    // Phase 1-A: prompt_override 対応
    if (payload.promptOverride) {
      enhancedPrompt = enhancedPrompt + '\n\n[User modification instruction]: ' + payload.promptOverride;
    }
    
    let referenceImages: ReferenceImage[] = []

    try {
      const characters = await fetchSceneCharacters(c.env.DB, payload.sceneId)
      if (!payload.isPromptCustomized) {
        const world = await fetchWorldSettings(c.env.DB, projectId)
        enhancedPrompt = enhancePromptWithWorldAndCharacters(enhancedPrompt, world, characters)
      }
      
      // ★ Phase 1-C: リトライ時に参照画像を段階的に削減
      // Attempt 1 (retry_count=0): 最大5枚
      // Attempt 2 (retry_count=1): 最大2枚
      // Attempt 3+ (retry_count>=2): 0枚
      const maxRefImages = job.retry_count === 0 ? 5 : job.retry_count === 1 ? 2 : 0;
      
      if (maxRefImages > 0) {
        const refs = await getSceneReferenceImages(c.env.DB, c.env.R2, payload.sceneId, maxRefImages, c.env.DEBUG_REFERENCE_IMAGES === '1')
        referenceImages = refs.map(img => ({ base64Data: img.base64Data, mimeType: img.mimeType, characterName: img.characterName }))
      }
      
      if (job.retry_count > 0) {
        console.log(`[Image Job] Phase 1-C: Retry #${job.retry_count}, reference images reduced to ${referenceImages.length} (max=${maxRefImages})`)
      }
    } catch (charError) {
      console.warn(`[Image Job] Failed to fetch characters for scene ${payload.sceneId}:`, charError)
    }

    // ===== Phase C: 背景再利用モード (referenceSceneId 対応) =====
    if (payload.referenceSceneId && job.retry_count === 0) {
      // 背景参照はリトライ時には使わない（重いため）
      try {
        const refImage = await c.env.DB.prepare(`
          SELECT r2_key FROM image_generations
          WHERE scene_id = ? AND is_active = 1 AND status = 'completed' AND r2_key IS NOT NULL
          ORDER BY id DESC LIMIT 1
        `).bind(payload.referenceSceneId).first<{ r2_key: string }>();
        
        if (refImage?.r2_key) {
          const r2Object = await c.env.R2.get(refImage.r2_key);
          if (r2Object) {
            const arrayBuffer = await r2Object.arrayBuffer();
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
            
            referenceImages.unshift({
              base64Data,
              mimeType,
              characterName: '__background_reference__'
            });
            
            enhancedPrompt = `IMPORTANT INSTRUCTION: The first reference image shows the background/scene composition to MAINTAIN. Keep the same background, environment, lighting, and composition. Only change the characters as described below.\n\n${enhancedPrompt}`;
            console.log(`[Image Job] Phase C: Background reference loaded from scene ${payload.referenceSceneId}, total refs=${referenceImages.length}`);
          }
        }
      } catch (bgError) {
        console.warn(`[Image Job] Phase C: Background reference loading failed:`, bgError);
      }
    }

    const styleSettings = await fetchSceneStyleSettings(c.env.DB, payload.sceneId, projectId)
    const effectiveStyleId = getEffectiveStylePresetId(styleSettings)
    const stylePreset = await fetchStylePreset(c.env.DB, effectiveStyleId)
    const finalPrompt = composeFinalPrompt(enhancedPrompt, stylePreset)

    // ★ Phase 1-A: 単体生成では既にレコードが作成済み (generationId がペイロードに含まれる)
    // バッチ生成では新規作成
    let generationId: number;
    if (payload.generationId) {
      // 単体生成: 既存レコードを 'generating' に更新
      generationId = payload.generationId;
      await c.env.DB.prepare(`
        UPDATE image_generations SET status = 'generating', prompt = ?, started_at = datetime('now') WHERE id = ?
      `).bind(finalPrompt, generationId).run()
    } else {
      // バッチ生成: 新規レコード作成
      const insertResult = await c.env.DB.prepare(`
        INSERT INTO image_generations (scene_id, prompt, status, provider, model, is_active, started_at)
        VALUES (?, ?, 'generating', 'gemini', ?, 0, datetime('now'))
      `).bind(payload.sceneId, finalPrompt, GEMINI_IMAGE_MODEL).run()
      generationId = insertResult.meta.last_row_id as number
    }

    // Generate image (with fallback)
    const effectiveAspectRatio = payload.aspectRatio || aspectRatio
    const imageResult = await generateImageWithFallback(c, finalPrompt, referenceImages, {
      aspectRatio: effectiveAspectRatio as any,
      skipDefaultInstructions: payload.isPromptCustomized,
    })

    if (!imageResult.success) {
      // ★ P1-4: ended_at 記録 + error_code
      const errCode = classifyError(imageResult.error)
      await c.env.DB.prepare(`
        UPDATE image_generations SET status = 'failed', error_message = ?, error_code = ?, ended_at = datetime('now') WHERE id = ?
      `).bind(imageResult.error || 'Unknown error', errCode, generationId).run()

      const isRateLimited = isRateLimitError(imageResult.error)
      if (isRateLimited) {
        await handleRateLimit(c.env.DB, job.id, 'gemini_image')
        await c.env.DB.prepare(`UPDATE image_generations SET is_active = 0 WHERE id = ?`).bind(generationId).run()
        // ★ P1-2: モデル名付きメトリクス記録
        await recordProviderMetric(c.env.DB, 'gemini_image', 'error_429', undefined, GEMINI_IMAGE_MODEL)
      } else {
        await failJob(c.env.DB, job.id, errCode, (imageResult.error || 'Unknown').substring(0, 500), job.retry_count, job.max_retries)
        const metricType = errCode === IMAGE_GEN_ERROR.TIMEOUT ? 'timeout' as const : 'error_other' as const
        await recordProviderMetric(c.env.DB, 'gemini_image', metricType, undefined, GEMINI_IMAGE_MODEL)
      }

      await logImageGeneration({
        env: c.env, userId: imageResult.userId ?? 1, projectId,
        sceneId: payload.sceneId, generationType: 'scene_image', provider: 'gemini',
        model: GEMINI_IMAGE_MODEL, apiKeySource: imageResult.apiKeySource,
        promptLength: finalPrompt.length, referenceImageCount: referenceImages.length,
        status: isRateLimited ? 'quota_exceeded' : 'failed',
        errorMessage: imageResult.error || 'Unknown',
        errorCode: errCode
      })

      failedCount++
    } else {
      // R2 upload
      const r2Key = buildR2Key(projectId, payload.sceneIdx, generationId)
      const r2UploadResult = await uploadToR2WithRetry(c.env.R2, r2Key, imageResult.imageData!)

      if (!r2UploadResult.success) {
        // ★ P1-4: ended_at 記録
        await c.env.DB.prepare(`
          UPDATE image_generations SET status = 'failed', error_message = ?, error_code = ?, ended_at = datetime('now') WHERE id = ?
        `).bind(r2UploadResult.error || 'R2 upload failed', IMAGE_GEN_ERROR.STORAGE_FAILED, generationId).run()
        await failJob(c.env.DB, job.id, IMAGE_GEN_ERROR.STORAGE_FAILED, r2UploadResult.error || 'R2 upload failed', job.retry_count, job.max_retries)
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

        // ★ Auto-transition: 全シーン完了チェック
        try {
          const missingCount = await c.env.DB.prepare(`
            SELECT COUNT(*) as cnt FROM scenes s
            LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1 AND ig.status = 'completed'
            WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL) AND ig.id IS NULL
          `).bind(projectId).first<{ cnt: number }>()
          
          if (missingCount && missingCount.cnt === 0) {
            await c.env.DB.prepare(`
              UPDATE projects SET status = 'completed', updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND status IN ('formatted', 'generating_images')
            `).bind(projectId).run()
            console.log(`[Image Job] All scenes have images, project ${projectId} → completed`)
          }
        } catch (autoTransitionErr) {
          console.warn('[Image Job] Auto-transition check failed:', autoTransitionErr)
        }

        successCount++
      }
    }
  } catch (sceneError) {
    console.error(`[Image Job] Job #${job.id} scene ${payload.sceneId} error:`, sceneError)
    await failJob(c.env.DB, job.id, IMAGE_GEN_ERROR.INTERNAL_ERROR, String(sceneError).substring(0, 500), job.retry_count, job.max_retries)
    failedCount++
  }

  return { successCount, failedCount }
}

// POST /api/scenes/:id/generate-image - 単体画像生成
// ★ Phase 1-A: 同期完了型 → 202 Accepted + ジョブキュー + ポーリング
// フロントエンドはポーリングで完了を検知する。リトライはサーバーサイドのみ。
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

    // 2. プロジェクト情報取得（output_preset, user_id を含む）
    const project = await c.env.DB.prepare(`
      SELECT id, status, output_preset, user_id FROM projects WHERE id = ?
    `).bind(scene.project_id).first<{ id: number; status: string; output_preset: string | null; user_id: number }>()

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
    // ★ pending も含む: Phase 1-A の async flow では pending → generating → completed
    const existingActive = await c.env.DB.prepare(`
      SELECT id, status FROM image_generations
      WHERE scene_id = ? AND status IN ('generating', 'pending')
        AND created_at > datetime('now', '-5 minutes')
    `).bind(sceneId).first<{ id: number; status: string }>()

    if (existingActive) {
      return c.json({
        error: {
          code: 'ALREADY_GENERATING',
          message: 'Image is already being generated for this scene. Please wait for completion.',
          details: {
            generation_id: existingActive.id,
            current_status: existingActive.status
          }
        }
      }, 409)
    }

    // 5. リクエストボディ解析 (prompt_override, reference_scene_id)
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

    // 6. image_generations レコード作成（queued 状態, is_active=0）
    const insertResult = await c.env.DB.prepare(`
      INSERT INTO image_generations (
        scene_id, prompt, status, provider, model, is_active
      ) VALUES (?, ?, 'pending', 'gemini', ?, 0)
    `).bind(sceneId, scene.image_prompt || '', GEMINI_IMAGE_MODEL).run()

    const generationId = insertResult.meta.last_row_id as number

    // 7. ジョブキューにジョブ作成 (processOneImageJob が処理)
    const { jobId } = await createJob(c.env.DB, {
      userId: project.user_id || 1,
      projectId: project.id,
      jobType: 'generate_image',
      provider: 'gemini_image',
      entityType: 'scene',
      entityId: parseInt(sceneId),
      payload: {
        sceneId: parseInt(sceneId),
        sceneIdx: scene.idx,
        imagePrompt: scene.image_prompt || '',
        aspectRatio,
        isPromptCustomized: scene.is_prompt_customized === 1,
        mode: 'single',
        // Phase 1-A: 単体生成固有のペイロード
        generationId,
        promptOverride: bodyPromptOverride,
        referenceSceneId,
      },
    })

    console.log(`[Single Image Gen] Phase 1-A: Created job #${jobId} for scene ${sceneId}, generation #${generationId} → 202 Accepted`)

    // 8. ★ Fix-1: waitUntil でバックグラウンドでジョブを実行
    // 202 レスポンス返却後、Cloudflare Workers のライフタイム内で processOneImageJob を非同期実行
    // これにより、ジョブが job_queue に滞留せず即座に処理される
    try {
      c.executionCtx.waitUntil(
        processOneImageJob(c, project.id, aspectRatio)
          .then(({ successCount, failedCount }) => {
            console.log(`[Single Image Gen] Fix-1: waitUntil completed for job #${jobId}, gen #${generationId}: success=${successCount}, failed=${failedCount}`)
          })
          .catch((err) => {
            console.error(`[Single Image Gen] Fix-1: waitUntil error for job #${jobId}, gen #${generationId}:`, err)
          })
      )
    } catch (waitUntilErr) {
      // waitUntil が使えない環境（テスト等）のフォールバック: ログのみ
      console.warn(`[Single Image Gen] Fix-1: waitUntil unavailable, job #${jobId} will be processed by next batch/poll`, waitUntilErr)
    }

    // 9. 202 Accepted で即座に返却 (フロントエンドはポーリングで完了を検知)
    return c.json({
      image_generation_id: generationId,
      status: 'pending',
      poll_url: `/api/image-generations/${generationId}/status`,
    }, 202)

  } catch (error) {
    console.error('Error in generate-image endpoint:', error)
    return c.json({
      error: {
        code: IMAGE_GEN_ERROR.INTERNAL_ERROR,
        message: 'Failed to queue image generation'
      }
    }, 500)
  }
})

// GET /api/image-generations/:id/status - 画像生成ステータスポーリング
// ★ Phase 1-B: フロントエンドは 202 レスポンス後、このエンドポイントをポーリングする
imageGeneration.get('/image-generations/:id/status', async (c) => {
  try {
    const generationId = parseInt(c.req.param('id'), 10)
    if (!generationId || isNaN(generationId)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid generation ID' } }, 400)
    }

    const gen = await c.env.DB.prepare(`
      SELECT ig.id, ig.scene_id, ig.status, ig.r2_url, ig.error_message, ig.error_code,
             ig.started_at, ig.ended_at, ig.is_active,
             s.project_id
      FROM image_generations ig
      JOIN scenes s ON s.id = ig.scene_id
      WHERE ig.id = ?
    `).bind(generationId).first<{
      id: number; scene_id: number; status: string; r2_url: string | null;
      error_message: string | null; error_code: string | null;
      started_at: string | null; ended_at: string | null; is_active: number;
      project_id: number;
    }>()

    if (!gen) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Generation not found' } }, 404)
    }

    // ★ progress_pct 推定: 経過時間ベース
    let progressPct = 0
    if (gen.status === 'completed') {
      progressPct = 100
    } else if (gen.status === 'failed') {
      progressPct = 0
    } else if (gen.status === 'generating' && gen.started_at) {
      const startedMs = new Date(gen.started_at + 'Z').getTime()
      const elapsedSec = (Date.now() - startedMs) / 1000
      if (elapsedSec < 45) {
        progressPct = Math.round((elapsedSec / 45) * 80)
      } else if (elapsedSec < 90) {
        progressPct = 80 + Math.round(((elapsedSec - 45) / 45) * 15)
      } else {
        progressPct = 95
      }
    } else if (gen.status === 'pending') {
      progressPct = 5 // キュー待ち
    }

    // ★ retryable 判定
    const isRetryable = gen.error_code === IMAGE_GEN_ERROR.TIMEOUT || 
                        gen.error_code === IMAGE_GEN_ERROR.RATE_LIMIT ||
                        gen.error_code === IMAGE_GEN_ERROR.QUOTA_EXCEEDED

    return c.json({
      id: gen.id,
      scene_id: gen.scene_id,
      project_id: gen.project_id,
      status: gen.status,
      r2_url: gen.status === 'completed' ? gen.r2_url : undefined,
      error_code: gen.status === 'failed' ? gen.error_code : undefined,
      error_message: gen.status === 'failed' ? gen.error_message : undefined,
      retryable: gen.status === 'failed' ? isRetryable : undefined,
      progress_pct: progressPct,
      started_at: gen.started_at,
      completed_at: gen.ended_at,
    })

  } catch (error) {
    // ★ IMG-LOG / POLL-FIX: 500原因の詳細をサーバーログに記録
    const errMsg = error instanceof Error ? error.message : String(error)
    const errName = error instanceof Error ? error.name : 'Unknown'
    const errStack = error instanceof Error ? (error.stack || '').substring(0, 500) : ''
    const genId = c.req.param('id')
    console.error(`[Image Gen Status 500] gen=${genId} type=${errName} msg=${errMsg}`)
    console.error(`[Image Gen Status 500] stack=${errStack}`)
    // レスポンスには error_type のみ（スタック情報は返さない — IMG-LOG方針準拠）
    return c.json({ error: { code: IMAGE_GEN_ERROR.INTERNAL_ERROR, message: 'Failed to get generation status', error_type: errName } }, 500)
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

    // 6. ★ Process ONE job immediately (synchronous — counted in response)
    const { successCount, failedCount } = await processOneImageJob(c, parseInt(projectId), aspectRatio)

    // 6b. ★ Fix-1: waitUntil で追加ジョブをバックグラウンド実行
    // 1リクエスト1ジョブでは進行が遅いので、waitUntil 内で追加処理（最大9ジョブ = 合計10）
    const parsedProjectId = parseInt(projectId)
    try {
      c.executionCtx.waitUntil(
        (async () => {
          const EXTRA_JOBS = 9  // waitUntil で追加実行するジョブ数（合計: 1同期 + 9非同期 = 10）
          let extraSuccess = 0, extraFailed = 0
          for (let i = 0; i < EXTRA_JOBS; i++) {
            try {
              const result = await processOneImageJob(c, parsedProjectId, aspectRatio)
              extraSuccess += result.successCount
              extraFailed += result.failedCount
              if (result.successCount === 0 && result.failedCount === 0) break  // キューが空
            } catch (err) {
              console.error(`[Batch waitUntil] Extra job ${i + 1} error:`, err)
              break
            }
          }
          console.log(`[Batch waitUntil] Fix-1: Extra ${extraSuccess} succeeded, ${extraFailed} failed for project ${parsedProjectId}`)
          
          // 全完了チェック（waitUntil 終了時）
          try {
            const finalProgress = await getJobProgress(c.env.DB, parsedProjectId, 'generate_image')
            if (finalProgress.total > 0 && (finalProgress.queued + finalProgress.processing + finalProgress.retryWait) === 0 && finalProgress.failed === 0) {
              await c.env.DB.prepare(`
                UPDATE projects SET status = 'completed', updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status IN ('formatted', 'generating_images')
              `).bind(parsedProjectId).run()
              console.log(`[Batch waitUntil] All jobs done, project ${parsedProjectId} → completed`)
            }
          } catch {}
        })()
      )
    } catch (waitUntilErr) {
      console.warn(`[Batch All Image Gen] Fix-1: waitUntil unavailable`, waitUntilErr)
    }

    // 7. Check overall progress (at time of synchronous response)
    const progress = await getJobProgress(c.env.DB, parsedProjectId, 'generate_image')
    const allDone = progress.total > 0 && (progress.queued + progress.processing + progress.retryWait) === 0

    if (allDone && progress.failed === 0) {
      await c.env.DB.prepare(`
        UPDATE projects SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(projectId).run()
    }

    return c.json({
      project_id: parsedProjectId,
      total_scenes: totalScenes,
      success_count: successCount,
      failed_count: failedCount,
      skipped_count: 0,
      batch_size: 1,
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
    // ★ IMG-LOG: エラー詳細を可視化（原因観測強化 — 解消ではなく次の再現時に原因を取るための計測）
    const errMsg = error instanceof Error ? error.message : String(error)
    const errStack = error instanceof Error ? error.stack : undefined
    const errName = error instanceof Error ? error.name : typeof error
    // サーバーログ: stack 含む完全な情報
    console.error('[generate-all-images] Unhandled error:', {
      message: errMsg,
      name: errName,
      stack: errStack?.substring(0, 500),
      projectId: c.req.param('id'),
    })
    // レスポンス: stack は含めない（本番セキュリティ）、error_type と短縮メッセージのみ
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: `Failed to generate images: ${errMsg.substring(0, 200)}`,
        debug: { error_type: errName }
      }
    }, 500)
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
