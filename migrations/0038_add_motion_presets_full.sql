-- Phase A-1: motion_presets テーブルにフルプリセットセットを追加
-- video-build-helpers.ts の MOTION_PRESETS_MAP と完全同期
--
-- 既存7種: none, kenburns_soft, kenburns_strong, pan_lr, pan_rl, pan_tb, pan_bt
-- 追加13種: kenburns_zoom_out, slide_*, hold_then_slide_*, combined_zoom_pan_*, auto
--
-- CHECK制約の拡張: motion_type に 'hold_then_pan' を追加
-- SQLite は ALTER TABLE ... ALTER COLUMN をサポートしないため、
-- 新テーブルを作成してデータを移行する

-- Step 1: 旧テーブルをリネーム
ALTER TABLE motion_presets RENAME TO motion_presets_old;

-- Step 2: 新テーブル作成（hold_then_pan を CHECK に追加）
CREATE TABLE motion_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  motion_type TEXT NOT NULL CHECK(motion_type IN ('none', 'zoom', 'pan', 'combined', 'hold_then_pan')),
  params TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Step 3: 旧データを移行
INSERT INTO motion_presets (id, name, description, motion_type, params, is_active, sort_order, created_at)
  SELECT id, name, description, motion_type, params, is_active, sort_order, created_at
  FROM motion_presets_old;

-- Step 4: 旧テーブル削除
DROP TABLE motion_presets_old;

-- Step 5: インデックス再作成
CREATE INDEX IF NOT EXISTS idx_motion_presets_active ON motion_presets(is_active, sort_order);

-- Step 6: 新しいプリセットを追加（13種 + auto）
-- ズーム系
INSERT OR IGNORE INTO motion_presets (id, name, description, motion_type, params, is_active, sort_order) VALUES
  ('kenburns_zoom_out', 'ズームアウト', 'Ken Burnsエフェクト（1.1→1.0）', 'zoom', '{"start_scale":1.1,"end_scale":1.0}', 1, 3);

-- スライド系（パンより大きな移動量）
INSERT OR IGNORE INTO motion_presets (id, name, description, motion_type, params, is_active, sort_order) VALUES
  ('slide_lr', 'スライド（左→右）', '大きめの横スライド', 'pan', '{"start_x":-10,"end_x":10,"start_y":0,"end_y":0}', 1, 10),
  ('slide_rl', 'スライド（右→左）', '大きめの横スライド（逆）', 'pan', '{"start_x":10,"end_x":-10,"start_y":0,"end_y":0}', 1, 11),
  ('slide_tb', 'スライド（上→下）', '大きめの縦スライド', 'pan', '{"start_x":0,"end_x":0,"start_y":-10,"end_y":10}', 1, 12),
  ('slide_bt', 'スライド（下→上）', '大きめの縦スライド（逆）', 'pan', '{"start_x":0,"end_x":0,"start_y":10,"end_y":-10}', 1, 13);

-- 静止→スライド系（hold_then_pan）
INSERT OR IGNORE INTO motion_presets (id, name, description, motion_type, params, is_active, sort_order) VALUES
  ('hold_then_slide_lr', '静止→スライド（左→右）', '前半静止、後半スライド', 'hold_then_pan', '{"start_x":-5,"end_x":10,"start_y":0,"end_y":0,"hold_ratio":0.3}', 1, 20),
  ('hold_then_slide_rl', '静止→スライド（右→左）', '前半静止、後半スライド（逆）', 'hold_then_pan', '{"start_x":5,"end_x":-10,"start_y":0,"end_y":0,"hold_ratio":0.3}', 1, 21),
  ('hold_then_slide_tb', '静止→スライド（上→下）', '前半静止、後半縦スライド', 'hold_then_pan', '{"start_x":0,"end_x":0,"start_y":-5,"end_y":10,"hold_ratio":0.3}', 1, 22),
  ('hold_then_slide_bt', '静止→スライド（下→上）', '前半静止、後半縦スライド（逆）', 'hold_then_pan', '{"start_x":0,"end_x":0,"start_y":5,"end_y":-10,"hold_ratio":0.3}', 1, 23);

-- 複合系（ズーム＋パン同時）
INSERT OR IGNORE INTO motion_presets (id, name, description, motion_type, params, is_active, sort_order) VALUES
  ('combined_zoom_pan_lr', 'ズーム＋パン（左→右）', 'ズームインしながら右へ', 'combined', '{"start_scale":1.0,"end_scale":1.08,"start_x":-3,"end_x":3,"start_y":0,"end_y":0}', 1, 30),
  ('combined_zoom_pan_rl', 'ズーム＋パン（右→左）', 'ズームインしながら左へ', 'combined', '{"start_scale":1.0,"end_scale":1.08,"start_x":3,"end_x":-3,"start_y":0,"end_y":0}', 1, 31);

-- 自動（シード基準ランダム選択）
INSERT OR IGNORE INTO motion_presets (id, name, description, motion_type, params, is_active, sort_order) VALUES
  ('auto', '自動（シード基準）', 'シーンIDに基づき8種類から自動選択。再ビルドでも同じ結果', 'none', '{}', 1, 99);
