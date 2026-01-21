-- R2: scene_motion テーブル（静止画モーション詳細設定）
-- scenes.motion_preset がプリセット名、scene_motion がカスタムパラメータ
-- シーンに1つだけ存在（1:1 関係）

CREATE TABLE IF NOT EXISTS scene_motion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL UNIQUE,  -- 1:1 関係

  -- プリセット（scenes.motion_preset と同期）
  preset TEXT NOT NULL DEFAULT 'kenburns' CHECK (preset IN (
    'none',       -- 動きなし
    'kenburns',   -- Ken Burns（ズーム + パン）
    'pan',        -- 単純パン（横/縦移動）
    'parallax'    -- 視差効果
  )),

  -- 開始・終了スケール（1.0 = 100%）
  start_scale REAL NOT NULL DEFAULT 1.0,
  end_scale REAL NOT NULL DEFAULT 1.1,

  -- 開始・終了位置（正規化座標、0=中央、正=右/下、負=左/上）
  start_x REAL NOT NULL DEFAULT 0.0,
  start_y REAL NOT NULL DEFAULT 0.0,
  end_x REAL NOT NULL DEFAULT 0.0,
  end_y REAL NOT NULL DEFAULT 0.05,

  -- イージング
  ease TEXT NOT NULL DEFAULT 'easeInOut' CHECK (ease IN (
    'linear',       -- 一定速度
    'easeIn',       -- 加速
    'easeOut',      -- 減速
    'easeInOut',    -- 加速→減速（推奨）
    'spring'        -- バネ効果
  )),

  -- Parallax 用の追加設定（将来拡張）
  params_json TEXT,  -- {"layers": [...]} など

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);

-- インデックス（scene_id は UNIQUE なので自動でインデックス作成されるが明示）
CREATE INDEX IF NOT EXISTS idx_scene_motion_preset ON scene_motion(preset);
