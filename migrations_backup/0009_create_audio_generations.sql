-- Migration: 0009_create_audio_generations
-- Purpose: Add audio_generations table for per-scene TTS history and activation

CREATE TABLE IF NOT EXISTS audio_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,

  -- TTS provider settings
  provider TEXT NOT NULL DEFAULT 'google',
  voice_id TEXT NOT NULL,
  model TEXT,

  -- Audio specs
  format TEXT NOT NULL DEFAULT 'mp3',
  sample_rate INTEGER DEFAULT 24000,

  -- Generation input/output
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | generating | completed | failed
  error_message TEXT,

  -- R2 storage
  r2_key TEXT,
  r2_url TEXT,

  -- Metadata
  is_active INTEGER NOT NULL DEFAULT 0,     -- 1 = active, 0 = history
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_audio_generations_scene_id
  ON audio_generations(scene_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audio_generations_scene_active
  ON audio_generations(scene_id, is_active);

CREATE INDEX IF NOT EXISTS idx_audio_generations_status
  ON audio_generations(status);
