-- Migration 0010: World & Character Bible (Phase X-2)
-- Purpose: Add support for world settings and character consistency
-- Note: Originally created as 0007 but renumbered to 0010 to avoid conflict with 0007_add_runs_system.sql

-- 1. World Settings Table
-- Stores project-wide world/setting information that applies to all scenes
CREATE TABLE IF NOT EXISTS world_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL UNIQUE,
  art_style TEXT,                    -- Art style (e.g., "anime", "realistic", "watercolor")
  time_period TEXT,                  -- Time period (e.g., "modern", "medieval", "futuristic")
  setting_description TEXT,          -- Detailed world description
  prompt_prefix TEXT,                -- Prompt prefix added to all image generations
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_world_settings_project_id ON world_settings(project_id);

-- 2. Project Character Models Table
-- Stores character definitions with appearance and reference images
CREATE TABLE IF NOT EXISTS project_character_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  character_key TEXT NOT NULL,       -- Character identifier (e.g., "protagonist", "villain")
  character_name TEXT NOT NULL,      -- Character name (e.g., "田中太郎")
  description TEXT,                  -- Character description
  appearance_description TEXT,       -- Appearance for prompt generation
  reference_image_r2_key TEXT,       -- Reference image R2 key
  reference_image_r2_url TEXT,       -- Reference image R2 URL (for public access)
  voice_preset_id TEXT,              -- Voice preset ID (Phase X-1 integration)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, character_key)
);

CREATE INDEX IF NOT EXISTS idx_character_models_project_id ON project_character_models(project_id);
CREATE INDEX IF NOT EXISTS idx_character_models_character_key ON project_character_models(project_id, character_key);

-- 3. Scene-Character Mapping Table
-- Links scenes to characters that appear in them
CREATE TABLE IF NOT EXISTS scene_character_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  character_key TEXT NOT NULL,       -- References project_character_models.character_key
  is_primary BOOLEAN DEFAULT 0,      -- Flag for primary character in scene
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  UNIQUE(scene_id, character_key)
);

CREATE INDEX IF NOT EXISTS idx_scene_character_scene_id ON scene_character_map(scene_id);
CREATE INDEX IF NOT EXISTS idx_scene_character_key ON scene_character_map(scene_id, character_key);
