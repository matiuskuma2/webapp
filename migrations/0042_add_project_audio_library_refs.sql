-- ====================================================================
-- 0042: project_audio_tracks にライブラリ参照カラムを追加
-- ====================================================================
-- 
-- 目的:
--   - プロジェクトBGMをシステムライブラリまたはユーザーライブラリから
--     選択して設定できるようにする
--   - アップロードだけでなく、既存ライブラリからの選択に対応
--
-- ====================================================================

-- ライブラリ参照用カラムを追加
ALTER TABLE project_audio_tracks ADD COLUMN audio_library_type TEXT CHECK (audio_library_type IN ('upload', 'system', 'user'));

ALTER TABLE project_audio_tracks ADD COLUMN system_audio_id INTEGER REFERENCES system_audio_library(id) ON DELETE SET NULL;

ALTER TABLE project_audio_tracks ADD COLUMN user_audio_id INTEGER REFERENCES user_audio_library(id) ON DELETE SET NULL;

-- 既存レコードをuploadタイプとして設定
UPDATE project_audio_tracks 
SET audio_library_type = 'upload' 
WHERE audio_library_type IS NULL AND r2_key IS NOT NULL;

-- ====================================================================
-- 運用ルール（SSOT）
-- ====================================================================
-- 
-- audio_library_type:
--   - 'upload': 直接アップロードされたファイル（r2_keyが必須）
--   - 'system': システムライブラリから選択（system_audio_idが必須）
--   - 'user': ユーザーライブラリから選択（user_audio_idが必須）
--
-- r2_url の扱い:
--   - upload: 直接アップロードしたファイルのR2 URL
--   - system: system_audio_library.file_url を参照して設定
--   - user: user_audio_library.r2_url を参照して設定
--
-- ====================================================================
