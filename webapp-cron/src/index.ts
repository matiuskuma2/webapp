/**
 * webapp-cron - Cloudflare Workers Cron Job
 * 
 * スケジュール:
 *   - 動画ファイル30日自動削除: 毎日 UTC 19:00 (JST 04:00)
 *   - Stuck builds cleanup: 5分ごと
 */

export interface Env {
  DB: D1Database
  R2: R2Bucket
}

// ===================================
// 定数
// ===================================
const DEFAULT_RETENTION_DAYS = 30
const BATCH_SIZE = 500
const DEFAULT_STUCK_MINUTES = 30
const TARGET_STATUSES = ['submitted', 'queued', 'rendering', 'uploading', 'validating']

// ===================================
// Types
// ===================================
interface VideoCleanupResult {
  success: boolean
  deleted: number
  total_found: number
  r2_errors: number
  retention_days: number
  cutoff_date: string
  error?: string
}

interface StuckCleanupResult {
  success: boolean
  checked: number
  marked_stuck: number
  skipped: number
  timestamp: string
  error?: string
}

// ===================================
// D1ロック（二重実行防止）
// ===================================
async function acquireCronLock(
  DB: D1Database,
  key: string,
  ttlSeconds: number
): Promise<boolean> {
  try {
    const res = await DB.prepare(`
      INSERT INTO cron_locks (key, locked_until, updated_at)
      VALUES (?, datetime('now', '+' || ? || ' seconds'), CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        locked_until = datetime('now', '+' || ? || ' seconds'),
        updated_at = CURRENT_TIMESTAMP
      WHERE cron_locks.locked_until < datetime('now')
    `).bind(key, ttlSeconds, ttlSeconds).run()

    return (res.meta.changes ?? 0) > 0
  } catch (e) {
    // cron_locksテーブルが存在しない場合はロックなしで実行
    console.warn('[cron] cron_locks table may not exist, proceeding without lock:', e)
    return true
  }
}

// ===================================
// Stuck Builds Cleanup
// ===================================
async function performStuckBuildCleanup(
  db: D1Database,
  stuckMinutes: number = DEFAULT_STUCK_MINUTES
): Promise<StuckCleanupResult> {
  const timestamp = new Date().toISOString()

  try {
    const placeholders = TARGET_STATUSES.map(() => '?').join(', ')

    const { results } = await db.prepare(
      `
      SELECT id, project_id, owner_user_id, status, updated_at, created_at
      FROM video_builds
      WHERE status IN (${placeholders})
        AND updated_at < datetime('now', '-' || ? || ' minutes')
      ORDER BY updated_at ASC
      LIMIT 200
      `
    ).bind(...TARGET_STATUSES, String(stuckMinutes)).all<{
      id: number
      project_id: number
      owner_user_id: number | null
      status: string
      updated_at: string
      created_at: string
    }>()

    const rows = results ?? []
    let marked = 0

    for (const b of rows) {
      const r = await db.prepare(
        `
        UPDATE video_builds
        SET status = 'failed',
            error_code = 'TIMEOUT_STUCK',
            error_message = 'Cron: ジョブが' || ? || '分以上更新されないため失敗扱い (was: ' || status || ')',
            progress_stage = 'Stuck',
            progress_message = 'Automatic cancellation by cron',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status IN (${placeholders})
        `
      ).bind(String(stuckMinutes), b.id, ...TARGET_STATUSES).run()

      if ((r.meta.changes ?? 0) === 1) {
        console.log(`[cron] Marked build ${b.id} as stuck (was: ${b.status}, created: ${b.created_at})`)
        marked++
      }
    }

    // 監査ログ
    try {
      await db.prepare(
        `
        INSERT INTO api_usage_logs (
          user_id, project_id, api_type, provider, model,
          input_tokens, output_tokens, duration_seconds, estimated_cost_usd,
          metadata_json, created_at
        ) VALUES (
          NULL, NULL,
          'cron_cleanup_stuck_builds', 'internal', 'cron',
          0, 0, 0, 0,
          ?, CURRENT_TIMESTAMP
        )
        `
      ).bind(
        JSON.stringify({
          stuck_minutes: stuckMinutes,
          checked: rows.length,
          marked_stuck: marked,
          target_statuses: TARGET_STATUSES,
          timestamp,
        })
      ).run()
    } catch (e) {
      console.warn('[cron] failed to write api_usage_logs', e)
    }

    console.log(`[cron] Stuck cleanup complete: checked=${rows.length}, marked=${marked}`)

    return {
      success: true,
      checked: rows.length,
      marked_stuck: marked,
      skipped: rows.length - marked,
      timestamp,
    }
  } catch (error) {
    console.error('[cron] Stuck build cleanup error:', error)
    return {
      success: false,
      checked: 0,
      marked_stuck: 0,
      skipped: 0,
      timestamp,
      error: error instanceof Error ? error.message : 'Stuck build cleanup failed'
    }
  }
}

