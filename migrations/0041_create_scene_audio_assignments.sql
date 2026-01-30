-- ====================================================================
-- 0041: scene_audio_assignments（シーンへの音素材割当）
-- ====================================================================
-- 
-- 目的:
--   - シーンとBGM/SFXの紐付けを管理
--   - ライブラリ参照 or 直接アップロードの両方に対応
--   - シーン単位での音量・タイミング調整
--
-- 設計方針:
--   - プロジェクトには紐付かない（シーンIDのみ）
--   - 1シーンに複数BGMは持てない（audio_type='bgm' は1件のみ）
--   - SFXは1シーンに複数可能
--   - 既存 scene_audio_cues からの移行パスを確保
--
-- SSOT:
--   - 音素材のSSOT: system_audio_library / user_audio_library
--   - 紐付けのSSOT: scene_audio_assignments（このテーブル）
--   - Video Build時はこのテーブルを読むだけ
--
-- ====================================================================

CREATE TABLE IF NOT EXISTS scene_audio_assignments (
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
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (system_audio_id) REFERENCES system_audio_library(id),
  FOREIGN KEY (user_audio_id) REFERENCES user_audio_library(id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_scene_audio_assignments_scene_id 
  ON scene_audio_assignments(scene_id);
CREATE INDEX IF NOT EXISTS idx_scene_audio_assignments_active 
  ON scene_audio_assignments(scene_id, is_active);
CREATE INDEX IF NOT EXISTS idx_scene_audio_assignments_type 
  ON scene_audio_assignments(scene_id, audio_type);
CREATE INDEX IF NOT EXISTS idx_scene_audio_assignments_bgm 
  ON scene_audio_assignments(scene_id, audio_type, is_active) 
  WHERE audio_type = 'bgm';

-- ====================================================================
-- 運用ルール（SSOT）
-- ====================================================================
-- 
-- BGM（シーン単位）:
--   - 1シーンにつき audio_type='bgm' かつ is_active=1 は最大1件
--   - 同じBGMを複数シーンで使う → 同じ library_id を参照
--   - BGM変更 → 古いレコードを is_active=0、新しいレコードを INSERT
--
-- SFX:
--   - 1シーンに複数 audio_type='sfx' を持てる
--   - 各SFXは start_ms でタイミング指定
--
-- Video Build 取得ルール:
--   SELECT * FROM scene_audio_assignments 
--   WHERE scene_id = ? AND is_active = 1
--   ORDER BY audio_type, start_ms
--
-- フォールバック（移行期間）:
--   - scene_audio_assignments にBGMがない場合
--   - project_audio_tracks の is_active=1 を参照（後方互換）
--   - 移行完了後はフォールバック削除
--
-- チャット操作例:
--   - 「ここにBGM入れて」
--     → scene_audio_assignments INSERT (audio_type='bgm')
--   - 「前と同じBGMにして」
--     → 同じ user_audio_id で INSERT
--   - 「このBGM消して」
--     → is_active=0 に UPDATE
--
-- ====================================================================
