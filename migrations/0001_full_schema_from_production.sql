-- Full Schema Dump from Production D1 Database
-- Generated: 2026-01-17
-- This includes all 39 migrations that were applied to production

-- ============================================================
-- Users and Authentication
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  company TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('superadmin', 'admin')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  video_build_sponsor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  api_sponsor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subscription_status INTEGER NOT NULL DEFAULT 0 CHECK (subscription_status IN (0, 1, 2, 3, 4)),
  myasp_user_id TEXT,
  subscription_plan TEXT NOT NULL DEFAULT 'free',
  subscription_started_at DATETIME,
  subscription_ended_at DATETIME,
  reset_token TEXT,
  reset_token_expires DATETIME
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, provider),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  character_key TEXT NOT NULL,
  character_name TEXT NOT NULL,
  description TEXT,
  appearance_description TEXT,
  reference_image_r2_key TEXT,
  reference_image_r2_url TEXT,
  voice_preset_id TEXT,
  aliases_json TEXT,
  is_favorite INTEGER DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, character_key)
);

-- ============================================================
-- Projects
-- ============================================================

CREATE TABLE IF NOT EXISTS projects (
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
  last_error DATETIME,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_template INTEGER DEFAULT 0,
  template_label TEXT,
  template_description TEXT
);

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

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  run_no INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN (
    'draft', 'approved', 'producing', 'completed', 'archived'
  )),
  source_type TEXT NOT NULL DEFAULT 'text',
  source_text TEXT,
  title TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, run_no)
);

CREATE TABLE IF NOT EXISTS text_chunks (
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
  validation_errors TEXT,
  run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, idx)
);

-- ============================================================
-- Scenes
-- ============================================================

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
  chunk_id INTEGER REFERENCES text_chunks(id) ON DELETE SET NULL,
  run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, idx)
);

CREATE TABLE IF NOT EXISTS scene_split_settings (
  project_id INTEGER PRIMARY KEY,
  target_scene_count INTEGER DEFAULT 20,
  min_chars INTEGER DEFAULT 800,
  max_chars INTEGER DEFAULT 1500,
  pacing TEXT DEFAULT 'normal' CHECK(pacing IN ('fast', 'normal', 'slow')),
  use_world_bible INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- ============================================================
-- Characters (Project-level and Scene-level)
-- ============================================================

CREATE TABLE IF NOT EXISTS project_character_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  character_key TEXT NOT NULL,
  character_name TEXT NOT NULL,
  description TEXT,
  appearance_description TEXT,
  reference_image_r2_key TEXT,
  reference_image_r2_url TEXT,
  voice_preset_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  aliases_json TEXT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, character_key)
);

CREATE TABLE IF NOT EXISTS project_character_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  user_character_id INTEGER NOT NULL,
  character_key TEXT NOT NULL,
  is_customized INTEGER DEFAULT 0,
  custom_appearance TEXT,
  custom_voice_preset_id TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_character_id) REFERENCES user_characters(id) ON DELETE CASCADE,
  UNIQUE(project_id, character_key)
);

CREATE TABLE IF NOT EXISTS scene_character_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  character_key TEXT NOT NULL,
  is_primary BOOLEAN DEFAULT 0,
  role TEXT DEFAULT 'image',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  UNIQUE(scene_id, character_key, role)
);

-- ============================================================
-- World Settings
-- ============================================================

CREATE TABLE IF NOT EXISTS world_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL UNIQUE,
  art_style TEXT,
  time_period TEXT,
  setting_description TEXT,
  prompt_prefix TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- ============================================================
-- Styles
-- ============================================================

CREATE TABLE IF NOT EXISTS style_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  prompt_prefix TEXT,
  prompt_suffix TEXT,
  negative_prompt TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_style_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  default_style_preset_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (default_style_preset_id) REFERENCES style_presets(id) ON DELETE SET NULL,
  UNIQUE(project_id)
);

CREATE TABLE IF NOT EXISTS scene_style_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  style_preset_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (style_preset_id) REFERENCES style_presets(id) ON DELETE SET NULL,
  UNIQUE(scene_id)
);

-- ============================================================
-- Image Generations
-- ============================================================

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

-- ============================================================
-- Audio Generations
-- ============================================================

CREATE TABLE IF NOT EXISTS audio_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  voice_id TEXT NOT NULL,
  model TEXT,
  format TEXT NOT NULL DEFAULT 'mp3',
  sample_rate INTEGER DEFAULT 24000,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  r2_key TEXT,
  r2_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  duration_ms INTEGER,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);

-- ============================================================
-- Video Generations
-- ============================================================

