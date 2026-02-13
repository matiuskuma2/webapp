# 画像生成ジョブキュー設計書

## 1. 現状の問題

### 現在のアーキテクチャ
```
advance POST → INSERT image_generations → await Gemini API (19s) → R2 upload → UPDATE → response
```

**問題点:**
- `advance` リクエスト内で Gemini API を `await` している（10-25秒/枚）
- Cloudflare Workers の wall time 制限（30秒 free / 6分 paid）に引っかかる
- タイムアウトで `generating` レコードが孤立 → 60秒 stale 検知で回復（ユーザー体感が悪い）
- 1リクエスト = 1画像 のシリアル処理（5枚 = 最低5回の advance 往復）

### 計測データ (v=92601ec, 2026-02-13)
| Metric | Value |
|--------|-------|
| 平均 total_ms/枚 | 21,424ms |
| 平均 gemini_ms/枚 | 19,371ms (90%) |
| 平均 r2_ms/枚 | 1,762ms (8%) |
| 5枚合計 | ~107秒 (1分47秒) |

## 2. 目標アーキテクチャ

### 設計方針
- `advance` は **キューに積むだけ**（数百ms で応答）
- 別の処理が **画像を非同期生成**（時間制限なし）
- UI は `status` API で進捗を見るだけ（現状の polling と同じ）

### Cloudflare で使えるプリミティブ

| Option | 説明 | 制約 | 適合度 |
|--------|------|------|--------|
| **D1 + Cron Trigger** | D1 をキューとして使い、Cron (1分間隔) でジョブ実行 | 最小1分間隔、Pages では Cron 不可 | △ |
| **Cloudflare Queues** | 本格的メッセージキュー | Pages では直接使えない、Workers 必要 | ○ (将来) |
| **D1 + Self-fetch** | advance で D1 に INSERT 後、`waitUntil` で自分自身の別エンドポイントを fetch | 現在の構成に近い、Pages 互換 | ◎ (MVP) |
| **Durable Objects** | ステートフル Worker | 複雑、Pages 互換要確認 | △ |

### 推奨: D1ベースジョブキュー + waitUntil self-fetch (段階的移行)

## 3. 段階的移行プラン

### Phase 1: 現状改善 (完了)
- [x] AbortController 25秒タイムアウト
- [x] 60秒 stale 検知
- [x] Gemini Flash モデル切替（19s → 5-10s 期待）
- [x] シーン数可変（3/5/7/10）

### Phase 2: advance からの分離 (次のステップ)

**新テーブル: `image_jobs`**
```sql
CREATE TABLE image_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  scene_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued, processing, completed, failed
  prompt TEXT,
  attempt INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES marunage_runs(id),
  FOREIGN KEY (scene_id) REFERENCES scenes(id)
);
CREATE INDEX idx_image_jobs_status ON image_jobs(status, created_at);
```

**フロー:**
```
1. advance (generating_images, noImage > 0)
   → INSERT INTO image_jobs (run_id, scene_id, status='queued', prompt=...)
   → waitUntil(self-fetch /api/marunage/internal/process-image-job)
   → return { action: 'images_queued' }  (即座に応答)

2. /api/marunage/internal/process-image-job (認証: X-Internal-Secret)
   → SELECT * FROM image_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1
   → UPDATE status = 'processing'
   → Gemini API call (25s timeout)
   → R2 upload
   → UPDATE status = 'completed' + image_generations UPDATE
   → waitUntil(self-fetch) で次のジョブを処理（チェーン）

3. status API は image_jobs + image_generations を JOIN して進捗返却
```

**メリット:**
- advance は 100ms で応答
- ジョブが失敗しても DB に記録 → 自動リトライ
- waitUntil チェーンで擬似的な並列処理も可能
- 既存の image_generations テーブルとの互換性を維持

### Phase 3: Cloudflare Queues (将来)
- Workers を Pages とは別にデプロイ
- Queues consumer で画像生成
- 本格的な並列・レート制御

## 4. Phase 2 の実装計画

### 変更するファイル
1. `migrations/0054_create_image_jobs.sql` — 新テーブル
2. `src/routes/marunage.ts` — advance の画像生成ロジックを `image_jobs` INSERT + self-fetch に置換
3. `src/routes/marunage.ts` — `/internal/process-image-job` エンドポイント追加
4. `src/routes/marunage.ts` — status API に `image_jobs` の進捗を追加

### 変更しないファイル
- `public/static/marunage-chat.js` — UI は変更不要（status API の形式を維持）
- `src/types/marunage.ts` — 既存の型はそのまま

### 実装工数見積もり
- Phase 2: 2-3時間（テスト含む）
- Phase 3: 1-2日（Workers 分離 + Queues セットアップ）

## 5. レート制御設計

Gemini API のレート制限: 15 RPM (free), 1000 RPM (paid)

### ジョブ間隔制御
```typescript
const RATE_LIMIT_DELAY = 3000  // 3秒間隔 = 20 RPM 以下
const MAX_CONCURRENT = 1       // 同時実行数

// process-image-job 内
const nextJob = await db.prepare(`
  SELECT * FROM image_jobs 
  WHERE status = 'queued' 
  ORDER BY created_at ASC LIMIT 1
`).first()

if (nextJob) {
  // Process current job
  await processJob(nextJob)
  
  // Chain to next job with delay
  await sleep(RATE_LIMIT_DELAY)
  ctx.waitUntil(fetch(selfUrl + '/api/marunage/internal/process-image-job', {
    headers: { 'X-Internal-Secret': env.CRON_SECRET }
  }))
}
```

## 6. 監視・可観測性

image_jobs テーブルにより、以下のクエリでリアルタイム監視が可能:

```sql
-- ジョブキュー長
SELECT status, COUNT(*) FROM image_jobs GROUP BY status;

-- 平均処理時間
SELECT AVG(julianday(completed_at) - julianday(started_at)) * 86400 as avg_seconds
FROM image_jobs WHERE status = 'completed';

-- 失敗率
SELECT 
  COUNT(CASE WHEN status = 'failed' THEN 1 END) * 100.0 / COUNT(*) as fail_rate
FROM image_jobs;
```
