-- Migration 0011: Add aliases_json to project_character_models (Phase X-2 Part 2)
-- Purpose: Support character name variations for auto-assignment

-- Add aliases_json column (NULL for backward compatibility)
-- Stores array of character name aliases as JSON
-- Example: ["太郎", "たろう", "主人公"]
ALTER TABLE project_character_models 
ADD COLUMN aliases_json TEXT NULL;

-- Backward compatibility: existing rows have NULL (treated as empty array [])
-- No default value to avoid unnecessary storage
