-- ====================================================================
-- 0029: R3-A 通しBGM（project_audio_tracks）
-- ====================================================================
-- 
-- 目的:
--   - プロジェクト全体を通して流れるBGMを管理
--   - セリフなしシーンでもBGMだけで動画が成立する
--   - 将来のダッキング（声の間だけBGM下げる）に対応
--
-- 設計方針:
--   - 1プロジェクトにつき active BGM は最大1本
--   - 音声（voices/utterances）とBGM（tracks）は分離
--   - ダッキング設定は今回は未実装だがカラムは用意
--
-- ====================================================================

CREATE TABLE IF NOT EXISTS project_audio_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,

  -- トラックタイプ（まずはBGMのみ）
  track_type TEXT NOT NULL DEFAULT 'bgm' CHECK (track_type IN ('bgm')),

  -- 音源（R2）
  r2_key TEXT,
  r2_url TEXT,
  duration_ms INTEGER,           -- 音源の長さ（後でprobe可能）

  -- 再生設定
  volume REAL NOT NULL DEFAULT 0.25,    -- 0.0-1.0（BGMはデフォルト0.25）
  loop INTEGER NOT NULL DEFAULT 1 CHECK (loop IN (0,1)),
  fade_in_ms INTEGER NOT NULL DEFAULT 800,
  fade_out_ms INTEGER NOT NULL DEFAULT 800,

  -- ダッキング設定（R3-Cで実装、今は未使用）
  ducking_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ducking_enabled IN (0,1)),
  ducking_volume REAL NOT NULL DEFAULT 0.12,       -- 声が鳴ってる間のBGM音量
  ducking_attack_ms INTEGER NOT NULL DEFAULT 120,  -- ダッキング開始の遷移時間
  ducking_release_ms INTEGER NOT NULL DEFAULT 220, -- ダッキング解除の遷移時間

  -- アクティブフラグ（1プロジェクトにつき1本だけactive）
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_project_audio_tracks_project_id
  ON project_audio_tracks(project_id);

CREATE INDEX IF NOT EXISTS idx_project_audio_tracks_active
  ON project_audio_tracks(project_id, is_active);

-- ====================================================================
-- 運用ルール（SSOT）
-- ====================================================================
-- 
-- 通しBGM:
--   - project_id ごとに is_active=1 は最大1件（アプリ側で担保）
--   - 新しいBGMをアップロードしたら、古いものは is_active=0
--   - duration_ms は未設定でもOK（将来probeで埋める）
--
-- JSON契約（buildProjectJson）:
--   - audio_global.bgm として出力
--   - r2_url は絶対URLに変換してRemotionに渡す
--   - BGMがなければ audio_global 自体を出さない
--
-- ====================================================================
