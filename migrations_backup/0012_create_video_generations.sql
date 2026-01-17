-- Migration: 0012_create_video_generations
-- Description: Create video_generations table for I2V (Image-to-Video) feature
-- Source: D1 Production Schema (2026-01-17)

-- Table: video_generations
-- Purpose: シーンごとの動画生成履歴を管理（Veo2/Veo3対応）
CREATE TABLE IF NOT EXISTS video_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL DEFAULT 'google_veo',
    model TEXT,
    status TEXT NOT NULL DEFAULT 'pending',  
    duration_sec INTEGER NOT NULL DEFAULT 5,  
    prompt TEXT,
    source_image_r2_key TEXT NOT NULL,
    r2_key TEXT,
    r2_url TEXT,
    error_message TEXT,
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    job_id TEXT,
    FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes for video_generations
CREATE INDEX IF NOT EXISTS idx_video_generations_created_at 
ON video_generations(created_at);

CREATE INDEX IF NOT EXISTS idx_video_generations_job_id 
ON video_generations(job_id);

CREATE INDEX IF NOT EXISTS idx_video_generations_scene_active 
ON video_generations(scene_id, is_active);

CREATE INDEX IF NOT EXISTS idx_video_generations_scene_status 
ON video_generations(scene_id, status);

CREATE INDEX IF NOT EXISTS idx_video_generations_status 
ON video_generations(status);

CREATE INDEX IF NOT EXISTS idx_video_generations_user_created 
ON video_generations(user_id, created_at);
