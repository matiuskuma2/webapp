-- Migration: 0046_add_character_style_preset
-- Description: キャラクターごとに画像スタイルプリセットを設定可能にする
-- Date: 2026-02-01

-- キャラクターモデルにスタイルプリセットIDを追加
ALTER TABLE project_character_models ADD COLUMN style_preset_id INTEGER REFERENCES style_presets(id);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_pcm_style_preset ON project_character_models(style_preset_id);
