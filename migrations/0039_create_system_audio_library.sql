-- Migration: 0039_create_system_audio_library
-- Description: システムBGM/SFXライブラリ（管理者が登録、全プロジェクトで使用可能）
-- Phase 2: SunoAIで作成したBGM/SFXを管理

-- システムオーディオライブラリ
CREATE TABLE IF NOT EXISTS system_audio_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- 種別
  audio_type TEXT NOT NULL CHECK (audio_type IN ('bgm', 'sfx')),
  
  -- メタデータ
  name TEXT NOT NULL,
  description TEXT,
  
  -- カテゴリ/ムード（検索・AI提案用）
  category TEXT,  -- 例: 'pop', 'classical', 'ambient', 'action', 'comedy'
  mood TEXT,      -- 例: '明るい', '落ち着いた', 'ドラマチック', '緊張感'
  tags TEXT,      -- JSON配列: ["元気", "ポップ", "日常"]
  
  -- ファイル情報
  file_url TEXT NOT NULL,
  file_size INTEGER,
  duration_ms INTEGER,
  
  -- サムネイル（波形画像など）
  thumbnail_url TEXT,
  
  -- ソース情報（SunoAI等）
  source TEXT,         -- 'suno_ai', 'manual_upload', etc.
  source_metadata TEXT, -- JSON: SunoAIのプロンプト等
  
  -- 管理
  created_by TEXT DEFAULT 'admin',
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  
  -- タイムスタンプ
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_system_audio_library_type ON system_audio_library(audio_type);
CREATE INDEX IF NOT EXISTS idx_system_audio_library_category ON system_audio_library(category);
CREATE INDEX IF NOT EXISTS idx_system_audio_library_mood ON system_audio_library(mood);
CREATE INDEX IF NOT EXISTS idx_system_audio_library_active ON system_audio_library(is_active);

-- サンプルデータ（デモ用 - 実際はSunoAIで生成した曲をアップロード）
-- INSERT INTO system_audio_library (audio_type, name, description, category, mood, tags, file_url, duration_ms, source)
-- VALUES 
--   ('bgm', '明るい日常BGM', 'ポップで明るい雰囲気の日常シーン向けBGM', 'pop', '明るい', '["元気", "ポップ", "日常"]', '/audio/system/bgm_bright_daily.mp3', 120000, 'suno_ai'),
--   ('bgm', '感動のクライマックス', 'ドラマチックで感動的なシーン向けBGM', 'orchestral', 'ドラマチック', '["感動", "クライマックス", "壮大"]', '/audio/system/bgm_dramatic.mp3', 180000, 'suno_ai'),
--   ('sfx', '驚きの効果音', 'キャラクターが驚いた時の効果音', 'reaction', '驚き', '["驚き", "リアクション"]', '/audio/system/sfx_surprise.mp3', 1000, 'manual_upload');
