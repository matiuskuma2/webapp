-- 0036: scene_balloons に display_policy を追加（SSOT）
-- always_on: 常時表示（シーン中ずっと）
-- voice_window: 音声パーツ時間窓に同期（デフォルト）
-- manual_window: start_ms/end_ms を手動指定

-- display_policy カラム追加
ALTER TABLE scene_balloons
ADD COLUMN display_policy TEXT NOT NULL DEFAULT 'voice_window';

-- 既存 display_mode を display_policy に移行（後方互換）
-- manual_window だけ manual_window、それ以外は voice_window
UPDATE scene_balloons
SET display_policy = CASE
  WHEN display_mode = 'manual_window' THEN 'manual_window'
  ELSE 'voice_window'
END;

-- クエリ高速化用インデックス
CREATE INDEX IF NOT EXISTS idx_scene_balloons_policy
ON scene_balloons(scene_id, display_policy);
