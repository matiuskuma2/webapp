-- projects table
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  audio_r2_key TEXT,
  audio_filename TEXT,
  audio_size_bytes INTEGER,
  audio_duration_seconds INTEGER,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'uploaded', 'transcribing', 'transcribed',
    'formatting', 'formatted', 'generating_images', 'completed', 'failed'
  )),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_created_at ON projects(created_at DESC);

-- transcriptions table
CREATE TABLE IF NOT EXISTS transcriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  language TEXT,
  duration_seconds INTEGER,
  word_count INTEGER,
  provider TEXT NOT NULL DEFAULT 'openai',
  model TEXT NOT NULL DEFAULT 'whisper-1',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_transcriptions_project_id ON transcriptions(project_id);

-- scenes table
CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'hook', 'context', 'main_point', 'evidence',
    'timeline', 'analysis', 'summary', 'cta'
  )),
  title TEXT NOT NULL,
  dialogue TEXT NOT NULL,
  bullets TEXT NOT NULL,
  image_prompt TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, idx)
);

CREATE INDEX idx_scenes_project_id ON scenes(project_id);
CREATE INDEX idx_scenes_project_idx ON scenes(project_id, idx);

-- image_generations table
CREATE TABLE IF NOT EXISTS image_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  r2_key TEXT,
  r2_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'generating', 'completed', 'failed', 'policy_violation'
  )),
  error_message TEXT,
  provider TEXT NOT NULL DEFAULT 'gemini',
  model TEXT NOT NULL DEFAULT 'gemini-3-pro-image-preview',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);

CREATE INDEX idx_image_generations_scene_id ON image_generations(scene_id);
CREATE INDEX idx_image_generations_scene_active ON image_generations(scene_id, is_active);
CREATE INDEX idx_image_generations_status ON image_generations(status);
