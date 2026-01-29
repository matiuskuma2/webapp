import { Hono } from 'hono'
import type { Bindings } from '../types/bindings'
import { buildImagePrompt, buildR2Key, composeStyledPrompt } from '../utils/image-prompt-builder'

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
function estimateImageGenerationCost(provider: string, model: string, imageCount: number = 1): number {
  // Gemini Imagen: ~$0.04/image, Gemini experimental: free during preview
  // OpenAI DALL-E 3: ~$0.04/image
  if (provider === 'gemini') {
    if (model.includes('imagen')) return 0.04 * imageCount;
    // gemini-3-pro-image-preview is experimental/free
    return 0;
  }
  if (provider === 'openai') {
    if (model.includes('dall-e-3')) return 0.04 * imageCount;
  }
  return 0;
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
  c: { env: Bindings },
  options?: { skipUserKey?: boolean }
): Promise<ApiKeyResult | null> {
  const { getCookie } = await import('hono/cookie');
  
  // Step 1: ユーザーAPIキーを試行（skipUserKey でなければ）
  if (!options?.skipUserKey) {
    try {
      // @ts-ignore - getCookie requires Context but we only have env
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
              const { decryptApiKey } = await import('../utils/crypto');
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
}> {
  // Step 1: APIキー取得
  // preferSystemKey が true の場合、システムキーを優先（一括生成でユーザーキーがレート制限に達した後）
  const preferSystem = options.preferSystemKey && c.env.GEMINI_API_KEY;
  
  let keyResult: ApiKeyResult | null;
  if (preferSystem) {
    // システムキーを優先
    keyResult = { apiKey: c.env.GEMINI_API_KEY!, source: 'system' };
    console.log(`[Image Gen] Using SYSTEM key (preferSystemKey=true, user key rate limited previously)`);
  } else {
    keyResult = await getApiKey(c);
  }
  
  // デバッグ: 環境変数の状態を確認
  console.log(`[Image Gen] API Key Status: source=${keyResult?.source}, systemKeyConfigured=${!!c.env.GEMINI_API_KEY}, preferSystemKey=${options.preferSystemKey}`);
  
  if (!keyResult) {
    return {
      success: false,
      error: 'No API key configured. Please configure your Google API key in Settings, or contact admin to configure system GEMINI_API_KEY.',
      apiKeySource: 'system'
    };
  }
  
  // Step 2: 最初の試行
  // リトライ回数を5回に増加（Gemini無料枠のレート制限対策）
  console.log(`[Image Gen] Attempting with ${keyResult.source} API key, aspectRatio: ${options.aspectRatio || '16:9'}`);
  const result = await generateImageWithRetry(
    prompt,
    keyResult.apiKey,
    5,  // 3→5 に増加（429エラー対策）
    referenceImages,
    options
  );
  
  // Step 3: 成功または非クォータエラー → そのまま返却
  if (result.success) {
    return {
      ...result,
      apiKeySource: keyResult.source,
      userId: keyResult.userId
    };
  }
  
  // Step 4: クォータ超過時のフォールバック処理
  const isQuotaError = result.error?.toLowerCase().includes('quota') || 
                       result.error?.toLowerCase().includes('resource_exhausted') ||
                       result.error?.includes('429') ||
                       result.error?.includes('RATE_LIMIT_429');
  
  // デバッグログ追加
  console.log(`[Image Gen] Generation failed. source=${keyResult.source}, isQuotaError=${isQuotaError}, hasSystemKey=${!!c.env.GEMINI_API_KEY}, error=${result.error?.substring(0, 150)}`);
  
  // ユーザーキーでレート制限 → システムキーにフォールバック
  if (keyResult.source === 'user' && isQuotaError && c.env.GEMINI_API_KEY) {
    console.log(`[Image Gen] User key quota exceeded, falling back to SYSTEM key`);
    
    const systemResult = await generateImageWithRetry(
      prompt,
      c.env.GEMINI_API_KEY,
      5,
      referenceImages,
      options
    );
    
    if (systemResult.success) {
      console.log(`[Image Gen] SUCCESS with SYSTEM key fallback`);
    } else {
      console.log(`[Image Gen] SYSTEM key also failed: ${systemResult.error?.substring(0, 100)}`);
    }
    
    return {
      ...systemResult,
      apiKeySource: 'system',
      userId: keyResult.userId
    };
  }
  
  // システムキーでレート制限の場合も、ユーザーキーが別にあれば試行
  // （ユーザーがキーを持っていない場合、最初からsystemになっている）
  if (keyResult.source === 'system' && isQuotaError) {
    // ユーザーキーを再取得してみる（skipUserKey=falseで）
    const userKeyResult = await getApiKey(c, { skipUserKey: false });
    
    // ユーザーキーが存在し、今のシステムキーと異なる場合
    if (userKeyResult && userKeyResult.source === 'user' && userKeyResult.apiKey !== keyResult.apiKey) {
      console.log(`[Image Gen] System key quota exceeded, trying USER key as alternative`);
      
      const userResult = await generateImageWithRetry(
        prompt,
        userKeyResult.apiKey,
        5,
        referenceImages,
        options
      );
      
      if (userResult.success) {
        console.log(`[Image Gen] SUCCESS with USER key alternative`);
        return {
          ...userResult,
          apiKeySource: 'user',
          userId: userKeyResult.userId
        };
      }
      console.log(`[Image Gen] USER key alternative also failed: ${userResult.error?.substring(0, 100)}`);
    }
    
    // ユーザーキーがない場合 → レート制限エラーをそのまま返す
    console.log(`[Image Gen] System key rate limited, no user key available for fallback`);
  }
  
  // Step 5: リトライ不可 → 元のエラーを返却
  console.log(`[Image Gen] No fallback available or all keys exhausted`);
  return {
    ...result,
    apiKeySource: keyResult.source,
    userId: keyResult.userId
  };
}

// POST /api/projects/:id/generate-images - バッチ画像生成
imageGeneration.post('/projects/:id/generate-images', async (c) => {
  try {
    const projectIdRaw = c.req.param('id')
    
    // 入力バリデーション
    const projectId = parseProjectId(projectIdRaw)
    if (!projectId) {
      return c.json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid project ID'
        }
      }, 400)
    }

    // 1. プロジェクト情報取得（output_preset を含む）
    const project = await c.env.DB.prepare(`
      SELECT id, status, output_preset FROM projects WHERE id = ?
    `).bind(projectId).first<{ id: number; status: string; output_preset: string | null }>()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }
    
    // output_preset からアスペクト比を取得
    const { getOutputPreset } = await import('../utils/output-presets')
    const outputPreset = getOutputPreset(project.output_preset)
    const aspectRatio = outputPreset.aspect_ratio
    console.log(`[Batch Image Gen] Project ${projectId}: output_preset=${project.output_preset || 'default'}, aspectRatio=${aspectRatio}`)

    // 2. ステータスチェック（formatted, generating_images, completed を許可）
    const allowedStatuses = ['formatted', 'generating_images', 'completed']
    if (!allowedStatuses.includes(project.status as string)) {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot generate images for project with status: ${project.status}`,
          details: {
            current_status: project.status,
            allowed_statuses: allowedStatuses
          }
        }
      }, 400)
    }

    // 3. プロジェクトステータスを 'generating_images' に（初回のみ）
    if (project.status === 'formatted') {
      await c.env.DB.prepare(`
        UPDATE projects 
        SET status = 'generating_images', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()
    }

    // 3.5. スタックした 'generating' レコードをタイムアウト処理（5分以上）
    await c.env.DB.prepare(`
      UPDATE image_generations
      SET status = 'failed', 
          error_message = 'Generation timeout (stuck for >5 minutes)'
      WHERE status = 'generating' 
        AND scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
        AND datetime(created_at, '+5 minutes') < datetime('now')
    `).bind(projectId).run()

    // 4. pending の scenes を取得（最大1件: Gemini APIが遅いため）
    const BATCH_SIZE = 1
    const { results: pendingScenes } = await c.env.DB.prepare(`
      SELECT s.id, s.idx, s.image_prompt, s.is_prompt_customized
      FROM scenes s
      LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
      WHERE s.project_id = ? AND ig.id IS NULL
      ORDER BY s.idx ASC
      LIMIT ?
    `).bind(projectId, BATCH_SIZE).all()

    if (pendingScenes.length === 0) {
      // 全scenes処理済み → status を 'completed' に
      await c.env.DB.prepare(`
        UPDATE projects 
        SET status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()

      const stats = await getImageGenerationStats(c.env.DB, projectId)

      return c.json({
        project_id: parseInt(projectId),
        status: 'completed',
        ...stats,
        message: 'All images generated'
      }, 200)
    }

    // 5. 各sceneの画像生成
    // SSOT: ヘルパー関数をインポート（単体生成・一括生成と統一）
    const { fetchSceneCharacters, fetchWorldSettings, enhancePromptWithWorldAndCharacters } = await import('../utils/world-character-helper');
    const { getSceneReferenceImages } = await import('../utils/character-reference-helper');
    const { fetchSceneStyleSettings, fetchStylePreset, composeFinalPrompt, getEffectiveStylePresetId } = await import('../utils/style-prompt-composer');
    
    let successCount = 0
    let failedCount = 0

    for (const scene of pendingScenes) {
      try {
        // Phase X-4: カスタムプロンプトフラグを確認
        const isPromptCustomized = scene.is_prompt_customized === 1;
        
        // 基本プロンプト構築
        let enhancedPrompt = buildImagePrompt(scene.image_prompt as string);
        
        // SSOT: キャラクター参照画像を取得 + テキスト強化
        let referenceImages: ReferenceImage[] = [];
        try {
          const characters = await fetchSceneCharacters(c.env.DB, scene.id as number);
          
          // テキスト強化（カスタムプロンプトでない場合のみ）
          if (!isPromptCustomized) {
            const world = await fetchWorldSettings(c.env.DB, parseInt(projectId));
            enhancedPrompt = enhancePromptWithWorldAndCharacters(enhancedPrompt, world, characters);
          }
          
          // SSOT: キャラクター参照画像取得（character-reference-helper使用）
          const debugRefImages = c.env.DEBUG_REFERENCE_IMAGES === '1';
          const ssotReferenceImages = await getSceneReferenceImages(
            c.env.DB,
            c.env.R2,
            scene.id as number,
            5,
            debugRefImages
          );
          
          referenceImages = ssotReferenceImages.map(img => ({
            base64Data: img.base64Data,
            mimeType: img.mimeType,
            characterName: img.characterName
          }));
        } catch (charError) {
          console.warn(`[Legacy Batch] Failed to fetch characters for scene ${scene.id}:`, charError);
        }

        // スタイルプリセット適用
        const styleSettings = await fetchSceneStyleSettings(c.env.DB, scene.id as number, parseInt(projectId));
        const effectiveStyleId = getEffectiveStylePresetId(styleSettings);
        const stylePreset = await fetchStylePreset(c.env.DB, effectiveStyleId);
        const finalPrompt = composeFinalPrompt(enhancedPrompt, stylePreset);

        // image_generationsレコード作成（generating状態）
        const insertResult = await c.env.DB.prepare(`
          INSERT INTO image_generations (
            scene_id, prompt, status, provider, model, is_active
          ) VALUES (?, ?, 'generating', 'gemini', 'gemini-3-pro-image-preview', 1)
        `).bind(scene.id, finalPrompt).run()

        const generationId = insertResult.meta.last_row_id as number

        // Gemini APIで画像生成（クォータ超過時のフォールバック付き）
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
          await c.env.DB.prepare(`
            UPDATE image_generations 
            SET status = 'failed', error_message = ?
            WHERE id = ?
          `).bind(imageResult.error || 'Unknown error', generationId).run()

          // Log failed generation
          const isQuotaExceeded = imageResult.error?.toLowerCase().includes('quota');
          await logImageGeneration({
            env: c.env,
            userId: imageResult.userId ?? 1,
            projectId: parseInt(projectId),
            sceneId: scene.id as number,
            generationType: 'scene_image',
            provider: 'gemini',
            model: 'gemini-3-pro-image-preview',
            apiKeySource: imageResult.apiKeySource,
            promptLength: finalPrompt.length,
            referenceImageCount: referenceImages.length,
            status: isQuotaExceeded ? 'quota_exceeded' : 'failed',
            errorMessage: imageResult.error || 'Unknown error',
            errorCode: isQuotaExceeded ? 'QUOTA_EXCEEDED' : 'GENERATION_FAILED'
          });

          failedCount++
          continue
        }

        // R2に画像保存（リトライ機構付き）
        const r2Key = buildR2Key(
          parseInt(projectId),
          scene.idx as number,
          generationId
        )

        const r2UploadResult = await uploadToR2WithRetry(
          c.env.R2,
          r2Key,
          imageResult.imageData!
        );
        
        if (!r2UploadResult.success) {
          // R2アップロード失敗 → status = 'failed', error_message保存
          await c.env.DB.prepare(`
            UPDATE image_generations 
            SET status = 'failed', error_message = ?
            WHERE id = ?
          `).bind(r2UploadResult.error || 'R2 upload failed', generationId).run();
          
          console.error(`[Batch Gen] R2 upload failed for scene ${scene.id}: ${r2UploadResult.error}`);
          failedCount++;
          continue;
        }

        // R2 URL: r2_key がすでに "images/" で始まっているので、"/" だけ追加
        const r2Url = `/${r2Key}`

        // 成功 → status = 'completed', r2_key, r2_url保存
        const updateResult = await c.env.DB.prepare(`
          UPDATE image_generations 
          SET status = 'completed', r2_key = ?, r2_url = ?
          WHERE id = ?
        `).bind(r2Key, r2Url, generationId).run()

        // ✅ DB更新失敗時の検証
        if (!updateResult.success) {
          console.error(`DB update failed for generation ${generationId}:`, updateResult)
          throw new Error('Failed to update image generation record')
        }

        // ✅ r2_url が null でないことを確認（念のため）
        const verifyResult = await c.env.DB.prepare(`
          SELECT r2_url FROM image_generations WHERE id = ?
        `).bind(generationId).first()

        if (!verifyResult || !verifyResult.r2_url) {
          console.error(`r2_url is null after update for generation ${generationId}`)
          // r2_url が null の場合、failed に戻す
          await c.env.DB.prepare(`
            UPDATE image_generations 
            SET status = 'failed', error_message = 'R2 URL update failed'
            WHERE id = ?
          `).bind(generationId).run()
          throw new Error('r2_url is null after DB update')
        }

        // Log image generation to image_generation_logs
        await logImageGeneration({
          env: c.env,
          userId: imageResult.userId ?? 1,
          projectId: parseInt(projectId),
          sceneId: scene.id as number,
          generationType: 'scene_image',
          provider: 'gemini',
          model: 'gemini-3-pro-image-preview',
          apiKeySource: imageResult.apiKeySource,
          promptLength: finalPrompt.length,
          referenceImageCount: referenceImages.length,
          status: 'success'
        });

        successCount++

      } catch (sceneError) {
        console.error(`Failed to generate image for scene ${scene.id}:`, sceneError)
        failedCount++
      }
    }

    // 6. 統計を取得
    const stats = await getImageGenerationStats(c.env.DB, projectId)

    return c.json({
      project_id: parseInt(projectId),
      status: 'generating_images',
      batch_processed: successCount,
      batch_failed: failedCount,
      ...stats
    }, 200)

  } catch (error) {
    console.error('Batch image generation error:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate images'
      }
    }, 500)
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

    // ✅ IMPROVEMENT: Auto-cleanup stuck 'generating' records (5+ minutes old)
    // This prevents UI getting stuck at 95% indefinitely
    try {
      const cleanupResult = await c.env.DB.prepare(`
        UPDATE image_generations
        SET status = 'failed', 
            error_message = 'Generation timeout (auto-cleanup on status check)'
        WHERE status = 'generating' 
          AND scene_id IN (SELECT id FROM scenes WHERE project_id = ?)
          AND created_at < datetime('now', '-5 minutes')
      `).bind(projectId).run()
      
      if (cleanupResult.meta.changes > 0) {
        console.log(`[Image Status] Auto-cleaned ${cleanupResult.meta.changes} stuck generating records for project ${projectId}`)
      }
    } catch (cleanupErr) {
      // Cleanup failure should not block the request
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
  // Total scenes count
  const { results: scenesCount } = await db.prepare(`
    SELECT COUNT(*) as total FROM scenes WHERE project_id = ?
  `).bind(projectId).all()

  const totalScenes = scenesCount[0]?.total || 0

  // Image generation stats
  const { results: imageStats } = await db.prepare(`
    SELECT ig.status, COUNT(*) as count
    FROM image_generations ig
    JOIN scenes s ON ig.scene_id = s.id
    WHERE s.project_id = ? AND ig.is_active = 1
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
    const { getOutputPreset } = await import('../utils/output-presets')
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
    const { fetchSceneStyleSettings, fetchStylePreset, composeFinalPrompt, getEffectiveStylePresetId } = await import('../utils/style-prompt-composer')
    
    const styleSettings = await fetchSceneStyleSettings(
      c.env.DB,
      parseInt(sceneId),
      scene.project_id as number
    )
    
    const effectiveStyleId = getEffectiveStylePresetId(styleSettings)
    const stylePreset = await fetchStylePreset(c.env.DB, effectiveStyleId)
    
    // 6. Phase X-2: Fetch world settings and character info (Optional - no error if missing)
    // Phase X-4: If prompt is customized, skip text enhancement but still load reference images
    const isPromptCustomized = scene.is_prompt_customized === 1;
    let enhancedPrompt = buildImagePrompt(scene.image_prompt as string);
    let referenceImages: ReferenceImage[] = [];
    
    try {
      const { fetchWorldSettings, fetchSceneCharacters, enhancePromptWithWorldAndCharacters } = await import('../utils/world-character-helper');
      const { getSceneReferenceImages } = await import('../utils/character-reference-helper');
      
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
    
    // 7. 最終プロンプト生成（スタイル適用）
    const finalPrompt = composeFinalPrompt(enhancedPrompt, stylePreset)

    // 7. image_generationsレコード作成（pending状態）
    const insertResult = await c.env.DB.prepare(`
      INSERT INTO image_generations (
        scene_id, prompt, status, provider, model, is_active
      ) VALUES (?, ?, 'pending', 'gemini', 'gemini-3-pro-image-preview', 0)
    `).bind(sceneId, finalPrompt).run()

    const generationId = insertResult.meta.last_row_id as number

    // 8. ステータスを 'generating' に更新
    await c.env.DB.prepare(`
      UPDATE image_generations SET status = 'generating' WHERE id = ?
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
      await c.env.DB.prepare(`
        UPDATE image_generations 
        SET status = 'failed', error_message = ?
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
        model: 'gemini-3-pro-image-preview',
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

      await c.env.DB.prepare(`
        UPDATE image_generations 
        SET status = 'failed', error_message = ?
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
    
    const updateResult = await c.env.DB.prepare(`
      UPDATE image_generations 
      SET status = 'completed', r2_key = ?, r2_url = ?, is_active = 1
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
      model: 'gemini-3-pro-image-preview',
      apiKeySource: imageResult.apiKeySource,
      promptLength: finalPrompt.length,
      referenceImageCount: referenceImages.length,
      status: 'success'
    });

    // 14. レスポンス返却
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

// POST /api/projects/:id/generate-all-images - 一括画像生成
imageGeneration.post('/:id/generate-all-images', async (c) => {
  try {
    const projectId = c.req.param('id')
    const body = await c.req.json().catch(() => ({ mode: 'all' }))
    const mode = body.mode || 'all' // 'all' | 'pending' | 'failed'

    // 1. プロジェクト情報取得（output_preset を含む）
    const project = await c.env.DB.prepare(`
      SELECT id, status, output_preset FROM projects WHERE id = ?
    `).bind(projectId).first<{ id: number; status: string; output_preset: string | null }>()

    if (!project) {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found'
        }
      }, 404)
    }
    
    // output_preset からアスペクト比を取得
    const { getOutputPreset } = await import('../utils/output-presets')
    const outputPreset = getOutputPreset(project.output_preset)
    const aspectRatio = outputPreset.aspect_ratio
    console.log(`[Batch All Image Gen] Project ${projectId}: output_preset=${project.output_preset || 'default'}, aspectRatio=${aspectRatio}`)

    // 2. ステータスチェック（formatted以降のみ許可）
    const allowedStatuses = ['formatted', 'generating_images', 'completed']
    if (!allowedStatuses.includes(project.status as string)) {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot generate images for project with status: ${project.status}`
        }
      }, 400)
    }

    // 3. ステータスを 'generating_images' に更新
    if (project.status === 'formatted') {
      await c.env.DB.prepare(`
        UPDATE projects SET status = 'generating_images', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()
    }

    // 4. 対象シーン取得（is_prompt_customizedも取得）
    let targetScenes: any[] = []
    
    if (mode === 'all') {
      // 全シーン
      const { results } = await c.env.DB.prepare(`
        SELECT id, idx, image_prompt, is_prompt_customized FROM scenes
        WHERE project_id = ?
        ORDER BY idx ASC
      `).bind(projectId).all()
      targetScenes = results
    } else if (mode === 'pending') {
      // アクティブな画像がないシーン
      const { results } = await c.env.DB.prepare(`
        SELECT s.id, s.idx, s.image_prompt, s.is_prompt_customized
        FROM scenes s
        LEFT JOIN image_generations ig ON s.id = ig.scene_id AND ig.is_active = 1
        WHERE s.project_id = ? AND ig.id IS NULL
        ORDER BY s.idx ASC
      `).bind(projectId).all()
      targetScenes = results
    } else if (mode === 'failed') {
      // 最後の生成が失敗したシーン
      const { results } = await c.env.DB.prepare(`
        SELECT s.id, s.idx, s.image_prompt, s.is_prompt_customized
        FROM scenes s
        INNER JOIN (
          SELECT scene_id, MAX(id) as max_id
          FROM image_generations
          GROUP BY scene_id
        ) latest ON s.id = latest.scene_id
        INNER JOIN image_generations ig ON ig.id = latest.max_id
        WHERE s.project_id = ? AND ig.status = 'failed'
        ORDER BY s.idx ASC
      `).bind(projectId).all()
      targetScenes = results
    }

    const totalScenes = targetScenes.length

    if (totalScenes === 0) {
      return c.json({
        project_id: parseInt(projectId),
        total_scenes: 0,
        target_scenes: 0,
        mode,
        status: project.status,
        message: 'No scenes to generate'
      }, 200)
    }

    // 5. 各シーンで画像生成（順次実行）
    let successCount = 0
    let failedCount = 0
    
    // ★ 一括生成用: ユーザーキーがレート制限に達したらシステムキーを優先
    let useSystemKeyFirst = false;
    
    // ヘルパー関数をインポート
    const { fetchSceneCharacters, fetchWorldSettings, enhancePromptWithWorldAndCharacters } = await import('../utils/world-character-helper');
    const { fetchSceneStyleSettings, fetchStylePreset, composeFinalPrompt, getEffectiveStylePresetId } = await import('../utils/style-prompt-composer');
    const { getSceneReferenceImages } = await import('../utils/character-reference-helper');

    for (const scene of targetScenes) {
      try {
        // Phase X-4: カスタムプロンプトフラグを確認（先に取得）
        const isPromptCustomized = scene.is_prompt_customized === 1;
        
        // 基本プロンプト構築
        let enhancedPrompt = buildImagePrompt(scene.image_prompt as string)
        
        // Phase X-3: キャラクター参照画像を取得 + テキスト強化
        let referenceImages: ReferenceImage[] = [];
        try {
          const characters = await fetchSceneCharacters(c.env.DB, scene.id as number);
          
          // テキスト強化（カスタムプロンプトでない場合のみ）
          if (!isPromptCustomized) {
            const world = await fetchWorldSettings(c.env.DB, parseInt(projectId));
            enhancedPrompt = enhancePromptWithWorldAndCharacters(enhancedPrompt, world, characters);
          }
          
          // SSOT: キャラクター参照画像取得（character-reference-helper使用）
          const debugRefImages = c.env.DEBUG_REFERENCE_IMAGES === '1';
          const ssotReferenceImages = await getSceneReferenceImages(
            c.env.DB,
            c.env.R2,
            scene.id as number,
            5,
            debugRefImages
          );
          
          referenceImages = ssotReferenceImages.map(img => ({
            base64Data: img.base64Data,
            mimeType: img.mimeType,
            characterName: img.characterName
          }));
        } catch (charError) {
          console.warn(`[Batch Image Gen] Failed to fetch characters for scene ${scene.id}:`, charError);
        }

        // スタイルプリセット適用
        const styleSettings = await fetchSceneStyleSettings(c.env.DB, scene.id as number, parseInt(projectId));
        const effectiveStyleId = getEffectiveStylePresetId(styleSettings);
        const stylePreset = await fetchStylePreset(c.env.DB, effectiveStyleId);
        const finalPrompt = composeFinalPrompt(enhancedPrompt, stylePreset);

        // image_generationsレコード作成
        const insertResult = await c.env.DB.prepare(`
          INSERT INTO image_generations (
            scene_id, prompt, status, provider, model, is_active
          ) VALUES (?, ?, 'generating', 'gemini', 'gemini-3-pro-image-preview', 0)
        `).bind(scene.id, finalPrompt).run()

        const generationId = insertResult.meta.last_row_id as number

        // Gemini APIで画像生成（クォータ超過時のフォールバック付き）
        // R4-fix: ユーザーキー → システムキーの優先順位 + クォータ超過時フォールバック
        // ★ 一括生成: 前のシーンでレート制限が発生した場合、システムキーを優先
        const imageResult = await generateImageWithFallback(
          c,
          finalPrompt,
          referenceImages,
          { 
            aspectRatio, 
            skipDefaultInstructions: isPromptCustomized,
            preferSystemKey: useSystemKeyFirst  // ★ 前のシーンでレート制限なら true
          }
        )

        if (!imageResult.success) {
          // 失敗
          await c.env.DB.prepare(`
            UPDATE image_generations 
            SET status = 'failed', error_message = ?
            WHERE id = ?
          `).bind(imageResult.error || 'Unknown error', generationId).run()
          
          // Log failed generation
          const isQuotaExceeded = imageResult.error?.toLowerCase().includes('quota') ||
                                  imageResult.error?.includes('429') ||
                                  imageResult.error?.includes('RATE_LIMIT_429');
          
          // ★ レート制限エラーの場合、次のシーンからシステムキーを優先
          if (isQuotaExceeded && imageResult.apiKeySource === 'user') {
            console.log(`[Batch All Gen] User key rate limited at scene ${scene.id}, switching to system key for remaining scenes`);
            useSystemKeyFirst = true;
          }
          
          await logImageGeneration({
            env: c.env,
            userId: imageResult.userId ?? 1,
            projectId: parseInt(projectId),
            sceneId: scene.id as number,
            generationType: 'scene_image',
            provider: 'gemini',
            model: 'gemini-3-pro-image-preview',
            apiKeySource: imageResult.apiKeySource,
            promptLength: finalPrompt.length,
            referenceImageCount: referenceImages.length,
            status: isQuotaExceeded ? 'quota_exceeded' : 'failed',
            errorMessage: imageResult.error || 'Unknown error',
            errorCode: isQuotaExceeded ? 'QUOTA_EXCEEDED' : 'GENERATION_FAILED'
          });
          
          failedCount++
          continue
        }

        // R2に保存（リトライ機構付き）
        const r2Key = buildR2Key(parseInt(projectId), scene.idx as number, generationId)
        const r2UploadResult = await uploadToR2WithRetry(
          c.env.R2,
          r2Key,
          imageResult.imageData!
        );
        
        if (!r2UploadResult.success) {
          // R2アップロード失敗
          await c.env.DB.prepare(`
            UPDATE image_generations 
            SET status = 'failed', error_message = ?
            WHERE id = ?
          `).bind(r2UploadResult.error || 'R2 upload failed', generationId).run();
          
          console.error(`[All Gen] R2 upload failed for scene ${scene.id}: ${r2UploadResult.error}`);
          failedCount++;
          continue;
        }

        // 既存のアクティブ画像を無効化
        await c.env.DB.prepare(`
          UPDATE image_generations 
          SET is_active = 0 
          WHERE scene_id = ? AND id != ? AND is_active = 1
        `).bind(scene.id, generationId).run()

        // 新しい画像をアクティブ化（r2_url も保存）
        const r2Url = `/${r2Key}`
        await c.env.DB.prepare(`
          UPDATE image_generations 
          SET status = 'completed', r2_key = ?, r2_url = ?, is_active = 1
          WHERE id = ?
        `).bind(r2Key, r2Url, generationId).run()

        // Log successful generation
        await logImageGeneration({
          env: c.env,
          userId: imageResult.userId ?? 1,
          projectId: parseInt(projectId),
          sceneId: scene.id as number,
          generationType: 'scene_image',
          provider: 'gemini',
          model: 'gemini-3-pro-image-preview',
          apiKeySource: imageResult.apiKeySource,
          promptLength: finalPrompt.length,
          referenceImageCount: referenceImages.length,
          status: 'success'
        });

        successCount++

      } catch (sceneError) {
        console.error(`Failed to generate image for scene ${scene.id}:`, sceneError)
        failedCount++
      }
    }

    // 6. 全て成功した場合、プロジェクトステータスを 'completed' に更新
    if (successCount === totalScenes && failedCount === 0) {
      await c.env.DB.prepare(`
        UPDATE projects SET status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(projectId).run()
    }

    // 7. レスポンス返却
    return c.json({
      project_id: parseInt(projectId),
      total_scenes: totalScenes,
      success_count: successCount,
      failed_count: failedCount,
      mode,
      status: successCount === totalScenes ? 'completed' : 'generating_images'
    }, 200)

  } catch (error) {
    console.error('Error in generate-all-images endpoint:', error)
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate images'
      }
    }, 500)
  }
})

/**
 * 画像生成オプション
 */
interface ImageGenerationOptions {
  aspectRatio?: '16:9' | '9:16' | '1:1';
  skipDefaultInstructions?: boolean;
  /** 一括生成でユーザーキーがレート制限に達した場合、システムキーを優先 */
  preferSystemKey?: boolean;
}

/**
 * Gemini APIで画像生成（429リトライ付き）
 * 公式仕様: generateContent エンドポイント
 * キャラクター参照画像をサポート（最大5枚）
 * 
 * @param prompt - 画像生成プロンプト
 * @param apiKey - Gemini API キー
 * @param maxRetries - 最大リトライ回数
 * @param referenceImages - キャラクター参照画像
 * @param options - 生成オプション（アスペクト比、指示スキップ）
 */
async function generateImageWithRetry(
  prompt: string,
  apiKey: string,
  maxRetries: number = 3,
  referenceImages: ReferenceImage[] = [],
  options: ImageGenerationOptions = {}
): Promise<{
  success: boolean
  imageData?: ArrayBuffer
  error?: string
}> {
  const { aspectRatio = '16:9', skipDefaultInstructions = false } = options;
  let lastError: string = ''

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // パーツを構築：参照画像 + テキストプロンプト
      const parts: any[] = []
      
      // キャラクター参照画像を追加（最大5枚）
      // ※ 参照画像は常に使用（視覚的一貫性のため）
      const limitedImages = referenceImages.slice(0, 5)
      for (const refImg of limitedImages) {
        parts.push({
          inline_data: {
            data: refImg.base64Data,
            mime_type: refImg.mimeType
          }
        })
      }
      
      // Phase X-4: カスタムプロンプトの場合はデフォルト指示をスキップ
      let enhancedPrompt = prompt
      
      // アスペクト比に応じた解像度を決定
      // Gemini API: 2K = 2048px on longest side
      // 16:9 → 2048x1152, 9:16 → 1152x2048, 1:1 → 1440x1440
      const imageSize = '2K'; // Gemini APIの2Kは自動で適切なサイズに調整
      
      console.log(`[Gemini Image Gen] Using aspectRatio: ${aspectRatio}, imageSize: ${imageSize}`);
      
      if (skipDefaultInstructions) {
        // カスタムプロンプト: 参照画像の説明のみ追加（日本語指示なし）
        if (limitedImages.length > 0) {
          const charNames = limitedImages
            .filter(img => img.characterName)
            .map(img => img.characterName)
            .join(', ')
          if (charNames) {
            enhancedPrompt = `Using the provided reference images for character visual consistency (${charNames}), generate: ${prompt}`
          } else {
            enhancedPrompt = `Using the provided reference images for character visual consistency, generate: ${prompt}`
          }
        }
        console.log('[Gemini Image Gen] Custom prompt mode - skipping default instructions')
      } else {
        // 通常モード: 日本語指示 + 参照画像説明
        const japaneseTextInstruction = 'IMPORTANT: Any text, signs, or labels in the image MUST be written in Japanese (日本語). Do NOT use English text.'
        
        if (limitedImages.length > 0) {
          const charNames = limitedImages
            .filter(img => img.characterName)
            .map(img => img.characterName)
            .join(', ')
          if (charNames) {
            enhancedPrompt = `${japaneseTextInstruction}\n\nUsing the provided reference images for character consistency (${charNames}), generate: ${prompt}`
          } else {
            enhancedPrompt = `${japaneseTextInstruction}\n\nUsing the provided reference images for character consistency, generate: ${prompt}`
          }
        } else {
          enhancedPrompt = `${japaneseTextInstruction}\n\n${prompt}`
        }
      }
      
      // テキストプロンプトを追加
      parts.push({ text: enhancedPrompt })
      
      console.log('[Gemini Image Gen] Request:', {
        referenceImageCount: limitedImages.length,
        promptLength: enhancedPrompt.length,
        hasCharacterRefs: limitedImages.some(img => img.characterName)
      })

      // Gemini API公式仕様: generateContent
      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent',
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [
              {
                parts: parts
              }
            ],
            generationConfig: {
              responseModalities: ['Image'],
              imageConfig: {
                aspectRatio: aspectRatio,  // output_preset から動的に設定
                imageSize: imageSize
              }
            }
          })
        }
      )

      // 429エラー時はリトライ
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After')
        // 指数バックオフ: 5s, 10s, 20s, 40s, 60s (max 60s) - Gemini無料枠(15 RPM)対応
        const waitTime = retryAfter 
          ? parseInt(retryAfter) * 1000 
          : Math.min(Math.pow(2, attempt + 1) * 2500, 60000)

        console.warn(`Rate limited (429). Retrying after ${waitTime}ms... (attempt ${attempt + 1}/${maxRetries})`)
        
        if (attempt < maxRetries - 1) {
          await sleep(waitTime)
          continue
        } else {
          // フォールバック判定用に 'RATE_LIMIT_429' を含める
          lastError = 'RATE_LIMIT_429: 画像生成のレート制限に達しました。Gemini APIの無料枠（1分間に15リクエスト）を超えています。'
          break
        }
      }

      // その他のエラー
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        
        // 詳細なエラー情報を構築
        const errorDetails = {
          status: response.status,
          message: errorData.error?.message || `API error: ${response.status}`,
          code: errorData.error?.code || 'UNKNOWN',
          details: errorData.error?.details || null
        }
        
        // JSON形式でエラーを保存（省略なし）
        lastError = JSON.stringify(errorDetails)
        console.error('Gemini API error (full details):', {
          httpStatus: response.status,
          errorCode: errorDetails.code,
          errorMessage: errorDetails.message,
          errorDetails: errorDetails.details,
          prompt: prompt.substring(0, 100) + '...'
        })
        break
      }

      // 成功: レスポンスから画像データを取得
      const result = await response.json()
      
      // candidates[0].content.parts から inlineData.data を取得
      if (result.candidates && result.candidates.length > 0) {
        const parts = result.candidates[0].content?.parts || []
        
        for (const part of parts) {
          if (part.inlineData && part.inlineData.data) {
            // base64デコード: atob (Web標準、Cloudflare Workers対応)
            const base64Data = part.inlineData.data
            const binaryString = atob(base64Data)
            const bytes = new Uint8Array(binaryString.length)
            
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i)
            }
            
            console.log('Image generation success:', {
              model: 'gemini-3-pro-image-preview',
              endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent',
              promptLength: prompt.length,
              imageSize: '2K',
              aspectRatio: '16:9',
              dataSizeBytes: bytes.buffer.byteLength
            })
            
            return {
              success: true,
              imageData: bytes.buffer
            }
          }
        }
        
        lastError = 'No inline data in response parts'
        break
      } else {
        lastError = 'No candidates in response'
        break
      }

    } catch (error) {
      const errorDetails = {
        type: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : null,
        attempt: attempt + 1,
        maxRetries
      }
      
      lastError = JSON.stringify(errorDetails)
      console.error(`Image generation attempt ${attempt + 1} failed (full details):`, {
        errorType: errorDetails.type,
        errorMessage: errorDetails.message,
        attempt: errorDetails.attempt,
        maxRetries: errorDetails.maxRetries,
        promptLength: prompt.length
      })
      
      // 最後の試行でない場合はリトライ
      if (attempt < maxRetries - 1) {
        await sleep(Math.pow(2, attempt) * 1000)
        continue
      }
    }
  }

  return {
    success: false,
    error: lastError
  }
}

// Sleep utility
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export default imageGeneration
