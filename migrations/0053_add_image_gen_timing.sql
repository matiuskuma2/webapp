-- 0053: Add timing/observability columns to image_generations
-- Purpose: Track where time is spent (Gemini API, R2 upload, total)
-- to diagnose "slow image generation" issues

ALTER TABLE image_generations ADD COLUMN started_at DATETIME;
ALTER TABLE image_generations ADD COLUMN ended_at DATETIME;
ALTER TABLE image_generations ADD COLUMN duration_ms INTEGER;
ALTER TABLE image_generations ADD COLUMN gemini_duration_ms INTEGER;
ALTER TABLE image_generations ADD COLUMN r2_duration_ms INTEGER;
ALTER TABLE image_generations ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;

-- Index for stale detection queries (status + created_at is already common)
CREATE INDEX IF NOT EXISTS idx_image_generations_status_started
  ON image_generations(status, started_at);
