-- ====================================================================
-- 0019_add_scene_speech_type.sql - NO-OP
-- ====================================================================
-- 
-- このマイグレーションは既に本番環境に speech_type カラムが存在するため
-- NO-OP（何もしない）に変更されています。
-- 
-- 背景:
--   - speech_type カラムは 0001_full_schema_from_production.sql または
--     別経路で既に本番DBに追加済み
--   - d1_migrations テーブルには記録されていなかったため、
--     wrangler migrations apply が再度実行しようとしてエラー発生
--   - duplicate column name: speech_type
-- 
-- 解決:
--   - このファイルを NO-OP 化して、安全にマイグレーション適用を継続できるようにする
--   - IF NOT EXISTS でインデックスだけ作成（冪等性を保証）
-- 
-- 元のコード（参考）:
--   ALTER TABLE scenes ADD COLUMN speech_type TEXT DEFAULT 'dialogue';
--   CREATE INDEX IF NOT EXISTS idx_scenes_speech_type ON scenes(speech_type);
-- 
-- ====================================================================

-- NO-OP: カラムは既に存在するためスキップ
-- ALTER TABLE scenes ADD COLUMN speech_type TEXT DEFAULT 'dialogue';

-- インデックスのみ作成（IF NOT EXISTS で冪等）
CREATE INDEX IF NOT EXISTS idx_scenes_speech_type ON scenes(speech_type);
