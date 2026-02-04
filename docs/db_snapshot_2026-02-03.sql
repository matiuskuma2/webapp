-- Table: _cf_KV
CREATE TABLE _cf_KV (
        key TEXT PRIMARY KEY,
        value BLOB
      ) WITHOUT ROWID;

-- Table: api_error_logs
CREATE TABLE api_error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- Who/What
  user_id INTEGER,                    -- NULL if error occurs before auth
  project_id INTEGER,                 -- NULL if not applicable
  scene_id INTEGER,                   -- NULL if not applicable
  
  -- What API
  api_type TEXT NOT NULL,             -- 'video_generation', 'audio_generation', 'image_generation', etc.
  api_endpoint TEXT,                  -- '/api/scenes/:id/generate-video'
  provider TEXT,                      -- 'google', 'vertex', 'openai', etc.
  video_engine TEXT,                  -- 'veo2', 'veo3' (for video)
  
  -- Error details
  error_code TEXT NOT NULL,           -- 'USER_KEY_ERROR', 'AWS_START_FAILED', 'DECRYPTION_FAILED', etc.
  error_message TEXT NOT NULL,        -- Human-readable error message
  error_details_json TEXT,            -- Additional error context as JSON
  
  -- HTTP info
  http_status_code INTEGER,           -- 400, 401, 403, 500, etc.
  
  -- Request context
  request_body_json TEXT,             -- Sanitized request body (no secrets)
  
  -- Timestamps
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- Foreign keys (soft - nullable for flexibility)
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE SET NULL
);

-- Table: api_usage_logs
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
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, sponsored_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, video_engine TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

-- Table: audio_generations
CREATE TABLE audio_generations (
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
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, duration_ms INTEGER,

  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);

-- Table: audit_logs
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 操作者情報
  user_id INTEGER,                          -- 操作者のユーザーID（NULLは匿名/システム）
  user_role TEXT,                           -- 操作時のロール（admin, superadmin等）
  -- 操作対象
  entity_type TEXT NOT NULL,                -- 'scene', 'audio', 'project' など
  entity_id INTEGER NOT NULL,               -- 対象エンティティのID
  project_id INTEGER,                       -- 関連プロジェクトID（あれば）
  -- 操作内容
  action TEXT NOT NULL,                     -- 'hide', 'restore', 'force_delete' など
  details TEXT,                             -- JSON形式の詳細情報
  -- タイムスタンプ
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: cron_locks
CREATE TABLE cron_locks (
  key TEXT PRIMARY KEY,
  locked_until DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: d1_migrations
CREATE TABLE d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table: image_generation_logs
CREATE TABLE image_generation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  project_id INTEGER,
  scene_id INTEGER,
  character_key TEXT,
  generation_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  api_key_source TEXT NOT NULL,
  sponsor_user_id INTEGER,
  prompt_length INTEGER,
  image_count INTEGER DEFAULT 1,
  image_size TEXT,
  image_quality TEXT,
  estimated_cost_usd REAL DEFAULT 0,
  billing_unit TEXT,
  billing_amount INTEGER DEFAULT 1,
  status TEXT NOT NULL,
  error_message TEXT,
  error_code TEXT,
  reference_image_count INTEGER DEFAULT 0,
  metadata_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Table: image_generations
CREATE TABLE image_generations (
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
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, asset_type TEXT DEFAULT 'ai',
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);

-- Table: motion_presets
CREATE TABLE motion_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  motion_type TEXT NOT NULL CHECK(motion_type IN ('none', 'zoom', 'pan', 'combined')),
  params TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Table: patch_effects
CREATE TABLE patch_effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patch_request_id INTEGER NOT NULL,

  -- 変更対象
  entity TEXT NOT NULL,                   -- 例: 'scene_balloons', 'scene_audio_cues'
  pk_json TEXT NOT NULL,                  -- 例: {"id": 123}
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),

  -- 変更内容
  before_json TEXT,                       -- 変更前（createの場合はNULL）
  after_json TEXT,                        -- 変更後（deleteの場合はNULL）

  -- タイムスタンプ
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (patch_request_id) REFERENCES patch_requests(id) ON DELETE CASCADE
);

