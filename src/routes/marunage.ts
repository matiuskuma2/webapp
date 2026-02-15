/**
 * Marunage Chat MVP - API Routes (Issue-1: API Foundation + Issue-2: Format & Image Generation)
 * 
 * === Non-Impact Protocol ===
 * 1) 既存 route ファイルを変更しない
 * 2) 既存の route ハンドラ関数を import しない
 *    - utils (image-prompt-builder, audit-logger) の再利用は許可
 *    - 既存 format API は HTTP 経由でのみ消費
 * 3) 書き込み対象は marunage_runs + 丸投げ新規プロジェクト配下のみ
 * 4) Issue-1: API 基盤 / Issue-2: Format 起動 + 画像生成 / Issue-5: UI
 * 
 * === Issue-1 Scope (API Foundation) ===
 * - GET  /active           — ユーザーのアクティブ run を検索
 * - POST /start            — テキスト→プロジェクト作成→run作成
 * - GET  /:projectId/status — 統合進捗 (読み取りのみ)
 * - POST /:projectId/advance — フェーズ遷移 + 処理起動
 * - POST /:projectId/retry  — 失敗 run の再開
 * - POST /:projectId/cancel — アクティブ run の中断
 * 
 * === Issue-2 Scope (Format & Image Generation) ===
 * - POST /start 後 → waitUntil で format 起動 (HTTP 経由)
 * - 5シーン収束 (advance formatting→awaiting_ready で超過シーン非表示)
 * - advance awaiting_ready→generating_images → 1枚ずつ直接生成 (waitUntil不使用)
 * - generating_images の自動リトライ (最大3回、失敗画像のみ再生成)
 * 
 * === Deferred to Issue-3 ===
 * - 音声生成 (marunageGenerateAudio)
 * 
 * Ref: docs/MARUNAGE_CHAT_MVP_PLAN_v3.md §5
 * Ref: docs/MARUNAGE_EXPERIENCE_SPEC_v1.md
 */

import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Bindings } from '../types/bindings'
import {
  type MarunagePhase,
  type MarunageConfig,
  type MarunageRunRow,
  type MarunageStartRequest,
  type MarunageStatusResponse,
  TERMINAL_PHASES,
  ALLOWED_TRANSITIONS,
  RETRY_ROLLBACK_MAP,
  MAX_RETRY_COUNT,
  DEFAULT_CONFIG,
  MARUNAGE_ERRORS,
} from '../types/marunage'
import { logAudit } from '../utils/audit-logger'
import { composeStyledPrompt, buildR2Key } from '../utils/image-prompt-builder'
import { getSceneReferenceImages } from '../utils/character-reference-helper'

const marunage = new Hono<{ Bindings: Bindings }>()

// ============================================================
// Helper: Session authentication
// ============================================================

async function getSessionUser(db: D1Database, sessionCookie: string | undefined): Promise<{ id: number; email: string; role: string } | null> {
  if (!sessionCookie) return null
  const session = await db.prepare(`
    SELECT u.id, u.email, u.role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sessionCookie).first<{ id: number; email: string; role: string }>()
  return session || null
}

function errorJson(c: any, err: { code: string; status: number }, message: string, details?: any) {
  return c.json({ error: { code: err.code, message, details: details || {} } }, err.status)
}

// ============================================================
// Helper: Get active/latest run (read-only queries)
// ============================================================

async function getActiveRunForUser(db: D1Database, userId: number): Promise<MarunageRunRow | null> {
  return await db.prepare(`
    SELECT mr.* FROM marunage_runs mr
    JOIN projects p ON p.id = mr.project_id
    WHERE mr.started_by_user_id = ? AND mr.phase NOT IN ('ready', 'failed', 'canceled')
      AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
    ORDER BY mr.created_at DESC LIMIT 1
  `).bind(userId).first<MarunageRunRow>() || null
}

async function getActiveRunForProject(db: D1Database, projectId: number): Promise<MarunageRunRow | null> {
  return await db.prepare(`
    SELECT mr.* FROM marunage_runs mr
    JOIN projects p ON p.id = mr.project_id
    WHERE mr.project_id = ? AND mr.phase NOT IN ('ready', 'failed', 'canceled')
      AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
    ORDER BY mr.created_at DESC LIMIT 1
  `).bind(projectId).first<MarunageRunRow>() || null
}

async function getLatestRunForProject(db: D1Database, projectId: number): Promise<MarunageRunRow | null> {
  return await db.prepare(`
    SELECT mr.* FROM marunage_runs mr
    JOIN projects p ON p.id = mr.project_id
    WHERE mr.project_id = ?
      AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
    ORDER BY mr.created_at DESC LIMIT 1
  `).bind(projectId).first<MarunageRunRow>() || null
}

// ============================================================
// Helper: Phase transition with optimistic locking
// ============================================================

async function transitionPhase(
  db: D1Database, runId: number, from: MarunagePhase, to: MarunagePhase,
  errorFields?: { error_code?: string; error_message?: string; error_phase?: string }
): Promise<boolean> {
  const allowed = ALLOWED_TRANSITIONS[from]
  if (!allowed?.includes(to)) {
    console.error(`[Marunage] Invalid transition: ${from} → ${to}`)
    return false
  }

  let sql = `UPDATE marunage_runs SET phase = ?, updated_at = CURRENT_TIMESTAMP`
  const binds: any[] = [to]

  if (errorFields) {
    sql += `, error_code = ?, error_message = ?, error_phase = ?`
    binds.push(errorFields.error_code || null, errorFields.error_message || null, errorFields.error_phase || null)
  }

  if (to === 'ready') {
    sql += `, completed_at = CURRENT_TIMESTAMP`
  }

  // Clear lock on terminal phases AND on generating_audio
  // (generating_audio advance handler polls audio job status, lock is not needed)
  if (TERMINAL_PHASES.includes(to) || to === 'generating_audio') {
    sql += `, locked_at = NULL, locked_until = NULL`
  }

  sql += ` WHERE id = ? AND phase = ?`
  binds.push(runId, from)

  const result = await db.prepare(sql).bind(...binds).run()
  return (result.meta?.changes ?? 0) > 0
}

// ============================================================
// Issue-2: Format startup helper (HTTP経由で既存 format API を消費)
// ============================================================

/**
 * フォーマット起動 — waitUntil 内で非同期実行
 * 既存の POST /api/projects/:id/format を HTTP 経由でポーリングする。
 * 
 * フロー:
 * 1. POST /api/projects/:id/format を呼ぶ（バッチ処理開始）
 * 2. 全チャンク完了まで繰り返し（最大 MAX_FORMAT_POLLS 回）
 * 3. formatted になったら marunage_runs の phase は advance で遷移される
 * 4. 失敗したら marunage_runs を 'failed' に遷移
 * 
 * ⚠️ 既存 route ファイルを変更しない。HTTP 消費者として既存 API を使う。
 */
const MAX_FORMAT_POLLS = 30      // 最大ポーリング回数（30回 × 3-5秒 ≈ 90-150秒）
const FORMAT_POLL_INTERVAL = 3000  // ポーリング間隔 (ms)

async function marunageFormatStartup(
  db: D1Database,
  runId: number,
  projectId: number,
  config: MarunageConfig,
  requestUrl: string,
  sessionCookie: string
): Promise<void> {
  const origin = new URL(requestUrl).origin
  const parseUrl = `${origin}/api/projects/${projectId}/parse`
  const formatUrl = `${origin}/api/projects/${projectId}/format`
  const cookieHeader = `session=${sessionCookie}`

  console.log(`[Marunage:Format] Starting format for project ${projectId}, run ${runId}`)

  try {
    // Step 0: Parse API — テキストをチャンクに分割（format の前提条件）
    console.log(`[Marunage:Format] Calling parse API for project ${projectId}`)
    const parseRes = await fetch(parseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookieHeader },
    })

    if (!parseRes.ok) {
      const parseErr = await parseRes.text().catch(() => 'Unknown')
      console.error(`[Marunage:Format] Parse API failed HTTP ${parseRes.status}: ${parseErr.substring(0, 300)}`)
      // Parse failure is fatal — cannot proceed without chunks
      await transitionPhase(db, runId, 'formatting', 'failed', {
        error_code: 'PARSE_FAILED',
        error_message: `Parse API returned ${parseRes.status}: ${parseErr.substring(0, 500)}`,
        error_phase: 'formatting',
      })
      return
    }

    const parseResult = await parseRes.json().catch(() => null) as any
    console.log(`[Marunage:Format] Parse completed: ${parseResult?.total_chunks || 0} chunks created`)

    // Step 1: Polling loop for format API
    // Phase 3 (M-5): Build character hints from project_character_models (if any)
    let characterHints: Array<{ key: string; name: string; description: string }> = []
    if (config.selected_character_ids && config.selected_character_ids.length > 0) {
      try {
        const { results: chars } = await db.prepare(`
          SELECT character_key, character_name, description
          FROM project_character_models WHERE project_id = ?
        `).bind(projectId).all()
        characterHints = (chars || []).map((ch: any) => ({
          key: ch.character_key as string,
          name: ch.character_name as string,
          description: (ch.description as string) || '',
        }))
        if (characterHints.length > 0) {
          console.log(`[Marunage:Format] Injecting ${characterHints.length} character hints into format API`)
        }
      } catch (e) {
        console.warn(`[Marunage:Format] Failed to load character hints:`, e)
      }
    }

    for (let poll = 0; poll < MAX_FORMAT_POLLS; poll++) {
      // Check if run is still active (not canceled/failed externally)
      const currentRun = await db.prepare(
        `SELECT phase FROM marunage_runs WHERE id = ? AND phase = 'formatting'`
      ).bind(runId).first<{ phase: string }>()

      if (!currentRun) {
        console.log(`[Marunage:Format] Run ${runId} is no longer in 'formatting' phase, stopping`)
        return
      }

      // Call existing format API via HTTP
      const res = await fetch(formatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookieHeader,
          'X-Execution-Context': 'marunage',
        },
        body: JSON.stringify({
          split_mode: config.split_mode || 'ai',
          target_scene_count: config.target_scene_count || 5,
          // Phase 3 (M-5): character hints for AI prompt injection
          ...(characterHints.length > 0 ? { character_hints: characterHints } : {}),
        }),
      })

      if (!res.ok) {
        const errBody = await res.text().catch(() => 'Unknown')
        console.error(`[Marunage:Format] HTTP ${res.status}: ${errBody.substring(0, 200)}`)

        // 4xx = permanent error
        if (res.status >= 400 && res.status < 500) {
          await transitionPhase(db, runId, 'formatting', 'failed', {
            error_code: 'FORMAT_API_ERROR',
            error_message: `Format API returned ${res.status}: ${errBody.substring(0, 500)}`,
            error_phase: 'formatting',
          })
          return
        }
        // 5xx = temporary, retry
        await sleep(FORMAT_POLL_INTERVAL)
        continue
      }

      const body = await res.json().catch(() => null) as any
      if (!body) {
        await sleep(FORMAT_POLL_INTERVAL)
        continue
      }

      console.log(`[Marunage:Format] Poll ${poll + 1}/${MAX_FORMAT_POLLS}: status=${body.status}, chunks=${body.total_chunks || 0}, done=${body.processed || 0}`)

      // Check if formatting is complete
      if (body.status === 'formatted') {
        // Issue-2.5: FORMAT_EMPTY — formatted だが可視シーンが0件なら failed に落とす
        const sceneCount = await db.prepare(
          `SELECT COUNT(*) as cnt FROM scenes WHERE project_id = ? AND (is_hidden = 0 OR is_hidden IS NULL)`
        ).bind(projectId).first<{ cnt: number }>()

        if (!sceneCount || sceneCount.cnt === 0) {
          console.error(`[Marunage:Format] Project ${projectId} formatted but 0 visible scenes — marking as failed`)
          await transitionPhase(db, runId, 'formatting', 'failed', {
            error_code: 'FORMAT_EMPTY',
            error_message: 'Format completed but no scenes were generated. Text may be too short or unstructured.',
            error_phase: 'formatting',
          })
          return
        }

        console.log(`[Marunage:Format] ✅ Project ${projectId} formatted successfully (${sceneCount.cnt} visible scenes)`)
        // Phase transition is handled by advance — we just log and exit
        return
      }

      // If there are pending/processing chunks, wait and retry
      if (body.status === 'formatting') {
        await sleep(FORMAT_POLL_INTERVAL)
        continue
      }

      // Unexpected status
      console.warn(`[Marunage:Format] Unexpected status: ${body.status}`)
      await sleep(FORMAT_POLL_INTERVAL)
    }

    // Polling exhausted — check if format actually completed
    const proj = await db.prepare(
      `SELECT status FROM projects WHERE id = ?`
    ).bind(projectId).first<{ status: string }>()

    if (proj?.status === 'formatted') {
      // Issue-2.5: same FORMAT_EMPTY check
      const sceneCount = await db.prepare(
        `SELECT COUNT(*) as cnt FROM scenes WHERE project_id = ? AND (is_hidden = 0 OR is_hidden IS NULL)`
      ).bind(projectId).first<{ cnt: number }>()
      if (!sceneCount || sceneCount.cnt === 0) {
        await transitionPhase(db, runId, 'formatting', 'failed', {
          error_code: 'FORMAT_EMPTY',
          error_message: 'Format completed but no scenes were generated',
          error_phase: 'formatting',
        })
        return
      }
      console.log(`[Marunage:Format] Project ${projectId} is formatted (${sceneCount.cnt} scenes, detected after polling exhausted)`)
      return
    }

    // Still not formatted after max polls
    console.error(`[Marunage:Format] Polling exhausted for project ${projectId}`)
    await transitionPhase(db, runId, 'formatting', 'failed', {
      error_code: 'FORMAT_TIMEOUT',
      error_message: `Format did not complete after ${MAX_FORMAT_POLLS} polls`,
      error_phase: 'formatting',
    })

  } catch (error) {
    console.error(`[Marunage:Format] Fatal error for run ${runId}:`, error)
    try {
      await transitionPhase(db, runId, 'formatting', 'failed', {
        error_code: 'FORMAT_CRASH',
        error_message: error instanceof Error ? error.message : String(error),
        error_phase: 'formatting',
      })
    } catch (_) {}
  }
}

// ============================================================
// Issue-2: Image generation orchestrator (丸投げ独自の Gemini 直接呼び出し)
// ============================================================

/**
 * 丸投げ専用の画像生成オーケストレーター
 * 既存の image-generation.ts をインポートしない。Gemini API を直接呼び出す。
 * 
 * フロー:
 * 1. 可視シーン(is_hidden=0)を取得
 * 2. 各シーンの image_prompt → スタイル適用 → Gemini API で生成
 * 3. R2 にアップロード → image_generations に記録
 * 4. 全完了後、ロック解除（advance が generating_audio への遷移を判定）
 * 
 * リトライ: 呼び出し元（advance）が retry_count を管理。この関数は1回分の生成のみ。
 */
// Image generation model:
//   gemini-3-pro-image-preview   → Nano Banana Pro: highest quality, Thinking mode, 4K support (avg ~19s/image)
//   gemini-2.5-flash-image       → Nano Banana: Flash-tier speed, Stable, good quality
// ★ 2026-02-13: Switched to Nano Banana Pro (gemini-3-pro-image-preview) for highest quality output
//   - Matches image-generation.ts (builder context) which already uses this model
//   - Timeout increased: 25s → 45s per attempt to accommodate Pro model's processing time
//   - Delay between images: 3s → 5s to respect lower RPM limits of Pro model
const GEMINI_MODEL = 'gemini-3-pro-image-preview'
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`
const IMAGE_GEN_RETRY = 2          // 個別画像のリトライ回数 (45s timeout × 2 = max 90s)
const IMAGE_GEN_DELAY = 5000       // 画像間の待機 (ms) — Pro model needs more spacing between requests
const MAX_R2_RETRIES = 3

// ============================================================
// Cost estimation & logging (Nano Banana Pro)
// ============================================================
// 2026-02 Google 公式レート:
//   Nano Banana Pro (gemini-3-pro-image-preview): $0.134/image (1K/2K)
//   Nano Banana     (gemini-2.5-flash-image):     $0.039/image
const COST_PER_IMAGE_USD = 0.134  // Nano Banana Pro rate

async function logImageGenerationCost(
  db: D1Database,
  params: {
    userId: number,
    projectId: string,
    sceneId: number,
    status: 'success' | 'failed',
    apiKeySource: string,
    sponsorUserId: number | null,
    promptLength: number,
    errorMessage?: string,
    generationType?: string,  // 'marunage_batch' | 'marunage_advance' (default: 'marunage_batch')
  }
): Promise<void> {
  try {
    const cost = params.status === 'success' ? COST_PER_IMAGE_USD : 0
    await db.prepare(`
      INSERT INTO image_generation_logs (
        user_id, project_id, scene_id, character_key,
        generation_type, provider, model,
        api_key_source, sponsor_user_id,
        prompt_length, image_count, image_size, image_quality,
        estimated_cost_usd, billing_unit, billing_amount,
        status, error_message, error_code,
        reference_image_count
      ) VALUES (?, ?, ?, NULL, ?, 'gemini', ?, ?, ?, ?, 1, NULL, NULL, ?, 'image', 1, ?, ?, NULL, 0)
    `).bind(
      params.userId,
      params.projectId,
      params.sceneId,
      params.generationType || 'marunage_batch',
      GEMINI_MODEL,
      params.apiKeySource,
      params.sponsorUserId,
      params.promptLength,
      cost,
      params.status,
      params.errorMessage ?? null,
    ).run()
    console.log(`[Marunage:Cost] scene=${params.sceneId} status=${params.status} cost=$${cost.toFixed(4)} model=${GEMINI_MODEL}`)
  } catch (e) {
    // ログ記録の失敗は無視
    console.error('[Marunage:Cost] Failed to log:', e)
  }
}

// ============================================================
// Issue-2.6: Billing context & API key resolution (SSOT)
// ============================================================
// 
// スポンサー判定SSOT: users.api_sponsor_id (video-generation.ts と同一ルール)
// - api_sponsor_id が設定されている → sponsor課金（api_sponsor_idのユーザーのキーを使用）
// - api_sponsor_id が NULL → user課金（本人のキーを使用）
// - どちらもキーが無い → system key にフォールバック
// - system key も無い → 失敗 (NO_API_KEY)
//
// 画像 (Gemini) と音声 (TTS) で同一の関数を使う。

type BillingSource = 'user' | 'sponsor' | 'system'

interface BillingContext {
  billingSource: BillingSource
  effectiveUserId: number | null  // キーを探すユーザー (sponsor時はsponsorのID)
  sponsorUserId: number | null    // スポンサーのユーザーID (sponsor時のみ非null)
}

async function resolveBillingContext(
  db: D1Database,
  userId: number
): Promise<BillingContext> {
  const user = await db.prepare(
    `SELECT api_sponsor_id FROM users WHERE id = ?`
  ).bind(userId).first<{ api_sponsor_id: number | null }>()

  if (user?.api_sponsor_id) {
    console.log(`[Marunage:Billing] User ${userId} is sponsored by user ${user.api_sponsor_id}`)
    return {
      billingSource: 'sponsor',
      effectiveUserId: user.api_sponsor_id,
      sponsorUserId: user.api_sponsor_id,
    }
  }

  return {
    billingSource: 'user',
    effectiveUserId: userId,
    sponsorUserId: null,
  }
}

/**
 * プロバイダーキーを解決する。
 * 優先順: effectiveUser のキー → system key → null
 * 
 * @param providerKind 'gemini' | 'tts_google' | 'tts_eleven' | 'tts_fish'
 */
async function resolveProviderKey(
  db: D1Database,
  billing: BillingContext,
  providerKind: string,
  systemKey: string | undefined,
  encryptionKey: string | undefined
): Promise<{ apiKey: string; keySource: BillingSource } | null> {
  // Map providerKind to DB provider name
  const dbProvider = providerKind === 'gemini' ? 'google' : providerKind.replace('tts_', '')

  // Step 1: effectiveUser (user or sponsor) のキーを試行
  if (billing.effectiveUserId && encryptionKey) {
    try {
      const keyRecord = await db.prepare(`
        SELECT encrypted_key FROM user_api_keys
        WHERE user_id = ? AND provider = ? AND is_active = 1
      `).bind(billing.effectiveUserId, dbProvider).first<{ encrypted_key: string }>()

      if (keyRecord?.encrypted_key) {
        const { decryptApiKey } = await import('../utils/crypto')
        const apiKey = await decryptApiKey(keyRecord.encrypted_key, encryptionKey)
        console.log(`[Marunage:Key] Using ${billing.billingSource} key (user_id=${billing.effectiveUserId}, provider=${dbProvider})`)
        return { apiKey, keySource: billing.billingSource }
      }
    } catch (e) {
      console.warn(`[Marunage:Key] Decrypt failed for user ${billing.effectiveUserId}:`, e)
    }
  }

  // Step 2: System key fallback
  if (systemKey) {
    console.log(`[Marunage:Key] Falling back to system key for ${providerKind}`)
    return { apiKey: systemKey, keySource: 'system' }
  }

  console.error(`[Marunage:Key] No key available for ${providerKind} (billing=${billing.billingSource}, effectiveUser=${billing.effectiveUserId})`)
  return null
}

/**
 * Gemini API で画像を1枚生成 (リトライ付き)
 * Phase 4 (M-7): referenceImages 追加 — キャラ参照画像を Gemini に渡す
 */
async function generateSingleImage(
  apiKey: string,
  prompt: string,
  aspectRatio: '16:9' | '9:16' | '1:1',
  referenceImages?: Array<{ base64Data: string; mimeType: string; characterName?: string }>
): Promise<{ success: boolean; imageData?: ArrayBuffer; error?: string }> {
  const japaneseTextInstruction = 'IMPORTANT: Any text, signs, or labels in the image MUST be written in Japanese (日本語). Do NOT use English text.'
  const characterTraitInstruction = 'NOTE: Character descriptions marked as "(visual appearance: ...)" describe how the character should LOOK visually. Do NOT render these descriptions as text in the image.'
  
  // Phase 4 (M-7): Add character consistency instruction when reference images are provided
  let enhancedPrompt = `${japaneseTextInstruction}\n\n${characterTraitInstruction}\n\n${prompt}`
  if (referenceImages && referenceImages.length > 0) {
    const charNames = referenceImages
      .filter(r => r.characterName)
      .map(r => r.characterName)
      .join(', ')
    if (charNames) {
      enhancedPrompt = `${japaneseTextInstruction}\n\n${characterTraitInstruction}\n\nUsing the provided reference images for character visual consistency (${charNames}), generate:\n\n${prompt}`
    }
  }

  let lastError = ''

  for (let attempt = 0; attempt < IMAGE_GEN_RETRY; attempt++) {
    try {
      // 45s timeout per attempt — Pro model (Nano Banana Pro) needs longer processing time (~19s avg)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 45000)
      
      const response = await fetch(GEMINI_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ parts: [
            // Phase 4 (M-7): Reference images first (if any) for character consistency
            ...(referenceImages || []).map(img => ({
              inlineData: { mimeType: img.mimeType, data: img.base64Data }
            })),
            { text: enhancedPrompt }
          ] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio },
          },
        }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      // Rate limit → retry with backoff
      if (response.status === 429) {
        const waitTime = Math.min(Math.pow(2, attempt + 1) * 2500, 60000)
        console.warn(`[Marunage:Image] 429 rate limit, waiting ${waitTime}ms (attempt ${attempt + 1}/${IMAGE_GEN_RETRY})`)
        if (attempt < IMAGE_GEN_RETRY - 1) {
          await sleep(waitTime)
          continue
        }
        lastError = 'RATE_LIMIT_429: Gemini API rate limit exceeded'
        break
      }

      if (!response.ok) {
        const errData = await response.json().catch(() => ({})) as any
        // Issue-2.7: Capture detailed error info for debugging
        const errorInfo = {
          status: response.status,
          code: errData?.error?.code || 'UNKNOWN',
          message: errData?.error?.message || `API error: ${response.status}`,
        }
        lastError = JSON.stringify(errorInfo).substring(0, 1000)
        console.error(`[Marunage:Image] Gemini error:`, errorInfo)
        break
      }

      const result = await response.json() as any

      // Issue-2.7: Capture response structure for debugging on failure
      const candidateCount = result.candidates?.length || 0
      const finishReason = result.candidates?.[0]?.finishReason || 'N/A'
      const partTypes = result.candidates?.[0]?.content?.parts?.map((p: any) =>
        p.inlineData ? 'image' : p.text ? 'text' : 'unknown'
      ) || []

      if (result.candidates?.[0]?.content?.parts) {
        for (const part of result.candidates[0].content.parts) {
          if (part.inlineData?.data) {
            const binaryString = atob(part.inlineData.data)
            const bytes = new Uint8Array(binaryString.length)
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i)
            }
            return { success: true, imageData: bytes.buffer }
          }
        }
        // Has candidates but no image data
        lastError = JSON.stringify({
          type: 'NO_IMAGE_DATA',
          candidates: candidateCount,
          finishReason,
          partTypes,
        }).substring(0, 1000)
        break
      }

      lastError = JSON.stringify({
        type: 'NO_CANDIDATES',
        candidates: candidateCount,
        finishReason,
        partTypes,
      }).substring(0, 1000)
      break

    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError'
      lastError = isAbort ? 'TIMEOUT_45s: Gemini API (Nano Banana Pro) did not respond within 45 seconds' : (error instanceof Error ? error.message : String(error))
      console.warn(`[Marunage:Image] Attempt ${attempt + 1}/${IMAGE_GEN_RETRY} failed: ${lastError}`)
      if (attempt < IMAGE_GEN_RETRY - 1) {
        await sleep(isAbort ? 1000 : 2000 * (attempt + 1))
        continue
      }
    }
  }

  return { success: false, error: lastError }
}

