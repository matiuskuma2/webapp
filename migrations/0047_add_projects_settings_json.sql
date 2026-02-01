-- Phase 2-1: Add settings_json column to projects table
-- This column stores project-level settings including telops_comic for manga text styling
ALTER TABLE projects ADD COLUMN settings_json TEXT DEFAULT '{}';

-- Create index for faster JSON operations (optional but recommended)
-- CREATE INDEX IF NOT EXISTS idx_projects_settings_json ON projects(settings_json);