-- Table: patch_requests
CREATE TABLE patch_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- 対象特定（必須）
  project_id INTEGER NOT NULL,
  video_build_id INTEGER,                 -- 修正対象ビルド（任意だが推奨）
  base_project_json_hash TEXT,            -- 元のproject.json hash（競合検知用）

  -- リクエスト者情報（監査用）
  requester_user_id INTEGER,              -- 実行ユーザー（将来の認証用）
  requester_role TEXT DEFAULT 'user',     -- 'user'|'admin'|'superadmin'

  -- ソース情報
  source TEXT NOT NULL DEFAULT 'chat' CHECK (source IN ('chat', 'ui', 'api')),
  user_message TEXT NOT NULL,             -- チャットの生文（LLM入力）
  parsed_intent_json TEXT,                -- LLMが抽出した意図（構造化、任意）

  -- パッチ内容
  ops_json TEXT NOT NULL,                 -- 正規化されたpatch ops（SSOT Patch v1形式）
  
  -- 実行結果
  dry_run_result_json TEXT,               -- dry-runの結果（差分・影響範囲・警告）
  apply_result_json TEXT,                 -- applyの結果（成功/失敗・適用件数）

  -- ステータス
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'dry_run_ok', 'dry_run_failed', 'apply_ok', 'apply_failed', 'cancelled')
  ),

  -- タイムスタンプ
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- 外部キー（projectsテーブルへの参照は任意）
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Table: payment_records
CREATE TABLE payment_records (
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

-- Table: project_audio_tracks
CREATE TABLE project_audio_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  track_type TEXT NOT NULL DEFAULT 'bgm' CHECK (track_type IN ('bgm')),
  r2_key TEXT,
  r2_url TEXT,
  duration_ms INTEGER,
  volume REAL NOT NULL DEFAULT 0.25,
  loop INTEGER NOT NULL DEFAULT 1 CHECK (loop IN (0,1)),
  fade_in_ms INTEGER NOT NULL DEFAULT 800,
  fade_out_ms INTEGER NOT NULL DEFAULT 800,
  ducking_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ducking_enabled IN (0,1)),
  ducking_volume REAL NOT NULL DEFAULT 0.12,
  ducking_attack_ms INTEGER NOT NULL DEFAULT 120,
  ducking_release_ms INTEGER NOT NULL DEFAULT 220,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, audio_library_type TEXT CHECK (audio_library_type IN ('upload', 'system', 'user')), system_audio_id INTEGER, user_audio_id INTEGER, video_start_ms INTEGER DEFAULT 0, video_end_ms INTEGER DEFAULT NULL, audio_offset_ms INTEGER DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Table: project_character_instances
CREATE TABLE project_character_instances (
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

-- Table: project_character_models
CREATE TABLE project_character_models (
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
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, aliases_json TEXT NULL, story_traits TEXT DEFAULT NULL, style_preset_id INTEGER REFERENCES style_presets(id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, character_key)
);

-- Table: project_style_settings
CREATE TABLE project_style_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  default_style_preset_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (default_style_preset_id) REFERENCES style_presets(id) ON DELETE SET NULL,
  UNIQUE(project_id)
);

-- Table: projects
CREATE TABLE "projects" (
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
, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, is_template INTEGER DEFAULT 0, template_label TEXT, template_description TEXT, output_preset TEXT DEFAULT 'yt_long', split_mode TEXT DEFAULT 'raw', target_scene_count INTEGER DEFAULT 5, settings_json TEXT DEFAULT '{}');

-- Table: runs
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  run_no INTEGER NOT NULL,  
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN (
    'draft',      
    'approved',   
    'producing',  
    'completed',  
    'archived'    
  )),
  source_type TEXT NOT NULL DEFAULT 'text',
  source_text TEXT,
  title TEXT,  
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, run_no)
);

