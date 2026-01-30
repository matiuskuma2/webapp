-- ====================================================================
-- 0040: user_audio_library（ユーザー音素材ライブラリ）
-- ====================================================================
-- 
-- 目的:
--   - BGM/SFXをプロジェクト横断で再利用可能にする
--   - キャラクターと同じ「再利用前提アセット」として設計
--   - 将来のAI提案・チャット操作の基盤
--
-- 設計方針:
--   - user_id に紐付き（project_id には紐付かない）
--   - system_audio_library（管理者登録）と並列
--   - タグ/ムードでAI提案に対応
--
-- SSOT:
--   - 音素材の唯一の真実: system_audio_library + user_audio_library
--   - シーンへの割当: scene_audio_assignments（別migration）
--
-- ====================================================================

CREATE TABLE IF NOT EXISTS user_audio_library (
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

-- インデックス
CREATE INDEX IF NOT EXISTS idx_user_audio_library_user_id 
  ON user_audio_library(user_id);
CREATE INDEX IF NOT EXISTS idx_user_audio_library_type 
  ON user_audio_library(user_id, audio_type);
CREATE INDEX IF NOT EXISTS idx_user_audio_library_active 
  ON user_audio_library(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_user_audio_library_category 
  ON user_audio_library(category);
CREATE INDEX IF NOT EXISTS idx_user_audio_library_mood 
  ON user_audio_library(mood);

-- ====================================================================
-- 運用ルール（SSOT）
-- ====================================================================
-- 
-- 音素材の唯一の真実:
--   - 管理者登録 → system_audio_library
--   - ユーザー登録 → user_audio_library
--   - プロジェクトには紐付かない（キャラクターと同じ設計）
--
-- チャット操作:
--   - 「いつもの明るいBGM」→ user_audio_library から検索
--   - 「前に使った効果音」→ use_count / updated_at で推定
--   - 「緊張感あるBGM」→ mood='緊張感' で検索
--
-- AI提案:
--   - tags, mood, category を使って適切な音素材を推薦
--   - use_count が高いものを優先
--
-- ====================================================================
