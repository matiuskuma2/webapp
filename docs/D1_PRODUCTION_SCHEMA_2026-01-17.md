# D1 Production Schema Snapshot (2026-01-17)

**Purpose**: 本番D1スキーマのバックアップ。マイグレーション作成時のSource of Truth。

**Database**: webapp-production (51860cd3-bfa8-4eab-8a11-aa230adee686)

---

## Tables

### video_generations

```sql
CREATE TABLE video_generations (
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
```

### video_builds

```sql
CREATE TABLE "video_builds" (
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
```

### api_usage_logs

```sql
CREATE TABLE "api_usage_logs" (
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
```

### user_api_keys

```sql
CREATE TABLE user_api_keys (
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
```

### system_settings

```sql
CREATE TABLE system_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

## Indexes

### video_generations indexes

```sql
CREATE INDEX idx_video_generations_created_at ON video_generations(created_at);
CREATE INDEX idx_video_generations_job_id ON video_generations(job_id);
CREATE INDEX idx_video_generations_scene_active ON video_generations(scene_id, is_active);
CREATE INDEX idx_video_generations_scene_status ON video_generations(scene_id, status);
CREATE INDEX idx_video_generations_status ON video_generations(status);
CREATE INDEX idx_video_generations_user_created ON video_generations(user_id, created_at);
```

### video_builds indexes

```sql
CREATE INDEX idx_video_builds_aws_job_id ON video_builds(aws_job_id);
CREATE INDEX idx_video_builds_executor_created ON video_builds(executor_user_id, created_at DESC);
CREATE INDEX idx_video_builds_idempotency_key ON video_builds(idempotency_key);
CREATE INDEX idx_video_builds_owner_created ON video_builds(owner_user_id, created_at DESC);
CREATE INDEX idx_video_builds_project_id ON video_builds(project_id);
CREATE INDEX idx_video_builds_retry ON video_builds(status, next_retry_at) WHERE status = 'retry_wait';
CREATE INDEX idx_video_builds_status ON video_builds(status);
CREATE INDEX idx_video_builds_status_created ON video_builds(status, created_at DESC);
```

### api_usage_logs indexes

```sql
CREATE INDEX idx_api_usage_logs_api_type ON api_usage_logs(api_type);
CREATE INDEX idx_api_usage_logs_created ON api_usage_logs(created_at);
CREATE INDEX idx_api_usage_logs_project ON api_usage_logs(project_id);
CREATE INDEX idx_api_usage_logs_sponsor_type ON api_usage_logs(sponsored_by_user_id, api_type);
CREATE INDEX idx_api_usage_logs_sponsored_by ON api_usage_logs(sponsored_by_user_id);
CREATE INDEX idx_api_usage_logs_user ON api_usage_logs(user_id);
```

### user_api_keys indexes

```sql
CREATE INDEX idx_user_api_keys_provider ON user_api_keys(provider, is_active);
CREATE INDEX idx_user_api_keys_user_id ON user_api_keys(user_id);
```

---

*Extracted: 2026-01-17*
