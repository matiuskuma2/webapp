-- Phase X-4: Add flag to track if image_prompt was customized by user
-- When customized, character appearance_description and Japanese text instruction are NOT added
-- Only character reference images are still used (for visual consistency)

ALTER TABLE scenes ADD COLUMN is_prompt_customized INTEGER DEFAULT 0;

-- Index for queries that filter by customization status
CREATE INDEX IF NOT EXISTS idx_scenes_prompt_customized ON scenes(project_id, is_prompt_customized);
