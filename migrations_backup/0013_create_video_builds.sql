-- Migration: 0013_create_video_builds
-- Description: Create video_builds table for Remotion video rendering
-- Source: D1 Production Schema (2026-01-17)

-- Table: video_builds
-- Purpose: プロジェクト全体の動画レンダリングジョブを管理
CREATE TABLE IF NOT EXISTS video_builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- User/Project relations
  project_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  executor_user_id INTEGER NOT NULL,
  is_delegation INTEGER NOT NULL DEFAULT 0,
  
  -- Status
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'validating', 'submitted', 'rendering', 'uploading', 
    'completed', 'failed', 'cancelled', 'retry_wait'
  )),

  -- Progress tracking
  progress_percent REAL DEFAULT 0,
  progress_stage TEXT,
  progress_message TEXT,

  -- Project data
  settings_json TEXT NOT NULL,
  project_json_version TEXT NOT NULL DEFAULT '1.1',
  project_json_r2_key TEXT,
  project_json_hash TEXT,

  -- AWS integration
  aws_job_id TEXT,
  aws_region TEXT NOT NULL DEFAULT 'ap-northeast-1',
  aws_function_name TEXT,
  remotion_site_name TEXT,
  remotion_render_id TEXT,

  -- S3 output
  s3_bucket TEXT,
  s3_output_key TEXT,
  s3_output_etag TEXT,
  s3_output_size_bytes INTEGER,

  -- Metrics
  total_scenes INTEGER,
  total_duration_ms INTEGER,
  render_started_at DATETIME,
  render_completed_at DATETIME,
  render_duration_sec INTEGER,
  estimated_cost_usd REAL DEFAULT 0.0001,

  -- Error handling
  error_code TEXT,
  error_message TEXT,
  error_details_json TEXT,

  -- Idempotency
  idempotency_key TEXT UNIQUE,

  -- Timestamps
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Retry mechanism
  retry_count INTEGER DEFAULT 0,
  next_retry_at DATETIME,
  last_retry_error TEXT,
  
  -- Additional fields
  download_url TEXT,
  retry_locked_at DATETIME,
  notified_completed_at DATETIME,
  notified_failed_at DATETIME,

  -- Foreign keys
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id) REFERENCES users(id),
  FOREIGN KEY (executor_user_id) REFERENCES users(id)
);

-- Indexes for video_builds
CREATE INDEX IF NOT EXISTS idx_video_builds_aws_job_id 
ON video_builds(aws_job_id);

CREATE INDEX IF NOT EXISTS idx_video_builds_executor_created 
ON video_builds(executor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_builds_idempotency_key 
ON video_builds(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_video_builds_owner_created 
ON video_builds(owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_builds_project_id 
ON video_builds(project_id);

CREATE INDEX IF NOT EXISTS idx_video_builds_retry 
ON video_builds(status, next_retry_at) WHERE status = 'retry_wait';

CREATE INDEX IF NOT EXISTS idx_video_builds_status 
ON video_builds(status);

CREATE INDEX IF NOT EXISTS idx_video_builds_status_created 
ON video_builds(status, created_at DESC);