// ===================================
// 動画クリーンアップ処理（既存）
// ===================================
async function performVideoCleanup(db: D1Database, r2: R2Bucket): Promise<VideoCleanupResult> {
  try {
    let retentionDays = DEFAULT_RETENTION_DAYS
    try {
      const settingResult = await db.prepare(`
        SELECT value FROM system_settings WHERE key = 'video_retention_days'
      `).first()
      
      if (settingResult?.value) {
        retentionDays = parseInt(settingResult.value as string, 10) || DEFAULT_RETENTION_DAYS
      }
    } catch (e) {
      console.warn('[Cron] Could not fetch video_retention_days, using default:', DEFAULT_RETENTION_DAYS)
    }
    
    console.log(`[Cron] Retention period: ${retentionDays} days`)
    
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
    const cutoffDateStr = cutoffDate.toISOString()
    
    console.log(`[Cron] Cutoff date: ${cutoffDateStr}`)
    
    const expiredVideos = await db.prepare(`
      SELECT id, r2_key, scene_id, user_id, created_at
      FROM video_generations
      WHERE created_at < ?
      ORDER BY created_at ASC
      LIMIT ?
    `).bind(cutoffDateStr, BATCH_SIZE).all()
    
    const videos = expiredVideos.results || []
    console.log(`[Cron] Found ${videos.length} expired videos`)
    
    if (videos.length === 0) {
      return {
        success: true,
        deleted: 0,
        total_found: 0,
        r2_errors: 0,
        retention_days: retentionDays,
        cutoff_date: cutoffDateStr
      }
    }
    
    let deletedCount = 0
    let r2Errors = 0
    
    for (const video of videos) {
      try {
        if (video.r2_key) {
          try {
            await r2.delete(video.r2_key as string)
            console.log(`[Cron] Deleted R2 object: ${video.r2_key}`)
          } catch (r2Error) {
            console.warn(`[Cron] R2 deletion failed for ${video.r2_key}:`, r2Error)
            r2Errors++
          }
        }
        
        await db.prepare(`
          DELETE FROM video_generations WHERE id = ?
        `).bind(video.id).run()
        
        deletedCount++
        console.log(`[Cron] Deleted video ${video.id} (scene_id: ${video.scene_id})`)
        
      } catch (dbError) {
        console.error(`[Cron] Failed to delete video ${video.id}:`, dbError)
      }
    }
    
    console.log(`[Cron] Video cleanup completed: ${deletedCount}/${videos.length} deleted, ${r2Errors} R2 errors`)
    
    return {
      success: true,
      deleted: deletedCount,
      total_found: videos.length,
      r2_errors: r2Errors,
      retention_days: retentionDays,
      cutoff_date: cutoffDateStr
    }
    
  } catch (error) {
    console.error('[Cron] Video cleanup error:', error)
    return {
      success: false,
      deleted: 0,
      total_found: 0,
      r2_errors: 0,
      retention_days: DEFAULT_RETENTION_DAYS,
      cutoff_date: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Video cleanup failed'
    }
  }
}

