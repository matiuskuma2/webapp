/**
 * Job Queue — D1-based rate-limit-aware job queue for Cloudflare Workers
 *
 * Design principle:
 *   1 HTTP request = 1 job execution (at most)
 *   429 → immediately set retry_wait, respond to frontend, let next poll retry
 *   Provider concurrency is enforced via locked_at counting in D1
 *
 * Ref: docs/RATE_LIMIT_AWARE_ARCHITECTURE_v1.md
 */

// ============================================================
// Types
// ============================================================

export type JobType =
  | 'generate_image'
  | 'format_chunk'
  | 'generate_audio'
  | 'generate_video'

export type JobProvider =
  | 'gemini_image'
  | 'openai_gpt4o'
  | 'google_tts'
  | 'fish_audio'
  | 'elevenlabs'
  | 'laozhang_veo'
  | 'laozhang_sora'

export type JobStatus =
  | 'queued'
  | 'processing'
  | 'retry_wait'
  | 'completed'
  | 'failed'
  | 'canceled'

export interface JobRow {
  id: number
  user_id: number
  project_id: number
  job_type: JobType
  provider: JobProvider
  status: JobStatus
  priority: number
  retry_count: number
  max_retries: number
  next_retry_at: string | null
  locked_at: string | null
  locked_by: string | null
  payload_json: string
  result_json: string | null
  error_code: string | null
  error_message: string | null
  entity_type: string | null
  entity_id: number | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
}

export interface CreateJobParams {
  userId: number
  projectId: number
  jobType: JobType
  provider: JobProvider
  priority?: number        // default 100
  maxRetries?: number      // default 3
  entityType?: string      // 'scene', 'text_chunk', 'utterance'
  entityId?: number
  payload: Record<string, unknown>
}

export interface JobProgress {
  total: number
  queued: number
  processing: number
  retryWait: number
  completed: number
  failed: number
}

// ============================================================
// Provider Concurrency Limits
// ============================================================

/** Max concurrent processing jobs per provider (across all users) */
export const PROVIDER_CONCURRENCY: Record<string, number> = {
  gemini_image:   2,   // Gemini free tier: 15 RPM → conservative
  openai_gpt4o:   3,   // Generous rate limits, but control for Worker CPU budget
  google_tts:     5,   // Google TTS has high rate limits
  fish_audio:     3,
  elevenlabs:     3,
  laozhang_veo:   2,
  laozhang_sora:  2,
}

/** How long (seconds) before a locked job is considered stuck */
const LOCK_TIMEOUT_SEC = 120

/** Generate a short random worker ID for this request */
function generateWorkerId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).substring(2, 8)
  return `w-${ts}-${rand}`
}

// ============================================================
// Core Operations
// ============================================================

/**
 * Create a new job in the queue.
 * If an identical pending/processing job already exists for the same entity, skip creation.
 */
