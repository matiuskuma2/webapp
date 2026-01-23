-- ============================================================
-- R4: video_builds にパッチ関連列を追加
-- ============================================================
-- 目的:
--   1. パッチ適用で生成されたビルドを追跡可能にする
--   2. 派生元ビルドを記録してロールバック・比較を可能にする
-- ============================================================

-- 派生元ビルドID（パッチ適用で派生した場合）
-- 既存ビルドには影響なし（NULLデフォルト）
ALTER TABLE video_builds ADD COLUMN source_video_build_id INTEGER NULL;

-- パッチリクエストID（パッチ適用で生成された場合）
-- 既存ビルドには影響なし（NULLデフォルト）
ALTER TABLE video_builds ADD COLUMN patch_request_id INTEGER NULL;

-- インデックス（パッチ適用ビルドの検索用）
CREATE INDEX IF NOT EXISTS idx_video_builds_source_build 
ON video_builds(source_video_build_id) WHERE source_video_build_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_video_builds_patch_request 
ON video_builds(patch_request_id) WHERE patch_request_id IS NOT NULL;
