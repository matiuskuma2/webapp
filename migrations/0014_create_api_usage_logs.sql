-- Migration: 0014_create_api_usage_logs
-- Description: Create api_usage_logs table with video_engine support
-- Source: D1 Production Schema (2026-01-17)
-- 
-- NOTE: This migration creates the table with ALL columns including
-- sponsored_by_user_id and video_engine (PR-2 additions).
-- For existing databases, use ALTER TABLE if needed.

-- Table: api_usage_logs
-- Purpose: API使用量とコストを追跡（Veo2/Veo3のvideo_engine分離含む）
CREATE TABLE IF NOT EXISTS api_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  project_id INTEGER,
  api_type TEXT NOT NULL,  
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  duration_seconds REAL DEFAULT 0,
  estimated_cost_usd REAL DEFAULT 0,
  metadata_json TEXT,  
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sponsored_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  video_engine TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

-- Indexes for api_usage_logs
CREATE INDEX IF NOT EXISTS idx_api_usage_logs_api_type 
ON api_usage_logs(api_type);

CREATE INDEX IF NOT EXISTS idx_api_usage_logs_created 
ON api_usage_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_api_usage_logs_project 
ON api_usage_logs(project_id);

CREATE INDEX IF NOT EXISTS idx_api_usage_logs_sponsor_type 
ON api_usage_logs(sponsored_by_user_id, api_type);

CREATE INDEX IF NOT EXISTS idx_api_usage_logs_sponsored_by 
ON api_usage_logs(sponsored_by_user_id);

CREATE INDEX IF NOT EXISTS idx_api_usage_logs_user 
ON api_usage_logs(user_id);
