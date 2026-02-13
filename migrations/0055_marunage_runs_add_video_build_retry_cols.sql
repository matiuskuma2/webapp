-- Migration: 0055_marunage_runs_add_video_build_retry_cols
-- ============================================================
-- Purpose:
--   Add columns to prevent infinite video-build retries.
--   video_build_attempted_at: last attempt timestamp
--   video_build_error: short error message from last failure
--
-- Design decision (P1.5):
--   - If video_build_attempted_at is within 30 minutes AND
--     video_build_error is not null, skip re-triggering.
--   - This prevents log floods from repeated failures when
--     MARUNAGE_ENABLE_VIDEO_BUILD is ON.
--
-- Safety:
--   - ADD COLUMN only — no table recreation
--   - Existing data fully preserved
--   - No impact on CHECK constraint or existing indexes
--
-- Ref: docs/16_MARUNAGE_VIDEO_BUILD_SSOT.md
-- Created: 2026-02-13
-- ============================================================

-- Last video build attempt timestamp (set on every trigger attempt)
ALTER TABLE marunage_runs ADD COLUMN video_build_attempted_at DATETIME NULL;

-- Short error from last video build failure (cleared on success)
ALTER TABLE marunage_runs ADD COLUMN video_build_error TEXT NULL;
