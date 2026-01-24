/**
 * cleanup-stuck-builds.ts
 * 
 * 目的: stuck build を検知して status 更新 + 監査ログ
 * ポイント: idempotent / lock-first / 監査ログ / 例外で落ちない
 * 
 * 使用箇所:
 *   - webapp-cron Worker (scheduled)
 *   - admin.ts HTTPエンドポイント (手動実行)
 */

export type CleanupResult = {
  checked: number;
  marked_stuck: number;
  skipped: number;
  timestamp: string;
};

const DEFAULT_STUCK_MINUTES = 30;

// 対象ステータス（これらが一定時間更新されていない場合に stuck 判定）
const TARGET_STATUSES = ['submitted', 'queued', 'rendering', 'uploading', 'validating'];

/**
 * D1ロック取得（二重実行防止）
 */
export async function acquireCronLock(
  DB: D1Database,
  key: string,
  ttlSeconds: number
): Promise<boolean> {
  try {
    // locked_until が過去なら奪取可能、INSERT or UPDATE
    const res = await DB.prepare(`
      INSERT INTO cron_locks (key, locked_until, updated_at)
      VALUES (?, datetime('now', '+' || ? || ' seconds'), CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        locked_until = datetime('now', '+' || excluded.locked_until || ' seconds'),
        updated_at = CURRENT_TIMESTAMP
      WHERE cron_locks.locked_until < datetime('now')
    `).bind(key, ttlSeconds).run();

    return (res.meta.changes ?? 0) > 0;
  } catch (e) {
    // cron_locksテーブルが存在しない場合はロックなしで実行
    console.warn('[cron] cron_locks table may not exist, proceeding without lock:', e);
    return true;
  }
}

/**
 * Stuck builds cleanup 本体
 * 
 * - idempotent: 同じビルドを何度処理しても同じ結果
 * - lock-first: UPDATE時にstatus条件を再確認
 */
export async function runCleanupStuckBuilds(
  DB: D1Database,
  opts?: { stuckMinutes?: number }
): Promise<CleanupResult> {
  const stuckMinutes = opts?.stuckMinutes ?? DEFAULT_STUCK_MINUTES;
  const timestamp = new Date().toISOString();

  // 対象: TARGET_STATUSES で一定時間更新なし
  const placeholders = TARGET_STATUSES.map(() => '?').join(', ');

  const { results } = await DB.prepare(
    `
    SELECT id, project_id, owner_user_id, status, updated_at, created_at
    FROM video_builds
    WHERE status IN (${placeholders})
      AND updated_at < datetime('now', '-' || ? || ' minutes')
    ORDER BY updated_at ASC
    LIMIT 200
    `
  ).bind(...TARGET_STATUSES, String(stuckMinutes)).all<{
    id: number;
    project_id: number;
    owner_user_id: number | null;
    status: string;
    updated_at: string;
    created_at: string;
  }>();

  const rows = results ?? [];
  let marked = 0;

  for (const b of rows) {
    // lock-first: 対象statusの時だけ更新（race condition対策）
    const r = await DB.prepare(
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
    ).bind(String(stuckMinutes), b.id, ...TARGET_STATUSES).run();

    if ((r.meta.changes ?? 0) === 1) {
      console.log(`[cron] Marked build ${b.id} as stuck (was: ${b.status}, created: ${b.created_at})`);
      marked++;
    }
  }

  // 監査ログ（api_usage_logs）
  // user_id は cron なので NULL（system user 扱い）
  try {
    await DB.prepare(
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
    ).run();
  } catch (e) {
    // 監査ログ失敗は致命にしない（Cron継続優先）
    console.warn('[cron] failed to write api_usage_logs', e);
  }

  console.log(`[cron] Cleanup complete: checked=${rows.length}, marked_stuck=${marked}, skipped=${rows.length - marked}`);

  return {
    checked: rows.length,
    marked_stuck: marked,
    skipped: rows.length - marked,
    timestamp,
  };
}
