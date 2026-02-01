-- Migration: 0043_add_scenes_is_hidden
-- Description: シーンのソフトデリート（非表示）機能追加
-- Date: 2026-02-01
-- Rationale: 
--   シーン削除は CASCADE により関連データ（画像・音声・動画生成履歴等）が
--   すべて失われるリスクがあるため、非表示フラグによるソフトデリートを導入。
--   is_hidden = 1 のシーンはビルド対象外となるが、データは保持される。

-- Add is_hidden column to scenes table
ALTER TABLE scenes ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;

-- Create index for filtering visible scenes
CREATE INDEX IF NOT EXISTS idx_scenes_is_hidden ON scenes(project_id, is_hidden);
