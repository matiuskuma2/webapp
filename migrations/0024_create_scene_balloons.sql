-- R2: scene_balloons テーブル（吹き出し SSOT）
-- utterance と紐づき、表示タイミングは utterance の音声区間に連動
-- display_mode='voice_window' なら [start_ms, end_ms] は utterance 区間を自動採用

CREATE TABLE IF NOT EXISTS scene_balloons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  utterance_id INTEGER,  -- scene_utterances への参照（NULL=手動配置の独立吹き出し）

  -- 位置・サイズ（正規化座標 0.0〜1.0）
  x REAL NOT NULL DEFAULT 0.5,          -- 中心X
  y REAL NOT NULL DEFAULT 0.5,          -- 中心Y
  w REAL NOT NULL DEFAULT 0.3,          -- 幅
  h REAL NOT NULL DEFAULT 0.2,          -- 高さ

  -- 吹き出し形状
  shape TEXT NOT NULL DEFAULT 'round' CHECK (shape IN (
    'round',    -- 丸型（通常会話）
    'square',   -- 角型
    'thought',  -- もくもく（思考）
    'shout',    -- ギザギザ（叫び）
    'caption'   -- キャプション（枠なし/四角枠）
  )),

  -- しっぽ（吹き出しの尾）
  tail_enabled INTEGER NOT NULL DEFAULT 1 CHECK (tail_enabled IN (0, 1)),
  tail_tip_x REAL DEFAULT 0.5,          -- しっぽ先端X（0.0〜1.0）
  tail_tip_y REAL DEFAULT 1.2,          -- しっぽ先端Y（吹き出し外に向かって）

  -- テキスト配置
  writing_mode TEXT NOT NULL DEFAULT 'horizontal' CHECK (writing_mode IN (
    'horizontal',  -- 横書き
    'vertical'     -- 縦書き
  )),
  text_align TEXT NOT NULL DEFAULT 'center' CHECK (text_align IN (
    'left', 'center', 'right'
  )),

  -- フォント設定
  font_family TEXT DEFAULT 'sans-serif',
  font_weight INTEGER DEFAULT 700,      -- 400=normal, 700=bold
  font_size INTEGER DEFAULT 24,         -- px
  line_height REAL DEFAULT 1.4,         -- 行間

  -- スタイリング
  padding INTEGER DEFAULT 12,           -- 内側余白 px
  bg_color TEXT DEFAULT '#FFFFFF',      -- 背景色
  text_color TEXT DEFAULT '#000000',    -- 文字色
  border_color TEXT DEFAULT '#000000',  -- 枠線色
  border_width INTEGER DEFAULT 2,       -- 枠線幅 px

  -- 表示モード
  display_mode TEXT NOT NULL DEFAULT 'voice_window' CHECK (display_mode IN (
    'voice_window',   -- utterance の音声区間に連動（推奨）
    'manual_window'   -- start_ms/end_ms を手動指定
  )),

  -- 表示タイミング（manual_window 時に使用）
  start_ms INTEGER,
  end_ms INTEGER,

  -- レイヤー順
  z_index INTEGER NOT NULL DEFAULT 0,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (utterance_id) REFERENCES scene_utterances(id) ON DELETE CASCADE
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_scene_balloons_scene_id ON scene_balloons(scene_id);
CREATE INDEX IF NOT EXISTS idx_scene_balloons_utterance_id ON scene_balloons(utterance_id);

-- ユニーク制約: 1つの utterance に対して 1つの吹き出し（voice_window モードの場合）
-- ただし manual_window では同じ utterance に複数吹き出しを許可する場合があるため、
-- この制約は適用しない（アプリケーションレイヤーで制御）
