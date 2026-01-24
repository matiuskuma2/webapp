-- R2-C: motion_presets テーブル（モーションプリセットマスタ）
-- プリセット一覧を管理し、scene_motion からの参照に使用

CREATE TABLE IF NOT EXISTS motion_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  motion_type TEXT NOT NULL CHECK(motion_type IN ('none', 'zoom', 'pan', 'combined')),
  params TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 初期データ挿入
INSERT OR IGNORE INTO motion_presets (id, name, description, motion_type, params, is_active, sort_order) VALUES
  ('none', '動きなし', '静止画のまま表示', 'none', '{}', 1, 0),
  ('kenburns_soft', 'ゆっくりズーム', 'Ken Burnsエフェクト（1.0→1.05）', 'zoom', '{"start_scale":1.0,"end_scale":1.05}', 1, 1),
  ('kenburns_strong', '強めズーム', 'Ken Burnsエフェクト（1.0→1.15）', 'zoom', '{"start_scale":1.0,"end_scale":1.15}', 1, 2),
  ('pan_lr', '左から右', 'パン（左→右）', 'pan', '{"start_x":-5,"end_x":5,"start_y":0,"end_y":0}', 1, 3),
  ('pan_rl', '右から左', 'パン（右→左）', 'pan', '{"start_x":5,"end_x":-5,"start_y":0,"end_y":0}', 1, 4),
  ('pan_tb', '上から下', 'パン（上→下）', 'pan', '{"start_x":0,"end_x":0,"start_y":-5,"end_y":5}', 1, 5),
  ('pan_bt', '下から上', 'パン（下→上）', 'pan', '{"start_x":0,"end_x":0,"start_y":5,"end_y":-5}', 1, 6);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_motion_presets_active ON motion_presets(is_active, sort_order);