/**
 * R2 アップロード (リトライ付き)
 */
async function uploadToR2(
  r2: R2Bucket,
  key: string,
  data: ArrayBuffer
): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 0; attempt < MAX_R2_RETRIES; attempt++) {
    try {
      await r2.put(key, data)
      return { success: true }
    } catch (error) {
      if (attempt < MAX_R2_RETRIES - 1) {
        await sleep(1000 * Math.pow(2, attempt))
        continue
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { success: false, error: 'R2 upload exhausted' }
}

/**
 * 丸投げ画像生成メインループ
 * 可視シーンの中で画像が未生成のものを順次生成する。
 * 
 * @param mode 'full' = 全シーン生成, 'retry' = 失敗のみ再生成
 */
async function marunageGenerateImages(
  db: D1Database,
  r2: R2Bucket,
  runId: number,
  projectId: number,
  config: MarunageConfig,
  userId: number | null,
  env: Bindings,
  mode: 'full' | 'retry' = 'full'
): Promise<void> {
  console.log(`[Marunage:Image] Starting image generation for project ${projectId}, run ${runId}, mode=${mode}`)

  const aspectRatio = config.output_preset === 'short_vertical' ? '9:16' : '16:9'

  // Issue-2.6: Billing-aware key resolution
  const billing = userId
    ? await resolveBillingContext(db, userId)
    : { billingSource: 'system' as BillingSource, effectiveUserId: null, sponsorUserId: null }

  const keyResult = await resolveProviderKey(db, billing, 'gemini', env.GEMINI_API_KEY, env.ENCRYPTION_KEY)
  if (!keyResult) {
    console.error(`[Marunage:Image] No Gemini API key available (billing=${billing.billingSource})`)
    await transitionPhase(db, runId, 'generating_images', 'failed', {
      error_code: 'NO_API_KEY',
      error_message: `No Gemini API key configured (billing=${billing.billingSource}, effective_user=${billing.effectiveUserId})`,
      error_phase: 'generating_images',
    })
    return
  }
  console.log(`[Marunage:Image] Key resolved: billing=${billing.billingSource}, keySource=${keyResult.keySource}`)

  // Get visible scenes
  const { results: scenes } = await db.prepare(`
    SELECT s.id, s.idx, s.image_prompt
    FROM scenes s
    WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
    ORDER BY s.idx ASC
  `).bind(projectId).all()

  if (!scenes || scenes.length === 0) {
    console.error(`[Marunage:Image] No visible scenes for project ${projectId}`)
    await transitionPhase(db, runId, 'generating_images', 'failed', {
      error_code: 'NO_SCENES',
      error_message: 'No visible scenes found',
      error_phase: 'generating_images',
    })
    return
  }

  let generated = 0
  let failed = 0

  for (const scene of scenes as any[]) {
    // Check if run is still in generating_images (not canceled)
    const currentRun = await db.prepare(
      `SELECT phase FROM marunage_runs WHERE id = ? AND phase = 'generating_images'`
    ).bind(runId).first<{ phase: string }>()
    if (!currentRun) {
      console.log(`[Marunage:Image] Run ${runId} no longer in generating_images, stopping`)
      return
    }

    // Check existing image for this scene
    const existingImage = await db.prepare(`
      SELECT id, status FROM image_generations
      WHERE scene_id = ? AND is_active = 1
    `).bind(scene.id).first<{ id: number; status: string }>()

    // In 'full' mode: skip completed images
    // In 'retry' mode: only process failed images
    if (mode === 'full' && existingImage?.status === 'completed') {
      generated++
      continue
    }
    if (mode === 'retry' && (!existingImage || existingImage.status === 'completed')) {
      if (existingImage?.status === 'completed') generated++
      continue
    }

    // Build styled prompt (uses utils, not route handlers)
    let prompt = scene.image_prompt as string || ''
    try {
      prompt = await composeStyledPrompt(db, projectId, scene.id as number, prompt)
    } catch (e) {
      console.warn(`[Marunage:Image] Style composition failed for scene ${scene.id}:`, e)
    }

    if (!prompt) {
      prompt = `A scene from a video presentation. Scene index: ${scene.idx}`
    }

    // Phase 4 (M-7): Fetch reference images for character consistency
    let refImages: Array<{ base64Data: string; mimeType: string; characterName?: string }> = []
    try {
      const refs = await getSceneReferenceImages(db, r2, scene.id as number, 5)
      refImages = refs.map(r => ({
        base64Data: r.base64Data,
        mimeType: r.mimeType,
        characterName: r.characterName,
      }))
      if (refImages.length > 0) {
        console.log(`[Marunage:Image] Loaded ${refImages.length} reference image(s) for scene ${scene.id}`)
      }
    } catch (e) {
      console.warn(`[Marunage:Image] Reference image loading failed for scene ${scene.id}:`, e)
      // Continue without reference images (graceful degradation)
    }

    // Create or update image_generations record
    let genId: number
    if (existingImage) {
      // Update existing failed record to 'generating'
      await db.prepare(`
        UPDATE image_generations
        SET status = 'generating', error_message = NULL, r2_key = NULL, started_at = datetime('now')
        WHERE id = ?
      `).bind(existingImage.id).run()
      genId = existingImage.id
    } else {
      // Create new record
      const insertResult = await db.prepare(`
        INSERT INTO image_generations (scene_id, prompt, status, provider, model, is_active, started_at)
        VALUES (?, ?, 'generating', 'gemini', '${GEMINI_MODEL}', 1, datetime('now'))
      `).bind(scene.id, prompt).run()
      genId = insertResult.meta.last_row_id as number
    }

    // Generate image
    const tImgStart = Date.now()
    console.log(`[Marunage:Image] Generating image for scene ${scene.id} (idx=${scene.idx}), genId=${genId}${refImages.length > 0 ? `, refImages=${refImages.length}` : ''}`)
    const imageResult = await generateSingleImage(keyResult.apiKey, prompt, aspectRatio as any, refImages.length > 0 ? refImages : undefined)
    const imgGeminiMs = Date.now() - tImgStart

    if (!imageResult.success || !imageResult.imageData) {
      const imgTotalMs = Date.now() - tImgStart
      console.error(`[Marunage:Image] Failed for scene ${scene.id}: ${imageResult.error} (gemini=${imgGeminiMs}ms)`)
      await db.prepare(`
        UPDATE image_generations
        SET status = 'failed', error_message = ?,
            ended_at = datetime('now'), duration_ms = ?, gemini_duration_ms = ?
        WHERE id = ?
      `).bind((imageResult.error || 'Unknown error').substring(0, 1000), imgTotalMs, imgGeminiMs, genId).run()
      
      // Cost log (failed)
      await logImageGenerationCost(db, {
        userId: userId || 1,
        projectId: String(projectId),
        sceneId: scene.id,
        status: 'failed',
        apiKeySource: keyResult.keySource,
        sponsorUserId: billing.sponsorUserId,
        promptLength: prompt.length,
        errorMessage: (imageResult.error || 'Unknown error').substring(0, 500),
      })
      
      failed++

      // Add delay between attempts even on failure
      await sleep(IMAGE_GEN_DELAY)
      continue
    }

    // Upload to R2
    const tR2UpStart = Date.now()
    const r2Key = buildR2Key(projectId, scene.idx as number, genId)
    const uploadResult = await uploadToR2(r2, r2Key, imageResult.imageData)
    const imgR2Ms = Date.now() - tR2UpStart

    if (!uploadResult.success) {
      const imgTotalMs = Date.now() - tImgStart
      console.error(`[Marunage:Image] R2 upload failed for scene ${scene.id}: ${uploadResult.error} (gemini=${imgGeminiMs}ms r2=${imgR2Ms}ms)`)
      await db.prepare(`
        UPDATE image_generations
        SET status = 'failed', error_message = ?,
            ended_at = datetime('now'), duration_ms = ?, gemini_duration_ms = ?, r2_duration_ms = ?
        WHERE id = ?
      `).bind(`R2 upload failed: ${uploadResult.error}`, imgTotalMs, imgGeminiMs, imgR2Ms, genId).run()
      failed++
      await sleep(IMAGE_GEN_DELAY)
      continue
    }

    // Mark completed
    const imgTotalMs = Date.now() - tImgStart
    const r2Url = `/${r2Key}`  // ★ FIX: r2_url を設定（preflight が参照する）
    await db.prepare(`
      UPDATE image_generations
      SET status = 'completed', r2_key = ?, r2_url = ?,
          ended_at = datetime('now'), duration_ms = ?, gemini_duration_ms = ?, r2_duration_ms = ?
      WHERE id = ?
    `).bind(r2Key, r2Url, imgTotalMs, imgGeminiMs, imgR2Ms, genId).run()

    generated++
    console.log(`[Marunage:Image] ✅ Scene ${scene.id} completed (${generated}/${scenes.length}) total=${imgTotalMs}ms gemini=${imgGeminiMs}ms r2=${imgR2Ms}ms`)
    
    // Cost log (success)
    await logImageGenerationCost(db, {
      userId: userId || 1,
      projectId: String(projectId),
      sceneId: scene.id,
      status: 'success',
      apiKeySource: keyResult.keySource,
      sponsorUserId: billing.sponsorUserId,
      promptLength: prompt.length,
    })

    // Delay between generations to respect Gemini rate limits
    await sleep(IMAGE_GEN_DELAY)
  }

  console.log(`[Marunage:Image] Finished: generated=${generated}, failed=${failed}, total=${scenes.length}`)

  // Unlock the run so advance can check completion
  await db.prepare(`
    UPDATE marunage_runs
    SET locked_at = NULL, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(runId).run()

  // If all failed, transition to failed immediately
  if (generated === 0 && failed > 0) {
    await transitionPhase(db, runId, 'generating_images', 'failed', {
      error_code: 'ALL_IMAGES_FAILED',
      error_message: `All ${failed} image(s) failed to generate`,
      error_phase: 'generating_images',
    })
  }
}

// ============================================================
// Helper: sleep
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ============================================================
// P1: Feature flag helper — reads MARUNAGE_ENABLE_VIDEO_BUILD
// from system_settings table. Default: OFF (false).
// Ref: docs/16_MARUNAGE_VIDEO_BUILD_SSOT.md
// ============================================================

async function isVideoBuildEnabled(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare(
      `SELECT value FROM system_settings WHERE key = 'MARUNAGE_ENABLE_VIDEO_BUILD' LIMIT 1`
    ).first<{ value: string }>()
    return row?.value === 'true' || row?.value === '1'
  } catch (_) {
    return false  // table missing or error → flag OFF
  }
}

// ============================================================
// P1: Video build trigger (background, Non-Impact Protocol)
// Called from ready phase when MARUNAGE_ENABLE_VIDEO_BUILD = true.
// Phase stays 'ready'; video_build_id is stored in marunage_runs.
//
// 3-STAGE GATE (incident prevention):
//   Gate 1: run.video_build_id IS NULL (no duplicate builds)
//           + no active build in video_builds for this project
//           + 30-min cooldown after last failure
//   Gate 2: GET /video-builds/preflight returns ok=true
//           (validates assets: images, audio, SITE_URL)
//   Gate 3: Cookie auth verified via preflight response
//           (if preflight returns 401/403, skip silently)
//
// Ref: docs/16_MARUNAGE_VIDEO_BUILD_SSOT.md
// ============================================================

/** Video build retry cooldown period (milliseconds) */
const VIDEO_BUILD_COOLDOWN_MS = 30 * 60 * 1000 // 30 minutes

/**
 * 丸投げ用デフォルト build_settings (Option A: 固定テンプレート)
 */
const MARUNAGE_DEFAULT_BUILD_SETTINGS = {
  captions: { enabled: true, position: 'bottom', show_speaker: false },
  bgm: { enabled: false },
  motion: { preset: 'gentle-zoom', transition: 'crossfade' },
  telops: { enabled: false },
}

/**
 * Record a video build attempt (success or failure) in marunage_runs.
 * Centralised helper to keep UPDATE queries consistent.
 */
async function recordVideoBuildAttempt(
  db: D1Database,
  runId: number,
  opts: { videoBuildId?: number; error?: string }
): Promise<void> {
  if (opts.videoBuildId) {
    await db.prepare(`
      UPDATE marunage_runs
      SET video_build_id = ?,
          video_build_attempted_at = CURRENT_TIMESTAMP,
          video_build_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(opts.videoBuildId, runId).run()
  } else {
    await db.prepare(`
      UPDATE marunage_runs
      SET video_build_attempted_at = CURRENT_TIMESTAMP,
          video_build_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind((opts.error || 'unknown').substring(0, 500), runId).run()
  }
}

/**
 * Trigger video build in background after run reaches 'ready'.
 *
 * 3-STAGE GATE:
 *  1) Duplicate / cooldown guard (DB check only)
 *  2) Preflight validation (GET /video-builds/preflight)
 *  3) Build creation (POST /video-builds)
 *
 * Phase does NOT change — it stays 'ready'.
 * Errors are logged but do NOT fail the run.
 */
async function marunageTriggerVideoBuild(
  db: D1Database,
  runId: number,
  projectId: number,
  config: MarunageConfig,
  requestUrl: string,
  sessionCookie: string
): Promise<void> {
  const origin = new URL(requestUrl).origin
  const tag = `[Marunage:Video:${projectId}]`

  console.log(`${tag} Trigger requested for run ${runId} [phase stays ready]`)

  // ────────────────────────────────────────────────────
  // GATE 1: Duplicate / cooldown guard
  // ────────────────────────────────────────────────────
  try {
    // 1a. If this run already has a video_build_id, skip
    const run = await db.prepare(`
      SELECT video_build_id, video_build_attempted_at, video_build_error
      FROM marunage_runs WHERE id = ?
    `).bind(runId).first<{
      video_build_id: number | null
      video_build_attempted_at: string | null
      video_build_error: string | null
    }>()

    if (run?.video_build_id) {
      console.log(`${tag} GATE1: video_build_id=${run.video_build_id} already set → skip`)
      return
    }

    // 1b. Check 30-min cooldown after last failure
    if (run?.video_build_attempted_at && run?.video_build_error) {
      const lastAttempt = new Date(run.video_build_attempted_at).getTime()
      const elapsed = Date.now() - lastAttempt
      if (elapsed < VIDEO_BUILD_COOLDOWN_MS) {
        const remainMin = Math.ceil((VIDEO_BUILD_COOLDOWN_MS - elapsed) / 60000)
        console.log(`${tag} GATE1: Cooldown active (${remainMin}min remaining, last error: ${run.video_build_error}) → skip`)
        return
      }
      console.log(`${tag} GATE1: Cooldown expired (${Math.floor(elapsed / 60000)}min since last failure), retrying`)
    }

    // 1c. Check for active builds on this project in video_builds table
    const activeBuild = await db.prepare(`
      SELECT id, status FROM video_builds
      WHERE project_id = ? AND status IN ('queued','validating','submitted','rendering','uploading')
      ORDER BY created_at DESC LIMIT 1
    `).bind(projectId).first<{ id: number; status: string }>()

    if (activeBuild) {
      console.log(`${tag} GATE1: Active build ${activeBuild.id} (${activeBuild.status}) exists → save & skip`)
      await recordVideoBuildAttempt(db, runId, { videoBuildId: activeBuild.id })
      return
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`${tag} GATE1 DB check error (non-fatal): ${msg}`)
    // On DB error, still attempt preflight (fail-open for gate 1 only)
  }

  // ────────────────────────────────────────────────────
  // GATE 2: Preflight — asset validation + cookie auth
  // ────────────────────────────────────────────────────
  const preflightUrl = `${origin}/api/projects/${projectId}/video-builds/preflight`
  const cookieHeader = `session=${sessionCookie}`

  try {
    console.log(`${tag} GATE2: Calling preflight...`)
    const pfResponse = await fetch(preflightUrl, {
      method: 'GET',
      headers: { 'Cookie': cookieHeader },
    })

    // Cookie/auth failure → skip silently (incident prevention)
    if (pfResponse.status === 401 || pfResponse.status === 403) {
      const reason = `preflight returned ${pfResponse.status} (auth failure)`
      console.warn(`${tag} GATE2: ${reason} → skip (cookie may be invalid/expired)`)
      await recordVideoBuildAttempt(db, runId, { error: reason })
      return
    }

    if (!pfResponse.ok) {
      const reason = `preflight returned ${pfResponse.status}`
      console.warn(`${tag} GATE2: ${reason} → skip`)
      await recordVideoBuildAttempt(db, runId, { error: reason })
      return
    }

    const pfResult = await pfResponse.json() as any
    // Preflight returns: is_ready (asset check), can_generate (full check incl. AWS, visual validation)
    const isReady = pfResult?.is_ready === true
    const canGenerate = pfResult?.can_generate === true || pfResult?.validation?.can_generate === true

    console.log(`${tag} GATE2: preflight result — is_ready=${pfResult?.is_ready}, can_generate=${pfResult?.can_generate}, missing=${pfResult?.missing?.length || 0}, errors=${pfResult?.validation?.errors?.length || 0}`)

    if (!isReady || !canGenerate) {
      const missingCount = pfResult?.missing?.length || 0
      const errorCount = pfResult?.validation?.errors?.length || 0
      const errorDetails = pfResult?.validation?.errors?.slice(0, 3)?.map((e: any) => e.message || e.reason || e.code).join('; ') || ''
      const reason = `preflight not ready (is_ready=${pfResult?.is_ready}, can_generate=${pfResult?.can_generate}, missing=${missingCount}, errors=${errorCount}${errorDetails ? ': ' + errorDetails.substring(0, 200) : ''})`
      console.warn(`${tag} GATE2: ${reason} → skip build`)
      await recordVideoBuildAttempt(db, runId, { error: reason })
      return
    }

    console.log(`${tag} GATE2: Preflight OK — assets validated, cookie authenticated`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const reason = `preflight fetch error: ${msg.substring(0, 200)}`
    console.error(`${tag} GATE2: ${reason} → skip`)
    await recordVideoBuildAttempt(db, runId, { error: reason })
    return
  }

  // ────────────────────────────────────────────────────
  // GATE 3: Create video build (POST /video-builds)
  // ────────────────────────────────────────────────────
  const buildUrl = `${origin}/api/projects/${projectId}/video-builds`

  try {
    const buildSettings = {
      ...MARUNAGE_DEFAULT_BUILD_SETTINGS,
      bgm: {
        ...MARUNAGE_DEFAULT_BUILD_SETTINGS.bgm,
        enabled: config.bgm_mode === 'auto',
      },
    }

    console.log(`${tag} GATE3: POST /video-builds...`)
    const response = await fetch(buildUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieHeader,
      },
      body: JSON.stringify(buildSettings),
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error')

      // 409 = build already in progress → extract and save existing build_id
      if (response.status === 409) {
        try {
          const conflict = JSON.parse(errorBody)
          const activeBuildId = conflict?.error?.details?.active_build_id
          if (activeBuildId) {
            console.log(`${tag} GATE3: 409 conflict — active build ${activeBuildId}, saving to run`)
            await recordVideoBuildAttempt(db, runId, { videoBuildId: activeBuildId })
            return
          }
        } catch (_) {}
      }

      const reason = `POST returned ${response.status}: ${errorBody.substring(0, 300)}`
      console.error(`${tag} GATE3: ${reason}`)
      await recordVideoBuildAttempt(db, runId, { error: reason })
      return
    }

    const result = await response.json() as any
    // POST /video-builds returns { success, build: { id, ... } }
    const videoBuildId = result?.build?.id || result?.video_build_id || result?.id

    if (!videoBuildId) {
      const reason = `No video_build_id in response (keys: ${Object.keys(result || {}).join(',')}): ${JSON.stringify(result).substring(0, 300)}`
      console.error(`${tag} GATE3: ${reason}`)
      await recordVideoBuildAttempt(db, runId, { error: reason })
      return
    }

    // SUCCESS — save video_build_id and clear any previous error
    await recordVideoBuildAttempt(db, runId, { videoBuildId })
    console.log(`${tag} GATE3: Video build ${videoBuildId} created and saved to run ${runId}`)

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const reason = `POST fetch error: ${msg.substring(0, 200)}`
    console.error(`${tag} GATE3: ${reason} (non-fatal)`)
    await recordVideoBuildAttempt(db, runId, { error: reason })
    // Phase stays 'ready' — non-fatal
  }
}

// ============================================================
// Issue-3: 音声生成起動ヘルパー
// bulk-audio API を HTTP 経由で呼び出し、audio_job_id を保存
// ============================================================

async function marunageStartAudioGeneration(
  db: D1Database,
  runId: number,
  projectId: number,
  config: MarunageConfig,
  requestUrl: string,
  sessionCookie: string
): Promise<void> {
  const origin = new URL(requestUrl).origin
  const bulkUrl = `${origin}/api/projects/${projectId}/audio/bulk-generate`

  console.log(`[Marunage:Audio] Starting audio generation for project ${projectId} (run ${runId})`)

  try {
    // Determine narration voice from config
    const provider = config.narration_voice?.provider || 'google'
    const voiceId = config.narration_voice?.voice_id || 'ja-JP-Neural2-B'

    // Update project settings with narration voice before calling bulk-audio
    // (bulk-audio reads from project.settings_json for voice resolution)
    try {
      const project = await db.prepare(
        `SELECT settings_json FROM projects WHERE id = ?`
      ).bind(projectId).first<{ settings_json: string | null }>()

      const settings = project?.settings_json ? JSON.parse(project.settings_json) : {}
      settings.default_narration_voice = { provider, voice_id: voiceId }

      await db.prepare(
        `UPDATE projects SET settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(JSON.stringify(settings), projectId).run()

      console.log(`[Marunage:Audio] Updated project ${projectId} narration voice: ${provider}/${voiceId}`)
    } catch (settingsError) {
      console.warn(`[Marunage:Audio] Failed to update project settings (non-fatal):`, settingsError)
    }

    // Call bulk-audio API via HTTP
    const response = await fetch(bulkUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `session=${sessionCookie}`,
      },
      body: JSON.stringify({
        mode: 'missing',           // Generate only missing utterances
        force_regenerate: false,
      }),
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error')
      console.error(`[Marunage:Audio] bulk-generate API returned ${response.status}: ${errorBody}`)

      // If 409 (job already running), try to extract existing job_id
      if (response.status === 409) {
        try {
          const conflict = JSON.parse(errorBody)
          if (conflict.existing_job_id) {
            console.log(`[Marunage:Audio] Job already exists (${conflict.existing_job_id}), saving to run`)
            await db.prepare(`
              UPDATE marunage_runs SET audio_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
            `).bind(conflict.existing_job_id, runId).run()
            return
          }
        } catch (_) {}
      }

      // Mark run as failed
      await transitionPhase(db, runId, 'generating_audio', 'failed', {
        error_code: 'AUDIO_START_FAILED',
        error_message: `Bulk audio API error: HTTP ${response.status} — ${errorBody.substring(0, 500)}`,
        error_phase: 'generating_audio',
      })
      return
    }

    const result = await response.json<{ job_id: number; status: string }>()
    const jobId = result.job_id

    console.log(`[Marunage:Audio] Bulk audio job ${jobId} created for project ${projectId}`)

    // Save audio_job_id to marunage_runs
    await db.prepare(`
      UPDATE marunage_runs SET audio_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(jobId, runId).run()

    console.log(`[Marunage:Audio] Saved audio_job_id=${jobId} to run ${runId}`)

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[Marunage:Audio] Critical error starting audio for run ${runId}:`, errorMsg)

    // Mark run as failed
    try {
      await transitionPhase(db, runId, 'generating_audio', 'failed', {
        error_code: 'AUDIO_START_FAILED',
        error_message: `Audio startup error: ${errorMsg.substring(0, 500)}`,
        error_phase: 'generating_audio',
      })
    } catch (failError) {
      console.error(`[Marunage:Audio] Failed to mark run as failed:`, failError)
    }
  }
}

// ============================================================
// 5-0. GET /runs - ユーザーの全 run 一覧
// ============================================================

marunage.get('/runs', async (c) => {
  const user = await getSessionUser(c.env.DB, getCookie(c, 'session'))
  if (!user) return errorJson(c, MARUNAGE_ERRORS.UNAUTHORIZED, 'Session required')

  // Query param: ?archived=1 to show archived runs, default shows only non-archived
  const showArchived = c.req.query('archived') === '1'

  const { results: runs } = await c.env.DB.prepare(`
    SELECT
      mr.id AS run_id,
      mr.project_id,
      mr.phase,
      mr.error_code,
      mr.error_message,
      mr.created_at,
      mr.updated_at,
      mr.completed_at,
      mr.is_archived,
      mr.video_build_id,
      p.title AS project_title,
      p.status AS project_status,
      (SELECT COUNT(*) FROM scenes s WHERE s.project_id = mr.project_id AND (s.is_hidden = 0 OR s.is_hidden IS NULL)) AS scene_count,
      (SELECT COUNT(*) FROM scenes s
       LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
       WHERE s.project_id = mr.project_id AND (s.is_hidden = 0 OR s.is_hidden IS NULL) AND ig.status = 'completed') AS images_done,
      (SELECT COUNT(DISTINCT su.scene_id) FROM scene_utterances su
       JOIN scenes s2 ON s2.id = su.scene_id
       JOIN audio_generations ag ON ag.id = su.audio_generation_id AND ag.status = 'completed'
       WHERE s2.project_id = mr.project_id AND (s2.is_hidden = 0 OR s2.is_hidden IS NULL)) AS audio_done,
      (SELECT ig2.r2_key FROM scenes s3
       LEFT JOIN image_generations ig2 ON ig2.scene_id = s3.id AND ig2.is_active = 1 AND ig2.status = 'completed'
       WHERE s3.project_id = mr.project_id AND (s3.is_hidden = 0 OR s3.is_hidden IS NULL) AND ig2.r2_key IS NOT NULL
       ORDER BY s3.idx ASC LIMIT 1) AS first_image_key,
      (SELECT vb.status FROM video_builds vb WHERE vb.id = mr.video_build_id) AS video_build_status,
      (SELECT vb.progress_percent FROM video_builds vb WHERE vb.id = mr.video_build_id) AS video_progress_percent,
      (SELECT vb.download_url FROM video_builds vb WHERE vb.id = mr.video_build_id) AS video_download_url
    FROM marunage_runs mr
    JOIN projects p ON p.id = mr.project_id
    WHERE mr.started_by_user_id = ?
      AND ${showArchived ? 'mr.is_archived = 1' : '(mr.is_archived = 0 OR mr.is_archived IS NULL)'}
    ORDER BY mr.created_at DESC
    LIMIT 50
  `).bind(user.id).all()

  return c.json({
    runs: (runs || []).map((r: any) => ({
      run_id: r.run_id,
      project_id: r.project_id,
      phase: r.phase,
      project_title: r.project_title,
      project_status: r.project_status,
      scene_count: r.scene_count || 0,
      images_done: r.images_done || 0,
      audio_done: r.audio_done || 0,
      error_code: r.error_code,
      error_message: r.error_message,
      created_at: r.created_at,
      updated_at: r.updated_at,
      completed_at: r.completed_at,
      is_active: !['ready', 'failed', 'canceled'].includes(r.phase),
      is_archived: r.is_archived === 1,
      video_build_id: r.video_build_id || null,
      video_build_status: r.video_build_status || null,
      video_progress_percent: r.video_progress_percent || 0,
      video_download_url: r.video_download_url || null,
      first_image_url: r.first_image_key ? `/images/${r.first_image_key}` : null,
    })),
  })
})

// ============================================================
// 5-0.3. POST /runs/:runId/archive - アーカイブ（非表示）
// ============================================================
marunage.post('/runs/:runId/archive', async (c) => {
  const user = await getSessionUser(c.env.DB, getCookie(c, 'session'))
  if (!user) return errorJson(c, MARUNAGE_ERRORS.UNAUTHORIZED, 'Session required')

  const runId = parseInt(c.req.param('runId'))
  if (isNaN(runId)) return errorJson(c, MARUNAGE_ERRORS.INVALID_REQUEST, 'Invalid runId')

  const run = await c.env.DB.prepare(`
    SELECT id, started_by_user_id FROM marunage_runs WHERE id = ?
  `).bind(runId).first<{ id: number; started_by_user_id: number }>()

  if (!run) return errorJson(c, MARUNAGE_ERRORS.NOT_FOUND, 'Run not found')
  if (run.started_by_user_id !== user.id) return errorJson(c, MARUNAGE_ERRORS.UNAUTHORIZED, 'Not your run')

  await c.env.DB.prepare(`
    UPDATE marunage_runs SET is_archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(runId).run()

  return c.json({ success: true, run_id: runId, is_archived: true })
})

// ============================================================
// 5-0.4. POST /runs/:runId/unarchive - アーカイブ解除
// ============================================================
marunage.post('/runs/:runId/unarchive', async (c) => {
  const user = await getSessionUser(c.env.DB, getCookie(c, 'session'))
  if (!user) return errorJson(c, MARUNAGE_ERRORS.UNAUTHORIZED, 'Session required')

  const runId = parseInt(c.req.param('runId'))
  if (isNaN(runId)) return errorJson(c, MARUNAGE_ERRORS.INVALID_REQUEST, 'Invalid runId')

  const run = await c.env.DB.prepare(`
    SELECT id, started_by_user_id FROM marunage_runs WHERE id = ?
  `).bind(runId).first<{ id: number; started_by_user_id: number }>()

  if (!run) return errorJson(c, MARUNAGE_ERRORS.NOT_FOUND, 'Run not found')
  if (run.started_by_user_id !== user.id) return errorJson(c, MARUNAGE_ERRORS.UNAUTHORIZED, 'Not your run')

  await c.env.DB.prepare(`
    UPDATE marunage_runs SET is_archived = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(runId).run()

  return c.json({ success: true, run_id: runId, is_archived: false })
})

// ============================================================
// 5-0.5. GET /runs/:runId - run_id → project_id 逆引き（v1仕様 §3.2）
// ready/failed/canceled の run も返す（Result View 再表示用）
// ============================================================

marunage.get('/runs/:runId', async (c) => {
  const user = await getSessionUser(c.env.DB, getCookie(c, 'session'))
  if (!user) return errorJson(c, MARUNAGE_ERRORS.UNAUTHORIZED, 'Session required')

  const runId = parseInt(c.req.param('runId'))
  if (isNaN(runId)) return errorJson(c, MARUNAGE_ERRORS.INVALID_REQUEST, 'Invalid runId')

  const run = await c.env.DB.prepare(`
    SELECT id AS run_id, project_id, phase, created_at
    FROM marunage_runs WHERE id = ?
  `).bind(runId).first<{ run_id: number; project_id: number; phase: string; created_at: string }>()

  if (!run) return errorJson(c, MARUNAGE_ERRORS.NOT_FOUND, 'Run not found')

  // Ownership check
  const ownership = await c.env.DB.prepare(
    `SELECT started_by_user_id FROM marunage_runs WHERE id = ?`
  ).bind(runId).first<{ started_by_user_id: number }>()
  if (ownership?.started_by_user_id !== user.id) {
    return errorJson(c, MARUNAGE_ERRORS.FORBIDDEN, 'Not your run')
  }

  return c.json(run)
})

// ============================================================
// 5-1. GET /active - ユーザーのアクティブ run を検索
// ============================================================

marunage.get('/active', async (c) => {
  const user = await getSessionUser(c.env.DB, getCookie(c, 'session'))
  if (!user) return errorJson(c, MARUNAGE_ERRORS.UNAUTHORIZED, 'Session required')

  const run = await getActiveRunForUser(c.env.DB, user.id)
  if (!run) return errorJson(c, MARUNAGE_ERRORS.NOT_FOUND, 'No active run found')

  return c.json({
    run_id: run.id,
    project_id: run.project_id,
    phase: run.phase,
  })
})

// ============================================================
// 5-2. POST /start - テキスト→プロジェクト作成→run作成
//       Issue-1: フォーマット起動なし (phase='formatting' で停止)
//       Issue-2: ここに formatStart pathway を追加予定
// ============================================================

marunage.post('/start', async (c) => {
  const user = await getSessionUser(c.env.DB, getCookie(c, 'session'))
  if (!user) return errorJson(c, MARUNAGE_ERRORS.UNAUTHORIZED, 'Session required')

  // Check for existing active run (user-level)
  const existingRun = await getActiveRunForUser(c.env.DB, user.id)
  if (existingRun) {
    return errorJson(c, MARUNAGE_ERRORS.CONFLICT, 'Active run already exists', {
      run_id: existingRun.id,
      project_id: existingRun.project_id,
      phase: existingRun.phase,
    })
  }

  let body: MarunageStartRequest
  try {
    body = await c.req.json<MarunageStartRequest>()
  } catch {
    return errorJson(c, MARUNAGE_ERRORS.INVALID_REQUEST, 'Invalid JSON body')
  }

  // Validation
  if (!body.text || typeof body.text !== 'string') {
    return errorJson(c, MARUNAGE_ERRORS.INVALID_REQUEST, 'text is required')
  }
  const textTrimmed = body.text.trim()
  if (textTrimmed.length < 100) {
    return errorJson(c, MARUNAGE_ERRORS.INVALID_REQUEST, 'text must be at least 100 characters', { min: 100, actual: textTrimmed.length })
  }
  if (textTrimmed.length > 50000) {
    return errorJson(c, MARUNAGE_ERRORS.INVALID_REQUEST, 'text must be at most 50000 characters', { max: 50000, actual: textTrimmed.length })
  }

  const outputPreset = body.output_preset || 'yt_long'
  if (!['yt_long', 'short_vertical'].includes(outputPreset)) {
    return errorJson(c, MARUNAGE_ERRORS.INVALID_REQUEST, 'Invalid output_preset')
  }

  // Target scene count (3-10, default 5)
  const targetSceneCount = Math.max(3, Math.min(10, body.target_scene_count || 5))

  // Narration voice
  const narrationVoice = {
    provider: body.narration_voice?.provider || 'google',
    voice_id: body.narration_voice?.voice_id || 'ja-JP-Neural2-B',
  }

  // Pre-flight: Fish Audio token check for narration voice
  if (narrationVoice.provider === 'fish' && !c.env.FISH_AUDIO_API_TOKEN) {
    console.warn(`[Marunage:Start] Fish Audio selected as narration voice but FISH_AUDIO_API_TOKEN is not set`)
    return c.json({
      error: {
        code: 'FISH_AUDIO_NOT_CONFIGURED',
        message: 'Fish Audio の API トークンが未設定です。ナレーション音声を Google TTS または ElevenLabs に変更してください。',
      }
    }, 400)
  }

  // Build config snapshot
  const config: MarunageConfig = {
    ...DEFAULT_CONFIG,
    target_scene_count: targetSceneCount,
    output_preset: outputPreset,
    narration_voice: {
      provider: narrationVoice.provider as any,
      voice_id: narrationVoice.voice_id,
    },
    // Phase 1: style selection snapshot
    ...(body.style_preset_id ? { style_preset_id: body.style_preset_id } : {}),
    // Phase 2: character selection snapshot
    ...(body.selected_character_ids?.length ? { selected_character_ids: body.selected_character_ids } : {}),
    ...(body.voice_policy ? { voice_policy: body.voice_policy } : {}),
  }
  const configJson = JSON.stringify(config)
  const title = body.title?.trim() || `丸投げ ${new Date().toLocaleDateString('ja-JP')}`

  try {
    // ===== Step 1: Create project (新規プロジェクト — 既存データへの影響なし) =====
    const projectResult = await c.env.DB.prepare(`
      INSERT INTO projects (title, status, user_id, source_type)
      VALUES (?, 'created', ?, 'text')
    `).bind(title, user.id).run()
    const projectId = projectResult.meta.last_row_id as number

    // Set source text + status='uploaded'
    await c.env.DB.prepare(`
      UPDATE projects
      SET source_text = ?, status = 'uploaded',
          source_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(textTrimmed, projectId).run()

    // ===== Step 1.2: Style selection (Phase 1: M-2) =====
    // Use provided style_preset_id if valid, otherwise fallback to 'インフォグラフィック'
    let styleId: number | null = null
    if (body.style_preset_id) {
      const userStyle = await c.env.DB.prepare(`
        SELECT id FROM style_presets WHERE id = ? AND is_active = 1 LIMIT 1
      `).bind(body.style_preset_id).first<{ id: number }>()
      if (userStyle) {
        styleId = userStyle.id
        console.log(`[Marunage:Start] Using user-selected style preset: id=${styleId}`)
      } else {
        console.warn(`[Marunage:Start] Invalid style_preset_id=${body.style_preset_id}, falling back to default`)
      }
    }
    if (!styleId) {
      const defaultStyle = await c.env.DB.prepare(`
        SELECT id FROM style_presets WHERE name = 'インフォグラフィック' AND is_active = 1 LIMIT 1
      `).first<{ id: number }>()
      styleId = defaultStyle?.id ?? null
    }
    if (styleId) {
      await c.env.DB.prepare(`
        INSERT INTO project_style_settings (project_id, default_style_preset_id) VALUES (?, ?)
      `).bind(projectId, styleId).run()
    }

    // ===== Step 1.4.5: Pre-flight — Fish Audio token validation =====
    // If any selected character uses Fish Audio voice, verify FISH_AUDIO_API_TOKEN is set.
    // Fail fast here instead of silently failing during audio generation (矛盾 #3 対策).
    if (body.selected_character_ids && body.selected_character_ids.length > 0) {
      const { results: selectedChars } = await c.env.DB.prepare(`
        SELECT id, character_name, voice_preset_id FROM user_characters
        WHERE id IN (${body.selected_character_ids.map(() => '?').join(',')}) AND user_id = ?
      `).bind(...body.selected_character_ids, user.id).all<{
        id: number; character_name: string; voice_preset_id: string | null
      }>()

      const fishChars = (selectedChars || []).filter(
        ch => ch.voice_preset_id && (ch.voice_preset_id.startsWith('fish:') || ch.voice_preset_id.startsWith('fish-'))
      )

      if (fishChars.length > 0 && !c.env.FISH_AUDIO_API_TOKEN) {
        const names = fishChars.map(ch => ch.character_name).join(', ')
        console.warn(`[Marunage:Start] Fish Audio voice used by [${names}] but FISH_AUDIO_API_TOKEN is not set`)
        return c.json({
          error: {
            code: 'FISH_AUDIO_NOT_CONFIGURED',
            message: `Fish Audio の API トークンが未設定です。キャラクター「${names}」は Fish Audio を使用しています。Google TTS または ElevenLabs の音声に変更するか、管理者に Fish Audio API トークンの設定を依頼してください。`,
          }
        }, 400)
      }
    }

    // ===== Step 1.5: Copy selected characters to project (Phase 2: M-3) =====
    if (body.selected_character_ids && body.selected_character_ids.length > 0) {
      for (const ucId of body.selected_character_ids) {
        // Fetch from user's library (ownership check)
        const uc = await c.env.DB.prepare(`
          SELECT id, character_key, character_name, description,
                 appearance_description, reference_image_r2_key, reference_image_r2_url,
                 voice_preset_id, aliases_json
          FROM user_characters WHERE id = ? AND user_id = ?
        `).bind(ucId, user.id).first<any>()

        if (!uc) {
          console.warn(`[Marunage:Start] user_character ${ucId} not found for user ${user.id}, skipping`)
          continue
        }

        // Check duplicate (same character_key already in project)
        const existing = await c.env.DB.prepare(`
          SELECT id FROM project_character_models WHERE project_id = ? AND character_key = ?
        `).bind(projectId, uc.character_key).first()

        if (existing) {
          console.warn(`[Marunage:Start] character_key=${uc.character_key} already in project ${projectId}, skipping`)
          continue
        }

        // Determine voice_preset_id: voice_policy override > original
        let voicePresetId = uc.voice_preset_id
        if (body.voice_policy?.mode === 'full_override' && body.voice_policy.characters?.[uc.character_key]) {
          const override = body.voice_policy.characters[uc.character_key]
          voicePresetId = override.voice_id  // e.g., "el-aria", "ja-JP-Wavenet-A"
        }

        // Copy to project_character_models (same schema as character-models.ts:344-358)
        await c.env.DB.prepare(`
          INSERT INTO project_character_models
            (project_id, character_key, character_name, description,
             appearance_description, reference_image_r2_key, reference_image_r2_url,
             voice_preset_id, aliases_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          projectId,
          uc.character_key,
          uc.character_name,
          uc.description,
          uc.appearance_description,
          uc.reference_image_r2_key,
          uc.reference_image_r2_url,
          voicePresetId,
          uc.aliases_json
        ).run()

        // Link in project_character_instances
        await c.env.DB.prepare(`
          INSERT INTO project_character_instances
            (project_id, user_character_id, character_key, is_customized)
          VALUES (?, ?, ?, ?)
        `).bind(projectId, ucId, uc.character_key, voicePresetId !== uc.voice_preset_id ? 1 : 0).run()
      }

      console.log(`[Marunage:Start] Copied ${body.selected_character_ids.length} character(s) to project ${projectId}`)
    }

    // ===== Step 1.6: Build settings_json with character voices (Phase 2: M-4) =====
    // Build character_voices map from project_character_models
    const characterVoices: Record<string, { provider: string; voice_id: string }> = {}
    if (body.selected_character_ids && body.selected_character_ids.length > 0) {
      const { results: projectChars } = await c.env.DB.prepare(`
        SELECT character_key, voice_preset_id FROM project_character_models WHERE project_id = ?
      `).bind(projectId).all()
      for (const pc of (projectChars || [])) {
        if (pc.voice_preset_id) {
          let provider = 'google'
          const vid = pc.voice_preset_id as string
          if (vid.startsWith('el-') || vid.startsWith('elevenlabs:')) provider = 'elevenlabs'
          else if (vid.startsWith('fish-') || vid.startsWith('fish:')) provider = 'fish'
          characterVoices[pc.character_key as string] = { provider, voice_id: vid }
        }
      }
    }

    // Set default narration voice + output_preset + marunage_mode in settings_json
    const settingsJson = JSON.stringify({
      default_narration_voice: narrationVoice,
      output_preset: outputPreset,
      marunage_mode: true,
      // Phase 2: character voices map (resolveVoiceForUtterance reads this as Priority 2 source)
      ...(Object.keys(characterVoices).length > 0 ? { character_voices: characterVoices } : {}),
    })
    await c.env.DB.prepare(`
      UPDATE projects SET settings_json = ?, output_preset = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(settingsJson, outputPreset, projectId).run()

    // Create Run #1 (same pattern as existing project creation)
    await c.env.DB.prepare(`
      INSERT INTO runs (project_id, run_no, state, title, source_type) VALUES (?, 1, 'draft', 'Run #1', 'text')
    `).bind(projectId).run()

    // ===== Step 2: Create marunage_run =====
    const runResult = await c.env.DB.prepare(`
      INSERT INTO marunage_runs (project_id, phase, config_json, started_by_user_id, started_from)
      VALUES (?, 'init', ?, ?, 'ui')
    `).bind(projectId, configJson, user.id).run()
    const runId = runResult.meta.last_row_id as number

    // ===== Step 3: Transition init → formatting =====
    // Issue-2: フェーズ遷移 + waitUntil で format 起動
    await transitionPhase(c.env.DB, runId, 'init', 'formatting')

    // Issue-2: Format startup — 非同期でフォーマット処理を開始
    const sessionCookie = getCookie(c, 'session') || ''
    const requestUrl = c.req.url
    c.executionCtx.waitUntil(
      marunageFormatStartup(c.env.DB, runId, projectId, config, requestUrl, sessionCookie)
        .catch(err => console.error(`[Marunage:Format] waitUntil error:`, err))
    )

    // Audit log
    try {
      await logAudit({
        db: c.env.DB,
        userId: user.id,
        userRole: user.role,
        entityType: 'project',
        entityId: projectId,
        projectId,
        action: 'marunage.run_started',
        details: { run_id: runId, config, note: 'Issue-2: format startup triggered via waitUntil' },
      })
    } catch (e) {
      console.warn('[Marunage] Audit log failed:', e)
    }

    return c.json({
      run_id: runId,
      project_id: projectId,
      phase: 'formatting' as MarunagePhase,
      config,
    }, 201)

  } catch (error: any) {
    // UNIQUE constraint violation = active run already exists
    if (error?.message?.includes('UNIQUE constraint')) {
      return errorJson(c, MARUNAGE_ERRORS.CONFLICT, 'Active run already exists for this project')
    }
    // Full error for server logs only
    console.error('[Marunage] Start error:', error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
    // Client gets only a safe message — no internal details
    return errorJson(c, MARUNAGE_ERRORS.INTERNAL_ERROR, 'Failed to start marunage run')
  }
})

// ============================================================
// 5-3. GET /:projectId/status - 丸投げ体験の統合進捗 (read-only)
// ============================================================

marunage.get('/:projectId/status', async (c) => {
  const user = await getSessionUser(c.env.DB, getCookie(c, 'session'))
  if (!user) return errorJson(c, MARUNAGE_ERRORS.UNAUTHORIZED, 'Session required')

  const projectId = parseInt(c.req.param('projectId'))
  if (isNaN(projectId)) return errorJson(c, MARUNAGE_ERRORS.INVALID_REQUEST, 'Invalid projectId')

  // Get active or latest run
  let run = await getActiveRunForProject(c.env.DB, projectId)
  if (!run) run = await getLatestRunForProject(c.env.DB, projectId)
  if (!run) return errorJson(c, MARUNAGE_ERRORS.NOT_FOUND, 'No marunage run found for this project')

  // Ownership check
  if (run.started_by_user_id !== user.id) {
    return errorJson(c, MARUNAGE_ERRORS.FORBIDDEN, 'Not your project')
  }

  const config: MarunageConfig = JSON.parse(run.config_json || '{}')

  // ===== Collect progress from DB (read-only, no N+1) =====

  // 1. Format progress
  const chunkStats = await c.env.DB.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS pending
    FROM text_chunks WHERE project_id = ?
  `).bind(projectId).first<{ total: number; done: number; failed: number; pending: number }>()

  const projectStatus = await c.env.DB.prepare(`
    SELECT status FROM projects WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)
  `).bind(projectId).first<{ status: string }>()

  const formatDone = projectStatus?.status === 'formatted' ||
                     projectStatus?.status === 'generating_images' ||
                     projectStatus?.status === 'completed'

  // 2. Scenes + utterance counts + audio completion status
  const { results: scenesData } = await c.env.DB.prepare(`
    SELECT
      s.id, s.idx, s.title,
      (SELECT COUNT(*) FROM scene_utterances su WHERE su.scene_id = s.id) AS utterance_count,
      (SELECT COUNT(*) FROM scene_utterances su
       JOIN audio_generations ag ON ag.id = su.audio_generation_id AND ag.status = 'completed'
       WHERE su.scene_id = s.id) AS audio_completed_count,
      ig.status AS image_status,
      ig.r2_key AS image_r2_key
    FROM scenes s
    LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
    WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
    ORDER BY s.idx ASC
  `).bind(projectId).all()

  const visibleScenes = scenesData || []
  const utterancesReady = visibleScenes.length > 0 && visibleScenes.every((s: any) => s.utterance_count > 0)

  // 3. Image progress
  const imageStats = await c.env.DB.prepare(`
    SELECT
      COUNT(*) AS total_scenes,
      SUM(CASE WHEN ig.status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN ig.status IN ('pending','generating') THEN 1 ELSE 0 END) AS generating,
      SUM(CASE WHEN ig.status='failed' OR ig.status='policy_violation' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN ig.id IS NULL THEN 1 ELSE 0 END) AS no_image
    FROM scenes s
    LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
    WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
  `).bind(projectId).first<{ total_scenes: number; completed: number; generating: number; failed: number; no_image: number }>()

  // 4. Audio progress
  let audioJobStatus: string | null = null
  let audioCompleted = 0
  let audioFailed = 0
  let audioTotalUtterances = 0

  if (run.audio_job_id) {
    const audioJob = await c.env.DB.prepare(`
      SELECT status FROM project_audio_jobs WHERE id = ?
    `).bind(run.audio_job_id).first<{ status: string }>()
    audioJobStatus = audioJob?.status || null
  }

  // Utterance-level audio progress
  const audioStats = await c.env.DB.prepare(`
    SELECT
      COUNT(*) AS total_utterances,
      SUM(CASE WHEN ag.status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN ag.status='failed' THEN 1 ELSE 0 END) AS failed
    FROM scene_utterances su
    JOIN scenes s ON s.id = su.scene_id
    LEFT JOIN audio_generations ag ON ag.id = su.audio_generation_id
    WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
  `).bind(projectId).first<{ total_utterances: number; completed: number; failed: number }>()

  if (audioStats) {
    audioTotalUtterances = audioStats.total_utterances || 0
    audioCompleted = audioStats.completed || 0
    audioFailed = audioStats.failed || 0
  }

  // Determine sub-states
  const formatState = formatDone ? 'done' : (chunkStats?.pending || 0) > 0 ? 'running' : (chunkStats?.failed || 0) > 0 ? 'failed' : 'pending'
  const imagesCompleted = imageStats?.completed || 0
  const imagesGenerating = imageStats?.generating || 0
  const imagesFailed = imageStats?.failed || 0
  const imagesPending = (imageStats?.no_image || 0)
  const imagesState = imagesCompleted === visibleScenes.length && visibleScenes.length > 0 ? 'done'
    : imagesGenerating > 0 ? 'running'
    : imagesFailed > 0 ? 'failed'
    : 'pending'
  const audioState = audioJobStatus === 'completed' ? 'done'
    : audioJobStatus === 'running' ? 'running'
    : audioJobStatus === 'failed' ? 'failed'
    : 'pending'

  // 5. Video build progress
  let videoBuildStatus: string | null = null
  let videoProgressPercent: number | null = null
  let videoDownloadUrl: string | null = null

  if (run.video_build_id) {
    const videoBuild = await c.env.DB.prepare(`
      SELECT status, progress_percent, download_url FROM video_builds WHERE id = ?
    `).bind(run.video_build_id).first<{ status: string; progress_percent: number | null; download_url: string | null }>()
    if (videoBuild) {
      videoBuildStatus = videoBuild.status
      videoProgressPercent = videoBuild.progress_percent
      videoDownloadUrl = videoBuild.download_url

      // If build is active (not terminal), trigger a refresh via internal fetch
      // This keeps the DB updated from AWS/Remotion so the marunage UI gets live progress
      const activeStatuses = ['queued', 'validating', 'submitted', 'rendering', 'uploading']
      if (activeStatuses.includes(videoBuild.status)) {
        try {
          const origin = new URL(c.req.url).origin
          const refreshUrl = `${origin}/api/video-builds/${run.video_build_id}/refresh`
          const sessionCookie = getCookie(c, 'session') || ''
          const refreshRes = await fetch(refreshUrl, {
            method: 'POST',
            headers: { 'Cookie': `session=${sessionCookie}` },
          })
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json() as any
            const rb = refreshData?.build
            if (rb) {
              videoBuildStatus = rb.status || videoBuildStatus
              videoProgressPercent = rb.progress_percent ?? videoProgressPercent
              videoDownloadUrl = rb.download_url || videoDownloadUrl
              console.log(`[Marunage:Status] Build ${run.video_build_id} refreshed: ${videoBuild.status} → ${rb.status}`)
            }
          }
        } catch (refreshErr) {
          console.warn(`[Marunage:Status] Build refresh failed (non-fatal):`, refreshErr instanceof Error ? refreshErr.message : refreshErr)
        }
      }
    }
  }

  // ── Auto-retry: If build failed + flag ON + phase ready → clear & re-trigger ──
  // Retries once per status poll to avoid infinite loops. Uses video_build_attempted_at as cooldown.
  const videoBuildFlagOn = await isVideoBuildEnabled(c.env.DB)
  if (run.phase === 'ready' && videoBuildFlagOn && videoBuildStatus === 'failed' && run.video_build_id) {
    // Check cooldown (5 min after failure detection)
    const attemptedAt = run.video_build_attempted_at ? new Date(run.video_build_attempted_at).getTime() : 0
    const elapsed = Date.now() - attemptedAt
    const RETRY_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes
    if (elapsed >= RETRY_COOLDOWN_MS) {
      console.log(`[Marunage:Status] Build ${run.video_build_id} failed, retrying after ${Math.floor(elapsed / 60000)}min cooldown`)
      // Clear run's video build state
      await c.env.DB.prepare(`
        UPDATE marunage_runs
        SET video_build_id = NULL, video_build_error = NULL, video_build_attempted_at = NULL
        WHERE id = ?
      `).bind(run.id).run()
      // Trigger in background
      const sessionCookie = getCookie(c, 'session') || ''
      c.executionCtx.waitUntil(
        marunageTriggerVideoBuild(
          c.env.DB, run.id, run.project_id, config,
          c.req.url, sessionCookie
        ).catch(err => console.error(`[Marunage:Status] Auto-retry error:`, err))
      )
      // Override state for this response
      videoBuildStatus = null
      videoProgressPercent = null
      videoDownloadUrl = null
    }
  }

  // ── Auto-trigger: If phase ready + flag ON + no build attempted → trigger first build ──
  // Handles cases where the flag was enabled after the run reached ready, or trigger was missed
  if (run.phase === 'ready' && videoBuildFlagOn && !run.video_build_id && !run.video_build_attempted_at && !run.video_build_error) {
    console.log(`[Marunage:Status] No build attempted for run ${run.id}, triggering now (flag ON + ready)`)
    const sessionCookie = getCookie(c, 'session') || ''
    c.executionCtx.waitUntil(
      marunageTriggerVideoBuild(
        c.env.DB, run.id, run.project_id, config,
        c.req.url, sessionCookie
      ).catch(err => console.error(`[Marunage:Status] Auto-trigger error:`, err))
    )
  }
  let videoState: 'off' | 'pending' | 'running' | 'done' | 'failed'
  if (run.video_build_id) {
    // Build exists — derive state from build status
    if (videoBuildStatus === 'completed') videoState = 'done'
    else if (['rendering', 'uploading', 'submitted', 'queued', 'validating'].includes(videoBuildStatus || '')) videoState = 'running'
    else if (videoBuildStatus === 'failed' || videoBuildStatus === 'cancelled') videoState = 'failed'
    else videoState = 'pending'
  } else if (run.video_build_error) {
    // Trigger attempted but failed
    videoState = 'failed'
  } else if (run.phase === 'ready' && videoBuildFlagOn) {
    // Flag ON, phase ready, no build yet → trigger will fire soon
    videoState = 'pending'
  } else {
    // Flag OFF or not in ready phase
    videoState = 'off'
  }

  // 6. Confirmed selections for left board (B-spec)
  const { results: confirmedCharacters } = await c.env.DB.prepare(`
    SELECT character_key, character_name, voice_preset_id
    FROM project_character_models
    WHERE project_id = ?
    ORDER BY id ASC
  `).bind(projectId).all()

  const styleSettings = await c.env.DB.prepare(`
    SELECT pss.default_style_preset_id, sp.name AS style_name
    FROM project_style_settings pss
    LEFT JOIN style_presets sp ON sp.id = pss.default_style_preset_id
    WHERE pss.project_id = ?
  `).bind(projectId).first<{ default_style_preset_id: number | null; style_name: string | null }>()

  // Narration voice from settings_json
  const projSettings = await c.env.DB.prepare(`
    SELECT settings_json FROM projects WHERE id = ?
  `).bind(projectId).first<{ settings_json: string | null }>()
  let confirmedVoice: { provider: string; voice_id: string } | null = null
  try {
    const sj = projSettings?.settings_json ? JSON.parse(projSettings.settings_json) : {}
    if (sj.default_narration_voice) {
      confirmedVoice = sj.default_narration_voice
    }
  } catch {}

  const response: MarunageStatusResponse = {
    run_id: run.id,
    project_id: run.project_id,
    phase: run.phase,
    config,
    error: run.error_code ? { code: run.error_code, message: run.error_message, phase: run.error_phase } : null,
    progress: {
      format: {
        state: formatState as any,
        scene_count: visibleScenes.length,
        chunks: {
          total: chunkStats?.total || 0,
          done: chunkStats?.done || 0,
          failed: chunkStats?.failed || 0,
          pending: chunkStats?.pending || 0,
        },
      },
      scenes_ready: {
        state: utterancesReady ? 'done' : 'pending',
        visible_count: visibleScenes.length,
        utterances_ready: utterancesReady,
        scenes: visibleScenes.map((s: any) => ({
          id: s.id,
          idx: s.idx,
          title: s.title,
          has_image: s.image_status === 'completed',
          image_status: s.image_status || 'pending', // pending | generating | completed | failed
          image_url: s.image_r2_key ? `/images/${s.image_r2_key}` : null,
          has_audio: (s.audio_completed_count || 0) > 0,
          utterance_count: s.utterance_count,
        })),
      },
      images: {
        state: imagesState as any,
        total: visibleScenes.length,
        completed: imagesCompleted,
        generating: imagesGenerating,
        failed: imagesFailed,
        pending: imagesPending,
      },
      audio: {
        state: audioState as any,
        job_id: run.audio_job_id,
        job_status: audioJobStatus,
        total_utterances: audioTotalUtterances,
        completed: audioCompleted,
        failed: audioFailed,
      },
      video: {
        state: videoState,
        enabled: videoBuildFlagOn,
        build_id: run.video_build_id || null,
        build_status: videoBuildStatus,
        progress_percent: videoProgressPercent,
        download_url: videoDownloadUrl,
        error: run.video_build_error || null,
        attempted_at: run.video_build_attempted_at || null,
      },
    },
    timestamps: {
      created_at: run.created_at,
      updated_at: run.updated_at,
      completed_at: run.completed_at,
    },
    // B-spec: confirmed selections for left board display
    confirmed: {
      characters: (confirmedCharacters || []).map((ch: any) => ({
        character_key: ch.character_key,
        character_name: ch.character_name,
        voice_preset_id: ch.voice_preset_id,
      })),
      style: styleSettings ? {
        preset_id: styleSettings.default_style_preset_id,
        name: styleSettings.style_name,
      } : null,
      voice: confirmedVoice,
    },
  }

  return c.json(response)
})

// ============================================================
// 5-4. POST /:projectId/advance - フェーズ遷移のみ (起動なし)
//       Issue-1: 状態遷移とロック管理のみ。外部処理は起動しない。
//       Issue-2: awaiting_ready → generating_images で画像生成を起動
//       Issue-3: generating_images → generating_audio で音声生成を起動
// ============================================================

marunage.post('/:projectId/advance', async (c) => {
  const user = await getSessionUser(c.env.DB, getCookie(c, 'session'))
  if (!user) return errorJson(c, MARUNAGE_ERRORS.UNAUTHORIZED, 'Session required')

  const projectId = parseInt(c.req.param('projectId'))
  if (isNaN(projectId)) return errorJson(c, MARUNAGE_ERRORS.INVALID_REQUEST, 'Invalid projectId')

  const run = await getActiveRunForProject(c.env.DB, projectId)
  if (!run) return errorJson(c, MARUNAGE_ERRORS.NOT_FOUND, 'No active run for this project')
  if (run.started_by_user_id !== user.id) return errorJson(c, MARUNAGE_ERRORS.FORBIDDEN, 'Not your project')

  // Lock check — but allow re-kick if stuck in generating_images with no progress
  if (run.locked_until) {
    const lockExpiry = new Date(run.locked_until).getTime()
    if (Date.now() < lockExpiry) {
      // Check if we're in generating_images with no image records (dead waitUntil)
      if (run.phase === 'generating_images') {
        const stuckCheck = await c.env.DB.prepare(`
          SELECT
            SUM(CASE WHEN ig.id IS NULL THEN 1 ELSE 0 END) AS no_image,
            SUM(CASE WHEN ig.status IN ('pending','generating') THEN 1 ELSE 0 END) AS in_progress
          FROM scenes s
          LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
          WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
        `).bind(projectId).first<{ no_image: number; in_progress: number }>()
        const noImage = stuckCheck?.no_image || 0
        const inProgress = stuckCheck?.in_progress || 0
        if (noImage > 0 && inProgress === 0) {
          console.log(`[Marunage:Advance] Lock bypassed: generating_images stuck with ${noImage} missing images, clearing lock`)
          await c.env.DB.prepare(`
            UPDATE marunage_runs SET locked_at = NULL, locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).bind(run.id).run()
          // Fall through to advance logic
        } else {
          return errorJson(c, MARUNAGE_ERRORS.CONFLICT, 'Run is locked. Please wait.', { locked_until: run.locked_until })
        }
      } else if (run.phase === 'generating_audio') {
        // generating_audio phase: always allow advance to check audio job status.
        // Lock was set during transition but advance needs to poll the audio job.
        console.log(`[Marunage:Advance] Lock bypassed: generating_audio phase, clearing lock to allow audio status polling`)
        await c.env.DB.prepare(`
          UPDATE marunage_runs SET locked_at = NULL, locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).bind(run.id).run()
        // Fall through to advance logic
      } else {
        return errorJson(c, MARUNAGE_ERRORS.CONFLICT, 'Run is locked. Please wait.', { locked_until: run.locked_until })
      }
    }
  }

  const currentPhase = run.phase as MarunagePhase
  const config: MarunageConfig = JSON.parse(run.config_json || '{}')

  try {
    switch (currentPhase) {
      // ---- formatting → awaiting_ready ----
      case 'formatting': {
        // Check if project formatting is complete by reading project.status
        const proj = await c.env.DB.prepare(
          `SELECT status FROM projects WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)`
        ).bind(projectId).first<{ status: string }>()

        if (!proj || proj.status !== 'formatted') {
          return c.json({
            run_id: run.id,
            previous_phase: currentPhase,
            new_phase: currentPhase,
            action: 'waiting',
            message: 'Formatting not yet complete',
          })
        }

        // 5-scene convergence: check and hide excess scenes
        const { results: allScenes } = await c.env.DB.prepare(`
          SELECT id, idx FROM scenes WHERE project_id = ? AND (is_hidden = 0 OR is_hidden IS NULL) ORDER BY idx ASC
        `).bind(projectId).all()

        if (!allScenes || allScenes.length === 0) {
          await transitionPhase(c.env.DB, run.id, currentPhase, 'failed', {
            error_code: 'NO_SCENES',
            error_message: 'No scenes generated',
            error_phase: 'formatting',
          })
          return c.json({
            run_id: run.id,
            previous_phase: currentPhase,
            new_phase: 'failed',
            action: 'failed_no_scenes',
            message: 'シーンが生成されませんでした',
          })
        }

        // Hide excess scenes beyond target_scene_count
        const targetCount = config.target_scene_count || 5
        if (allScenes.length > targetCount) {
          const excessIds = allScenes.slice(targetCount).map((s: any) => s.id)
          for (const id of excessIds) {
            await c.env.DB.prepare(
              `UPDATE scenes SET is_hidden = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
            ).bind(id).run()
          }
          try {
            await logAudit({
              db: c.env.DB, userId: user.id, userRole: user.role,
              entityType: 'project', entityId: projectId, projectId,
              action: 'marunage.scene_trim',
              details: { hidden_scene_ids: excessIds, kept: targetCount, original_total: allScenes.length },
            })
          } catch (_) {}
        }

        // Transition formatting → awaiting_ready
        const ok = await transitionPhase(c.env.DB, run.id, 'formatting', 'awaiting_ready')
        if (!ok) {
          return c.json({
            run_id: run.id,
            previous_phase: currentPhase,
            new_phase: 'awaiting_ready',
            action: 'already_advanced',
            message: 'Already transitioned',
          })
        }

        return c.json({
          run_id: run.id,
          previous_phase: 'formatting',
          new_phase: 'awaiting_ready',
          action: 'scenes_confirmed',
          message: `${Math.min(allScenes.length, targetCount)}シーンに分割しました`,
        })
      }

      // ---- awaiting_ready → generating_images ----
      case 'awaiting_ready': {
        // Check utterances are ready for all visible scenes
        const { results: sceneUtts } = await c.env.DB.prepare(`
          SELECT s.id, (SELECT COUNT(*) FROM scene_utterances su WHERE su.scene_id = s.id) AS utt_count
          FROM scenes s WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL) ORDER BY s.idx ASC
        `).bind(projectId).all()

        const ready = sceneUtts && sceneUtts.length > 0 && sceneUtts.every((s: any) => s.utt_count > 0)
        if (!ready) {
          return c.json({
            run_id: run.id,
            previous_phase: currentPhase,
            new_phase: currentPhase,
            action: 'waiting',
            message: 'Utterances not yet ready',
          })
        }

        // Issue-2: Transition to generating_images (no lock, no waitUntil)
        // Images will be generated 1-by-1 via advance calls from frontend polling
        const ok = await transitionPhase(c.env.DB, run.id, 'awaiting_ready', 'generating_images')
        if (!ok) {
          return c.json({
            run_id: run.id,
            previous_phase: currentPhase,
            new_phase: 'generating_images',
            action: 'already_advanced',
            message: 'Already transitioned',
          })
        }

        return c.json({
          run_id: run.id,
          previous_phase: 'awaiting_ready',
          new_phase: 'generating_images',
          action: 'images_started',
          message: '画像生成を開始しました',
        })
      }

      // ---- generating_images → generating_audio (or retry failed) ----
      case 'generating_images': {
        // Check image completion status (including scenes with no image record)
        const imgStats = await c.env.DB.prepare(`
          SELECT
            COUNT(*) AS total_scenes,
            SUM(CASE WHEN ig.status='completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN ig.status IN ('pending','generating') THEN 1 ELSE 0 END) AS generating,
            SUM(CASE WHEN ig.status='failed' OR ig.status='policy_violation' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN ig.id IS NULL THEN 1 ELSE 0 END) AS no_image
          FROM scenes s
          LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
          WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
        `).bind(projectId).first<{ total_scenes: number; completed: number; generating: number; failed: number; no_image: number }>()

        const completed = imgStats?.completed || 0
        const generating = imgStats?.generating || 0
        const failed = imgStats?.failed || 0
        const noImage = imgStats?.no_image || 0

        console.log(`[Marunage:Advance:Images] project=${projectId} completed=${completed} generating=${generating} failed=${failed} noImage=${noImage}`)

        // If there are scenes with no image record, generate ONE image directly (not via waitUntil)
        // This avoids Cloudflare Workers waitUntil timeout for multiple images.
        // Frontend polls every 10s → advance → 1 image → repeat until all done.
        if (noImage > 0 && generating === 0) {
          console.log(`[Marunage:Advance:Images] Generating 1 image directly (${noImage} remaining)`)
          
          const aspectRatio = config.output_preset === 'short_vertical' ? '9:16' : '16:9'
          
          // Resolve API key
          const billing = user.id
            ? await resolveBillingContext(c.env.DB, user.id)
            : { billingSource: 'system' as BillingSource, effectiveUserId: null, sponsorUserId: null }
          const keyResult = await resolveProviderKey(c.env.DB, billing, 'gemini', c.env.GEMINI_API_KEY, c.env.ENCRYPTION_KEY)
          if (!keyResult) {
            console.error(`[Marunage:Advance:Images] No Gemini API key`)
            await transitionPhase(c.env.DB, run.id, 'generating_images', 'failed', {
              error_code: 'NO_API_KEY',
              error_message: `No Gemini API key configured`,
              error_phase: 'generating_images',
            })
            return c.json({
              run_id: run.id,
              previous_phase: currentPhase,
              new_phase: 'failed',
              action: 'failed',
              message: 'APIキーが設定されていません',
            })
          }
          
          // Find first scene without image
          const nextScene = await c.env.DB.prepare(`
            SELECT s.id, s.idx, s.image_prompt
            FROM scenes s
            LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
            WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL) AND ig.id IS NULL
            ORDER BY s.idx ASC LIMIT 1
          `).bind(projectId).first<{ id: number; idx: number; image_prompt: string }>()
          
          if (!nextScene) {
            return c.json({
              run_id: run.id,
              previous_phase: currentPhase,
              new_phase: currentPhase,
              action: 'waiting',
              message: 'No scene without image found',
            })
          }
          
          // Build prompt
          let prompt = nextScene.image_prompt || ''
          try {
            prompt = await composeStyledPrompt(c.env.DB, projectId, nextScene.id, prompt)
          } catch (e) {
            console.warn(`[Marunage:Advance:Images] Style composition failed:`, e)
          }
          if (!prompt) prompt = `A scene from a video presentation. Scene index: ${nextScene.idx}`
          
          // Phase 4 (M-7): Fetch reference images for character consistency
          let refImages: Array<{ base64Data: string; mimeType: string; characterName?: string }> = []
          try {
            const refs = await getSceneReferenceImages(c.env.DB, c.env.R2, nextScene.id, 5)
            refImages = refs.map(r => ({
              base64Data: r.base64Data,
              mimeType: r.mimeType,
              characterName: r.characterName,
            }))
            if (refImages.length > 0) {
              console.log(`[Marunage:Advance:Images] Loaded ${refImages.length} reference image(s) for scene ${nextScene.id}`)
            }
          } catch (e) {
            console.warn(`[Marunage:Advance:Images] Reference image loading failed for scene ${nextScene.id}:`, e)
            // Continue without reference images (graceful degradation)
          }
          
          // ── Timing: overall start ──
          const t0 = Date.now()
          
          // Create image_generations record with started_at
          const insertResult = await c.env.DB.prepare(`
            INSERT INTO image_generations (scene_id, prompt, status, provider, model, is_active, started_at)
            VALUES (?, ?, 'generating', 'gemini', '${GEMINI_MODEL}', 1, datetime('now'))
          `).bind(nextScene.id, prompt).run()
          const genId = insertResult.meta.last_row_id as number
          
          // ── Timing: Gemini API call ──
          const tGeminiStart = Date.now()
          console.log(`[Marunage:Advance:Images] Calling Gemini for scene ${nextScene.id} (idx=${nextScene.idx})${refImages.length > 0 ? ` with ${refImages.length} ref images` : ''}`)
          const imageResult = await generateSingleImage(keyResult.apiKey, prompt, aspectRatio as any, refImages.length > 0 ? refImages : undefined)
          const geminiMs = Date.now() - tGeminiStart
          
          if (imageResult.success && imageResult.imageData) {
            // ── Timing: R2 upload ──
            const tR2Start = Date.now()
            const r2Key = `projects/${projectId}/scenes/${nextScene.id}/image_${genId}.png`
            await c.env.R2.put(r2Key, imageResult.imageData, {
              httpMetadata: { contentType: 'image/png' },
            })
            const r2Ms = Date.now() - tR2Start
            const totalMs = Date.now() - t0
            
            const r2Url = `/${r2Key}`  // ★ FIX: r2_url を設定（preflight が参照する）
            await c.env.DB.prepare(`
              UPDATE image_generations
              SET status = 'completed', r2_key = ?, r2_url = ?,
                  ended_at = datetime('now'), duration_ms = ?, gemini_duration_ms = ?, r2_duration_ms = ?
              WHERE id = ?
            `).bind(r2Key, r2Url, totalMs, geminiMs, r2Ms, genId).run()
            // Note: scenes table does NOT have image_status/image_r2_key columns.
            // Image status is tracked exclusively via image_generations table.
            console.log(`[Marunage:Advance:Images] Scene ${nextScene.idx} ✅ completed — total=${totalMs}ms gemini=${geminiMs}ms r2=${r2Ms}ms`)
            
            // ★ P0-1: コスト記録（advance経路）— 全画像生成経路で必ず1行残す SSOT
            await logImageGenerationCost(c.env.DB, {
              userId: user.id,
              projectId: String(projectId),
              sceneId: nextScene.id,
              status: 'success',
              apiKeySource: keyResult.keySource,
              sponsorUserId: billing.sponsorUserId,
              promptLength: prompt.length,
              generationType: 'marunage_advance',
            })
          } else {
            const totalMs = Date.now() - t0
            await c.env.DB.prepare(`
              UPDATE image_generations
              SET status = 'failed', error_message = ?,
                  ended_at = datetime('now'), duration_ms = ?, gemini_duration_ms = ?
              WHERE id = ?
            `).bind((imageResult.error || 'Unknown error').substring(0, 500), totalMs, geminiMs, genId).run()
            console.error(`[Marunage:Advance:Images] Scene ${nextScene.idx} ❌ failed — total=${totalMs}ms gemini=${geminiMs}ms error=${imageResult.error}`)
            
            // ★ P0-1: コスト記録（advance経路・失敗）— 失敗も必ず記録
            await logImageGenerationCost(c.env.DB, {
              userId: user.id,
              projectId: String(projectId),
              sceneId: nextScene.id,
              status: 'failed',
              apiKeySource: keyResult.keySource,
              sponsorUserId: billing.sponsorUserId,
              promptLength: prompt.length,
              errorMessage: (imageResult.error || 'Unknown error').substring(0, 500),
              generationType: 'marunage_advance',
            })
          }
          
          return c.json({
            run_id: run.id,
            previous_phase: currentPhase,
            new_phase: currentPhase,
            action: 'images_started',
            message: `画像生成中 (シーン${nextScene.idx + 1})`,
          })
        }

        if (generating > 0) {
          // Safety: if image_generations stuck in 'generating' for >60s, mark as failed
          // Gemini + R2 should complete in <30s; 60s is generous
          // Use COALESCE(started_at, created_at) for backward compat (old rows have no started_at)
          const staleFixed = await c.env.DB.prepare(`
            UPDATE image_generations
            SET status = 'failed',
                error_message = 'Timed out (stuck in generating >60s)',
                ended_at = datetime('now'),
                duration_ms = CAST((julianday('now') - julianday(COALESCE(started_at, created_at))) * 86400000 AS INTEGER)
            WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ? AND (is_hidden = 0 OR is_hidden IS NULL))
              AND is_active = 1
              AND status = 'generating'
              AND COALESCE(started_at, created_at) < datetime('now', '-60 seconds')
          `).bind(projectId).run()
          const fixedCount = staleFixed.meta.changes || 0
          if (fixedCount > 0) {
            console.log(`[Marunage:Advance:Images] Fixed ${fixedCount} stale generating records (>60s)`)
            // Return immediately so next poll re-evaluates with fresh stats
            return c.json({
              run_id: run.id,
              previous_phase: currentPhase,
              new_phase: currentPhase,
              action: 'stale_fixed',
              message: `${fixedCount}枚の停滞画像を検出、再生成します`,
            })
          }
          
          return c.json({
            run_id: run.id,
            previous_phase: currentPhase,
            new_phase: currentPhase,
            action: 'waiting',
            message: `Images still generating (${completed} completed, ${generating} in progress)`,
          })
        }

        // All completed → transition to generating_audio
        // Explicitly check noImage === 0 and generating === 0 for safety
        if (completed > 0 && failed === 0 && noImage === 0 && generating === 0) {
          // No lock needed: advance handler checks audio_job_id & job status on each poll.
          // The 10-min lock was blocking subsequent advance calls (409 CONFLICT bug).
          const ok = await transitionPhase(c.env.DB, run.id, 'generating_images', 'generating_audio')
          if (!ok) {
            return c.json({
              run_id: run.id,
              previous_phase: currentPhase,
              new_phase: 'generating_audio',
              action: 'already_advanced',
              message: 'Already transitioned',
            })
          }

          // Issue-3: Start audio generation via waitUntil
          const sessionCookie = getCookie(c, 'session') || ''
          const config: MarunageConfig = run.config_json ? JSON.parse(run.config_json) : DEFAULT_CONFIG

          c.executionCtx.waitUntil(
            marunageStartAudioGeneration(
              c.env.DB, run.id, projectId, config,
              c.req.url, sessionCookie
            ).catch(err => console.error(`[Marunage:Audio] waitUntil error:`, err))
          )

          return c.json({
            run_id: run.id,
            previous_phase: 'generating_images',
            new_phase: 'generating_audio',
            action: 'audio_started',
            message: '音声生成を開始しました',
          })
        }

        // Failed images — Issue-2: Auto-retry (max 3 times)
        // Reset failed images one at a time so they get picked up by the noImage > 0 branch.
        if (failed > 0) {
          const MAX_IMAGE_RETRIES = 3
          if (run.retry_count < MAX_IMAGE_RETRIES) {
            // Increment retry count
            await c.env.DB.prepare(`
              UPDATE marunage_runs
              SET retry_count = retry_count + 1,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).bind(run.id).run()

            // Deactivate failed image records so the scenes appear as noImage in next advance
            await c.env.DB.prepare(`
              UPDATE image_generations
              SET is_active = 0
              WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ? AND (is_hidden = 0 OR is_hidden IS NULL))
                AND is_active = 1
                AND (status = 'failed' OR status = 'policy_violation')
            `).bind(projectId).run()

            console.log(`[Marunage:Advance:Images] Deactivated ${failed} failed images for retry (${run.retry_count + 1}/${MAX_IMAGE_RETRIES})`)

            return c.json({
              run_id: run.id,
              previous_phase: currentPhase,
              new_phase: currentPhase,
              action: 'retrying',
              message: `${failed}枚の失敗画像をリトライ準備中 (${run.retry_count + 1}/${MAX_IMAGE_RETRIES})`,
            })
          }

          // Retry exhausted → failed
          await transitionPhase(c.env.DB, run.id, 'generating_images', 'failed', {
            error_code: 'IMAGE_GENERATION_FAILED',
            error_message: `${failed} image(s) failed after ${MAX_IMAGE_RETRIES} retries`,
            error_phase: 'generating_images',
          })
          return c.json({
            run_id: run.id,
            previous_phase: 'generating_images',
            new_phase: 'failed',
            action: 'failed',
            message: '画像生成が失敗しました',
          })
        }

        // No images at all yet (edge case: generation just started or no records)
        return c.json({
          run_id: run.id,
          previous_phase: currentPhase,
          new_phase: currentPhase,
          action: 'waiting',
          message: 'No images generated yet',
        })
      }

      // ---- generating_audio → ready ----
      case 'generating_audio': {
        if (!run.audio_job_id) {
          // Issue-3: audio_job_id が未設定 — waitUntil が遅延/失敗した可能性
          // bulk-audio API に既存ジョブがないか確認し、なければ再起動
          const sessionCookie = getCookie(c, 'session') || ''
          const config: MarunageConfig = run.config_json ? JSON.parse(run.config_json) : DEFAULT_CONFIG

          // Check if there's already a job for this project
          const existingJob = await c.env.DB.prepare(`
            SELECT id, status FROM project_audio_jobs
            WHERE project_id = ? AND status IN ('queued', 'running', 'completed')
            ORDER BY created_at DESC LIMIT 1
          `).bind(projectId).first<{ id: number; status: string }>()

          if (existingJob) {
            // Found an existing job — save it and proceed
            await c.env.DB.prepare(`
              UPDATE marunage_runs SET audio_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
            `).bind(existingJob.id, run.id).run()
            console.log(`[Marunage:Audio] Found existing job ${existingJob.id} (${existingJob.status}), saved to run ${run.id}`)

            if (existingJob.status === 'completed') {
              // Audio done → transition to ready
              const ok = await transitionPhase(c.env.DB, run.id, 'generating_audio', 'ready')
              if (ok) {
                // P1: Conditionally trigger video build in background
                const videoBuildEnabled = await isVideoBuildEnabled(c.env.DB)
                if (videoBuildEnabled) {
                  const sessionCookieAudio = getCookie(c, 'session') || ''
                  c.executionCtx.waitUntil(
                    marunageTriggerVideoBuild(
                      c.env.DB, run.id, projectId, config,
                      c.req.url, sessionCookieAudio
                    ).catch(err => console.error(`[Marunage:Video] waitUntil error:`, err))
                  )
                  console.log(`[Marunage:Audio] Audio complete, video build triggered (flag ON)`)
                } else {
                  console.log(`[Marunage:Audio] Audio complete, video build skipped (flag OFF)`)
                }
              }
              return c.json({
                run_id: run.id,
                previous_phase: 'generating_audio',
                new_phase: ok ? 'ready' : 'generating_audio',
                action: ok ? 'completed' : 'already_advanced',
                message: ok ? '完成しました！' : 'Already transitioned',
              })
            }

            return c.json({
              run_id: run.id,
              previous_phase: currentPhase,
              new_phase: currentPhase,
              action: 'waiting',
              message: `Audio job found (${existingJob.status}), waiting for completion`,
            })
          }

          // No existing job — re-trigger audio generation
          console.log(`[Marunage:Audio] No audio_job_id for run ${run.id}, re-triggering audio generation`)
          c.executionCtx.waitUntil(
            marunageStartAudioGeneration(
              c.env.DB, run.id, projectId, config,
              c.req.url, sessionCookie
            ).catch(err => console.error(`[Marunage:Audio] Re-trigger error:`, err))
          )

          return c.json({
            run_id: run.id,
            previous_phase: currentPhase,
            new_phase: currentPhase,
            action: 'audio_retrigger',
            message: '音声生成を再起動しました',
          })
        }

        const audioJob = await c.env.DB.prepare(`
          SELECT status FROM project_audio_jobs WHERE id = ?
        `).bind(run.audio_job_id).first<{ status: string }>()

        if (!audioJob || audioJob.status !== 'completed') {
          if (audioJob?.status === 'failed') {
            await transitionPhase(c.env.DB, run.id, 'generating_audio', 'failed', {
              error_code: 'AUDIO_GENERATION_FAILED',
              error_message: 'Bulk audio job failed',
              error_phase: 'generating_audio',
            })
            return c.json({
              run_id: run.id,
              previous_phase: 'generating_audio',
              new_phase: 'failed',
              action: 'failed',
              message: '音声生成に失敗しました',
            })
          }
          return c.json({
            run_id: run.id,
            previous_phase: currentPhase,
            new_phase: currentPhase,
            action: 'waiting',
            message: 'Audio still generating',
          })
        }

        // Audio done → ready (P1: phase is always 'ready', video build is background)
        const ok = await transitionPhase(c.env.DB, run.id, 'generating_audio', 'ready')
        if (!ok) {
          return c.json({
            run_id: run.id,
            previous_phase: currentPhase,
            new_phase: 'ready',
            action: 'already_advanced',
            message: 'Already transitioned',
          })
        }

        // P1: Conditionally trigger video build in background (flag check)
        const videoBuildEnabled = await isVideoBuildEnabled(c.env.DB)
        if (videoBuildEnabled) {
          const sessionCookieForVideo = getCookie(c, 'session') || ''
          c.executionCtx.waitUntil(
            marunageTriggerVideoBuild(
              c.env.DB, run.id, projectId, config,
              c.req.url, sessionCookieForVideo
            ).catch(err => console.error(`[Marunage:Video] waitUntil error:`, err))
          )
          console.log(`[Marunage:Audio] Audio complete, video build triggered (flag ON)`)
        } else {
          console.log(`[Marunage:Audio] Audio complete, video build skipped (flag OFF)`)
        }

        try {
          await logAudit({
            db: c.env.DB, userId: user.id, userRole: user.role,
            entityType: 'project', entityId: projectId, projectId,
            action: 'marunage.run_completed',
            details: { run_id: run.id, video_build_enabled: videoBuildEnabled },
          })
        } catch (_) {}

        return c.json({
          run_id: run.id,
          previous_phase: 'generating_audio',
          new_phase: 'ready',
          action: 'completed',
          message: '完成しました！',
        })
      }

      default:
        return errorJson(c, MARUNAGE_ERRORS.INVALID_PHASE, `Cannot advance from phase: ${currentPhase}`)
    }
  } catch (error) {
    // Full stack trace for server logs only (never exposed to client)
    const fullError = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
    console.error(`[Marunage] Advance error for run ${run.id}:`, fullError)

    // Client gets only a safe error identifier — no internal details
    return errorJson(c, MARUNAGE_ERRORS.INTERNAL_ERROR, 'Failed to advance', {
      run_id: run.id,
      phase: currentPhase,
    })
  }
})

