-- Phase X-5: Character Story Traits System
-- 
-- Purpose: Track character traits extracted from story/dialogue
-- and allow per-scene overrides for character transformations
--
-- Example:
--   Character: ベル
--   Story Trait: "小さな妖精、キラキラと光る羽" (applies to all scenes)
--   Scene Override: Scene 10 - "人間の姿に変身" (overrides story trait for this scene)

-- 1. Add story_traits column to project_character_models
-- This stores traits extracted from the story (JSON array)
-- Format: ["小さな妖精", "キラキラと光る羽", "明るい性格"]
ALTER TABLE project_character_models ADD COLUMN story_traits TEXT DEFAULT NULL;

-- 2. Create scene_character_traits table for per-scene overrides
-- When a character transforms or changes appearance in a specific scene
CREATE TABLE IF NOT EXISTS scene_character_traits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL,
    character_key TEXT NOT NULL,
    -- Override type: 'transform' (complete change), 'add' (additional trait), 'remove' (hide trait)
    override_type TEXT NOT NULL DEFAULT 'transform',
    -- The trait description for this scene
    trait_description TEXT NOT NULL,
    -- Source: 'auto' (extracted by AI), 'manual' (user edited)
    source TEXT NOT NULL DEFAULT 'auto',
    -- Confidence score for auto-extracted traits (0.0-1.0)
    confidence REAL DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
    UNIQUE(scene_id, character_key)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_scene_character_traits_scene ON scene_character_traits(scene_id);
CREATE INDEX IF NOT EXISTS idx_scene_character_traits_character ON scene_character_traits(character_key);
