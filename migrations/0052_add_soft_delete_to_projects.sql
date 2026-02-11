-- Migration: 0052_add_soft_delete_to_projects
-- Description: プロジェクトのソフトデリート（論理削除）対応
-- 
-- 背景:
--   ハードデリートは30以上の子テーブルへのカスケード削除を伴い、
--   キャラクターモデル、BGM、効果音などプロジェクト横断リソースへの
--   予期しない影響が発生するリスクがある。
--   また、監査ログ（audit_logs）も削除されインシデント追跡ができなくなる。
--
-- 方針:
--   is_deleted フラグ + deleted_at タイムスタンプによるソフトデリート。
--   削除時は UPDATE のみ、子テーブルのデータは一切触れない。
--   一覧取得時に WHERE is_deleted = 0 でフィルタリング。
--
-- Date: 2026-02-11

-- Step 1: is_deleted カラム追加（デフォルト0 = 未削除）
ALTER TABLE projects ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;

-- Step 2: deleted_at カラム追加（削除日時、NULL = 未削除）
ALTER TABLE projects ADD COLUMN deleted_at DATETIME;

-- Step 3: 一覧取得の高速化用インデックス
-- is_deleted = 0 のプロジェクトのみを効率的に取得する部分インデックス
CREATE INDEX IF NOT EXISTS idx_projects_not_deleted
  ON projects(is_deleted, created_at DESC)
  WHERE is_deleted = 0;
