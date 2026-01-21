-- Migration: Add Run management system (Phase B-0 & B-2)
-- Purpose: Enable multiple input/format cycles per project with version control

-- 1. Create runs table
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  run_no INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft', 'approved', 'producing', 'completed', 'archived')) DEFAULT 'draft',
  source_type TEXT CHECK(source_type IN ('text', 'audio')),
  source_text TEXT,
  source_audio_url TEXT,
  title TEXT NOT NULL,
  
  -- Phase B-2: Add status tracking for parse/format/generate
  parse_status TEXT CHECK(parse_status IN ('pending', 'parsing', 'parsed', 'failed')) DEFAULT 'pending',
  format_status TEXT CHECK(format_status IN ('pending', 'formatting', 'formatted', 'failed')) DEFAULT 'pending',
  generate_status TEXT CHECK(generate_status IN ('pending', 'generating', 'completed', 'failed')) DEFAULT 'pending',
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, run_no)
);

-- 2. Add run_id to text_chunks (nullable for backward compatibility)
ALTER TABLE text_chunks ADD COLUMN run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE;

-- 3. Add run_id to scenes (nullable for backward compatibility)
ALTER TABLE scenes ADD COLUMN run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE;

-- 4. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_runs_project_id ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
CREATE INDEX IF NOT EXISTS idx_text_chunks_run_id ON text_chunks(run_id);
CREATE INDEX IF NOT EXISTS idx_scenes_run_id ON scenes(run_id);

-- 5. Create index for run lookup by project + run_no
CREATE INDEX IF NOT EXISTS idx_runs_project_run_no ON runs(project_id, run_no);
