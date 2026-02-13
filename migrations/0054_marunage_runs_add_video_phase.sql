-- Migration: 0054_marunage_runs_add_video_phase
-- ============================================================
-- Purpose:
--   1. Remove hard CHECK constraint on phase column
--      (move to application-level validation in types/marunage.ts)
--   2. Add video_build_id column (FK → video_builds)
--   3. Add building_video, video_ready to allowed phases
-- 
-- Why table recreation:
--   SQLite does not support ALTER TABLE ... DROP CHECK.
--   Must recreate table to modify CHECK constraint.
--
-- Safety:
--   - Data is preserved via INSERT ... SELECT
--   - Indexes and unique constraints are recreated
--   - Foreign keys are preserved
--   - Phase validation moves to ALLOWED_TRANSITIONS in types/marunage.ts
--
-- Ref: docs/15_PHASE_LOCK_PRESERVE_SPEC.md §8
-- Created: 2026-02-13
-- ============================================================

PRAGMA foreign_keys = OFF;

-- Step 1: Create new table WITHOUT CHECK constraint on phase
CREATE TABLE marunage_runs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,

  -- Phase: no CHECK constraint — validated by application layer (types/marunage.ts)
  -- Valid values: init, formatting, awaiting_ready, generating_images,
  --              generating_audio, building_video, video_ready,
  --              ready, failed, canceled
  phase TEXT NOT NULL DEFAULT 'init',

  config_json TEXT NOT NULL DEFAULT '{}',
  started_by_user_id INTEGER NULL,
  started_from TEXT NULL,

  error_code TEXT NULL,
  error_message TEXT NULL,
  error_phase TEXT NULL,

  retry_count INTEGER NOT NULL DEFAULT 0,

  audio_job_id INTEGER NULL,

  -- NEW: Link to video build (added in 0054)
  video_build_id INTEGER NULL,

  locked_at DATETIME NULL,
  locked_until DATETIME NULL,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (started_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (audio_job_id) REFERENCES project_audio_jobs(id) ON DELETE SET NULL,
  FOREIGN KEY (video_build_id) REFERENCES video_builds(id) ON DELETE SET NULL
);

-- Step 2: Copy all existing data
INSERT INTO marunage_runs_new (
  id, project_id, phase, config_json,
  started_by_user_id, started_from,
  error_code, error_message, error_phase,
  retry_count, audio_job_id, video_build_id,
  locked_at, locked_until,
  created_at, updated_at, completed_at
)
SELECT
  id, project_id, phase, config_json,
  started_by_user_id, started_from,
  error_code, error_message, error_phase,
  retry_count, audio_job_id, NULL,
  locked_at, locked_until,
  created_at, updated_at, completed_at
FROM marunage_runs;

-- Step 3: Drop old table
DROP TABLE marunage_runs;

-- Step 4: Rename new table
ALTER TABLE marunage_runs_new RENAME TO marunage_runs;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_marunage_runs_project_id
  ON marunage_runs(project_id);

CREATE INDEX IF NOT EXISTS idx_marunage_runs_phase
  ON marunage_runs(phase);

CREATE INDEX IF NOT EXISTS idx_marunage_runs_updated_at
  ON marunage_runs(updated_at);

CREATE INDEX IF NOT EXISTS idx_marunage_runs_video_build_id
  ON marunage_runs(video_build_id);

-- Critical: Only ONE active run per project
-- Active = not in terminal phases (ready, video_ready, failed, canceled)
CREATE UNIQUE INDEX IF NOT EXISTS uq_marunage_runs_one_active_per_project
  ON marunage_runs(project_id)
  WHERE phase NOT IN ('ready', 'video_ready', 'failed', 'canceled');

PRAGMA foreign_keys = ON;