-- Table: scene_audio_assignments
CREATE TABLE scene_audio_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  
  -- ライブラリ参照タイプ
  -- 'system': system_audio_library を参照
  -- 'user': user_audio_library を参照
  -- 'direct': 直接アップロード（ライブラリに登録せず使い捨て）
  audio_library_type TEXT NOT NULL CHECK (audio_library_type IN ('system', 'user', 'direct')),
  
  -- ライブラリ参照ID（type に応じて使用）
  system_audio_id INTEGER,      -- audio_library_type='system' の場合
  user_audio_id INTEGER,        -- audio_library_type='user' の場合
  
  -- 直接アップロード用（audio_library_type='direct' の場合）
  direct_r2_key TEXT,
  direct_r2_url TEXT,
  direct_name TEXT,
  direct_duration_ms INTEGER,
  
  -- 音素材タイプ
  audio_type TEXT NOT NULL CHECK (audio_type IN ('bgm', 'sfx')),
  
  -- シーン内タイミング（ミリ秒）
  -- BGM: 通常 start_ms=0, end_ms=NULL（シーン全体）
  -- SFX: start_ms で開始タイミング指定
  start_ms INTEGER NOT NULL DEFAULT 0,
  end_ms INTEGER,  -- NULL = 音素材の duration 分再生
  
  -- オーバーライド設定（NULLならライブラリのデフォルト使用）
  volume_override REAL,
  loop_override INTEGER CHECK (loop_override IS NULL OR loop_override IN (0,1)),
  fade_in_ms_override INTEGER,
  fade_out_ms_override INTEGER,
  
  -- 管理
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  
  -- タイムスタンプ
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, audio_offset_ms INTEGER DEFAULT 0,
  
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (system_audio_id) REFERENCES system_audio_library(id),
  FOREIGN KEY (user_audio_id) REFERENCES user_audio_library(id)
);

-- Table: scene_audio_cues
CREATE TABLE scene_audio_cues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  
  -- タイプ（将来拡張用: sfx, bgm_segment, ambient等）
  cue_type TEXT NOT NULL DEFAULT 'sfx',
  
  -- 識別用の名前（例: 剣の音、風、爆発、足音）
  name TEXT,
  
  -- R2ストレージ
  r2_key TEXT,
  r2_url TEXT,
  
  -- 音声ファイルのメタデータ
  duration_ms INTEGER,  -- 音声ファイルの長さ
  
  -- 再生設定
  volume REAL NOT NULL DEFAULT 0.8,  -- 0.0〜1.0
  
  -- タイミング（シーン内の相対時間）
  start_ms INTEGER NOT NULL DEFAULT 0,  -- シーン開始からのオフセット
  end_ms INTEGER,  -- NULL可: NULLの場合はduration_msで自動計算
  
  -- ループ設定（環境音用）
  loop INTEGER NOT NULL DEFAULT 0,  -- 0: 1回再生, 1: ループ
  
  -- フェード設定
  fade_in_ms INTEGER NOT NULL DEFAULT 0,
  fade_out_ms INTEGER NOT NULL DEFAULT 0,
  
  -- 有効フラグ
  is_active INTEGER NOT NULL DEFAULT 1,
  
  -- タイムスタンプ
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);

-- Table: scene_balloons
CREATE TABLE scene_balloons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  utterance_id INTEGER,
  x REAL NOT NULL DEFAULT 0.5,
  y REAL NOT NULL DEFAULT 0.5,
  w REAL NOT NULL DEFAULT 0.3,
  h REAL NOT NULL DEFAULT 0.2,
  shape TEXT NOT NULL DEFAULT 'round',
  tail_enabled INTEGER NOT NULL DEFAULT 1,
  tail_tip_x REAL DEFAULT 0.5,
  tail_tip_y REAL DEFAULT 1.2,
  writing_mode TEXT NOT NULL DEFAULT 'horizontal',
  text_align TEXT NOT NULL DEFAULT 'center',
  font_family TEXT DEFAULT 'sans-serif',
  font_weight INTEGER DEFAULT 700,
  font_size INTEGER DEFAULT 24,
  line_height REAL DEFAULT 1.4,
  padding INTEGER DEFAULT 12,
  bg_color TEXT DEFAULT '#FFFFFF',
  text_color TEXT DEFAULT '#000000',
  border_color TEXT DEFAULT '#000000',
  border_width INTEGER DEFAULT 2,
  display_mode TEXT NOT NULL DEFAULT 'voice_window',
  start_ms INTEGER,
  end_ms INTEGER,
  z_index INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, bubble_r2_key TEXT, bubble_r2_url TEXT, bubble_width_px INTEGER, bubble_height_px INTEGER, bubble_source_version INTEGER NOT NULL DEFAULT 1, bubble_updated_at DATETIME, display_policy TEXT NOT NULL DEFAULT 'voice_window',
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (utterance_id) REFERENCES scene_utterances(id) ON DELETE CASCADE
);

