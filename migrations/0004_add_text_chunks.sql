-- Add text_chunks table for long text processing
-- Migration: 0004_add_text_chunks
-- Description: Support chunked processing of long text input

CREATE TABLE IF NOT EXISTS text_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'formatting', 'formatted', 'failed')),
  error_message TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, idx)
);

CREATE INDEX idx_text_chunks_project_id ON text_chunks(project_id);
CREATE INDEX idx_text_chunks_status ON text_chunks(status);
CREATE INDEX idx_text_chunks_project_idx ON text_chunks(project_id, idx);

-- Add parsed status to projects table
-- Note: This uses ALTER TABLE which is supported in SQLite 3.25.0+
-- Current valid statuses: created, uploaded, transcribing, transcribed, formatting, formatted, generating_images, completed, failed
-- We need to recreate the table with the new constraint

-- Step 1: Create temporary table with new constraint
CREATE TABLE projects_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  audio_r2_key TEXT,
  audio_filename TEXT,
  audio_size_bytes INTEGER,
  audio_duration_seconds INTEGER,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'uploaded', 'transcribing', 'transcribed',
    'parsing', 'parsed', 'formatting', 'formatted', 
    'generating_images', 'completed', 'failed'
  )),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_type TEXT NOT NULL DEFAULT 'audio' CHECK (source_type IN ('audio', 'text')),
  source_text TEXT,
  source_updated_at DATETIME,
  error_message TEXT,
  last_error DATETIME
);

-- Step 2: Copy data from old table
INSERT INTO projects_new 
SELECT id, title, audio_r2_key, audio_filename, audio_size_bytes, audio_duration_seconds,
       status, created_at, updated_at, source_type, source_text, source_updated_at,
       error_message, last_error
FROM projects;

-- Step 3: Drop old table
DROP TABLE projects;

-- Step 4: Rename new table
ALTER TABLE projects_new RENAME TO projects;

-- Step 5: Recreate indexes
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_created_at ON projects(created_at DESC);
