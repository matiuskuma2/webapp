-- Migration: 0057_marunage_runs_add_is_archived
-- Add is_archived column to marunage_runs for hiding projects from list view.
-- Archived runs are not deleted, just hidden from the default list.

ALTER TABLE marunage_runs ADD COLUMN is_archived INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_marunage_runs_is_archived
  ON marunage_runs(is_archived);