-- Table: scene_character_map
CREATE TABLE "scene_character_map" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  character_key TEXT NOT NULL,
  is_primary BOOLEAN DEFAULT 0,
  role TEXT DEFAULT 'image',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  UNIQUE(scene_id, character_key, role)
);

-- Table: scene_character_traits
CREATE TABLE scene_character_traits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL,
    character_key TEXT NOT NULL,
    override_type TEXT NOT NULL DEFAULT 'transform',
    trait_description TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'auto',
    confidence REAL DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
    UNIQUE(scene_id, character_key)
);

-- Table: scene_motion
CREATE TABLE scene_motion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL UNIQUE,
  motion_preset_id TEXT NOT NULL DEFAULT 'kenburns_soft',
  custom_params TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (motion_preset_id) REFERENCES motion_presets(id)
);

-- Table: scene_split_settings
CREATE TABLE scene_split_settings (
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

-- Table: scene_style_settings
CREATE TABLE scene_style_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  style_preset_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (style_preset_id) REFERENCES style_presets(id) ON DELETE SET NULL,
  UNIQUE(scene_id)
);

-- Table: scene_telops
CREATE TABLE scene_telops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  utterance_id INTEGER,
  text TEXT NOT NULL,
  x REAL NOT NULL DEFAULT 0.5,
  y REAL NOT NULL DEFAULT 0.9,
  w REAL NOT NULL DEFAULT 0.8,
  h REAL,
  text_align TEXT NOT NULL DEFAULT 'center',
  style TEXT NOT NULL DEFAULT 'subtitle',
  font_family TEXT DEFAULT 'sans-serif',
  font_weight INTEGER DEFAULT 700,
  font_size INTEGER DEFAULT 28,
  stroke_enabled INTEGER NOT NULL DEFAULT 1,
  stroke_width INTEGER DEFAULT 2,
  stroke_color TEXT DEFAULT '#000000',
  bg_enabled INTEGER NOT NULL DEFAULT 1,
  bg_color TEXT DEFAULT 'rgba(0,0,0,0.6)',
  bg_padding INTEGER DEFAULT 8,
  text_color TEXT DEFAULT '#FFFFFF',
  display_mode TEXT NOT NULL DEFAULT 'utterance_window',
  start_ms INTEGER,
  end_ms INTEGER,
  enter_animation TEXT DEFAULT 'fade',
  exit_animation TEXT DEFAULT 'fade',
  animation_duration_ms INTEGER DEFAULT 150,
  z_index INTEGER NOT NULL DEFAULT 10,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (utterance_id) REFERENCES scene_utterances(id) ON DELETE SET NULL
);

-- Table: scene_utterances
CREATE TABLE scene_utterances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  order_no INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  character_key TEXT,
  audio_generation_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, role TEXT NOT NULL DEFAULT 'dialogue', duration_ms INTEGER,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (audio_generation_id) REFERENCES audio_generations(id)
);

-- Table: scenes
CREATE TABLE scenes (
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
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, chunk_id INTEGER REFERENCES text_chunks(id) ON DELETE SET NULL, run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE, comic_data TEXT DEFAULT NULL, display_asset_type TEXT DEFAULT 'image', speech_type TEXT DEFAULT 'dialogue', is_prompt_customized INTEGER DEFAULT 0, text_render_mode TEXT NOT NULL DEFAULT 'remotion', motion_preset TEXT NOT NULL DEFAULT 'kenburns', motion_params_json TEXT, duration_override_ms INTEGER, is_hidden INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, idx)
);