// ===================================
// Cloudflare Workers Cron Trigger Handler
// ===================================
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[Cron] Triggered at ${new Date().toISOString()}, cron: ${event.cron}`)
    
    // Cron式に基づいて処理を分岐
    // */5 * * * * = 5分ごと（Stuck builds）
    // 0 19 * * * = 毎日 UTC 19:00（Video cleanup）
    
    if (event.cron === '*/5 * * * *') {
      // Stuck builds cleanup
      const lockAcquired = await acquireCronLock(env.DB, 'cleanup-stuck-builds', 240) // 4分ロック
      if (!lockAcquired) {
        console.log('[Cron] Could not acquire lock for stuck builds cleanup, skipping')
        return
      }
      
      const result = await performStuckBuildCleanup(env.DB)
      console.log('[Cron] Stuck builds result:', JSON.stringify(result))
      
    } else if (event.cron === '0 19 * * *') {
      // Video cleanup
      const lockAcquired = await acquireCronLock(env.DB, 'video-cleanup', 3600) // 1時間ロック
      if (!lockAcquired) {
        console.log('[Cron] Could not acquire lock for video cleanup, skipping')
        return
      }
      
      const result = await performVideoCleanup(env.DB, env.R2)
      console.log('[Cron] Video cleanup result:', JSON.stringify(result))
      
      if (!result.success) {
        console.error('[Cron] Video cleanup failed:', result.error)
      }
    } else {
      // 未知のcron式の場合は両方実行
      console.log('[Cron] Unknown cron expression, running stuck builds cleanup')
      const result = await performStuckBuildCleanup(env.DB)
      console.log('[Cron] Result:', JSON.stringify(result))
    }
  },
  
  // HTTP リクエストハンドラ（手動トリガー・テスト用）
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    
    // ヘルスチェック
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'webapp-cron',
        schedules: [
          '*/5 * * * * (Stuck builds cleanup)',
          '0 19 * * * (Video cleanup, UTC 19:00 = JST 04:00)'
        ],
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    // 手動トリガー - Stuck builds
    if (url.pathname === '/trigger/stuck-builds' && request.method === 'POST') {
      console.log('[Cron] Manual trigger: stuck builds cleanup')
      const result = await performStuckBuildCleanup(env.DB)
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    // 手動トリガー - Video cleanup
    if (url.pathname === '/trigger/video-cleanup' && request.method === 'POST') {
      console.log('[Cron] Manual trigger: video cleanup')
      const result = await performVideoCleanup(env.DB, env.R2)
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    // 後方互換（旧: /trigger）
    if (url.pathname === '/trigger' && request.method === 'POST') {
      console.log('[Cron] Manual trigger via HTTP (legacy)')
      const result = await performVideoCleanup(env.DB, env.R2)
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    // ステータス確認
    if (url.pathname === '/status') {
      try {
        const statsResult = await env.DB.prepare(`
          SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN created_at < datetime('now', '-30 days') THEN 1 ELSE 0 END) as expired
          FROM video_generations
        `).first()
        
        const stuckResult = await env.DB.prepare(`
          SELECT COUNT(*) as stuck_count
          FROM video_builds
          WHERE status IN ('submitted', 'queued', 'rendering', 'uploading', 'validating')
            AND updated_at < datetime('now', '-30 minutes')
        `).first()
        
        let retentionDays = DEFAULT_RETENTION_DAYS
        try {
          const settingResult = await env.DB.prepare(`
            SELECT value FROM system_settings WHERE key = 'video_retention_days'
          `).first()
          
          if (settingResult?.value) {
            retentionDays = parseInt(settingResult.value as string, 10) || DEFAULT_RETENTION_DAYS
          }
        } catch (e) {
          // 無視
        }
        
        return new Response(JSON.stringify({
          status: 'ok',
          service: 'webapp-cron',
          schedules: [
            '*/5 * * * * (Stuck builds cleanup)',
            '0 19 * * * (Video cleanup, UTC 19:00 = JST 04:00)'
          ],
          retention_days: retentionDays,
          videos: {
            total: statsResult?.total || 0,
            expired: statsResult?.expired || 0
          },
          stuck_builds: stuckResult?.stuck_count || 0,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        })
      } catch (error) {
        return new Response(JSON.stringify({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        })
      }
    }
    
    return new Response('Not Found', { status: 404 })
  }
}
