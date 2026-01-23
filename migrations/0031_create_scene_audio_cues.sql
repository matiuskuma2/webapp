-- R3-B: Scene Audio Cues (SFX/効果音)
-- シーン内の特定タイミングで再生される効果音を管理
-- 
-- 設計思想:
-- - BGM: project_audio_tracks（通し再生）
-- - SFX: scene_audio_cues（シーン内タイミング指定）
-- - Voice: scene_utterances（音声パーツ）
-- 
-- この3層でAudio全体のSSOTを構成

CREATE TABLE IF NOT EXISTS scene_audio_cues (
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

-- インデックス
CREATE INDEX IF NOT EXISTS idx_scene_audio_cues_scene_id ON scene_audio_cues(scene_id);
CREATE INDEX IF NOT EXISTS idx_scene_audio_cues_active ON scene_audio_cues(scene_id, is_active);
CREATE INDEX IF NOT EXISTS idx_scene_audio_cues_type ON scene_audio_cues(cue_type);