-- Table: sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,  
  user_id INTEGER NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Table: sqlite_sequence
CREATE TABLE sqlite_sequence(name,seq);

-- Table: style_presets
CREATE TABLE style_presets (
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

-- Table: subscription_logs
CREATE TABLE subscription_logs (
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

-- Table: system_audio_library
CREATE TABLE system_audio_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audio_type TEXT NOT NULL CHECK (audio_type IN ('bgm', 'sfx')),
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  mood TEXT,
  tags TEXT,
  file_url TEXT NOT NULL,
  file_size INTEGER,
  duration_ms INTEGER,
  thumbnail_url TEXT,
  source TEXT,
  source_metadata TEXT,
  created_by TEXT DEFAULT 'admin',
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Table: system_settings
CREATE TABLE system_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: text_chunks
CREATE TABLE "text_chunks" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  error_message TEXT,
  scene_count INTEGER DEFAULT 0,
  processed_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, validation_errors TEXT, run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, idx)
);

-- Table: transcriptions
CREATE TABLE transcriptions (
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

-- Table: tts_usage_logs
CREATE TABLE tts_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  project_id INTEGER,
  scene_id INTEGER,
  character_key TEXT,
  provider TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  model TEXT,
  text_length INTEGER NOT NULL,
  audio_duration_ms INTEGER,
  audio_bytes INTEGER,
  estimated_cost_usd REAL,
  billing_unit TEXT,
  billing_amount INTEGER,
  status TEXT NOT NULL,
  cache_hit INTEGER DEFAULT 0,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Table: user_api_keys
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

-- Table: user_audio_library
CREATE TABLE user_audio_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  
  -- 種別
  audio_type TEXT NOT NULL CHECK (audio_type IN ('bgm', 'sfx')),
  
  -- メタデータ
  name TEXT NOT NULL,
  description TEXT,
  
  -- カテゴリ/ムード（AI提案・検索用）
  category TEXT,   -- 'pop', 'classical', 'ambient', 'action', 'comedy', 'dramatic'
  mood TEXT,       -- '明るい', '落ち着いた', 'ドラマチック', '緊張感', '悲しい'
  tags TEXT,       -- JSON配列: ["元気", "ポップ", "日常"]
  
  -- ファイル情報（R2）
  r2_key TEXT NOT NULL,
  r2_url TEXT NOT NULL,
  duration_ms INTEGER,
  file_size INTEGER,
  
  -- デフォルト再生設定
  default_volume REAL NOT NULL DEFAULT 0.25,
  default_loop INTEGER NOT NULL DEFAULT 0 CHECK (default_loop IN (0,1)),
  default_fade_in_ms INTEGER NOT NULL DEFAULT 0,
  default_fade_out_ms INTEGER NOT NULL DEFAULT 0,
  
  -- 管理
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  use_count INTEGER NOT NULL DEFAULT 0,  -- 使用回数（AI提案の重み付け用）
  
  -- タイムスタンプ
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Table: user_characters
CREATE TABLE user_characters (
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

-- Table: users
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  company TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('superadmin', 'admin')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
, video_build_sponsor_id INTEGER REFERENCES users(id) ON DELETE SET NULL, api_sponsor_id INTEGER REFERENCES users(id) ON DELETE SET NULL, subscription_status INTEGER NOT NULL DEFAULT 0 
  CHECK (subscription_status IN (0, 1, 2, 3, 4)), myasp_user_id TEXT, subscription_plan TEXT NOT NULL DEFAULT 'free', subscription_started_at DATETIME, subscription_ended_at DATETIME, reset_token TEXT, reset_token_expires DATETIME);

-- Table: video_builds
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
  notified_failed_at DATETIME, source_video_build_id INTEGER NULL, patch_request_id INTEGER NULL, render_usage_logged INTEGER NOT NULL DEFAULT 0,

  
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id) REFERENCES users(id),
  FOREIGN KEY (executor_user_id) REFERENCES users(id)
);

-- Table: video_generations
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
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, job_id TEXT,
    FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Table: webhook_logs
CREATE TABLE webhook_logs (
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

-- Table: world_settings
CREATE TABLE world_settings (
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

