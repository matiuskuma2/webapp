-- Migration: 0058_create_job_queue.sql
-- Created: 2026-03-08
-- Description: Rate-Limit-Aware Job Queue
--   ジョブベースの非同期処理キュー。全てのAI API呼び出しを
--   job_queue テーブル経由で管理し、429対応・同時実行制御・リトライを統一。
--   設計ドキュメント: docs/RATE_LIMIT_AWARE_ARCHITECTURE_v1.md

-- =====================================================
-- 1. job_queue — 全処理ジョブの SSOT
-- =====================================================
CREATE TABLE IF NOT EXISTS job_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- 所属
  user_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,

  -- ジョブ定義
  job_type TEXT NOT NULL,   -- 'generate_image', 'format_chunk', 'generate_audio', 'generate_video'
  provider TEXT NOT NULL,   -- 'gemini_image', 'openai_gpt4o', 'google_tts', 'fish_audio', 'elevenlabs', 'laozhang_veo', 'laozhang_sora'

  -- ステータス
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'retry_wait', 'completed', 'failed', 'canceled')),
  priority INTEGER NOT NULL DEFAULT 100,  -- 低い値 = 高優先度 (1=urgent, 100=normal, 200=background)

  -- リトライ制御
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  next_retry_at TEXT,      -- ISO datetime: retry_wait ステータス時の次回実行予定

  -- ロック制御 (楽観ロック)
  locked_at TEXT,          -- ISO datetime: processing 開始時刻
  locked_by TEXT,          -- リクエスト識別子 (request ID / worker ID)

  -- ペイロード
  payload_json TEXT NOT NULL DEFAULT '{}',  -- ジョブ固有パラメータ (JSON)
  result_json TEXT,                         -- 完了時の結果 (JSON)

  -- エラー情報
  error_code TEXT,
  error_message TEXT,

  -- 関連エンティティ (ジョブタイプ別)
  entity_type TEXT,   -- 'scene', 'text_chunk', 'utterance', 'video_generation'
  entity_id INTEGER,  -- 対応レコードのID

  -- タイムスタンプ
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- ジョブ取得用: status + provider + priority + created_at
CREATE INDEX IF NOT EXISTS idx_job_queue_fetch
  ON job_queue(status, provider, priority, created_at);

-- プロジェクト単位の進捗確認
CREATE INDEX IF NOT EXISTS idx_job_queue_project
  ON job_queue(project_id, job_type, status);

-- ユーザー単位の使用量確認
CREATE INDEX IF NOT EXISTS idx_job_queue_user
  ON job_queue(user_id, status);

-- retry_wait ジョブの next_retry_at 検索
CREATE INDEX IF NOT EXISTS idx_job_queue_retry
  ON job_queue(next_retry_at) WHERE status = 'retry_wait';

-- stuck ジョブ検出用 (processing のまま locked_at が古い)
CREATE INDEX IF NOT EXISTS idx_job_queue_stuck
  ON job_queue(locked_at) WHERE status = 'processing';

-- entity 逆引き
CREATE INDEX IF NOT EXISTS idx_job_queue_entity
  ON job_queue(entity_type, entity_id) WHERE entity_type IS NOT NULL;


-- =====================================================
-- 2. provider_usage — プロバイダー別メトリクス (時間窓)
-- =====================================================
CREATE TABLE IF NOT EXISTS provider_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  provider TEXT NOT NULL,     -- 'gemini_image', 'openai_gpt4o', etc.
  model TEXT,                 -- 'gemini-3.1-flash-image-preview', 'gpt-4o-2024-08-06'
  window_key TEXT NOT NULL,   -- 'minute:2026-03-07T14:30', 'hour:2026-03-07T14'

  -- メトリクス
  request_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_429_count INTEGER NOT NULL DEFAULT 0,
  error_timeout_count INTEGER NOT NULL DEFAULT 0,
  error_other_count INTEGER NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,  -- avg = total_latency_ms / MAX(success_count,1)

  -- サーキットブレーカー
  circuit_open_until TEXT,  -- datetime: この時刻まで新規リクエストをブロック

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(provider, model, window_key)
);

CREATE INDEX IF NOT EXISTS idx_provider_usage_window
  ON provider_usage(provider, window_key);

CREATE INDEX IF NOT EXISTS idx_provider_usage_circuit
  ON provider_usage(circuit_open_until) WHERE circuit_open_until IS NOT NULL;