// ============================================================
// 5-5. POST /:projectId/retry - 失敗 run の再開
// ============================================================

marunage.post('/:projectId/retry', async (c) => {
  const user = await getSessionUser(c.env.DB, getCookie(c, 'session'))
  if (!user) return errorJson(c, MARUNAGE_ERRORS.UNAUTHORIZED, 'Session required')

  const projectId = parseInt(c.req.param('projectId'))
  const run = await c.env.DB.prepare(`
    SELECT * FROM marunage_runs WHERE project_id = ? AND phase = 'failed' ORDER BY created_at DESC LIMIT 1
  `).bind(projectId).first<MarunageRunRow>()

  if (!run) return errorJson(c, MARUNAGE_ERRORS.NOT_FOUND, 'No failed run found')
  if (run.started_by_user_id !== user.id) return errorJson(c, MARUNAGE_ERRORS.FORBIDDEN, 'Not your project')
  if (run.retry_count >= MAX_RETRY_COUNT) return errorJson(c, MARUNAGE_ERRORS.RETRY_EXHAUSTED, 'Retry limit reached')

  const errorPhase = run.error_phase || 'formatting'
  const rollbackTo = RETRY_ROLLBACK_MAP[errorPhase] || 'formatting'

  const result = await c.env.DB.prepare(`
    UPDATE marunage_runs
    SET phase = ?, retry_count = retry_count + 1,
        error_code = NULL, error_message = NULL, error_phase = NULL,
        locked_at = NULL, locked_until = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND phase = 'failed'
  `).bind(rollbackTo, run.id).run()

  if ((result.meta?.changes ?? 0) === 0) {
    return errorJson(c, MARUNAGE_ERRORS.CONFLICT, 'Run is no longer in failed state')
  }

  try {
    await logAudit({
      db: c.env.DB, userId: user.id, userRole: user.role,
      entityType: 'project', entityId: projectId, projectId,
      action: 'marunage.run_retried',
      details: { run_id: run.id, from_phase: 'failed', to_phase: rollbackTo, retry_count: run.retry_count + 1 },
    })
  } catch (_) {}

  return c.json({
    run_id: run.id,
    previous_phase: 'failed',
    new_phase: rollbackTo,
    action: 'retried',
    message: '再試行を開始しました',
  })
})

