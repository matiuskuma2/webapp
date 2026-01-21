-- Migration: 0017_create_api_error_logs.sql
-- Purpose: Create api_error_logs table to track all API errors for debugging and monitoring
-- Created: 2026-01-18
--
-- This table captures errors that occur during:
-- - Video generation (Veo2/Veo3)
-- - Audio generation (TTS)
-- - Image generation
-- - Other API calls
--
-- Important: Errors should be logged BEFORE returning error response to client

CREATE TABLE IF NOT EXISTS api_error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- Who/What
  user_id INTEGER,                    -- NULL if error occurs before auth
  project_id INTEGER,                 -- NULL if not applicable
  scene_id INTEGER,                   -- NULL if not applicable
  
  -- What API
  api_type TEXT NOT NULL,             -- 'video_generation', 'audio_generation', 'image_generation', etc.
  api_endpoint TEXT,                  -- '/api/scenes/:id/generate-video'
  provider TEXT,                      -- 'google', 'vertex', 'openai', etc.
  video_engine TEXT,                  -- 'veo2', 'veo3' (for video)
  
  -- Error details
  error_code TEXT NOT NULL,           -- 'USER_KEY_ERROR', 'AWS_START_FAILED', 'DECRYPTION_FAILED', etc.
  error_message TEXT NOT NULL,        -- Human-readable error message
  error_details_json TEXT,            -- Additional error context as JSON
  
  -- HTTP info
  http_status_code INTEGER,           -- 400, 401, 403, 500, etc.
  
  -- Request context
  request_body_json TEXT,             -- Sanitized request body (no secrets)
  
  -- Timestamps
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- Foreign keys (soft - nullable for flexibility)
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE SET NULL
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_api_error_logs_user_id ON api_error_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_api_error_logs_api_type ON api_error_logs(api_type);
CREATE INDEX IF NOT EXISTS idx_api_error_logs_error_code ON api_error_logs(error_code);
CREATE INDEX IF NOT EXISTS idx_api_error_logs_created_at ON api_error_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_api_error_logs_scene_id ON api_error_logs(scene_id);
