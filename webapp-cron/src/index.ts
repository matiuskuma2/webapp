/**
 * webapp-cron - Cloudflare Workers Cron Job
 * 
 * 動画ファイルの30日自動削除を実行
 * スケジュール: 毎日 UTC 19:00 (JST 04:00)
 */

export interface Env {
  DB: D1Database
  R2: R2Bucket
}

// 定数
const DEFAULT_RETENTION_DAYS = 30
const BATCH_SIZE = 500

interface CleanupResult {
  success: boolean
  deleted: number
  total_found: number
  r2_errors: number
  retention_days: number
  cutoff_date: string
  error?: string
}

/**
 * 動画クリーンアップ処理
 */
async function performVideoCleanup(db: D1Database, r2: R2Bucket): Promise<CleanupResult> {
  try {
    // system_settings から保持期間を取得
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
    
    // カットオフ日を計算
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
    const cutoffDateStr = cutoffDate.toISOString()
    
    console.log(`[Cron] Cutoff date: ${cutoffDateStr}`)
    
    // 期限切れ動画を検索
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
    
    // 動画を削除 (R2 + DB)
    let deletedCount = 0
    let r2Errors = 0
    
    for (const video of videos) {
      try {
        // R2 からベストエフォートで削除
        if (video.r2_key) {
          try {
            await r2.delete(video.r2_key as string)
            console.log(`[Cron] Deleted R2 object: ${video.r2_key}`)
          } catch (r2Error) {
            console.warn(`[Cron] R2 deletion failed for ${video.r2_key}:`, r2Error)
            r2Errors++
            // R2 が失敗しても DB 削除は続行
          }
        }
        
        // DB から削除
        await db.prepare(`
          DELETE FROM video_generations WHERE id = ?
        `).bind(video.id).run()
        
        deletedCount++
        console.log(`[Cron] Deleted video ${video.id} (scene_id: ${video.scene_id})`)
        
      } catch (dbError) {
        console.error(`[Cron] Failed to delete video ${video.id}:`, dbError)
        // 次の動画へ続行
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

/**
 * Cloudflare Workers Cron Trigger Handler
 */
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[Cron] Triggered at ${new Date().toISOString()}, cron: ${event.cron}`)
    
    const result = await performVideoCleanup(env.DB, env.R2)
    
    console.log('[Cron] Result:', JSON.stringify(result))
    
    if (!result.success) {
      // エラーをログに記録（Cloudflare のログで確認可能）
      console.error('[Cron] Cleanup failed:', result.error)
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
        schedule: '0 19 * * * (UTC 19:00 = JST 04:00)',
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    // 手動トリガー（POST /trigger）
    if (url.pathname === '/trigger' && request.method === 'POST') {
      console.log('[Cron] Manual trigger via HTTP')
      
      const result = await performVideoCleanup(env.DB, env.R2)
      
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    // ステータス確認
    if (url.pathname === '/status') {
      try {
        // 動画統計を取得
        const statsResult = await env.DB.prepare(`
          SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN created_at < datetime('now', '-30 days') THEN 1 ELSE 0 END) as expired
          FROM video_generations
        `).first()
        
        // 保持期間を取得
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
          schedule: '0 19 * * * (UTC 19:00 = JST 04:00)',
          retention_days: retentionDays,
          videos: {
            total: statsResult?.total || 0,
            expired: statsResult?.expired || 0
          },
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
