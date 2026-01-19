-- Migration: 0018_create_tts_usage_logs
-- Description: Create tts_usage_logs table for TTS usage tracking
-- SSOT: docs/TTS_USAGE_LIMITS_SPEC.md

-- Table: tts_usage_logs
-- Purpose: TTS使用量とコストを追跡（プロバイダ別、キャッシュ対応）
CREATE TABLE IF NOT EXISTS tts_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- 識別子
  user_id INTEGER NOT NULL,
  project_id INTEGER,
  scene_id INTEGER,
  character_key TEXT,
  
  -- プロバイダ情報
  provider TEXT NOT NULL,           -- 'google' | 'fish' | 'elevenlabs'
  voice_id TEXT NOT NULL,
  model TEXT,                       -- 'eleven_multilingual_v2' など
  
  -- 使用量
  text_length INTEGER NOT NULL,     -- 入力文字数
  audio_duration_ms INTEGER,        -- 出力音声長（ミリ秒）
  audio_bytes INTEGER,              -- ファイルサイズ
  
  -- 課金情報
  estimated_cost_usd REAL,          -- 推定コスト（USD）
  billing_unit TEXT,                -- 'characters' | 'seconds'
  billing_amount INTEGER,           -- 課金単位での使用量
  
  -- 結果
  status TEXT NOT NULL,             -- 'success' | 'failed' | 'cached'
  cache_hit INTEGER DEFAULT 0,      -- キャッシュヒットフラグ
  error_message TEXT,
  
  -- タイムスタンプ
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  -- 外部キー
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (scene_id) REFERENCES scenes(id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_tts_usage_user ON tts_usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_tts_usage_provider ON tts_usage_logs(provider);
CREATE INDEX IF NOT EXISTS idx_tts_usage_project ON tts_usage_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_tts_usage_created ON tts_usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_tts_usage_status ON tts_usage_logs(status);
