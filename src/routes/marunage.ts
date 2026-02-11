/**
 * Marunage Chat MVP - API Routes (Issue-1: API Foundation)
 * 
 * === Non-Impact Protocol ===
 * 1) 既存 route ファイルを変更しない
 * 2) 既存内部関数を直接呼び出さない (HTTP経由のみ — Issue-2以降で実装)
 * 3) 書き込み対象は marunage_runs のみ (プロジェクト作成は既存テーブルへの書き込みだが新規プロジェクトのみ)
 * 4) Issue-1 は API 基盤のみ (Issue-5 で UI)
 * 
 * === Issue-1 Scope ===
 * - GET  /active           — ユーザーのアクティブ run を検索
 * - POST /start            — テキスト→プロジェクト作成→run作成 (フォーマット起動なし)
 * - GET  /:projectId/status — 統合進捗 (読み取りのみ)
 * - POST /:projectId/advance — フェーズ遷移のみ (外部処理起動なし)
 * - POST /:projectId/retry  — 失敗 run の再開
 * - POST /:projectId/cancel — アクティブ run の中断
 * 
 * === Deferred to Issue-2/3 ===
 * - フォーマット起動 (processTextChunks)
 * - 画像生成 (marunageGenerateImages)
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

  // Clear lock on terminal phases
  if (TERMINAL_PHASES.includes(to)) {
    sql += `, locked_at = NULL, locked_until = NULL`
  }

  sql += ` WHERE id = ? AND phase = ?`
  binds.push(runId, from)

  const result = await db.prepare(sql).bind(...binds).run()
  return (result.meta?.changes ?? 0) > 0
}

async function transitionPhaseWithLock(
  db: D1Database, runId: number, from: MarunagePhase, to: MarunagePhase, lockUntil: string
): Promise<boolean> {
  const allowed = ALLOWED_TRANSITIONS[from]
  if (!allowed?.includes(to)) return false

  const result = await db.prepare(`
    UPDATE marunage_runs
    SET phase = ?, locked_at = CURRENT_TIMESTAMP, locked_until = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND phase = ?
  `).bind(to, lockUntil, runId, from).run()

  return (result.meta?.changes ?? 0) > 0
}

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

  // Narration voice
  const narrationVoice = {
    provider: body.narration_voice?.provider || 'google',
    voice_id: body.narration_voice?.voice_id || 'ja-JP-Neural2-B',
  }

  // Build config snapshot
  const config: MarunageConfig = {
    ...DEFAULT_CONFIG,
    output_preset: outputPreset,
    narration_voice: {
      provider: narrationVoice.provider as any,
      voice_id: narrationVoice.voice_id,
    },
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

    // Set default narration voice + output_preset + marunage_mode in settings_json
    const settingsJson = JSON.stringify({
      default_narration_voice: narrationVoice,
      output_preset: outputPreset,
      marunage_mode: true,
    })
    await c.env.DB.prepare(`
      UPDATE projects SET settings_json = ?, output_preset = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(settingsJson, outputPreset, projectId).run()

    // Set default style preset (same pattern as existing project creation)
    const defaultStyle = await c.env.DB.prepare(`
      SELECT id FROM style_presets WHERE name = 'インフォグラフィック' AND is_active = 1 LIMIT 1
    `).first<{ id: number }>()
    if (defaultStyle) {
      await c.env.DB.prepare(`
        INSERT INTO project_style_settings (project_id, default_style_preset_id) VALUES (?, ?)
      `).bind(projectId, defaultStyle.id).run()
    }

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
    // Issue-1: フェーズ遷移のみ。フォーマット処理は起動しない。
    // Issue-2: ここで format-startup pathway を追加予定。
    await transitionPhase(c.env.DB, runId, 'init', 'formatting')

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
        details: { run_id: runId, config, note: 'Issue-1: phase transition only, no format start' },
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
    console.error('[Marunage] Start error:', error)
    return errorJson(c, MARUNAGE_ERRORS.INTERNAL_ERROR, 'Failed to start marunage run', { message: String(error) })
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

  // 2. Scenes + utterance counts
  const { results: scenesData } = await c.env.DB.prepare(`
    SELECT
      s.id, s.idx, s.title,
      (SELECT COUNT(*) FROM scene_utterances su WHERE su.scene_id = s.id) AS utterance_count,
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
          image_url: s.image_r2_key ? `/images/${s.image_r2_key}` : null,
          has_audio: false, // TODO: Issue-3 で拡充
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
    },
    timestamps: {
      created_at: run.created_at,
      updated_at: run.updated_at,
      completed_at: run.completed_at,
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

  // Lock check
  if (run.locked_until) {
    const lockExpiry = new Date(run.locked_until).getTime()
    if (Date.now() < lockExpiry) {
      return errorJson(c, MARUNAGE_ERRORS.CONFLICT, 'Run is locked. Please wait.', { locked_until: run.locked_until })
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

        // Issue-1: Set lock + transition only. No image generation start.
        // Issue-2: ここで画像生成を waitUntil で起動する予定。
        const lockUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString()
        const ok = await transitionPhaseWithLock(c.env.DB, run.id, 'awaiting_ready', 'generating_images', lockUntil)
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
          action: 'transitioned',
          message: '画像生成フェーズに遷移しました (Issue-2で起動実装予定)',
        })
      }

      // ---- generating_images → generating_audio ----
      case 'generating_images': {
        // Check image completion status
        const imgStats = await c.env.DB.prepare(`
          SELECT
            SUM(CASE WHEN ig.status='completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN ig.status IN ('pending','generating') THEN 1 ELSE 0 END) AS generating,
            SUM(CASE WHEN ig.status='failed' OR ig.status='policy_violation' THEN 1 ELSE 0 END) AS failed
          FROM scenes s
          LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
          WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
        `).bind(projectId).first<{ completed: number; generating: number; failed: number }>()

        const completed = imgStats?.completed || 0
        const generating = imgStats?.generating || 0
        const failed = imgStats?.failed || 0

        if (generating > 0) {
          return c.json({
            run_id: run.id,
            previous_phase: currentPhase,
            new_phase: currentPhase,
            action: 'waiting',
            message: 'Images still generating',
          })
        }

        // All completed → transition to generating_audio
        if (completed > 0 && failed === 0) {
          // Issue-1: Transition only. No audio generation start.
          // Issue-3: ここで音声生成を waitUntil で起動する予定。
          const lockUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString()
          const ok = await transitionPhaseWithLock(c.env.DB, run.id, 'generating_images', 'generating_audio', lockUntil)
          if (!ok) {
            return c.json({
              run_id: run.id,
              previous_phase: currentPhase,
              new_phase: 'generating_audio',
              action: 'already_advanced',
              message: 'Already transitioned',
            })
          }

          return c.json({
            run_id: run.id,
            previous_phase: 'generating_images',
            new_phase: 'generating_audio',
            action: 'transitioned',
            message: '音声生成フェーズに遷移しました (Issue-3で起動実装予定)',
          })
        }

        // Failed images
        if (failed > 0) {
          if (run.retry_count < 3) {
            // Issue-1: increment retry count only, no actual retry execution
            await c.env.DB.prepare(`
              UPDATE marunage_runs SET retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
            `).bind(run.id).run()

            return c.json({
              run_id: run.id,
              previous_phase: currentPhase,
              new_phase: currentPhase,
              action: 'retry_noted',
              message: `画像失敗を記録 (${run.retry_count + 1}/3) — Issue-2で自動リトライ実装予定`,
            })
          }

          // Retry exhausted → failed
          await transitionPhase(c.env.DB, run.id, 'generating_images', 'failed', {
            error_code: 'IMAGE_GENERATION_FAILED',
            error_message: `${failed} image(s) failed after 3 retries`,
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
          return c.json({
            run_id: run.id,
            previous_phase: currentPhase,
            new_phase: currentPhase,
            action: 'waiting',
            message: 'Audio job not started yet',
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

        // Audio done → ready!
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

        try {
          await logAudit({
            db: c.env.DB, userId: user.id, userRole: user.role,
            entityType: 'project', entityId: projectId, projectId,
            action: 'marunage.run_completed',
            details: { run_id: run.id },
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
    console.error(`[Marunage] Advance error for run ${run.id}:`, error)
    return errorJson(c, MARUNAGE_ERRORS.INTERNAL_ERROR, 'Failed to advance', { message: String(error) })
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
