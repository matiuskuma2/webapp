-- Migration: 0005_format_chunked_processing
-- Description: Support chunked formatting with progress tracking

-- Add chunk_id to scenes table for tracking which chunk generated which scenes
ALTER TABLE scenes ADD COLUMN chunk_id INTEGER REFERENCES text_chunks(id) ON DELETE SET NULL;

-- Create index for chunk-based scene lookup
CREATE INDEX idx_scenes_chunk_id ON scenes(chunk_id);

-- Add processing status to text_chunks
-- Status flow: pending → processing → done → failed
-- Note: SQLite doesn't support ALTER TABLE ... MODIFY COLUMN with CHECK constraint
-- So we need to recreate the table

-- Step 1: Create new table with updated constraint
CREATE TABLE text_chunks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  error_message TEXT,
  scene_count INTEGER DEFAULT 0,
  processed_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, idx)
);

-- Step 2: Copy data
INSERT INTO text_chunks_new (id, project_id, idx, text, status, error_message, created_at, updated_at)
SELECT id, project_id, idx, text, 
       CASE 
         WHEN status = 'formatted' THEN 'done'
         WHEN status = 'formatting' THEN 'processing'
         ELSE status 
       END,
       error_message, created_at, updated_at
FROM text_chunks;

-- Step 3: Drop old table
DROP TABLE text_chunks;

-- Step 4: Rename new table
ALTER TABLE text_chunks_new RENAME TO text_chunks;

-- Step 5: Recreate indexes
CREATE INDEX idx_text_chunks_project_id ON text_chunks(project_id);
CREATE INDEX idx_text_chunks_status ON text_chunks(status);
CREATE INDEX idx_text_chunks_project_idx ON text_chunks(project_id, idx);