CREATE TABLE IF NOT EXISTS video_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google_veo',
  model TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  duration_sec INTEGER NOT NULL DEFAULT 5,
  prompt TEXT,
  source_image_r2_key TEXT NOT NULL,
  r2_key TEXT,
  r2_url TEXT,
  error_message TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  job_id TEXT,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- Video Builds
-- ============================================================

CREATE TABLE IF NOT EXISTS video_builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  executor_user_id INTEGER NOT NULL,
  is_delegation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'validating', 'submitted', 'rendering', 'uploading', 
    'completed', 'failed', 'cancelled', 'retry_wait'
  )),
  progress_percent REAL DEFAULT 0,
  progress_stage TEXT,
  progress_message TEXT,
  settings_json TEXT NOT NULL,
  project_json_version TEXT NOT NULL DEFAULT '1.1',
  project_json_r2_key TEXT,
  project_json_hash TEXT,
  aws_job_id TEXT,
  aws_region TEXT NOT NULL DEFAULT 'ap-northeast-1',
  aws_function_name TEXT,
  remotion_site_name TEXT,
  remotion_render_id TEXT,
  s3_bucket TEXT,
  s3_output_key TEXT,
  s3_output_etag TEXT,
  s3_output_size_bytes INTEGER,
  total_scenes INTEGER,
  total_duration_ms INTEGER,
  render_started_at DATETIME,
  render_completed_at DATETIME,
  render_duration_sec INTEGER,
  estimated_cost_usd REAL DEFAULT 0.0001,
  error_code TEXT,
  error_message TEXT,
  error_details_json TEXT,
  idempotency_key TEXT UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retry_count INTEGER DEFAULT 0,
  next_retry_at DATETIME,
  last_retry_error TEXT,
  download_url TEXT,
  retry_locked_at DATETIME,
  notified_completed_at DATETIME,
  notified_failed_at DATETIME,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id) REFERENCES users(id),
  FOREIGN KEY (executor_user_id) REFERENCES users(id)
);

-- ============================================================
-- API Usage Logs
-- ============================================================

CREATE TABLE IF NOT EXISTS api_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  project_id INTEGER,
  api_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  duration_seconds REAL DEFAULT 0,
  estimated_cost_usd REAL DEFAULT 0,
  metadata_json TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sponsored_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  video_engine TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

-- ============================================================
-- System Settings
-- ============================================================

CREATE TABLE IF NOT EXISTS system_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  description TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Webhooks and Payments
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'myasp',
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  processed_status TEXT NOT NULL DEFAULT 'received' 
    CHECK (processed_status IN ('received', 'processing', 'completed', 'failed')),
  error_message TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME
);

CREATE TABLE IF NOT EXISTS payment_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  myasp_user_id TEXT,
  payment_type TEXT NOT NULL DEFAULT 'subscription_new',
  payment_status TEXT NOT NULL DEFAULT 'completed',
  amount_jpy INTEGER NOT NULL DEFAULT 0,
  plan_name TEXT,
  period_start DATETIME,
  period_end DATETIME,
  payment_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  myasp_transaction_id TEXT,
  webhook_log_id INTEGER,
  metadata_json TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (webhook_log_id) REFERENCES webhook_logs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS subscription_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  previous_status INTEGER NOT NULL,
  new_status INTEGER NOT NULL,
  change_reason TEXT NOT NULL,
  changed_by TEXT NOT NULL DEFAULT 'system',
  webhook_log_id INTEGER,
  metadata_json TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (webhook_log_id) REFERENCES webhook_logs(id) ON DELETE SET NULL
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_scenes_project_id ON scenes(project_id);
CREATE INDEX IF NOT EXISTS idx_scenes_chunk_id ON scenes(chunk_id);
CREATE INDEX IF NOT EXISTS idx_scenes_run_id ON scenes(run_id);
CREATE INDEX IF NOT EXISTS idx_image_generations_scene_id ON image_generations(scene_id);
CREATE INDEX IF NOT EXISTS idx_audio_generations_scene_id ON audio_generations(scene_id);
CREATE INDEX IF NOT EXISTS idx_video_generations_scene_id ON video_generations(scene_id);
CREATE INDEX IF NOT EXISTS idx_video_generations_job_id ON video_generations(job_id);
CREATE INDEX IF NOT EXISTS idx_video_builds_project_id ON video_builds(project_id);
CREATE INDEX IF NOT EXISTS idx_video_builds_status ON video_builds(status);
CREATE INDEX IF NOT EXISTS idx_api_usage_logs_user_id ON api_usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_logs_project_id ON api_usage_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_scene_character_map_scene_id ON scene_character_map(scene_id);