export async function createJob(
  db: D1Database,
  params: CreateJobParams
): Promise<{ jobId: number; created: boolean }> {
  const {
    userId, projectId, jobType, provider,
    priority = 100, maxRetries = 3,
    entityType, entityId, payload,
  } = params

  // Dedup check: skip if same entity already has an active job
  if (entityType && entityId) {
    const existing = await db.prepare(`
      SELECT id FROM job_queue
      WHERE entity_type = ? AND entity_id = ?
        AND status IN ('queued', 'processing', 'retry_wait')
      LIMIT 1
    `).bind(entityType, entityId).first<{ id: number }>()

    if (existing) {
      return { jobId: existing.id, created: false }
    }
  }

  const result = await db.prepare(`
    INSERT INTO job_queue (
      user_id, project_id, job_type, provider,
      status, priority, max_retries,
      entity_type, entity_id, payload_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).bind(
    userId, projectId, jobType, provider,
    priority, maxRetries,
    entityType ?? null, entityId ?? null,
    JSON.stringify(payload),
  ).run()

  const jobId = result.meta.last_row_id as number
  console.log(`[JobQueue] Created job #${jobId} type=${jobType} provider=${provider} entity=${entityType}:${entityId}`)
  return { jobId, created: true }
}

/**
 * Create multiple jobs in a batch (one INSERT per job, but dedup-checked).
 * Returns count of actually created jobs.
 */
export async function createJobsBatch(
  db: D1Database,
  jobs: CreateJobParams[]
): Promise<{ created: number; skipped: number }> {
  let created = 0
  let skipped = 0
  for (const params of jobs) {
    const result = await createJob(db, params)
    if (result.created) created++
    else skipped++
  }
  console.log(`[JobQueue] Batch created=${created} skipped=${skipped}`)
  return { created, skipped }
}

/**
 * Fetch and lock the next eligible job for the given provider.
 * Returns null if no job is available or provider is at capacity.
 *
 * Steps:
 *   1. Check provider concurrency (count active processing jobs)
 *   2. Auto-recover stuck jobs (locked_at > LOCK_TIMEOUT_SEC ago)
 *   3. Find oldest queued/retry_wait-ready job
 *   4. Atomically lock it (optimistic: UPDATE WHERE status IN (...))
 */
export async function fetchAndLockJob(
  db: D1Database,
  provider: JobProvider,
  projectId?: number
): Promise<JobRow | null> {
  const workerId = generateWorkerId()
  const maxConcurrent = PROVIDER_CONCURRENCY[provider] ?? 2

  // 1. Count currently processing jobs for this provider
  const activeResult = await db.prepare(`
    SELECT COUNT(*) as cnt FROM job_queue
    WHERE provider = ? AND status = 'processing'
      AND locked_at > datetime('now', '-${LOCK_TIMEOUT_SEC} seconds')
  `).bind(provider).first<{ cnt: number }>()
  const activeCount = activeResult?.cnt ?? 0

  if (activeCount >= maxConcurrent) {
    console.log(`[JobQueue] Provider ${provider} at capacity: ${activeCount}/${maxConcurrent}`)
    return null // Caller should return 'throttled' to frontend
  }

  // 2. Auto-recover stuck jobs (processing for too long)
  const recovered = await db.prepare(`
    UPDATE job_queue
    SET status = 'queued', locked_at = NULL, locked_by = NULL,
        error_message = COALESCE(error_message, '') || ' [auto-recovered from stuck]',
        updated_at = datetime('now')
    WHERE status = 'processing'
      AND locked_at < datetime('now', '-${LOCK_TIMEOUT_SEC} seconds')
      AND provider = ?
  `).bind(provider).run()
  if ((recovered.meta.changes ?? 0) > 0) {
    console.log(`[JobQueue] Auto-recovered ${recovered.meta.changes} stuck ${provider} jobs`)
  }

  // 3. Find next eligible job
  let query: string
  let bindParams: (string | number)[]

  if (projectId) {
    // Project-scoped fetch (for advance endpoint)
    query = `
      SELECT * FROM job_queue
      WHERE provider = ? AND project_id = ? AND (
        status = 'queued' OR
        (status = 'retry_wait' AND next_retry_at <= datetime('now'))
      )
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    `
    bindParams = [provider, projectId]
  } else {
    // Global fetch (for generic worker)
    query = `
      SELECT * FROM job_queue
      WHERE provider = ? AND (
        status = 'queued' OR
        (status = 'retry_wait' AND next_retry_at <= datetime('now'))
      )
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    `
    bindParams = [provider]
  }

  const job = await db.prepare(query).bind(...bindParams).first<JobRow>()
  if (!job) return null

  // 4. Optimistic lock
  const lockResult = await db.prepare(`
    UPDATE job_queue
    SET status = 'processing', locked_at = datetime('now'), locked_by = ?,
        started_at = COALESCE(started_at, datetime('now')),
        updated_at = datetime('now')
    WHERE id = ? AND status IN ('queued', 'retry_wait')
  `).bind(workerId, job.id).run()

  if ((lockResult.meta.changes ?? 0) === 0) {
    // Another request grabbed it
    console.log(`[JobQueue] Job #${job.id} already locked by another worker`)
    return null
  }

  console.log(`[JobQueue] Locked job #${job.id} type=${job.job_type} provider=${job.provider} by ${workerId}`)
  return { ...job, status: 'processing', locked_at: new Date().toISOString(), locked_by: workerId }
}

/**
 * Mark a job as completed with optional result data.
 */
export async function completeJob(
  db: D1Database,
  jobId: number,
  resultJson?: Record<string, unknown>
): Promise<void> {
  await db.prepare(`
    UPDATE job_queue
    SET status = 'completed',
        result_json = ?,
        completed_at = datetime('now'),
        locked_at = NULL,
        locked_by = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    resultJson ? JSON.stringify(resultJson) : null,
    jobId
  ).run()
  console.log(`[JobQueue] Job #${jobId} completed`)
}

/**
 * Mark a job as failed. If retries remain, set to retry_wait instead.
 */
export async function failJob(
  db: D1Database,
  jobId: number,
  errorCode: string,
  errorMessage: string,
  retryCount: number,
  maxRetries: number
): Promise<{ finalStatus: 'failed' | 'retry_wait' }> {
  if (retryCount < maxRetries) {
    // Calculate backoff: 10s, 20s, 40s
    const backoffSec = Math.min(10 * Math.pow(2, retryCount), 120)
    await db.prepare(`
      UPDATE job_queue
      SET status = 'retry_wait',
          retry_count = retry_count + 1,
          next_retry_at = datetime('now', '+' || ? || ' seconds'),
          error_code = ?,
          error_message = ?,
          locked_at = NULL,
          locked_by = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(backoffSec, errorCode, errorMessage, jobId).run()
    console.log(`[JobQueue] Job #${jobId} → retry_wait (attempt ${retryCount + 1}/${maxRetries}, backoff=${backoffSec}s)`)
    return { finalStatus: 'retry_wait' }
  }

  await db.prepare(`
    UPDATE job_queue
    SET status = 'failed',
        error_code = ?,
        error_message = ?,
        locked_at = NULL,
        locked_by = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(errorCode, errorMessage, jobId).run()
  console.log(`[JobQueue] Job #${jobId} → failed (retries exhausted: ${retryCount}/${maxRetries})`)
  return { finalStatus: 'failed' }
}

/**
 * Handle 429 Rate Limit response:
 *   - Immediately set job to retry_wait (no in-request retry)
 *   - Record provider metric
 *   - Return the retry delay so frontend can show it
 */
export async function handleRateLimit(
  db: D1Database,
  jobId: number,
  provider: JobProvider,
  retryAfterSec?: number
): Promise<{ retryAfterSec: number }> {
  const delay = Math.min(retryAfterSec ?? 15, 60) // clamp to 60s max

  await db.prepare(`
    UPDATE job_queue
    SET status = 'retry_wait',
        retry_count = retry_count + 1,
        next_retry_at = datetime('now', '+' || ? || ' seconds'),
        error_code = 'RATE_LIMITED_429',
        error_message = 'Provider rate limit hit, waiting ' || ? || 's',
        locked_at = NULL,
        locked_by = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(delay, delay, jobId).run()

  // Record metric
  await recordProviderMetric(db, provider, 'rate_limited')

  console.log(`[JobQueue] Job #${jobId} → retry_wait (429, retry in ${delay}s)`)
  return { retryAfterSec: delay }
}

/**
 * Cancel all pending/processing jobs for a project.
 */
export async function cancelProjectJobs(
  db: D1Database,
  projectId: number,
  jobType?: JobType
): Promise<number> {
  let query = `
    UPDATE job_queue
    SET status = 'canceled', locked_at = NULL, locked_by = NULL, updated_at = datetime('now')
    WHERE project_id = ? AND status IN ('queued', 'processing', 'retry_wait')
  `
  const binds: (string | number)[] = [projectId]

  if (jobType) {
    query += ` AND job_type = ?`
    binds.push(jobType)
  }

  const result = await db.prepare(query).bind(...binds).run()
  const canceled = result.meta.changes ?? 0
  if (canceled > 0) {
    console.log(`[JobQueue] Canceled ${canceled} jobs for project ${projectId}${jobType ? ` (type=${jobType})` : ''}`)
  }
  return canceled
}

// ============================================================
// Progress Queries
// ============================================================

/**
 * Get job progress for a project + job_type combo.
 */
export async function getJobProgress(
  db: D1Database,
  projectId: number,
  jobType: JobType
): Promise<JobProgress> {
  const result = await db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
      SUM(CASE WHEN status = 'retry_wait' THEN 1 ELSE 0 END) as retry_wait,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM job_queue
    WHERE project_id = ? AND job_type = ?
  `).bind(projectId, jobType).first<{
    total: number; queued: number; processing: number;
    retry_wait: number; completed: number; failed: number
  }>()

  return {
    total: result?.total ?? 0,
    queued: result?.queued ?? 0,
    processing: result?.processing ?? 0,
    retryWait: result?.retry_wait ?? 0,
    completed: result?.completed ?? 0,
    failed: result?.failed ?? 0,
  }
}

/**
 * Check if all jobs for a project+type are in terminal state.
 */
export async function areAllJobsDone(
  db: D1Database,
  projectId: number,
  jobType: JobType
): Promise<{ allDone: boolean; hasFailures: boolean; progress: JobProgress }> {
  const progress = await getJobProgress(db, projectId, jobType)
  const active = progress.queued + progress.processing + progress.retryWait
  return {
    allDone: progress.total > 0 && active === 0,
    hasFailures: progress.failed > 0,
    progress,
  }
}

// ============================================================
// Provider Metrics
// ============================================================

type MetricType = 'success' | 'rate_limited' | 'timeout' | 'error'

/**
 * Record a provider metric for monitoring.
 * Uses UPSERT (INSERT ON CONFLICT UPDATE) for atomic counter increment.
 */
export async function recordProviderMetric(
  db: D1Database,
  provider: string,
  metric: MetricType,
  latencyMs?: number,
  model?: string
): Promise<void> {
  const now = new Date()
  const windowKey = `minute:${now.toISOString().substring(0, 16)}` // e.g. minute:2026-03-07T14:30

  const successInc = metric === 'success' ? 1 : 0
  const err429Inc = metric === 'rate_limited' ? 1 : 0
  const errTimeoutInc = metric === 'timeout' ? 1 : 0
  const errOtherInc = metric === 'error' ? 1 : 0
  const latencyInc = (metric === 'success' && latencyMs) ? latencyMs : 0

  try {
    await db.prepare(`
      INSERT INTO provider_usage (
        provider, model, window_key,
        request_count, success_count, error_429_count, error_timeout_count, error_other_count,
        total_latency_ms, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(provider, model, window_key) DO UPDATE SET
        request_count = request_count + 1,
        success_count = success_count + ?,
        error_429_count = error_429_count + ?,
        error_timeout_count = error_timeout_count + ?,
        error_other_count = error_other_count + ?,
        total_latency_ms = total_latency_ms + ?,
        updated_at = datetime('now')
    `).bind(
      provider, model ?? null, windowKey,
      successInc, err429Inc, errTimeoutInc, errOtherInc, latencyInc,
      // ON CONFLICT SET params
      successInc, err429Inc, errTimeoutInc, errOtherInc, latencyInc,
    ).run()
  } catch (e) {
    // Non-critical: don't let metrics recording break the main flow
    console.warn(`[JobQueue:Metrics] Failed to record metric for ${provider}:`, e)
  }
}

/**
 * Check if a provider's circuit breaker is open.
 */
export async function isProviderCircuitOpen(
  db: D1Database,
  provider: string
): Promise<boolean> {
  const now = new Date()
  const windowKey = `minute:${now.toISOString().substring(0, 16)}`

  const row = await db.prepare(`
    SELECT circuit_open_until FROM provider_usage
    WHERE provider = ? AND window_key = ? AND circuit_open_until > datetime('now')
    LIMIT 1
  `).bind(provider, windowKey).first<{ circuit_open_until: string }>()

  return !!row
}

/**
 * Open circuit breaker for a provider (e.g., after excessive 429s).
 */
export async function openProviderCircuit(
  db: D1Database,
  provider: string,
  durationSec: number = 30
): Promise<void> {
  const now = new Date()
  const windowKey = `minute:${now.toISOString().substring(0, 16)}`

  await db.prepare(`
    UPDATE provider_usage
    SET circuit_open_until = datetime('now', '+' || ? || ' seconds'),
        updated_at = datetime('now')
    WHERE provider = ? AND window_key = ?
  `).bind(durationSec, provider, windowKey).run()

  console.log(`[JobQueue:Circuit] Opened circuit for ${provider} for ${durationSec}s`)
}

// ============================================================
// Cleanup
// ============================================================

/**
 * Delete old completed/failed/canceled jobs (housekeeping).
 * Called periodically or from admin endpoint.
 */
export async function cleanupOldJobs(
  db: D1Database,
  olderThanDays: number = 7
): Promise<number> {
  const result = await db.prepare(`
    DELETE FROM job_queue
    WHERE status IN ('completed', 'failed', 'canceled')
      AND updated_at < datetime('now', '-' || ? || ' days')
  `).bind(olderThanDays).run()
  const deleted = result.meta.changes ?? 0
  if (deleted > 0) {
    console.log(`[JobQueue] Cleaned up ${deleted} old jobs (>${olderThanDays} days)`)
  }
  return deleted
}

/**
 * Delete old provider_usage metrics.
 */
export async function cleanupOldMetrics(
  db: D1Database,
  olderThanDays: number = 3
): Promise<number> {
  const result = await db.prepare(`
    DELETE FROM provider_usage
    WHERE updated_at < datetime('now', '-' || ? || ' days')
  `).bind(olderThanDays).run()
  return result.meta.changes ?? 0
}
