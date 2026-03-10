/**
 * Gemini Image Generation Client — SSOT (Single Source of Truth)
 *
 * 全ての Gemini 画像生成を統一する共通クライアント。
 * image-generation.ts と marunage.ts の両方からこのモジュールを使用する。
 *
 * 統一ポイント:
 * - APIエンドポイント・モデル名
 * - リクエスト形式 (camelCase: inlineData — Gemini SDK 公式準拠)
 * - リトライ・タイムアウト・429バックオフロジック
 * - エラーハンドリング形式
 *
 * Ref: docs/RATE_LIMIT_AWARE_ARCHITECTURE_v1.md
 */

// ============================================================
// Constants
// ============================================================

export const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview'
export const GEMINI_IMAGE_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`

/** 
 * 1リクエストあたりのAPIタイムアウト (ms)
 * ★ 50秒に延長: Gemini画像生成は参照画像付きで30-45秒かかることがある
 *   Cloudflare Workers のI/O待ちは30秒CPU上限にカウントされない
 */
const API_TIMEOUT_MS = 50_000

/**
 * 全リトライ合計の上限 (ms)
 * ★ 120秒に延長: Workers実行コンテキストは数分間維持可能（I/O待ち中心のため）
 *   これにより attempt=1が50秒タイムアウトしても、attempt=2で再試行できる
 */
const MAX_TOTAL_ELAPSED_MS = 120_000

/** デフォルトリトライ回数 */
const DEFAULT_MAX_RETRIES = 3

/** 画像間の待機時間 (ms) — Gemini 15 RPM (free) 対策 */
export const IMAGE_GEN_DELAY_MS = 3_000

// ============================================================
// Types
// ============================================================

export interface GeminiReferenceImage {
  base64Data: string
  mimeType: string
  characterName?: string
}

export interface GeminiImageOptions {
  aspectRatio?: '16:9' | '9:16' | '1:1'
  /** カスタムプロンプトの場合、日本語テキスト指示をスキップ */
  skipDefaultInstructions?: boolean
  maxRetries?: number
}

export interface GeminiImageResult {
  success: boolean
  imageData?: ArrayBuffer
  error?: string
  /** Gemini API 呼び出しにかかった実時間 (ms) */
  durationMs?: number
}

// ============================================================
// Core: generateImageWithRetry (SSOT)
// ============================================================

/**
 * Gemini API で画像生成 (429 リトライ付き)
 *
 * 仕様:
 * - generateContent エンドポイント使用
 * - キャラクター参照画像 (最大5枚) サポート
 * - 429 → 指数バックオフ (5s, 10s, 20s — 上限 20s)
 * - サーバーエラー (500/502/503/524) → リトライ
 * - 全リトライ合計 55 秒制限 (Workers 保護)
 *
 * @param prompt     画像生成プロンプト
 * @param apiKey     Gemini API キー
 * @param referenceImages キャラクター参照画像
 * @param options    生成オプション
 */
export async function generateImageWithRetry(
  prompt: string,
  apiKey: string,
  referenceImages: GeminiReferenceImage[] = [],
  options: GeminiImageOptions = {}
): Promise<GeminiImageResult> {
  const {
    aspectRatio = '16:9',
    skipDefaultInstructions = false,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = options

  let lastError = ''
  const startedAt = Date.now()

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // ★ 合計経過時間チェック (Workers 実行コンテキスト保護)
    if (Date.now() - startedAt > MAX_TOTAL_ELAPSED_MS) {
      console.warn(
        `[GeminiImageClient] Total elapsed ${Date.now() - startedAt}ms exceeds ${MAX_TOTAL_ELAPSED_MS}ms, aborting retries`
      )
      lastError = lastError || 'TOTAL_TIMEOUT: Image generation exceeded 55s total time limit'
      break
    }

    try {
      // --- パーツ構築: 参照画像 + テキストプロンプト ---
      const parts: any[] = []

      const limitedImages = referenceImages.slice(0, 5)
      for (const refImg of limitedImages) {
        // ★ camelCase (Gemini SDK 公式準拠)
        parts.push({
          inlineData: {
            data: refImg.base64Data,
            mimeType: refImg.mimeType,
          },
        })
      }

      // --- プロンプト強化 ---
      let enhancedPrompt: string

      const japaneseTextInstruction =
        'IMPORTANT: Any text, signs, or labels in the image MUST be written in Japanese (日本語). Do NOT use English text.'
      const characterTraitInstruction =
        'NOTE: Character descriptions marked as "(visual appearance: ...)" describe how the character should LOOK visually (clothing, features, expression, etc.). Do NOT render these descriptions as text in the image.'

      if (skipDefaultInstructions) {
        if (limitedImages.length > 0) {
          const charNames = limitedImages
            .filter((img) => img.characterName)
            .map((img) => img.characterName)
            .join(', ')
          enhancedPrompt = charNames
            ? `Using the provided reference images for character visual consistency (${charNames}), generate: ${prompt}`
            : `Using the provided reference images for character visual consistency, generate: ${prompt}`
        } else {
          enhancedPrompt = prompt
        }
        console.log('[GeminiImageClient] Custom prompt mode — skipping default instructions')
      } else {
        if (limitedImages.length > 0) {
          const charNames = limitedImages
            .filter((img) => img.characterName)
            .map((img) => img.characterName)
            .join(', ')
          enhancedPrompt = charNames
            ? `${japaneseTextInstruction}\n\n${characterTraitInstruction}\n\nUsing the provided reference images for character consistency (${charNames}), generate: ${prompt}`
            : `${japaneseTextInstruction}\n\n${characterTraitInstruction}\n\nUsing the provided reference images for character consistency, generate: ${prompt}`
        } else {
          enhancedPrompt = `${japaneseTextInstruction}\n\n${characterTraitInstruction}\n\n${prompt}`
        }
      }

      parts.push({ text: enhancedPrompt })

      console.log('[GeminiImageClient] Request:', {
        attempt: attempt + 1,
        maxRetries,
        referenceImageCount: limitedImages.length,
        promptLength: enhancedPrompt.length,
        aspectRatio,
        hasCharacterRefs: limitedImages.some((img) => img.characterName),
      })

      // --- Gemini API 呼び出し ---
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

      const response = await fetch(GEMINI_IMAGE_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio },
          },
        }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      // --- 429 レート制限 ---
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After')
        const waitTime = retryAfter
          ? parseInt(retryAfter) * 1000
          : Math.min(Math.pow(2, attempt + 1) * 2500, 20_000)

        console.warn(
          `[GeminiImageClient] Rate limited (429). Wait ${waitTime}ms (attempt ${attempt + 1}/${maxRetries})`
        )

        // 合計経過時間チェック
        if (Date.now() - startedAt + waitTime > MAX_TOTAL_ELAPSED_MS) {
          lastError =
            'RATE_LIMIT_429: 画像生成のレート制限に達しました。Gemini APIの無料枠（1分間に15リクエスト）を超えています。'
          break
        }
        if (attempt < maxRetries - 1) {
          await sleep(waitTime)
          continue
        }
        lastError =
          'RATE_LIMIT_429: 画像生成のレート制限に達しました。Gemini APIの無料枠（1分間に15リクエスト）を超えています。'
        break
      }

      // --- サーバーサイドエラー (リトライ可能) ---
      const retryableStatuses = [500, 502, 503, 524]
      if (retryableStatuses.includes(response.status)) {
        const waitTime = Math.min(Math.pow(2, attempt + 1) * 2000, 30_000)
        console.warn(
          `[GeminiImageClient] Server error ${response.status}. Wait ${waitTime}ms (attempt ${attempt + 1}/${maxRetries})`
        )
        if (attempt < maxRetries - 1) {
          await sleep(waitTime)
          continue
        }
        const errorData: any = await response.json().catch(() => ({}))
        lastError = JSON.stringify({
          status: response.status,
          message: errorData.error?.message || `API error: ${response.status} (all retries exhausted)`,
          code: errorData.error?.code || 'SERVER_ERROR',
          details: errorData.error?.details || null,
        })
        break
      }

      // --- その他のエラー (リトライ不可) ---
      if (!response.ok) {
        const errorData: any = await response.json().catch(() => ({}))
        lastError = JSON.stringify({
          status: response.status,
          message: errorData.error?.message || `API error: ${response.status}`,
          code: errorData.error?.code || 'UNKNOWN',
          details: errorData.error?.details || null,
        })
        console.error('[GeminiImageClient] Non-retryable error:', {
          httpStatus: response.status,
          errorMessage: errorData.error?.message,
          promptLength: prompt.length,
        })
        break
      }

      // --- 成功: レスポンスから画像データ取得 ---
      const result: any = await response.json()

      if (result.candidates && result.candidates.length > 0) {
        const respParts = result.candidates[0].content?.parts || []
        for (const part of respParts) {
          if (part.inlineData?.data) {
            const base64Data = part.inlineData.data
            const binaryString = atob(base64Data)
            const bytes = new Uint8Array(binaryString.length)
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i)
            }

            const durationMs = Date.now() - startedAt
            console.log('[GeminiImageClient] Success:', {
              model: GEMINI_IMAGE_MODEL,
              aspectRatio,
              promptLength: prompt.length,
              dataSizeBytes: bytes.buffer.byteLength,
              durationMs,
              attempts: attempt + 1,
            })

            return { success: true, imageData: bytes.buffer, durationMs }
          }
        }

        // candidatesはあるが画像データなし
        const finishReason = result.candidates[0]?.finishReason || 'N/A'
        const partTypes = respParts.map((p: any) =>
          p.inlineData ? 'image' : p.text ? 'text' : 'unknown'
        )
        lastError = JSON.stringify({
          type: 'NO_IMAGE_DATA',
          finishReason,
          partTypes,
          candidates: result.candidates.length,
        })
        break
      }

      lastError = 'No candidates in response'
      break
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError'
      const isMessagePort =
        error instanceof Error && error.message?.includes('message port closed')

      const errorDetails = {
        type: isAbort
          ? 'TIMEOUT'
          : isMessagePort
            ? 'WORKER_CONTEXT_CLOSED'
            : 'NETWORK_ERROR',
        message: isAbort
          ? `Gemini API did not respond within ${API_TIMEOUT_MS / 1000} seconds`
          : isMessagePort
            ? 'Cloudflare Workers execution context terminated'
            : error instanceof Error
              ? error.message
              : 'Unknown error',
        attempt: attempt + 1,
        maxRetries,
        elapsedMs: Date.now() - startedAt,
      }

      lastError = JSON.stringify(errorDetails)
      console.error(
        `[GeminiImageClient] Attempt ${attempt + 1} failed:`,
        errorDetails.type,
        errorDetails.message,
        `elapsed=${errorDetails.elapsedMs}ms`
      )

      if (attempt < maxRetries - 1) {
        // ★ タイムアウト後は即座にリトライ（500ms待ち）— 長時間待つ必要なし
        const retryDelay = isAbort || isMessagePort ? 500 : Math.min(Math.pow(2, attempt) * 1000, 5000)
        // ★ リトライ前に全体経過時間を再チェック
        if (Date.now() - startedAt + retryDelay + API_TIMEOUT_MS > MAX_TOTAL_ELAPSED_MS + 5_000) {
          console.warn(`[GeminiImageClient] Skipping retry: would exceed total time limit`)
          break
        }
        await sleep(retryDelay)
        continue
      }
    }
  }

  return { success: false, error: lastError, durationMs: Date.now() - startedAt }
}

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
