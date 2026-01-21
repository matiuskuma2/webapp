-- Add source_type and source_text columns to projects table
-- Migration: 0002_add_source_type
-- Description: Support text input in addition to audio input

ALTER TABLE projects ADD COLUMN source_type TEXT NOT NULL DEFAULT 'audio' CHECK (source_type IN ('audio', 'text'));
ALTER TABLE projects ADD COLUMN source_text TEXT;
ALTER TABLE projects ADD COLUMN source_updated_at DATETIME;

-- Update existing projects to have source_type='audio'
UPDATE projects SET source_type = 'audio' WHERE source_type IS NULL;
