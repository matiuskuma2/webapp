-- 0034: video_builds にレンダーコストログ済みフラグを追加
-- Safe Chat v1: video_build_render の二重計上防止用

ALTER TABLE video_builds
ADD COLUMN render_usage_logged INTEGER NOT NULL DEFAULT 0;

-- 完了済みだがログ未記録のビルドを高速に検索するためのインデックス
CREATE INDEX IF NOT EXISTS idx_video_builds_render_usage_logged
ON video_builds(render_usage_logged);

-- 複合条件での検索用（status=completed AND render_usage_logged=0）
CREATE INDEX IF NOT EXISTS idx_video_builds_completed_not_logged
ON video_builds(status, render_usage_logged)
WHERE status = 'completed' AND render_usage_logged = 0;
