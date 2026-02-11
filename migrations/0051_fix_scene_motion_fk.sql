-- Migration: 0051_fix_scene_motion_fk
-- Description: scene_motion テーブルの壊れたFK参照を修正
-- Problem: motion_presets → motion_presets_old リネーム後にscene_motionが作成されたため、
--          FK が "motion_presets_old"(存在しないテーブル) を参照している。
--          PRAGMA foreign_keys = ON 環境でDELETEがエラーになる原因。
-- Date: 2026-02-11

-- Step 1: 既存データを退避
CREATE TABLE IF NOT EXISTS scene_motion_backup AS SELECT * FROM scene_motion;

-- Step 2: 壊れたテーブルを削除
DROP TABLE IF EXISTS scene_motion;

-- Step 3: 正しいFKで再作成
CREATE TABLE scene_motion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL UNIQUE,
  motion_preset_id TEXT NOT NULL DEFAULT 'kenburns_soft',
  custom_params TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (motion_preset_id) REFERENCES motion_presets(id)
);

-- Step 4: データ復元
INSERT INTO scene_motion (id, scene_id, motion_preset_id, custom_params, created_at, updated_at)
  SELECT id, scene_id, motion_preset_id, custom_params, created_at, updated_at
  FROM scene_motion_backup;

-- Step 5: バックアップテーブル削除
DROP TABLE IF EXISTS scene_motion_backup;
