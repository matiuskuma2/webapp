-- R2: scenes テーブルに描画制御カラムを追加
-- text_render_mode: Remotion で描画 / 画像に焼き込み済み / 文字なし
-- motion_preset: 静止画の動きプリセット
-- motion_params_json: Ken Burns 等の詳細パラメータ

-- text_render_mode: Remotion描画制御
-- 'remotion': Remotion で吹き出し/テロップを描画（R2推奨）
-- 'baked': 画像に文字が焼き込み済み（Remotionは描画しない）
-- 'none': 文字描画なし（ナレーションのみ）
ALTER TABLE scenes ADD COLUMN text_render_mode TEXT NOT NULL DEFAULT 'remotion'
  CHECK (text_render_mode IN ('remotion', 'baked', 'none'));

-- motion_preset: 静止画の動きプリセット
-- 'none': 動きなし（静止）
-- 'kenburns': Ken Burns エフェクト（ズーム + パン）
-- 'pan': 横/縦パン
-- 'parallax': 視差効果（レイヤー分離が必要）
ALTER TABLE scenes ADD COLUMN motion_preset TEXT NOT NULL DEFAULT 'kenburns'
  CHECK (motion_preset IN ('none', 'kenburns', 'pan', 'parallax'));

-- motion_params_json: 動きの詳細パラメータ（JSON）
-- 例: {"start_scale": 1.0, "end_scale": 1.1, "start_x": 0, "end_x": 0.1, "ease": "easeInOut"}
ALTER TABLE scenes ADD COLUMN motion_params_json TEXT;

-- インデックス（text_render_mode での検索最適化）
CREATE INDEX IF NOT EXISTS idx_scenes_text_render_mode ON scenes(text_render_mode);
