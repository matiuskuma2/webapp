-- R2: scene_telops テーブル（テロップ/字幕 SSOT）
-- 吹き出し外のテキスト表示（説明文、ナレーション字幕、補足情報など）
-- utterance_id を指定すれば音声区間に連動、NULL なら手動タイミング

CREATE TABLE IF NOT EXISTS scene_telops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  utterance_id INTEGER,  -- scene_utterances への参照（NULL=独立テロップ）

  -- テキスト内容
  text TEXT NOT NULL,

  -- 位置・サイズ（正規化座標 0.0〜1.0）
  x REAL NOT NULL DEFAULT 0.5,          -- 中心X
  y REAL NOT NULL DEFAULT 0.9,          -- 中心Y（デフォルトは画面下部）
  w REAL NOT NULL DEFAULT 0.8,          -- 幅
  h REAL,                               -- 高さ（NULL=自動計算）

  -- テキスト配置
  text_align TEXT NOT NULL DEFAULT 'center' CHECK (text_align IN (
    'left', 'center', 'right'
  )),

  -- スタイル
  style TEXT NOT NULL DEFAULT 'subtitle' CHECK (style IN (
    'subtitle',     -- 字幕スタイル（下部、背景付き）
    'caption',      -- キャプション（上部、小さめ）
    'title',        -- タイトル（大きめ、中央）
    'emphasis',     -- 強調（大きめ、アニメーション付き）
    'custom'        -- カスタム（全パラメータ手動）
  )),

  -- フォント設定
  font_family TEXT DEFAULT 'sans-serif',
  font_weight INTEGER DEFAULT 700,      -- 400=normal, 700=bold
  font_size INTEGER DEFAULT 28,         -- px

  -- スタイリング
  stroke_enabled INTEGER NOT NULL DEFAULT 1 CHECK (stroke_enabled IN (0, 1)),
  stroke_width INTEGER DEFAULT 2,       -- 文字の縁取り幅
  stroke_color TEXT DEFAULT '#000000',  -- 縁取り色

  bg_enabled INTEGER NOT NULL DEFAULT 1 CHECK (bg_enabled IN (0, 1)),
  bg_color TEXT DEFAULT 'rgba(0,0,0,0.6)',   -- 背景色（半透明黒）
  bg_padding INTEGER DEFAULT 8,              -- 背景の余白 px

  text_color TEXT DEFAULT '#FFFFFF',    -- 文字色

  -- 表示モード
  display_mode TEXT NOT NULL DEFAULT 'utterance_window' CHECK (display_mode IN (
    'utterance_window',  -- utterance の音声区間に連動
    'manual_window',     -- start_ms/end_ms を手動指定
    'always'             -- シーン全体で常時表示
  )),

  -- 表示タイミング（manual_window 時に使用）
  start_ms INTEGER,
  end_ms INTEGER,

  -- アニメーション
  enter_animation TEXT DEFAULT 'fade' CHECK (enter_animation IN (
    'none', 'fade', 'slide_up', 'slide_down', 'scale'
  )),
  exit_animation TEXT DEFAULT 'fade' CHECK (exit_animation IN (
    'none', 'fade', 'slide_up', 'slide_down', 'scale'
  )),
  animation_duration_ms INTEGER DEFAULT 150,  -- アニメーション時間

  -- レイヤー順
  z_index INTEGER NOT NULL DEFAULT 10,   -- テロップはデフォルトで吹き出しより上

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (utterance_id) REFERENCES scene_utterances(id) ON DELETE SET NULL
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_scene_telops_scene_id ON scene_telops(scene_id);
CREATE INDEX IF NOT EXISTS idx_scene_telops_utterance_id ON scene_telops(utterance_id);
