-- ============================================================
-- R4: SSOTパッチ（チャット修正）の監査ログ + 差分管理
-- ============================================================
-- 目的:
--   1. ユーザーのチャット修正リクエストを記録
--   2. dry-run/apply の結果を保存
--   3. ロールバック可能な差分管理
-- ============================================================

-- ------------------------------------------------------------
-- 1. patch_requests: 修正リクエスト本体
-- ------------------------------------------------------------
-- 「誰が」「どの動画(build)に対して」「何を指示し」「何を適用し」「結果どうなった」を残す
CREATE TABLE IF NOT EXISTS patch_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- 対象特定（必須）
  project_id INTEGER NOT NULL,
  video_build_id INTEGER,                 -- 修正対象ビルド（任意だが推奨）
  base_project_json_hash TEXT,            -- 元のproject.json hash（競合検知用）

  -- リクエスト者情報（監査用）
  requester_user_id INTEGER,              -- 実行ユーザー（将来の認証用）
  requester_role TEXT DEFAULT 'user',     -- 'user'|'admin'|'superadmin'

  -- ソース情報
  source TEXT NOT NULL DEFAULT 'chat' CHECK (source IN ('chat', 'ui', 'api')),
  user_message TEXT NOT NULL,             -- チャットの生文（LLM入力）
  parsed_intent_json TEXT,                -- LLMが抽出した意図（構造化、任意）

  -- パッチ内容
  ops_json TEXT NOT NULL,                 -- 正規化されたpatch ops（SSOT Patch v1形式）
  
  -- 実行結果
  dry_run_result_json TEXT,               -- dry-runの結果（差分・影響範囲・警告）
  apply_result_json TEXT,                 -- applyの結果（成功/失敗・適用件数）

  -- ステータス
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'dry_run_ok', 'dry_run_failed', 'apply_ok', 'apply_failed', 'cancelled')
  ),

  -- タイムスタンプ
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- 外部キー（projectsテーブルへの参照は任意）
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_patch_requests_project ON patch_requests(project_id);
CREATE INDEX IF NOT EXISTS idx_patch_requests_build ON patch_requests(video_build_id);
CREATE INDEX IF NOT EXISTS idx_patch_requests_status ON patch_requests(status);
CREATE INDEX IF NOT EXISTS idx_patch_requests_created ON patch_requests(created_at DESC);

-- ------------------------------------------------------------
-- 2. patch_effects: 行単位の変更記録（ロールバック用）
-- ------------------------------------------------------------
-- 「どのテーブルのどの行がどう変わったか」を記録
CREATE TABLE IF NOT EXISTS patch_effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patch_request_id INTEGER NOT NULL,

  -- 変更対象
  entity TEXT NOT NULL,                   -- 例: 'scene_balloons', 'scene_audio_cues'
  pk_json TEXT NOT NULL,                  -- 例: {"id": 123}
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),

  -- 変更内容
  before_json TEXT,                       -- 変更前（createの場合はNULL）
  after_json TEXT,                        -- 変更後（deleteの場合はNULL）

  -- タイムスタンプ
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (patch_request_id) REFERENCES patch_requests(id) ON DELETE CASCADE
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_patch_effects_patch ON patch_effects(patch_request_id);
CREATE INDEX IF NOT EXISTS idx_patch_effects_entity ON patch_effects(entity);
