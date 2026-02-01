-- Migration: 0044_create_audit_logs
-- Description: 監査ログテーブル（運用インシデント追跡用）
-- Date: 2026-02-01

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 操作者情報
  user_id INTEGER,                          -- 操作者のユーザーID（NULLは匿名/システム）
  user_role TEXT,                           -- 操作時のロール（admin, superadmin等）
  -- 操作対象
  entity_type TEXT NOT NULL,                -- 'scene', 'audio', 'project' など
  entity_id INTEGER NOT NULL,               -- 対象エンティティのID
  project_id INTEGER,                       -- 関連プロジェクトID（あれば）
  -- 操作内容
  action TEXT NOT NULL,                     -- 'hide', 'restore', 'force_delete' など
  details TEXT,                             -- JSON形式の詳細情報
  -- タイムスタンプ
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_project ON audit_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
