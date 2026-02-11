-- Migration: 0050_create_marunage_runs
-- ============================================================
-- MARUNAGE Chat (MVP) - Pipeline Orchestration SSOT
-- - Existing services must NOT be affected.
-- - SSOT for "marunage pipeline" lives ONLY in marunage_runs.
-- - Do NOT extend projects.status (CHECK constraint / widespread dependencies).
-- ============================================================
-- Created: 2026-02-11
-- Ref: docs/MARUNAGE_CHAT_MVP_PLAN_v3.md §2-3

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS marunage_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Project association
  project_id INTEGER NOT NULL,
  
  -- SSOT phase (MVP)
  phase TEXT NOT NULL DEFAULT 'init'
    CHECK (phase IN (
      'init',              -- created run, text saved, settings snapshotted
      'formatting',        -- formatting running
      'awaiting_ready',    -- formatted, waiting for 5-scene normalization + utterances
      'generating_images', -- image generation running (batch)
      'generating_audio',  -- bulk audio job running
      'ready',             -- MVP complete (images + audio ready)
      'failed',            -- terminal error
      'canceled'           -- terminal user/admin cancellation
    )),

  -- Configuration snapshot frozen at start
  -- {
  --   "experience_tag": "marunage_chat_v1",
  --   "target_scene_count": 5,
  --   "split_mode": "ai",
  --   "output_preset": "yt_long",
  --   "narration_voice": { "provider": "google", "voice_id": "ja-JP-Neural2-B" },
  --   "bgm_mode": "none"
  -- }
  config_json TEXT NOT NULL DEFAULT '{}',

  -- Execution context / audit
  started_by_user_id INTEGER NULL,
  started_from TEXT NULL,  -- 'ui' | 'api' | 'admin'

  -- Error tracking
  error_code TEXT NULL,
  error_message TEXT NULL,
  error_phase TEXT NULL,

  retry_count INTEGER NOT NULL DEFAULT 0,

  -- Link to bulk audio job
  audio_job_id INTEGER NULL,

  -- Optimistic locking
  locked_at DATETIME NULL,
  locked_until DATETIME NULL,

  -- Timestamps
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (started_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (audio_job_id) REFERENCES project_audio_jobs(id) ON DELETE SET NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_marunage_runs_project_id
  ON marunage_runs(project_id);

CREATE INDEX IF NOT EXISTS idx_marunage_runs_phase
  ON marunage_runs(phase);

CREATE INDEX IF NOT EXISTS idx_marunage_runs_updated_at
  ON marunage_runs(updated_at);

-- Critical: Only ONE active run per project
-- Active = not in terminal phases (ready, failed, canceled)
CREATE UNIQUE INDEX IF NOT EXISTS uq_marunage_runs_one_active_per_project
  ON marunage_runs(project_id)
  WHERE phase NOT IN ('ready', 'failed', 'canceled');
