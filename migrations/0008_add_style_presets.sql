-- Migration: Add Style Presets system for image generation
-- Purpose: Allow users to define and select visual styles for generated images

-- 1. Create style_presets table
CREATE TABLE IF NOT EXISTS style_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  prompt_prefix TEXT,
  prompt_suffix TEXT,
  negative_prompt TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Create project_style_settings table
CREATE TABLE IF NOT EXISTS project_style_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  default_style_preset_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (default_style_preset_id) REFERENCES style_presets(id) ON DELETE SET NULL,
  UNIQUE(project_id)
);

-- 3. Create scene_style_settings table
CREATE TABLE IF NOT EXISTS scene_style_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  style_preset_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (style_preset_id) REFERENCES style_presets(id) ON DELETE SET NULL,
  UNIQUE(scene_id)
);

-- 4. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_style_presets_active ON style_presets(is_active);
CREATE INDEX IF NOT EXISTS idx_project_style_settings_project ON project_style_settings(project_id);
CREATE INDEX IF NOT EXISTS idx_scene_style_settings_scene ON scene_style_settings(scene_id);

-- 5. Insert default style presets
INSERT INTO style_presets (name, description, prompt_prefix, prompt_suffix, negative_prompt, is_active) VALUES
(
  '日本アニメ風',
  'YouTube向けの明るく親しみやすいアニメスタイル',
  'Japanese anime style, vibrant colors, clear outlines, cel-shaded, ',
  ', saturated colors, clean composition, bright lighting, anime aesthetic',
  'realistic, photographic, dark, muddy colors, blurry, low quality',
  1
),
(
  'インフォマーシャル風',
  '情報を明確に伝える図解スタイル',
  'Infographic style, clean layout, clear typography, icons and diagrams, ',
  ', whitespace, professional presentation, educational, easy to understand',
  'cluttered, chaotic, hard to read, confusing, dark',
  1
),
(
  'シネマ調',
  '高級感のある映画的なスタイル',
  'Cinematic style, dramatic lighting, depth of field, film grain, ',
  ', professional photography, high-end production, realistic, atmospheric, moody',
  'cartoon, flat, bright, oversaturated, cheap, amateur',
  1
);
