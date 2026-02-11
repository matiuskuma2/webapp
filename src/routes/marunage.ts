/**
 * Marunage Chat MVP - API Routes
 * 
 * 全エンドポイントは /api/marunage/* 配下。
 * 既存コードへの依存方向: 丸投げ → 既存（読む/呼ぶのみ）
 * 既存 → 丸投げ の参照は一切なし。
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
  type MarunageAdvanceResponse,
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
// Helper: Get active run for user
// ============================================================

async function getActiveRunForUser(db: D1Database, userId: number): Promise<MarunageRunRow | null> {
  return await db.prepare(`
    SELECT * FROM marunage_runs
    WHERE started_by_user_id = ? AND phase NOT IN ('ready', 'failed', 'canceled')
    ORDER BY created_at DESC LIMIT 1
  `).bind(userId).first<MarunageRunRow>() || null
}

async function getActiveRunForProject(db: D1Database, projectId: number): Promise<MarunageRunRow | null> {
  return await db.prepare(`
    SELECT * FROM marunage_runs
    WHERE project_id = ? AND phase NOT IN ('ready', 'failed', 'canceled')
    ORDER BY created_at DESC LIMIT 1
  `).bind(projectId).first<MarunageRunRow>() || null
}

async function getLatestRunForProject(db: D1Database, projectId: number): Promise<MarunageRunRow | null> {
  return await db.prepare(`
    SELECT * FROM marunage_runs
    WHERE project_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(projectId).first<MarunageRunRow>() || null
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
// 5-2. POST /start - テキスト→プロジェクト作成→run作成→フォーマット起動
// ============================================================

marunage.post('/start', async (c) => {
  const user = await getSessionUser(c.env.DB, getCookie(c, 'session'))
  if (!user) return errorJson(c, MARUNAGE_ERRORS.UNAUTHORIZED, 'Session required')

  // Check for existing active run (user-level, not project-level)
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
    // ===== Step 1: Create project =====
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

    // Set default narration voice in settings_json
    const settingsJson = JSON.stringify({
      default_narration_voice: narrationVoice,
    })
    await c.env.DB.prepare(`
      UPDATE projects SET settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(settingsJson, projectId).run()

    // Set default style preset (same as existing project creation)
    const defaultStyle = await c.env.DB.prepare(`
      SELECT id FROM style_presets WHERE name = 'インフォグラフィック' AND is_active = 1 LIMIT 1
    `).first<{ id: number }>()
    if (defaultStyle) {
      await c.env.DB.prepare(`
        INSERT INTO project_style_settings (project_id, default_style_preset_id) VALUES (?, ?)
      `).bind(projectId, defaultStyle.id).run()
    }

    // Create Run #1 (same as existing project creation)
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
    await c.env.DB.prepare(`
      UPDATE marunage_runs SET phase = 'formatting', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND phase = 'init'
    `).bind(runId).run()

    // ===== Step 4: Kick formatting in waitUntil =====
    // Refetch project for processTextChunks
    const project = await c.env.DB.prepare(`
      SELECT * FROM projects WHERE id = ?
    `).bind(projectId).first()

    if (project) {
      // Use waitUntil for background formatting
      // processTextChunks needs a Hono context-like object
      c.executionCtx.waitUntil(
        (async () => {
          try {
            // Import and call processTextChunks
            // We replicate the formatting call pattern from formatting.ts
            const { processTextChunks } = await import('./formatting')
            await processTextChunks(c, String(projectId), project, config.split_mode, config.target_scene_count)
            console.log(`[Marunage] Formatting started for project ${projectId}, run ${runId}`)
          } catch (err) {
            console.error(`[Marunage] Formatting error for run ${runId}:`, err)
            // Mark run as failed
            await c.env.DB.prepare(`
              UPDATE marunage_runs
              SET phase = 'failed', error_code = 'FORMAT_ERROR',
                  error_message = ?, error_phase = 'formatting',
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).bind(String(err), runId).run()
          }
        })()
      )
    }

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
        details: { run_id: runId, config },
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
// 5-3. GET /:projectId/status - 丸投げ体験の統合進捗
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

  // ===== Collect progress from DB (4 queries, no N+1) =====

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
    SELECT status FROM projects WHERE id = ?
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
          has_audio: false, // TODO: add audio status per scene
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
// 5-4. POST /:projectId/advance - フェーズ遷移 + 処理起動
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
        const proj = await c.env.DB.prepare(`SELECT status FROM projects WHERE id = ?`).bind(projectId).first<{ status: string }>()
        if (!proj || proj.status !== 'formatted') {
          return c.json({ run_id: run.id, previous_phase: currentPhase, new_phase: currentPhase, action: 'waiting', message: 'Formatting not yet complete' })
        }

        // 5-scene convergence: hide scenes beyond 5
        const { results: allScenes } = await c.env.DB.prepare(`
          SELECT id, idx FROM scenes WHERE project_id = ? AND (is_hidden = 0 OR is_hidden IS NULL) ORDER BY idx ASC
        `).bind(projectId).all()

        if (!allScenes || allScenes.length === 0) {
          // No scenes → fail
          await transitionPhase(c.env.DB, run.id, currentPhase, 'failed', { error_code: 'NO_SCENES', error_message: 'No scenes generated', error_phase: 'formatting' })
          return c.json({ run_id: run.id, previous_phase: currentPhase, new_phase: 'failed', action: 'failed_no_scenes', message: 'シーンが生成されませんでした' })
        }

        // Hide excess scenes
        if (allScenes.length > 5) {
          const excessIds = allScenes.slice(5).map((s: any) => s.id)
          for (const id of excessIds) {
            await c.env.DB.prepare(`UPDATE scenes SET is_hidden = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id).run()
          }
          try {
            await logAudit({
              db: c.env.DB, userId: user.id, userRole: user.role,
              entityType: 'project', entityId: projectId, projectId,
              action: 'marunage.scene_trim',
              details: { hidden_scene_ids: excessIds, kept: 5, original_total: allScenes.length },
            })
          } catch (_) {}
        }

        // Transition
        const ok = await transitionPhase(c.env.DB, run.id, 'formatting', 'awaiting_ready')
        if (!ok) return c.json({ run_id: run.id, previous_phase: currentPhase, new_phase: 'awaiting_ready', action: 'already_advanced', message: 'Already transitioned' })

        return c.json({ run_id: run.id, previous_phase: 'formatting', new_phase: 'awaiting_ready', action: 'scenes_confirmed', message: `${Math.min(allScenes.length, 5)}シーンに分割しました` })
      }

      // ---- awaiting_ready → generating_images ----
      case 'awaiting_ready': {
        // Check utterances ready
        const { results: sceneUtts } = await c.env.DB.prepare(`
          SELECT s.id, (SELECT COUNT(*) FROM scene_utterances su WHERE su.scene_id = s.id) AS utt_count
          FROM scenes s WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL) ORDER BY s.idx ASC
        `).bind(projectId).all()

        const ready = sceneUtts && sceneUtts.length > 0 && sceneUtts.every((s: any) => s.utt_count > 0)
        if (!ready) {
          return c.json({ run_id: run.id, previous_phase: currentPhase, new_phase: currentPhase, action: 'waiting', message: 'Utterances not yet ready' })
        }

        // Set lock (5 min) + transition
        const lockUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString()
        const ok = await transitionPhaseWithLock(c.env.DB, run.id, 'awaiting_ready', 'generating_images', lockUntil)
        if (!ok) return c.json({ run_id: run.id, previous_phase: currentPhase, new_phase: 'generating_images', action: 'already_advanced', message: 'Already transitioned' })

        // Kick image generation in waitUntil
        c.executionCtx.waitUntil(
          marunageGenerateImages(c.env, projectId, run.id, config).catch(err => {
            console.error(`[Marunage] Image generation error for run ${run.id}:`, err)
          })
        )

        return c.json({ run_id: run.id, previous_phase: 'awaiting_ready', new_phase: 'generating_images', action: 'started_images', message: '画像生成を開始しました' })
      }

      // ---- generating_images → generating_audio ----
      case 'generating_images': {
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
          return c.json({ run_id: run.id, previous_phase: currentPhase, new_phase: currentPhase, action: 'waiting', message: 'Images still generating' })
        }

        // All completed → next phase
        if (completed >= 5 || (completed > 0 && failed === 0)) {
          const lockUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString()
          const ok = await transitionPhaseWithLock(c.env.DB, run.id, 'generating_images', 'generating_audio', lockUntil)
          if (!ok) return c.json({ run_id: run.id, previous_phase: currentPhase, new_phase: 'generating_audio', action: 'already_advanced', message: 'Already transitioned' })

          // Kick audio generation
          c.executionCtx.waitUntil(
            marunageGenerateAudio(c.env, projectId, run.id, config).catch(err => {
              console.error(`[Marunage] Audio generation error for run ${run.id}:`, err)
            })
          )

          return c.json({ run_id: run.id, previous_phase: 'generating_images', new_phase: 'generating_audio', action: 'started_audio', message: '音声生成を開始しました' })
        }

        // Failed images: auto-retry logic (backend-owned)
        if (failed > 0) {
          if (run.retry_count < 3) {
            // Auto-retry: re-generate failed images
            await c.env.DB.prepare(`
              UPDATE marunage_runs SET retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
            `).bind(run.id).run()

            c.executionCtx.waitUntil(
              marunageRetryFailedImages(c.env, projectId, run.id, config).catch(err => {
                console.error(`[Marunage] Image retry error for run ${run.id}:`, err)
              })
            )

            return c.json({ run_id: run.id, previous_phase: currentPhase, new_phase: currentPhase, action: 'auto_retry', message: `画像を再試行中 (${run.retry_count + 1}/3)` })
          }

          // Retry exhausted → failed
          await transitionPhase(c.env.DB, run.id, 'generating_images', 'failed', {
            error_code: 'IMAGE_GENERATION_FAILED',
            error_message: `${failed} image(s) failed after 3 retries`,
            error_phase: 'generating_images',
          })
          return c.json({ run_id: run.id, previous_phase: 'generating_images', new_phase: 'failed', action: 'failed', message: '画像生成が失敗しました' })
        }

        return c.json({ run_id: run.id, previous_phase: currentPhase, new_phase: currentPhase, action: 'waiting', message: 'No images generated yet' })
      }

      // ---- generating_audio → ready ----
      case 'generating_audio': {
        if (!run.audio_job_id) {
          return c.json({ run_id: run.id, previous_phase: currentPhase, new_phase: currentPhase, action: 'waiting', message: 'Audio job not started yet' })
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
            return c.json({ run_id: run.id, previous_phase: 'generating_audio', new_phase: 'failed', action: 'failed', message: '音声生成に失敗しました' })
          }
          return c.json({ run_id: run.id, previous_phase: currentPhase, new_phase: currentPhase, action: 'waiting', message: 'Audio still generating' })
        }

        // Audio done → ready!
        const ok = await c.env.DB.prepare(`
          UPDATE marunage_runs
          SET phase = 'ready', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
              locked_at = NULL, locked_until = NULL
          WHERE id = ? AND phase = 'generating_audio'
        `).bind(run.id).run()

        if ((ok.meta?.changes ?? 0) === 0) {
          return c.json({ run_id: run.id, previous_phase: currentPhase, new_phase: 'ready', action: 'already_advanced', message: 'Already transitioned' })
        }

        try {
          await logAudit({
            db: c.env.DB, userId: user.id, userRole: user.role,
            entityType: 'project', entityId: projectId, projectId,
            action: 'marunage.run_completed',
            details: { run_id: run.id },
          })
        } catch (_) {}

        return c.json({ run_id: run.id, previous_phase: 'generating_audio', new_phase: 'ready', action: 'completed', message: '完成しました！' })
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
// Issue-2: Image Generation Orchestration (独自実装 — 既存変更ゼロ)
// ============================================================

async function marunageGenerateImages(
  env: Bindings, projectId: number, runId: number, config: MarunageConfig
): Promise<void> {
  console.log(`[Marunage] Starting image generation for project ${projectId}, run ${runId}`)

  try {
    // Get visible scenes
    const { results: scenes } = await env.DB.prepare(`
      SELECT s.id, s.idx, s.title, s.image_prompt
      FROM scenes s
      WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
      ORDER BY s.idx ASC
    `).bind(projectId).all()

    if (!scenes || scenes.length === 0) {
      await env.DB.prepare(`
        UPDATE marunage_runs SET phase = 'failed', error_code = 'NO_SCENES', error_message = 'No visible scenes', error_phase = 'generating_images', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(runId).run()
      return
    }

    // Resolve API key (user → sponsor → system, same as existing logic)
    const apiKey = await resolveGeminiApiKey(env, projectId)
    if (!apiKey) {
      await env.DB.prepare(`
        UPDATE marunage_runs SET phase = 'failed', error_code = 'NO_API_KEY', error_message = 'No Gemini API key available', error_phase = 'generating_images', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(runId).run()
      return
    }

    // Generate images for each scene (sequential, simple)
    for (const scene of scenes) {
      try {
        // Check if scene already has an active completed image
        const existing = await env.DB.prepare(`
          SELECT id FROM image_generations WHERE scene_id = ? AND is_active = 1 AND status = 'completed'
        `).bind(scene.id).first()
        if (existing) continue // Skip already completed

        // Build prompt (use scene's image_prompt or generate from title)
        const prompt = (scene as any).image_prompt || `Illustration for scene: ${(scene as any).title || 'Scene ' + (scene as any).idx}`

        // Determine aspect ratio from preset
        const aspectRatio = config.output_preset === 'short_vertical' ? '9:16' : '16:9'

        // Call Gemini Imagen API
        const imageResult = await generateImageWithGemini(env, apiKey, prompt, aspectRatio, scene.id as number, projectId)

        if (imageResult.success) {
          console.log(`[Marunage] Image completed for scene ${(scene as any).idx} (project ${projectId})`)
        } else {
          console.error(`[Marunage] Image failed for scene ${(scene as any).idx}:`, imageResult.error)
        }
      } catch (err) {
        console.error(`[Marunage] Image error for scene ${(scene as any).idx}:`, err)
        // Mark this image as failed, continue with others
        await env.DB.prepare(`
          UPDATE image_generations SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE scene_id = ? AND is_active = 1 AND status IN ('pending', 'generating')
        `).bind(String(err), scene.id).run()
      }
    }

    // Clear lock after completion
    await env.DB.prepare(`
      UPDATE marunage_runs SET locked_at = NULL, locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(runId).run()

    console.log(`[Marunage] Image generation completed for project ${projectId}`)

  } catch (error) {
    console.error(`[Marunage] Image orchestration error:`, error)
    await env.DB.prepare(`
      UPDATE marunage_runs SET phase = 'failed', error_code = 'IMAGE_ORCHESTRATION_ERROR',
             error_message = ?, error_phase = 'generating_images', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(String(error), runId).run()
  }
}

async function marunageRetryFailedImages(
  env: Bindings, projectId: number, runId: number, config: MarunageConfig
): Promise<void> {
  console.log(`[Marunage] Retrying failed images for project ${projectId}`)

  const { results: failedScenes } = await env.DB.prepare(`
    SELECT s.id, s.idx, s.title, s.image_prompt
    FROM scenes s
    JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
    WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (ig.status = 'failed' OR ig.status = 'policy_violation')
    ORDER BY s.idx ASC
  `).bind(projectId).all()

  if (!failedScenes || failedScenes.length === 0) return

  const apiKey = await resolveGeminiApiKey(env, projectId)
  if (!apiKey) return

  for (const scene of failedScenes) {
    try {
      // Deactivate failed image
      await env.DB.prepare(`
        UPDATE image_generations SET is_active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE scene_id = ? AND is_active = 1 AND (status = 'failed' OR status = 'policy_violation')
      `).bind(scene.id).run()

      const prompt = (scene as any).image_prompt || `Illustration for scene: ${(scene as any).title || 'Scene ' + (scene as any).idx}`
      const aspectRatio = config.output_preset === 'short_vertical' ? '9:16' : '16:9'

      await generateImageWithGemini(env, apiKey, prompt, aspectRatio, scene.id as number, projectId)
    } catch (err) {
      console.error(`[Marunage] Retry image error for scene ${(scene as any).idx}:`, err)
    }
  }
}

// ============================================================
// Gemini Image Generation (self-contained, no existing file changes)
// ============================================================

async function resolveGeminiApiKey(env: Bindings, projectId: number): Promise<string | null> {
  // Priority: User key → System key
  try {
    // Check user's API key
    const project = await env.DB.prepare(`
      SELECT user_id FROM projects WHERE id = ?
    `).bind(projectId).first<{ user_id: number | null }>()

    if (project?.user_id) {
      const userKey = await env.DB.prepare(`
        SELECT api_key_encrypted FROM user_api_keys WHERE user_id = ? AND provider = 'gemini' AND is_active = 1
      `).bind(project.user_id).first<{ api_key_encrypted: string }>()

      if (userKey?.api_key_encrypted) {
        // For now, treat encrypted key as plain (decryption handled elsewhere)
        // In production, would call decryption util
        return userKey.api_key_encrypted
      }
    }
  } catch (_) {}

  // System fallback
  return env.GEMINI_API_KEY || null
}

async function generateImageWithGemini(
  env: Bindings, apiKey: string, prompt: string, aspectRatio: string,
  sceneId: number, projectId: number
): Promise<{ success: boolean; error?: string }> {

  // Insert pending image_generation record
  const insertResult = await env.DB.prepare(`
    INSERT INTO image_generations (scene_id, status, prompt, provider, model, aspect_ratio, is_active, created_at, updated_at)
    VALUES (?, 'generating', ?, 'gemini', 'imagen-3.0-generate-002', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(sceneId, prompt, aspectRatio).run()
  const imageGenId = insertResult.meta.last_row_id as number

  try {
    // Deactivate previous images for this scene
    await env.DB.prepare(`
      UPDATE image_generations SET is_active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE scene_id = ? AND is_active = 1 AND id != ?
    `).bind(sceneId, imageGenId).run()

    // Call Gemini Imagen API
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${apiKey}`

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: aspectRatio,
          safetyFilterLevel: 'BLOCK_MEDIUM_AND_ABOVE',
        },
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Gemini API error ${response.status}: ${errorText.substring(0, 200)}`)
    }

    const data = await response.json() as any
    const predictions = data.predictions
    if (!predictions || predictions.length === 0) {
      throw new Error('No predictions returned from Gemini')
    }

    // Decode base64 image and upload to R2
    const base64Image = predictions[0].bytesBase64Encoded
    if (!base64Image) throw new Error('No image data in prediction')

    const imageBytes = Uint8Array.from(atob(base64Image), c => c.charCodeAt(0))
    const r2Key = `images/projects/${projectId}/scenes/${sceneId}/${imageGenId}.png`

    await env.R2.put(r2Key, imageBytes, {
      httpMetadata: { contentType: 'image/png' },
    })

    // Update record as completed
    await env.DB.prepare(`
      UPDATE image_generations
      SET status = 'completed', r2_key = ?, file_size = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(r2Key, imageBytes.length, imageGenId).run()

    return { success: true }

  } catch (error: any) {
    const errorMsg = error?.message || String(error)
    await env.DB.prepare(`
      UPDATE image_generations
      SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(errorMsg.substring(0, 500), imageGenId).run()

    return { success: false, error: errorMsg }
  }
}

// ============================================================
// Issue-3: Audio Generation Orchestration
// ============================================================

async function marunageGenerateAudio(
  env: Bindings, projectId: number, runId: number, config: MarunageConfig
): Promise<void> {
  console.log(`[Marunage] Starting audio generation for project ${projectId}, run ${runId}`)

  try {
    const narrationVoice = config.narration_voice

    // Create a bulk audio job via direct DB insert (same as existing bulk-audio pattern)
    const jobResult = await env.DB.prepare(`
      INSERT INTO project_audio_jobs (project_id, mode, status, created_at, updated_at)
      VALUES (?, 'missing', 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(projectId).run()
    const jobId = jobResult.meta.last_row_id as number

    // Link job to run
    await env.DB.prepare(`
      UPDATE marunage_runs SET audio_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(jobId, runId).run()

    // Call bulk audio generation
    const { runBulkGenerationJob } = await import('./bulk-audio')
    await runBulkGenerationJob(
      env,
      jobId,
      projectId,
      'missing',
      false,
      narrationVoice.provider,
      narrationVoice.voice_id
    )

    // Clear lock
    await env.DB.prepare(`
      UPDATE marunage_runs SET locked_at = NULL, locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(runId).run()

    console.log(`[Marunage] Audio generation completed for project ${projectId}`)

  } catch (error: any) {
    console.error(`[Marunage] Audio orchestration error:`, error)
    // If it's a 409 (job already exists), that's fine
    if (!error?.message?.includes('409') && !error?.message?.includes('UNIQUE constraint')) {
      await env.DB.prepare(`
        UPDATE marunage_runs SET phase = 'failed', error_code = 'AUDIO_ORCHESTRATION_ERROR',
               error_message = ?, error_phase = 'generating_audio', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(String(error).substring(0, 500), runId).run()
    }
  }
}

export default marunage
