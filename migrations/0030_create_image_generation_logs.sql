-- Migration: 0030_create_image_generation_logs
-- Description: Create image_generation_logs table for image generation usage tracking
-- Purpose: 画像生成の使用量とコストを追跡（シーン画像、キャラクター画像）
-- Created: 2026-01-23

-- Table: image_generation_logs
-- Purpose: 画像生成の使用量とコストを追跡（APIキーソース別）
CREATE TABLE IF NOT EXISTS image_generation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- 識別子
  user_id INTEGER NOT NULL,               -- リクエストしたユーザー
  project_id INTEGER,                     -- プロジェクトID（シーン画像の場合）
  scene_id INTEGER,                       -- シーンID（シーン画像の場合）
  character_key TEXT,                     -- キャラクターキー（キャラクター画像の場合）
  
  -- 画像生成タイプ
  generation_type TEXT NOT NULL,          -- 'scene_image' | 'character_preview' | 'character_reference'
  
  -- プロバイダ情報
  provider TEXT NOT NULL,                 -- 'gemini' | 'openai' | 'other'
  model TEXT NOT NULL,                    -- 'gemini-3-pro-image-preview' | 'dall-e-3' など
  
  -- APIキーソース (重要: コスト負担者の特定)
  api_key_source TEXT NOT NULL,           -- 'user' | 'system' | 'sponsor'
  sponsor_user_id INTEGER,                -- スポンサーの場合、スポンサーユーザーID
  
  -- 生成パラメータ
  prompt_length INTEGER,                  -- プロンプトの文字数
  image_count INTEGER DEFAULT 1,          -- 生成画像数
  image_size TEXT,                        -- '1:1' | '16:9' など
  image_quality TEXT,                     -- '1K' | '2K' など
  
  -- 課金情報
  estimated_cost_usd REAL DEFAULT 0,      -- 推定コスト（USD）
  billing_unit TEXT,                      -- 'image' | 'request'
  billing_amount INTEGER DEFAULT 1,       -- 課金単位での使用量
  
  -- 結果
  status TEXT NOT NULL,                   -- 'success' | 'failed' | 'quota_exceeded'
  error_message TEXT,
  error_code TEXT,                        -- 'QUOTA_EXCEEDED' | 'RATE_LIMITED' など
  
  -- 追加メタデータ
  reference_image_count INTEGER DEFAULT 0,-- 参照画像の数
  metadata_json TEXT,                     -- その他のメタデータ（JSON）
  
  -- タイムスタンプ
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  -- 外部キー
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (scene_id) REFERENCES scenes(id),
  FOREIGN KEY (sponsor_user_id) REFERENCES users(id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_image_gen_logs_user ON image_generation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_image_gen_logs_project ON image_generation_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_image_gen_logs_scene ON image_generation_logs(scene_id);
CREATE INDEX IF NOT EXISTS idx_image_gen_logs_type ON image_generation_logs(generation_type);
CREATE INDEX IF NOT EXISTS idx_image_gen_logs_provider ON image_generation_logs(provider);
CREATE INDEX IF NOT EXISTS idx_image_gen_logs_key_source ON image_generation_logs(api_key_source);
CREATE INDEX IF NOT EXISTS idx_image_gen_logs_created ON image_generation_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_image_gen_logs_status ON image_generation_logs(status);
CREATE INDEX IF NOT EXISTS idx_image_gen_logs_sponsor ON image_generation_logs(sponsor_user_id);
