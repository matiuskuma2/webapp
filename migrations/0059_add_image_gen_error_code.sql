-- Migration 0059: Add error_code column to image_generations
-- Phase 1-B: ポーリング用にエラーコードカラムを追加
-- Phase 1-A: 'queued' ステータス対応（CHECK制約を削除して再作成は不要、D1はALTER TABLE DROP CONSTRAINTをサポートしない）

-- error_code カラム追加
ALTER TABLE image_generations ADD COLUMN error_code TEXT;

-- duration_ms カラム追加（Gemini API処理時間）
ALTER TABLE image_generations ADD COLUMN duration_ms INTEGER;

-- error_code にインデックス追加（メトリクス集計用）
CREATE INDEX IF NOT EXISTS idx_image_gen_error_code
  ON image_generations(error_code);
