-- Scene Split設定をプロジェクトに保存
-- 再実行時に同じモード・設定を使用するためのSSOT

-- split_mode: 'raw' = 原文保持モード（文字を1文字も変えない）
--             'optimized' = 整形モード（要約/編集OK）
-- target_scene_count: 目標シーン数
-- preserve_newlines: raw モードで改行を維持するか
-- preserve_punctuation: raw モードで句読点を維持するか

ALTER TABLE projects ADD COLUMN split_mode TEXT DEFAULT 'raw';
ALTER TABLE projects ADD COLUMN target_scene_count INTEGER DEFAULT 5;

-- インデックス（optional）
CREATE INDEX IF NOT EXISTS idx_projects_split_mode ON projects(split_mode);
