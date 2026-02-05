-- Migration: 0049_create_project_audio_jobs
-- Purpose: SSOT for bulk audio generation jobs
-- 
-- This table tracks the state of bulk audio generation jobs per project.
-- It prevents concurrent jobs, tracks progress, and enables recovery from failures.
--
-- SSOT Rules:
-- - One job per project at a time (enforced by status check, not unique constraint)
-- - Job owns the generation progress until completed/failed/canceled
-- - UI reads status, never writes directly to audio_generations

CREATE TABLE IF NOT EXISTS project_audio_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  
  -- Job configuration (snapshot at job creation)
  mode TEXT NOT NULL CHECK (mode IN ('missing', 'pending', 'all')),
  force_regenerate INTEGER NOT NULL DEFAULT 0,
  narration_provider TEXT DEFAULT 'google',
  narration_voice_id TEXT DEFAULT 'ja-JP-Neural2-B',
  
  -- Job lifecycle status
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'canceled')),
  
  -- Progress tracking
  total_utterances INTEGER NOT NULL DEFAULT 0,
  processed_utterances INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  
  -- Error tracking
  last_error TEXT,
  error_details_json TEXT,  -- Array of { utterance_id, error_message }
  
  -- Concurrency control
  locked_until DATETIME,  -- For stuck job recovery
  
  -- Audit
  started_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_project_audio_jobs_project_status 
  ON project_audio_jobs(project_id, status);

CREATE INDEX IF NOT EXISTS idx_project_audio_jobs_status_locked 
  ON project_audio_jobs(status, locked_until);

-- Comments for SSOT documentation
-- status transitions:
-- queued -> running (job picked up)
-- running -> completed (all done)
-- running -> failed (critical error or all utterances failed)
-- running -> canceled (user cancellation)
-- queued/running -> (auto-fail if locked_until passed and status still not terminal)
