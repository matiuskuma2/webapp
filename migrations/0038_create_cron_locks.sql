-- 0038: cron_locks - scheduled job lock (二重実行防止)
CREATE TABLE IF NOT EXISTS cron_locks (
  key TEXT PRIMARY KEY,
  locked_until DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cron_locks_locked_until ON cron_locks(locked_until);