// ============================================================
// 5-6. POST /:projectId/cancel - アクティブ run の中断
// ============================================================

marunage.post('/:projectId/cancel', async (c) => {
  const user = await getSessionUser(c.env.DB, getCookie(c, 'session'))
  if (!user) return errorJson(c, MARUNAGE_ERRORS.UNAUTHORIZED, 'Session required')

  const projectId = parseInt(c.req.param('projectId'))
  const run = await getActiveRunForProject(c.env.DB, projectId)
  if (!run) return errorJson(c, MARUNAGE_ERRORS.NOT_FOUND, 'No active run found')
  if (run.started_by_user_id !== user.id) return errorJson(c, MARUNAGE_ERRORS.FORBIDDEN, 'Not your project')

  const result = await c.env.DB.prepare(`
    UPDATE marunage_runs
    SET phase = 'canceled', updated_at = CURRENT_TIMESTAMP,
        locked_at = NULL, locked_until = NULL
    WHERE id = ? AND phase NOT IN ('ready', 'failed', 'canceled')
  `).bind(run.id).run()

  if ((result.meta?.changes ?? 0) === 0) {
    return errorJson(c, MARUNAGE_ERRORS.CONFLICT, 'Run is already terminal')
  }

  // Best-effort: cancel audio job if running
  if (run.audio_job_id) {
    try {
      await c.env.DB.prepare(`
        UPDATE project_audio_jobs SET status = 'canceled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')
      `).bind(run.audio_job_id).run()
    } catch (_) {}
  }

  try {
    await logAudit({
      db: c.env.DB, userId: user.id, userRole: user.role,
      entityType: 'project', entityId: projectId, projectId,
      action: 'marunage.run_canceled',
      details: { run_id: run.id, canceled_at_phase: run.phase },
    })
  } catch (_) {}

  return c.json({
    run_id: run.id,
    previous_phase: run.phase,
    new_phase: 'canceled',
    action: 'canceled',
    message: '処理を中断しました',
  })
})

export default marunage
