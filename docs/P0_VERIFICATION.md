# P0 完成判定チェックリスト & 検証SQL

**作成日**: 2026-03-08
**対象**: Rate-Limit-Aware Architecture P0 (画像生成ジョブ化)

---

## 1. 完成判定チェックリスト

### A. Migration (0058)
- [x] `job_queue` テーブル (22カラム) — ローカル確認済み
- [x] `provider_usage` テーブル (13カラム) — ローカル確認済み
- [x] INDEX 6個 (job_queue) + 3個 (provider_usage) — 確認済み
- [ ] **本番D1に適用済み** ← デプロイ時に実行

### B. 画像生成経路
- [x] Marunage `generating_images` → job_queue経由 (Step A〜F)
- [x] Builder `generate-all-images` → job_queue経由 (1リクエスト=1ジョブ)
- [ ] Builder `scenes/:id/generate-image` → 単一シーン、P0スコープ外 (P1対応予定)
- [x] 1リクエスト内で複数件の重い生成をしない
- [x] 429 → 即 `retry_wait` (in-request sleep 廃止)
- [x] `retry_wait` → `next_retry_at` → 次ポールで `fetchAndLockJob` が再取得

### C. 状態遷移整合
- [x] `job_queue.status` = queued/processing/retry_wait/completed/failed/canceled
- [x] `image_generations.status` と矛盾しないパス
- [x] `is_active=1` がsceneごとに多重化しない (成功時に旧active無効化)
- [x] retry_wait後に再取得される (fetchAndLockJob の WHERE句)
- [x] stuck検知で復旧する (LOCK_TIMEOUT_SEC = 120s)

### D. Provider制御
- [x] `fetchAndLockJob()` が provider別同時実行上限を確認
- [x] gemini_image:2, openai:3, google_tts:5, fish:3, elevenlabs:3, laozhang:2
- [x] `recordProviderMetric` で success/error/timeout/429 を記録
- [x] 429時に `next_retry_at` が入る
- [x] circuit breaker設計あり (openProviderCircuit関数)

### E. Timeout (外部API fetch)
全ての外部API fetchにAbortController + setTimeout設定済み:
- [x] Google TTS: 60s (audio-generation.ts x3, bulk-audio.ts x1, utterances.ts x1)
- [x] Gemini Image: 35s/40s (marunage.ts x2)
- [x] Fish Audio: 30s (fish-audio.ts)
- [x] ElevenLabs TTS: 60s (elevenlabs.ts)
- [x] ElevenLabs Admin: 15s (admin.ts)
- [x] LaoZhang VEO submit: 30s, status: 15s (laozhang-client.ts)
- [x] LaoZhang Sora submit: 30s x2, status: 15s (laozhang-client.ts)
- [x] OpenAI Chat: 60s (runs-v2.ts)
- [x] OpenAI Whisper: 120s (transcriptions.ts)
- [x] Cloudflare GraphQL: 30s (infrastructure-cost.ts)
- [x] Marunage内部 parse: 60s, format: 120s (marunage.ts)
- [x] formatting.ts 6箇所: 既存のAbortController設定あり

### F. フロントエンド
- [x] `rate_limited` アクション表示 (marunage-chat.js)
- [x] `stale_fixed` アクション表示 (marunage-chat.js)
- [x] `job_progress` ベースポーリング (project-editor.js)
- [x] rate_limit中のUI表示 (project-editor.js)
- [x] no-progress safety (20回連続進捗なしで停止)

### G. レガシー互換
- [x] `jobProgress.total === 0` でも既存 `image_generations` だけで完了判定
- [x] 旧プロジェクトで停止しない
- [x] 新規プロジェクトでは job_queue が作られる

---

## 2. 検証SQL (本番実行用)

### A. テーブル存在確認
```sql
SELECT name FROM sqlite_master
WHERE type='table' AND name IN ('job_queue', 'provider_usage');
```

### B. job_queue カラム確認
```sql
PRAGMA table_info(job_queue);
```

### C. INDEX確認
```sql
SELECT name, tbl_name FROM sqlite_master
WHERE type='index' AND tbl_name IN ('job_queue', 'provider_usage')
ORDER BY tbl_name, name;
```

---

## 3. 運用確認SQL

### プロジェクト画像ジョブ進捗
```sql
SELECT project_id, job_type, status, COUNT(*) AS cnt
FROM job_queue
WHERE project_id = ? AND job_type = 'generate_image'
GROUP BY project_id, job_type, status;
```

### retry_wait 残件
```sql
SELECT id, project_id, entity_id AS scene_id, provider,
       retry_count, next_retry_at, error_code, error_message
FROM job_queue
WHERE job_type = 'generate_image' AND status = 'retry_wait'
ORDER BY next_retry_at ASC LIMIT 50;
```

### stuck processing ジョブ
```sql
SELECT id, project_id, entity_id AS scene_id, provider,
       locked_at, updated_at, retry_count
FROM job_queue
WHERE status = 'processing'
  AND updated_at < datetime('now', '-2 minutes');
```

### active画像重複確認
```sql
SELECT scene_id, COUNT(*) AS active_count
FROM image_generations WHERE is_active = 1
GROUP BY scene_id HAVING COUNT(*) > 1;
```

### active画像なしのシーン
```sql
SELECT s.id AS scene_id, s.project_id, s.idx
FROM scenes s
LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
WHERE (s.is_hidden = 0 OR s.is_hidden IS NULL) AND ig.id IS NULL
  AND s.project_id = ?;
```

### provider_usage 最近1時間
```sql
SELECT provider, window_key, request_count, success_count,
       error_429_count, error_timeout_count, error_other_count,
       total_latency_ms, circuit_open_until
FROM provider_usage
WHERE window_key >= 'minute:' || strftime('%Y-%m-%dT%H:', 'now', '-1 hour')
ORDER BY provider, window_key DESC;
```

### 429多発確認
```sql
SELECT provider,
       SUM(error_429_count) AS total_429,
       SUM(request_count) AS total_requests,
       ROUND(CASE WHEN SUM(request_count) = 0 THEN 0
             ELSE 100.0 * SUM(error_429_count) / SUM(request_count)
             END, 2) AS rate_limit_pct
FROM provider_usage GROUP BY provider
ORDER BY total_429 DESC;
```

---

## 4. P0完了判定の実テスト (本番適用後)

| Test | 内容 | 合格条件 |
|------|------|---------|
| T1 | Builder 10枚一括 | job_queue 10件作成→1枚ずつ→completed |
| T2 | Marunage 5シーン | generating_images→job_queue→generating_audio |
| T3 | 429疑似 | sleep せず retry_wait → 再取得で復帰 |
| T4 | 旧プロジェクト | job_queue.total=0 でも正常遷移 |
| T5 | 重複防止 | 連打しても active=1 が scene あたり1件 |

---

## 5. 既知の制限 (P1/P2で対応)

- `scenes/:id/generate-image` (単一シーン) は job_queue 未経由 (P1)
- 内部HTTP呼び出し 5/7箇所がtimeout未設定 (P1)
- format / audio / video 処理は job_queue 化されていない (P1/P2)
- provider自動ルーティング未実装 (P2)
- user_rate_limits テーブル未作成 (P1)
