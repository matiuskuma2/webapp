# Rate-Limit-Aware Architecture — 包括的調査レポート & 設計ドキュメント v1

**作成日**: 2026-03-07
**対象プロジェクト**: webapp (丸投げ動画制作SaaS)
**ステータス**: 設計レビュー待ち

---

## 目次

1. [現状分析: アーキテクチャの全体像](#1-現状分析)
2. [検出された問題点 (技術的負債 & インシデント原因)](#2-検出された問題点)
3. [Cloudflare Workers の制約と設計上の判断](#3-cloudflare-workers-の制約)
4. [Rate-Limit-Aware アーキテクチャ設計](#4-rate-limit-aware-アーキテクチャ設計)
5. [DBスキーマ設計](#5-dbスキーマ設計)
6. [フェーズ別実装計画](#6-フェーズ別実装計画)
7. [移行戦略](#7-移行戦略)
8. [リスクと代替案](#8-リスクと代替案)

---

## 1. 現状分析

### 1.1 外部API依存マップ

| Provider | 用途 | エンドポイント | 呼び出し元ファイル | タイムアウト設定 |
|----------|------|---------------|-------------------|-----------------|
| **OpenAI GPT-4o** | シーン分割 (format) | `api.openai.com/v1/chat/completions` | formatting.ts (6箇所) | 60s/30s (修正済) |
| **OpenAI Whisper** | 音声文字起こし | `api.openai.com/v1/audio/transcriptions` | transcriptions.ts | ❌ なし |
| **Gemini Flash Image** | 画像生成 | `generativelanguage.googleapis.com/v1beta/...` | image-generation.ts, marunage.ts | 35s per attempt |
| **Gemini 2.0 Flash** | キャラ分析/パッチ | `generativelanguage.googleapis.com/v1beta/...` | character-models.ts, patches.ts | ❌ なし |
| **Google TTS** | 音声合成 | `texttospeech.googleapis.com/v1/text:synthesize` | audio-generation.ts, bulk-audio.ts | ❌ なし |
| **Fish Audio** | 音声合成 (代替) | `api.fish.audio/v1/tts` | fish-audio.ts | ❌ なし |
| **ElevenLabs** | 音声合成 (代替) | `api.elevenlabs.io/v1/...` | elevenlabs.ts | ❌ なし |
| **LaoZhang.ai** | 動画生成 (Veo/Sora) | `api.laozhang.ai/...` | laozhang-client.ts | ❌ なし |
| **AWS Lambda** | 動画レンダリング | VIDEO_BUILD_ORCHESTRATOR_URL | video-generation.ts | ❌ なし |
| **SendGrid** | メール送信 | `api.sendgrid.com/v3/mail/send` | settings.ts | ❌ なし |
| **Cloudflare API** | 使用量確認 | `api.cloudflare.com/client/v4/graphql` | admin.ts | ❌ なし |

**致命的発見**: 18箇所の外部 fetch のうち、タイムアウト保護があるのは **formatting.ts (修正済み) と image-generation.ts/marunage.ts の画像生成のみ**。残りの12箇所はタイムアウトなし。

### 1.2 処理パイプライン

```
[テキスト入力]
  │
  ▼
[パース] ── inlineIntelligentChunking (ローカル処理、500-1500文字)
  │
  ▼
[フォーマット] ── OpenAI GPT-4o × チャンク数 (BATCH_SIZE=1に修正済)
  │               各チャンクで generateMiniScenesAI → 5-20シーン生成
  │
  ▼
[awaiting_ready] ── utterance生成待ち (waitUntil内で自動実行)
  │
  ▼
[画像生成] ── Gemini Flash Image × シーン数 (1枚ずつ advance ポーリング)
  │             参照画像あり: R2から読み込み + base64エンコード
  │
  ▼
[音声生成] ── Google TTS / Fish Audio × utterance数 (bulk-audio.ts, waitUntil内)
  │             CONCURRENCY=2 で並列実行
  │
  ▼
[動画生成] ── LaoZhang/AWS × シーン数 (submit → ポーリング方式)
  │
  ▼
[ビルド] ── AWS Lambda (Remotion) で最終動画レンダリング
```

### 1.3 フロントエンド通信パターン

| パターン | 使用箇所 | ポーリング間隔 |
|----------|----------|--------------|
| **advance ポーリング** | marunage-chat.js | 10秒 |
| **バッチ + ポーリング** | project-editor.js (画像) | 3秒 |
| **waitUntil + DB状態確認** | bulk-audio | ジョブステータスAPI |
| **submit + ポーリング** | video-generation | 非同期ジョブ方式 |

### 1.4 既存DBテーブル (57テーブル, 57マイグレーション)

```
主要テーブル:
├── projects (status: uploaded→parsing→parsed→formatting→formatted→generating_images→completed)
├── text_chunks (status: pending→processing→completed→failed)
├── scenes (idx順、is_hidden制御)
├── image_generations (status: pending→generating→completed→failed→policy_violation)
├── audio_generations (status同上)
├── video_generations (status: generating→completed→failed, job_id for polling)
├── project_audio_jobs (status: queued→running→completed→failed→canceled)
├── marunage_runs (phase: init→formatting→awaiting_ready→generating_images→generating_audio→ready→failed→canceled)
├── image_generation_logs (コスト追跡)
├── api_usage_logs (API使用量追跡)
├── tts_usage_logs (TTS使用量追跡)
└── api_error_logs (エラー追跡)
```

---

## 2. 検出された問題点

### 2.1 Project 409 — シーン分割失敗 (根本原因)

**症状**: `formatting` フェーズでスタックし、シーンが生成されない。

**根本原因チェーン**:
1. `formatting.ts` の `generateMiniScenesWithSchemaAI` が OpenAI GPT-4o を呼び出す
2. OpenAI の応答が遅い場合 (15-30秒)、`BATCH_SIZE=3` だと合計45-90秒
3. Cloudflare Workers の CPU タイムリミット (paid: 30s default, max 5min) を超過
4. Worker が `message port closed` エラーで終了
5. catch ブロックが `formatting_in_progress` を返すため、永続的にスタック

**修正状況** (a6e8164):
- ✅ OpenAI API 呼び出しに 60s/30s タイムアウト追加
- ✅ BATCH_SIZE を 3→1 に削減
- ✅ 2分以上 `processing` のチャンクを自動 `pending` リセット
- ✅ AbortError ハンドリング改善

**残存リスク**:
- ⚠️ `waitUntil` 内の character-auto-assign / trait-extractor / dialogue-parser (formatting.ts:1259) にタイムアウトなし
- ⚠️ 他の OpenAI 呼び出し (image prompt 修復、multi-image prompt) にタイムアウトなし

### 2.2 Project 422 — 画像生成未完了 (根本原因)

**症状**: 一部の画像が `generating` のままスタック。

**根本原因チェーン**:
1. `generateImageWithRetry` が 429 (Rate Limit) を受けた際、指数バックオフで待機
2. 旧設定: 5回リトライ × (5s, 10s, 20s, 40s, 60s) = 最大135秒待機
3. Worker の実行時間制限を超過
4. `image_generations` レコードが `generating` のまま残る
5. ステータスチェックの stuck 検出 (90秒) では回復不十分

**修正状況** (a6e8164):
- ✅ リトライ合計時間を 55秒に制限
- ✅ リトライ回数を 5→3 に削減
- ✅ 個別バックオフ上限を 20秒に設定
- ✅ `responseModalities` を `['TEXT','IMAGE']` に統一
- ✅ 45秒超のバックオフで即座にエラー終了

**残存リスク**:
- ⚠️ 429 発生時、同じリクエスト内でリトライするため Worker 実行時間を消費
- ⚠️ ユーザー間のレートリミット共有制御なし

### 2.3 システム全体の技術的負債

#### 2.3.1 タイムアウト保護の欠如 (Critical)

| ファイル | fetch 呼び出し数 | タイムアウト設定数 |
|----------|----------------|-------------------|
| formatting.ts | 6 | 6 (修正済) |
| image-generation.ts | 3 | 3 (修正済) |
| marunage.ts | 6 | 1 (generateSingleImage のみ) |
| audio-generation.ts | 3 | **0** |
| bulk-audio.ts | 1 | **0** |
| transcriptions.ts | 1 | **0** |
| fish-audio.ts | 1 | **0** |
| elevenlabs.ts | 1 | **0** |
| laozhang-client.ts | 5 | **0** |

#### 2.3.2 waitUntil の乱用 (High)

`waitUntil` は「レスポンス返却後のバックグラウンド処理」用だが、以下の問題:
- **33箇所** で使用されている
- `bulk-audio.ts`: 全 utterance を waitUntil 内でループ処理 (50+ utterance × 2並列 × 5-10秒 = 125-250秒)
- `formatting.ts`: character-auto-assign + trait-extractor + dialogue-parser を waitUntil 内で直列実行
- waitUntil のタイムアウトは明確でなく、Worker コンテキスト終了でサイレント失敗

#### 2.3.3 自己参照 fetch (Medium)

`marunage.ts` が同一 Worker 内のエンドポイントを `fetch(${origin}/api/projects/${id}/format)` で呼び出し:
- サブリクエスト数制限 (free: 50, paid: 10,000) に影響
- 同一 isolate 内では実質的にデッドロックリスク

#### 2.3.4 バッチ処理の限界 (Medium)

`generate-all-images` エンドポイント (image-generation.ts):
- `MAX_SCENES_PER_BATCH = 3` で 3 シーンを1リクエスト内で直列処理
- 各シーンで Gemini API + R2 アップロード = 35秒+ のため、合計105秒超
- Cloudflare Workers の制限で失敗 → `message port closed`

#### 2.3.5 状態管理の複雑性 (Medium)

- **プロジェクトステータス**: 8 状態遷移 (`projects.status`)
- **ランステータス**: 8 フェーズ (`marunage_runs.phase`)
- **チャンクステータス**: 4 状態 (`text_chunks.status`)
- **画像生成ステータス**: 5 状態 (`image_generations.status`)
- **音声ジョブステータス**: 5 状態 (`project_audio_jobs.status`)
- 状態間の整合性保証がなく、不整合時の自動復旧ロジックが散在

---

## 3. Cloudflare Workers の制約

### 3.1 ハード制約

| 項目 | Free | Paid |
|------|------|------|
| CPU時間/リクエスト | 10ms | 30s (default), max 5min |
| メモリ | 128MB | 128MB |
| サブリクエスト数 | 50 | 10,000 |
| 同時接続 | 6 | 6 |
| ログサイズ | 256KB/request | 256KB/request |
| バンドルサイズ | 1MB (free) | 10MB (gzip) |
| Cron Trigger 実行時間 | — | 15分 |
| Queue consumer 実行時間 | — | 15分 |

### 3.2 Cloudflare Queues (利用可能)

Cloudflare Workers には **Queues** サービスが存在する:
- **メッセージベースの非同期処理**
- Consumer は最大 **15分** 実行可能 (Cron Trigger と同等)
- バッチ処理対応 (最大 100 メッセージ/バッチ)
- リトライ制御あり (最大リトライ回数設定可能)
- dead letter queue サポート

**しかし、Pages Functions からは直接 Queues を使用できない**ため、Worker を別途デプロイするか、D1 ベースの「擬似キュー」を実装する必要がある。

### 3.3 設計方針: D1ベース Job Queue + ポーリング

Cloudflare Workers の制約を考慮し、以下の方針を採用:

```
┌─────────────────────────────────────────────────┐
│  Frontend (ブラウザ)                              │
│   ├── POST /api/jobs/submit → ジョブ登録          │
│   ├── GET /api/jobs/:id/status → ステータス確認    │
│   └── ポーリング 3-10秒間隔                       │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│  Workers (HTTPリクエスト)                          │
│   ├── ジョブ登録: D1に INSERT (status=queued)     │
│   ├── ステータス確認: D1から SELECT               │
│   └── ジョブ実行: 1ジョブのみ処理、完了後レスポンス  │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│  D1 Database (状態管理)                           │
│   ├── job_queue テーブル (SSOT)                   │
│   ├── provider_usage テーブル (レート制限追跡)     │
│   └── user_rate_limits テーブル (公平制御)         │
└─────────────────────────────────────────────────┘
```

**キーポイント**:
- ジョブは「1リクエスト = 1ジョブ」原則で処理
- 429 を受けたら即座に `retry_wait` 状態に移行し、レスポンスを返す
- フロントエンドがポーリングで次回実行をトリガー
- Provider ごとの同時実行数は D1 の `locked_at` カラムで制御

---

## 4. Rate-Limit-Aware アーキテクチャ設計

### 4.1 ジョブステート図

```
                  ┌─────────┐
                  │ queued  │ ← 登録時
                  └────┬────┘
                       │ ポーリング or advance で取得
                       │ provider concurrency check ✓
                       ▼
                  ┌──────────┐
          ┌──────│processing│──────┐
          │      └────┬─────┘      │
          │           │            │
     429 received     │ success    │ error (non-429)
          │           │            │
          ▼           ▼            ▼
   ┌────────────┐ ┌─────────┐ ┌────────┐
   │ retry_wait │ │completed│ │ failed │
   └──────┬─────┘ └─────────┘ └────────┘
          │
          │ next_retry_at 到達
          │ + ポーリングで再取得
          ▼
   ┌──────────┐
   │ queued   │ (retry_count++)
   └──────────┘
```

### 4.2 Provider-Level Throttling

```typescript
// 同時実行制御テーブル (D1)
// provider_limits.request_count で現在の同時実行数を追跡

const PROVIDER_CONCURRENCY = {
  'openai_gpt4o':    { maxConcurrent: 3, windowMs: 60_000 },
  'gemini_image':    { maxConcurrent: 2, windowMs: 60_000 },  // free: 15 RPM
  'google_tts':      { maxConcurrent: 5, windowMs: 60_000 },
  'fish_audio':      { maxConcurrent: 3, windowMs: 60_000 },
  'elevenlabs':      { maxConcurrent: 3, windowMs: 60_000 },
  'laozhang_veo':    { maxConcurrent: 2, windowMs: 60_000 },
  'laozhang_sora':   { maxConcurrent: 2, windowMs: 60_000 },
} as const;
```

### 4.3 ジョブ実行フロー (1リクエスト = 1ジョブ)

```typescript
// advance endpoint (または dedicated worker endpoint)
async function processNextJob(db: D1Database, provider: string, env: Bindings) {
  // 1. Provider concurrency check
  const activeCount = await db.prepare(`
    SELECT COUNT(*) as cnt FROM job_queue 
    WHERE provider = ? AND status = 'processing' AND locked_at > datetime('now', '-120 seconds')
  `).bind(provider).first<{cnt: number}>();
  
  const limit = PROVIDER_CONCURRENCY[provider];
  if (activeCount.cnt >= limit.maxConcurrent) {
    return { action: 'throttled', message: `${provider} at capacity (${activeCount.cnt}/${limit.maxConcurrent})` };
  }
  
  // 2. Fetch oldest queued job (with retry_wait check)
  const job = await db.prepare(`
    SELECT * FROM job_queue 
    WHERE provider = ? AND (
      status = 'queued' OR 
      (status = 'retry_wait' AND next_retry_at <= datetime('now'))
    )
    ORDER BY priority ASC, created_at ASC
    LIMIT 1
  `).bind(provider).first();
  
  if (!job) return { action: 'no_jobs' };
  
  // 3. Lock the job (optimistic locking)
  const lockResult = await db.prepare(`
    UPDATE job_queue SET status = 'processing', locked_at = datetime('now'), locked_by = ?
    WHERE id = ? AND status IN ('queued', 'retry_wait')
  `).bind(workerId, job.id).run();
  
  if (lockResult.meta.changes === 0) {
    return { action: 'contention' }; // Another worker grabbed it
  }
  
  // 4. Execute the job (single API call)
  try {
    const result = await executeJob(job, env);
    
    // 5. Update status
    await db.prepare(`
      UPDATE job_queue SET status = 'completed', completed_at = datetime('now'), locked_at = NULL
      WHERE id = ?
    `).bind(job.id).run();
    
    // 6. Record success metric
    await recordProviderMetric(db, provider, 'success', result.latencyMs);
    
    return { action: 'completed', jobId: job.id };
    
  } catch (error) {
    if (is429Error(error)) {
      // 429 → retry_wait (DO NOT retry in this request)
      const retryAfter = Math.min(getRetryAfter(error) || 10, 60);
      await db.prepare(`
        UPDATE job_queue 
        SET status = 'retry_wait', retry_count = retry_count + 1, 
            next_retry_at = datetime('now', '+' || ? || ' seconds'),
            locked_at = NULL, error_message = ?
        WHERE id = ?
      `).bind(retryAfter, '429 Rate Limited', job.id).run();
      
      await recordProviderMetric(db, provider, 'rate_limited', 0);
      
      return { action: 'rate_limited', retryAfter };
      
    } else {
      // Other error → failed (or retry if retries remain)
      const maxRetries = 3;
      if (job.retry_count < maxRetries) {
        await db.prepare(`
          UPDATE job_queue 
          SET status = 'retry_wait', retry_count = retry_count + 1,
              next_retry_at = datetime('now', '+30 seconds'),
              locked_at = NULL, error_message = ?
          WHERE id = ?
        `).bind(String(error), job.id).run();
      } else {
        await db.prepare(`
          UPDATE job_queue SET status = 'failed', error_message = ?, locked_at = NULL
          WHERE id = ?
        `).bind(String(error), job.id).run();
      }
      
      return { action: 'failed', error: String(error) };
    }
  }
}
```

### 4.4 フロントエンド統合

**現在の advance ポーリング方式をそのまま拡張**:

```javascript
// marunage-chat.js (既存のポーリングループ)
async function pollAdvance() {
  const res = await fetch(`/api/marunage/${projectId}/advance`, { method: 'POST' });
  const data = await res.json();
  
  // 新しいレスポンス形式
  switch (data.action) {
    case 'job_completed':
      updateUI(data.progress); // { completed: 3, total: 5, failed: 0 }
      break;
    case 'throttled':
      showStatus(`APIレート制限中... ${data.retryAfter}秒後に再試行`);
      await sleep(data.retryAfter * 1000);
      break;
    case 'rate_limited':
      showStatus(`429制限受信 — ${data.retryAfter}秒後に自動再試行`);
      break;
    case 'all_completed':
      advanceToNextPhase();
      break;
    case 'failed':
      showError(data.message);
      break;
  }
}
```

---

## 5. DBスキーマ設計

### 5.1 job_queue テーブル

```sql
-- Migration: 0058_create_job_queue.sql
CREATE TABLE IF NOT EXISTS job_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- 所属
  user_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  
  -- ジョブ定義
  job_type TEXT NOT NULL,  -- 'format_chunk', 'generate_image', 'generate_audio', 'generate_video'
  provider TEXT NOT NULL,  -- 'openai_gpt4o', 'gemini_image', 'google_tts', 'fish_audio', 'laozhang_veo', etc.
  
  -- ステータス
  status TEXT NOT NULL DEFAULT 'queued',  -- 'queued', 'processing', 'retry_wait', 'completed', 'failed', 'canceled'
  priority INTEGER NOT NULL DEFAULT 100,  -- 低い = 高優先度 (1=urgent, 100=normal, 200=background)
  
  -- リトライ制御
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  next_retry_at TEXT,  -- datetime for retry_wait
  
  -- ロック制御
  locked_at TEXT,      -- datetime when processing started
  locked_by TEXT,      -- worker identifier (request ID)
  
  -- ペイロード
  payload_json TEXT NOT NULL,  -- ジョブ固有のパラメータ (JSON)
  result_json TEXT,            -- 完了時の結果 (JSON)
  
  -- エラー情報
  error_code TEXT,
  error_message TEXT,
  
  -- 関連エンティティ (ジョブタイプ別)
  entity_type TEXT,   -- 'text_chunk', 'scene', 'utterance', 'video_generation'
  entity_id INTEGER,  -- 対応レコードのID
  
  -- タイムスタンプ
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_job_queue_status_provider ON job_queue(status, provider, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_job_queue_project ON job_queue(project_id, job_type, status);
CREATE INDEX IF NOT EXISTS idx_job_queue_user ON job_queue(user_id, status);
CREATE INDEX IF NOT EXISTS idx_job_queue_retry ON job_queue(status, next_retry_at) WHERE status = 'retry_wait';
CREATE INDEX IF NOT EXISTS idx_job_queue_locked ON job_queue(locked_at) WHERE status = 'processing';
```

### 5.2 provider_usage テーブル

```sql
-- Migration: 0059_create_provider_usage.sql
CREATE TABLE IF NOT EXISTS provider_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  provider TEXT NOT NULL,     -- 'openai_gpt4o', 'gemini_image', etc.
  model TEXT,                 -- 'gpt-4o-2024-08-06', 'gemini-3.1-flash-image-preview'
  window_key TEXT NOT NULL,   -- 'minute:2026-03-07T14:30', 'hour:2026-03-07T14'
  
  -- メトリクス
  request_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_429_count INTEGER NOT NULL DEFAULT 0,
  error_timeout_count INTEGER NOT NULL DEFAULT 0,
  error_other_count INTEGER NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,    -- 合計レイテンシ (avg = total / success)
  
  -- サーキットブレーカー
  circuit_open_until TEXT,    -- datetime until which requests should be blocked
  
  -- タイムスタンプ
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  UNIQUE(provider, model, window_key)
);

CREATE INDEX IF NOT EXISTS idx_provider_usage_window ON provider_usage(provider, window_key);
CREATE INDEX IF NOT EXISTS idx_provider_usage_circuit ON provider_usage(circuit_open_until) WHERE circuit_open_until IS NOT NULL;
```

### 5.3 user_rate_limits テーブル

```sql
-- Migration: 0060_create_user_rate_limits.sql
CREATE TABLE IF NOT EXISTS user_rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  user_id INTEGER NOT NULL,
  
  -- 同時実行制御
  active_jobs INTEGER NOT NULL DEFAULT 0,       -- 現在 processing のジョブ数
  max_concurrent_jobs INTEGER NOT NULL DEFAULT 5,-- ユーザー上限
  
  -- レート制御 (時間窓)
  hourly_requests INTEGER NOT NULL DEFAULT 0,   -- 直近1時間のリクエスト数
  hourly_limit INTEGER NOT NULL DEFAULT 100,    -- 1時間の上限
  daily_requests INTEGER NOT NULL DEFAULT 0,    -- 直近24時間のリクエスト数
  daily_limit INTEGER NOT NULL DEFAULT 500,     -- 1日の上限
  
  -- プロジェクト並列制御
  max_projects_parallel INTEGER NOT NULL DEFAULT 2,  -- 同時処理可能プロジェクト数
  
  -- ウィンドウリセット
  hourly_reset_at TEXT,  -- 次のhourlyリセット時刻
  daily_reset_at TEXT,   -- 次のdailyリセット時刻
  
  -- タイムスタンプ
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  UNIQUE(user_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

---

## 6. フェーズ別実装計画

### Phase 0 (P0) — 即時安定化: 画像生成の完全ジョブ化

**目標**: 最も頻繁に失敗する画像生成を job_queue ベースに移行し、429 でブロックしない。

**スコープ**:
1. `job_queue` テーブル作成
2. `provider_usage` テーブル作成
3. 画像生成 (marunage advance 経路) を job_queue 経由に変更
4. 画像生成 (project-editor バッチ経路) を job_queue 経由に変更
5. 429 受信時に即座に `retry_wait` に移行 (in-request リトライ廃止)
6. Provider 同時実行数チェック (gemini_image: max 2)

**実装詳細**:

```
現在のフロー:
  advance → generateSingleImage → [35s timeout] → [429? → in-request retry] → R2 upload

新しいフロー:
  advance → check job_queue for pending → lock job → generateSingleImage → [35s timeout]
    ├── success → update job completed + update image_generations
    ├── 429 → update job retry_wait (next_retry_at) + return to frontend
    └── error → update job failed + update image_generations
```

**影響ファイル**:
- `migrations/0058_create_job_queue.sql` (新規)
- `migrations/0059_create_provider_usage.sql` (新規)
- `src/utils/job-queue.ts` (新規) — ジョブ管理のユーティリティ
- `src/routes/marunage.ts` — advance 画像生成を job_queue 経由に
- `src/routes/image-generation.ts` — バッチ画像生成を job_queue 経由に
- `public/static/marunage-chat.js` — throttled/retry_wait レスポンスの処理
- `public/static/project-editor.js` — 同上

**工数見積**: 2-3日

---

### Phase 1 (P1) — フォーマット処理のジョブ化 + ユーザー公平制御

**目標**: OpenAI 呼び出しもジョブ化し、ユーザー間の公平性を保証。

**スコープ**:
1. `user_rate_limits` テーブル作成
2. フォーマット処理 (text_chunk → scenes) を job_queue 経由に変更
3. Provider usage メトリクス収集開始
4. ユーザー同時実行数チェック
5. プロジェクト並列制限

**実装詳細**:

```
現在のフロー:
  advance (formatting) → processTextChunks (1 chunk) → generateMiniScenesAI → OpenAI API

新しいフロー:
  advance (formatting)
    → SELECT pending format_chunk jobs for this project
    → IF none: create jobs (1 per text_chunk, provider=openai_gpt4o)
    → process 1 job: lock → generateMiniScenesAI → complete/fail/retry_wait
    → return progress to frontend
```

**影響ファイル**:
- `migrations/0060_create_user_rate_limits.sql` (新規)
- `src/utils/job-queue.ts` — フォーマットジョブ対応追加
- `src/routes/marunage.ts` — formatting フェーズの job_queue 統合
- `src/routes/formatting.ts` — processTextChunks を job 実行関数に変換

**工数見積**: 2日

---

### Phase 2 (P2) — 音声・動画ジョブ化 + 自動プロバイダールーティング

**目標**: 全処理ステップのジョブ化完了、プロバイダーの自動切り替え。

**スコープ**:
1. 音声生成 (bulk-audio) を job_queue 経由に変更
2. 動画生成を job_queue 経由に変更 (既に非同期だが統一)
3. Provider メトリクスに基づく自動ルーティング
4. プライオリティキュー (BYOKユーザー優先)
5. プランベースの割り当て

**音声生成の改善**:

```
現在のフロー:
  POST /api/audio/bulk → waitUntil(runBulkGenerationJob)
    → for each utterance (CONCURRENCY=2): generateSingleUtteranceAudio → Google TTS / Fish Audio

問題: waitUntil 内で50+ utterance をループ → Worker コンテキスト終了でサイレント失敗

新しいフロー:
  POST /api/audio/bulk → create N jobs (1 per utterance, provider=google_tts)
  advance (generating_audio) → process 1-2 jobs per poll cycle
    → check provider concurrency (google_tts: max 5)
    → lock job → generate audio → upload R2 → complete
```

**プロバイダー自動ルーティング**:

```typescript
async function selectBestProvider(db: D1Database, jobType: string, userHasBYOK: boolean) {
  // 1. Get recent metrics for all eligible providers
  const windowKey = getCurrentMinuteKey();
  const metrics = await db.prepare(`
    SELECT provider, request_count, error_429_count, total_latency_ms, success_count, circuit_open_until
    FROM provider_usage
    WHERE window_key = ? AND provider IN (SELECT provider FROM provider_config WHERE job_type = ?)
  `).bind(windowKey, jobType).all();
  
  // 2. Filter out circuit-broken providers
  // 3. Score: lower is better
  //    score = (429_rate * 100) + (avg_latency_ms / 100) + (request_count / limit * 50)
  // 4. BYOK users get priority on their own keys
  
  return bestProvider;
}
```

**工数見積**: 3-4日

---

## 7. 移行戦略

### 7.1 後方互換性の維持

**重要**: 既存のフロントエンドコードとの互換性を100%維持する。

```
移行前: advance → 直接 API 呼び出し → レスポンス
移行後: advance → job_queue チェック/実行 → 同じレスポンス形式
```

advance エンドポイントの **レスポンス形式は変更しない**。内部的にジョブキュー経由で処理するが、フロントエンドから見ると同じポーリングループで動作する。

### 7.2 段階的移行

```
Week 1 (P0):
  Day 1: job_queue, provider_usage テーブル作成 + マイグレーション
  Day 2: src/utils/job-queue.ts 実装
  Day 3: marunage.ts 画像生成を job_queue 統合 + テスト
  Day 4: image-generation.ts バッチ経路の統合 + テスト
  Day 5: デプロイ + 監視

Week 2 (P1):
  Day 1: user_rate_limits テーブル + マイグレーション
  Day 2: formatting.ts の job_queue 統合
  Day 3: marunage.ts formatting フェーズの統合 + テスト
  Day 4: デプロイ + 監視

Week 3 (P2):
  Day 1-2: bulk-audio.ts の job_queue 統合
  Day 3: video-generation.ts の統合 (既に非同期なため軽微)
  Day 4: Provider 自動ルーティング実装
  Day 5: デプロイ + 監視
```

### 7.3 ロールバック計画

各フェーズで feature flag を使用:

```typescript
// wrangler.jsonc の環境変数
const USE_JOB_QUEUE_IMAGE = c.env.FF_JOB_QUEUE_IMAGE === 'true';
const USE_JOB_QUEUE_FORMAT = c.env.FF_JOB_QUEUE_FORMAT === 'true';
const USE_JOB_QUEUE_AUDIO = c.env.FF_JOB_QUEUE_AUDIO === 'true';

if (USE_JOB_QUEUE_IMAGE) {
  // 新しいジョブキュー経路
  return await processImageJobFromQueue(c);
} else {
  // 既存の直接実行経路
  return await generateImageDirectly(c);
}
```

---

## 8. リスクと代替案

### 8.1 リスク

| リスク | 影響度 | 対策 |
|--------|--------|------|
| D1 ベースキューの性能 | Medium | ジョブ数が少ない (1プロジェクト数十件) ため問題なし。インデックス最適化で対応。 |
| ポーリング負荷増加 | Low | 既にポーリング方式のため変化なし。間隔調整で対応。 |
| マイグレーション失敗 | High | 新規テーブルのみのため既存データに影響なし。 |
| Feature Flag 管理 | Low | 安定確認後に旧コード削除。 |

### 8.2 代替案: Cloudflare Queues (将来検討)

Cloudflare Queues を使う場合:
- **メリット**: 真のメッセージキュー、リトライ内蔵、dead letter queue
- **デメリット**: Pages Functions からは直接利用不可、別 Worker のデプロイが必要
- **判断**: 現段階では D1 ベースキューで十分。ユーザー数増加時に検討。

### 8.3 代替案: Durable Objects (将来検討)

Durable Objects を使う場合:
- **メリット**: ステートフルな処理、WebSocket 対応、15分のアラームタイマー
- **デメリット**: 複雑性増大、コスト増、Pages Functions との統合が煩雑
- **判断**: 現段階ではオーバーエンジニアリング。

---

## 付録 A: 全タイムアウト未設定箇所一覧

以下は P0-P2 の実装に加えて、個別に修正すべきタイムアウト未設定箇所:

```
priority: Critical
├── src/routes/audio-generation.ts:594  — Google TTS fetch (60sタイムアウト追加)
├── src/routes/audio-generation.ts:847  — Google TTS fetch (同上)
├── src/routes/audio-generation.ts:1257 — Google TTS fetch (同上)
├── src/routes/bulk-audio.ts:129        — Google TTS fetch (60sタイムアウト追加)
├── src/utils/fish-audio.ts:41          — Fish Audio TTS fetch (30sタイムアウト追加)
├── src/utils/elevenlabs.ts             — ElevenLabs fetch (30sタイムアウト追加)

priority: High
├── src/routes/transcriptions.ts:186    — OpenAI Whisper fetch (120sタイムアウト追加)
├── src/utils/laozhang-client.ts:124    — LaoZhang submit (30sタイムアウト追加)
├── src/utils/laozhang-client.ts:181    — LaoZhang status (15sタイムアウト追加)
├── src/utils/laozhang-client.ts:271    — LaoZhang Sora (30sタイムアウト追加)
├── src/utils/laozhang-client.ts:280    — LaoZhang Sora (30sタイムアウト追加)
├── src/utils/laozhang-client.ts:343    — LaoZhang Sora status (15sタイムアウト追加)

priority: Medium
├── src/routes/settings.ts:400          — SendGrid fetch (15sタイムアウト追加)
├── src/routes/admin.ts:155             — Cloudflare API fetch (15sタイムアウト追加)
├── src/routes/character-models.ts:928  — Gemini fetch (60sタイムアウト追加)
├── src/routes/patches.ts:4202          — Gemini fetch (60sタイムアウト追加)
├── src/routes/patches.ts:4729          — Gemini fetch (60sタイムアウト追加)
├── src/routes/marunage.ts:185          — self-fetch parse (60sタイムアウト追加)
├── src/routes/marunage.ts:239          — self-fetch format (60sタイムアウト追加)
├── src/routes/marunage.ts:1235         — self-fetch preflight (30sタイムアウト追加)
├── src/routes/marunage.ts:1296         — self-fetch build (60sタイムアウト追加)
├── src/routes/marunage.ts:1394         — self-fetch bulk (60sタイムアウト追加)
├── src/routes/marunage.ts:2127         — self-fetch refresh (30sタイムアウト追加)
```

---

## 付録 B: 監視ダッシュボード SQL クエリ

```sql
-- リアルタイム: Provider ごとの同時実行数
SELECT provider, COUNT(*) as active
FROM job_queue WHERE status = 'processing'
GROUP BY provider;

-- 直近1時間: Provider ごとの 429 レート
SELECT provider, 
  SUM(request_count) as total_requests,
  SUM(error_429_count) as total_429,
  ROUND(SUM(error_429_count) * 100.0 / MAX(SUM(request_count), 1), 1) as rate_429_pct,
  ROUND(SUM(total_latency_ms) * 1.0 / MAX(SUM(success_count), 1)) as avg_latency_ms
FROM provider_usage
WHERE window_key LIKE 'minute:' || strftime('%Y-%m-%dT%H', 'now') || '%'
GROUP BY provider;

-- キュー滞留: 最も古い queued ジョブの待機時間
SELECT job_type, provider, 
  MIN(created_at) as oldest_queued,
  ROUND((julianday('now') - julianday(MIN(created_at))) * 86400) as wait_seconds,
  COUNT(*) as queue_depth
FROM job_queue WHERE status IN ('queued', 'retry_wait')
GROUP BY job_type, provider;

-- ユーザー公平性: アクティブジョブ数 TOP 10
SELECT u.email, url.active_jobs, url.hourly_requests, url.daily_requests
FROM user_rate_limits url
JOIN users u ON u.id = url.user_id
ORDER BY url.active_jobs DESC LIMIT 10;
```

---

## 付録 C: 前回の修正 (a6e8164) の評価

| 修正内容 | 効果 | 評価 |
|----------|------|------|
| OpenAI API に 60s/30s タイムアウト追加 | Worker ハング防止 | ✅ 正しい |
| BATCH_SIZE 3→1 | 1リクエスト内の処理時間短縮 | ✅ 正しいが、ジョブ化で不要になる |
| 2分以上 processing チャンクの自動リセット | stuck 復旧 | ✅ 正しい（ジョブ化後は locked_at で統一） |
| リトライ合計時間 55秒制限 | Worker タイムアウト防止 | ✅ 正しいが、in-request リトライ自体を廃止すべき |
| リトライ 5→3 | 実行時間短縮 | ✅ 正しい |
| バックオフ上限 20秒 | 待機時間短縮 | ✅ 正しいが、429 で即座に retry_wait にすべき |
| responseModalities ['TEXT','IMAGE'] | Gemini API 互換性 | ✅ 正しい |

**総合評価**: 前回の修正は **応急処置として正しい**が、根本的には「1リクエスト内で429リトライする」設計自体がCloudflare Workers に不適合。ジョブ化で解決する。

---

*このドキュメントは設計レビュー後、実装フェーズに移行します。*
*質問やフィードバックは随時お願いします。*
