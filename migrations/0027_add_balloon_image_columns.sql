-- ====================================================================
-- 0027: A案 baked 対応 - scene_balloons に画像素材カラムを追加
-- ====================================================================
-- 
-- A案 baked の定義（固定）:
--   - 漫画制作で「文字入りバブルPNG」を作成
--   - Remotion は bubble_r2_url の画像を utterance 時間窓で ON/OFF
--   - Remotion で文字を「描かない」（テキストレンダリングなし）
--   - 見た目は漫画制作側で 100% 確定（SSOT）
--
-- text_render_mode の意味（固定）:
--   - 'remotion': Remotion が文字を描く（テロップ/字幕用）
--   - 'baked':    Remotion は文字を描かない（bubble_r2_url の画像を表示）
--   - 'none':     文字表示なし
--
-- ====================================================================

-- 1. バブル画像のR2参照カラム追加
ALTER TABLE scene_balloons ADD COLUMN bubble_r2_key TEXT;
ALTER TABLE scene_balloons ADD COLUMN bubble_r2_url TEXT;

-- 2. 画像サイズ（実ピクセル、Remotion レンダリング用）
ALTER TABLE scene_balloons ADD COLUMN bubble_width_px INTEGER;
ALTER TABLE scene_balloons ADD COLUMN bubble_height_px INTEGER;

-- 3. 画像バージョン管理（キャッシュ無効化用）
ALTER TABLE scene_balloons ADD COLUMN bubble_source_version INTEGER NOT NULL DEFAULT 1;

-- 4. 画像更新日時
ALTER TABLE scene_balloons ADD COLUMN bubble_updated_at DATETIME;

-- ====================================================================
-- 運用ルール（コメントとして明記）
-- ====================================================================
-- 
-- A案 baked 成立条件:
--   1. bubble_r2_url が NOT NULL（画像素材が存在）
--   2. scene.text_render_mode = 'baked'
--   3. utterance_id が NOT NULL（タイミング情報の参照先）
--
-- Remotion 表示ルール:
--   - base: display_asset_type='comic' → active_comic.r2_url
--   - overlay: bubble_r2_url を start_ms <= t < end_ms の間だけ表示
--   - 字幕コンポーネント: text_render_mode='baked' なら OFF
--
-- 事故防止:
--   - text_render_mode='baked' && bubble_r2_url=NULL → 何も表示しない（警告）
--   - 漫画シーンに Remotion 字幕を乗せると二重表示になるため禁止
--
-- ====================================================================
