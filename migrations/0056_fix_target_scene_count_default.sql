-- Fix: target_scene_count の DEFAULT 5 を NULL に変更
-- 原因: DEFAULT 5 のせいで、新規プロジェクトでも常に target_scene_count=5 が返り、
--        フロントエンドが段落数ではなく 5 を初期表示してしまうバグ
--
-- SQLite では ALTER TABLE ... ALTER COLUMN がサポートされないため、
-- 既存データの 5 を NULL にリセットするだけでOK
-- （カラムのDEFAULTは変更できないが、INSERT時にNULLを明示すれば問題ない）

-- 既存プロジェクトで target_scene_count=5（デフォルトのまま）のものを NULL にリセット
-- ユーザーが明示的に 5 を選んだケースもリセットされるが、
-- 次回 format 実行時に正しい値が設定されるため問題ない
UPDATE projects SET target_scene_count = NULL WHERE target_scene_count = 5;
