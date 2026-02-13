-- Migration: 0054_add_video_build_id_to_marunage_runs
-- ============================================================
-- Purpose:
--   Add video_build_id column to marunage_runs table.
--   This links a run to its video build WITHOUT changing the
--   existing phase CHECK constraint.
--
-- Design decision (P1 scope):
--   - CHECK constraint on phase is preserved (P2 will modify it)
--   - Phase remains: init, formatting, awaiting_ready,
--     generating_images, generating_audio, ready, failed, canceled
--   - Video progress is tracked via video_builds table lookup
--     while phase stays 'ready'
--   - building_video / video_ready phases deferred to P2
--
-- Safety:
--   - ADD COLUMN only — no table recreation needed
--   - Existing data is fully preserved
--   - No impact on CHECK constraint or existing indexes
--
-- Ref: docs/16_MARUNAGE_VIDEO_BUILD_SSOT.md
-- Created: 2026-02-13
-- ============================================================

-- Add video_build_id column (nullable, links to video_builds)
ALTER TABLE marunage_runs ADD COLUMN video_build_id INTEGER NULL;

-- Index for looking up runs by video build
CREATE INDEX IF NOT EXISTS idx_marunage_runs_video_build_id
  ON marunage_runs(video_build_id);
