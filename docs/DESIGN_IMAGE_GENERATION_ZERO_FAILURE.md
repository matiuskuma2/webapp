# 画像生成ゼロ失敗化 設計ドキュメント

**作成日:** 2026-03-10
**対象プロジェクト:** MarumuVi AI (app.marumuviai.com)
**ステータス:** 計画段階（実装前レビュー）

---

## 1. 現状分析

### 1.1 コードベース全体図

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        フロントエンド                                      │
│  project-editor.js                                                       │
│    generateSceneImage()                                                  │
│      ├── POST /scenes/:id/generate-image  (単体・同期)                    │
│      ├── 504/retryable → window.sceneRetryCount → 最大2回自動リトライ      │
│      └── 524 → ポーリングに切替                                           │
│    bulkImageGeneration()                                                 │
│      ├── POST /projects/:id/generate-images  (バッチ・ポーリング)          │
│      └── POST /projects/:id/generate-all-images  (mode=all/pending/failed)│
└──────────┬───────────────────────────────────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────────────────────────────────┐
│                     image-generation.ts                                   │
│                                                                          │
│  [単体] POST /scenes/:id/generate-image                                  │
│    → generateImageWithFallback()  ← 同期完了型 (リクエスト内で完結)         │
│    → R2 Upload → is_active 排他制御 → レスポンス                          │
│                                                                          │
│  [バッチ] POST /projects/:id/generate-all-images                          │
│    → createJob() per scene → processOneImageJob()                        │
│    → 1リクエスト=1ジョブ実行、フロントがポーリングで進行                    │
│                                                                          │
│  [共通] processOneImageJob()                                              │
│    → fetchAndLockJob() → buildPrompt → generateImageWithFallback()       │
│    → R2 Upload → completeJob/failJob                                     │
│                                                                          │
│  [共通] generateImageWithFallback()                                       │
│    1. getApiKey() → user key 優先、なければ system key                    │
│    2. sharedGenerateImage(key, prompt, refs, opts)                        │
│    3. 失敗 → isQuotaError 判定                                           │
│       YES + user key → system key で全く同じ条件で再実行  ★問題A          │
│       YES + system key → user key で再実行  ★問題B                       │
│       NO → そのまま失敗返却                                               │
└──────────┬───────────────────────────────────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────────────────────────────────┐
│                   gemini-image-client.ts (SSOT)                           │
│                                                                          │
│  generateImageWithRetry(prompt, apiKey, refs, opts)                       │
│    for attempt 0..maxRetries:                                             │
│      → 全体経過チェック (120s上限)                                         │
│      → Gemini API fetch (50s AbortSignal)                                │
│      → 429 → Retry-After or exp backoff (5s,10s,20s cap)                 │
│      → 500/502/503/524 → exp backoff (4s,8s,16s... cap 30s)             │
│      → 200 → inlineData → ArrayBuffer                                    │
│      → AbortError (timeout) → 500ms wait → continue                     │
│      → その他 → break (リトライ不可)                                      │
└──────────┬───────────────────────────────────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────────────────────────────────┐
│                      job-queue.ts                                         │
│                                                                          │
│  createJob() → dedup check → INSERT                                      │
│  fetchAndLockJob() → concurrency check (gemini_image: max 2)             │
│                    → auto-recover stuck (120s)                            │
│                    → optimistic lock                                      │
│  failJob() → retry_count < max_retries → retry_wait (10s,20s,40s...)     │
│           → retry_count >= max_retries → failed (終了)                    │
│  handleRateLimit() → retry_wait + 15s (max 60s)                          │
│                                                                          │
│  max_retries = 3 (デフォルト)                                              │
│  LOCK_TIMEOUT_SEC = 120                                                   │
│  PROVIDER_CONCURRENCY.gemini_image = 2                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.2 現在の数値（Project 443 実データ）

| 指標 | 値 |
|---|---|
| 総シーン数 | 150+ |
| 完了 | 35 |
| 失敗 | 18 |
| スタック（generating） | 1 |
| **失敗率** | **≈34%** |
| 全失敗原因 | Gemini API タイムアウト (35s) |
| 429/quota 系エラー | 0件 |

### 1.3 適用済み修正（2026-03-10 デプロイ済み）

| 修正 | Before | After |
|---|---|---|
| API タイムアウト | 35s | 50s |
| 全体リトライ上限 | 55s | 120s |
| タイムアウト間の待機 | 1s exp backoff | 500ms (即リトライ) |
| 全体時間チェック | リトライ後 | リトライ前にプリチェック |
| 単体生成エラー | 500 | 504 + `retryable:true` |
| フロントエンド | 手動やり直し | 自動リトライ最大2回 |

---

## 2. 問題の棚卸し（7つの無駄・危険パターン）

### ★★★ P1: タイムアウトで admin key fallback する無駄

**場所:** `image-generation.ts` L367-401 `generateImageWithFallback()`

**現在の挙動:**
```
1. user key で sharedGenerateImage() → 50秒タイムアウト
2. isQuotaError を判定
   → error に "429" や "quota" が含まれるか？
3. タイムアウトエラーには "TIMEOUT" しか含まれない → isQuotaError = false
4. → fallback しない → そのまま失敗返却
```

**実際:** タイムアウト時に admin fallback は**発動していない**（isQuotaError判定が正しく効いている）。

**ただし潜在的リスク:**
- エラーメッセージの変更で誤爆する可能性あり
- 将来 Gemini API が 429 とタイムアウトを混在させるレスポンスを返す可能性
- `RATE_LIMIT_429: ...` というプレフィックス付きメッセージがタイムアウト前に429を経験した場合に残る

**対策案:** `isQuotaError` を**明示的なエラーコード**（文字列マッチではなく構造化エラー）で判定する。

---

### ★★★ P2: 単体生成が同期完了型 → ユーザーに生の500/504が見える

**場所:** `image-generation.ts` L744-1157 `POST /scenes/:id/generate-image`

**現在の挙動:**
```
1. フロントが POST /scenes/:id/generate-image を呼ぶ
2. サーバーが image_generations INSERT → generating → Gemini API 呼び出し
3. Gemini が50秒以内に応答 → completed → 200返却
4. Gemini が50秒超 → AbortError → generateImageWithRetry が失敗返却
   → generateImageWithFallback が失敗返却
   → 504 + retryable:true 返却
5. フロント側で自動リトライ (最大2回)
```

**問題点:**
- リクエストスレッドが50秒ブロックされる
- Cloudflare Workers のコンテキスト保持に依存（長時間の場合は不安定）
- フロント側に「504」が見える（ユーザー体験に直結）
- リトライ中にブラウザタブを閉じると永久に失敗

**重要な補足:**
- 現在のフロント自動リトライ (2回) + サーバー側 generateImageWithRetry (3回) の組合せで、最大 3×3 = 9回の Gemini API 呼び出しが発生する可能性がある
- ただし MAX_TOTAL_ELAPSED_MS=120s で制限されるため、実質 2-3回が上限

---

### ★★ P3: バッチ生成の「1リクエスト=1ジョブ」制約

**場所:** `image-generation.ts` L1159-1294 `POST /projects/:id/generate-all-images`

**現在の挙動:**
```
1. フロントがポーリングで generate-all-images を連続呼び出し
2. 各リクエストで processOneImageJob() → 1シーンだけ処理
3. 150シーンの場合、フロントが150回以上ポーリングする必要がある
```

**問題点:**
- rate-limit-aware 設計としては正しいが、150シーン規模だと完了に長時間かかる
- フロント側ポーリングが途切れると処理が止まる（cronやworkerがない）
- `PROVIDER_CONCURRENCY.gemini_image = 2` だが、実際の並列実行は1（1リクエスト=1ジョブ）

---

### ★★ P4: marunage.ts の画像生成が別ロジック

**場所:** `marunage.ts` L850-900 (直接実行) / L2910-3050 (advance/job_queue)

**現在の挙動（2系統）:**

**A. 直接実行 (L850):** 
- `generateSingleImage()` → `sharedGenerateImage(apiKey, prompt, refs, { maxRetries: 3 })`
- fallback なし（user key しか試さない）
- 失敗 → そのまま failed + continue（次のシーンへ）

**B. advance/job_queue (L2924):**
- `sharedGenerateImage(prompt, keyResult.apiKey, refs, { maxRetries: 1 })`
- 1回のみ試行 → job_queue の retry_wait で管理
- 429 → handleRateLimit() → retry_wait
- timeout → failJob() → retry_wait or failed

**問題点:**
- 直接実行パスには admin key fallback がない
- advance パスは maxRetries=1 で正しくジョブキューに委譲
- 2つのパスでAPIキー取得ロジックが異なる

---

### ★★ P5: generateImageWithFallback の system→user 逆fallback

**場所:** `image-generation.ts` L385-398

**現在の挙動:**
```
if (keyResult.source === 'system' && isQuotaError) {
  const userKeyResult = await getApiKey(c, { skipUserKey: false });
  // system key が quota → user key で試す
}
```

**問題点:**
- system key (管理者負担) の quota を user key (ユーザー負担) で救済する
- コスト負担の方向が逆転する
- ユーザーが知らないうちに自分のAPIキーで課金される
- sponsor/billing の設計意図に反する

---

### ★ P6: フロントとバックエンドのリトライが二重化

**場所:** フロント: `project-editor.js` L6140-6161 / バック: `gemini-image-client.ts`

**現在の挙動:**
```
[フロント] generateSceneImage() → 失敗 → 2秒後にリトライ (最大2回)
  ↓
[バックエンド] generateImageWithRetry() → 50秒タイムアウト → 500ms後にリトライ (最大3回、120s上限)
  ↓
合計: フロント3回 × バックエンド最大3回 = 最大9回の Gemini API 呼び出し
```

**問題点:**
- フロントリトライ中にバックエンド側でも新しい image_generations レコードが作られる
- 失敗レコードが大量に蓄積される
- 同じシーンへの重複リクエストは排他チェック (`ALREADY_GENERATING`) があるが、
  タイミングによっては前回の generating が failed に変わった直後にフロント再送されて通過する

---

### ★ P7: 参照画像枚数の固定（retry時も同じ重さ）

**場所:** `gemini-image-client.ts` L117 / `image-generation.ts` L643

**現在の挙動:**
```
const limitedImages = referenceImages.slice(0, 5)
// → 常に最大5枚を送信
// → retry でも同じ5枚で同じ処理時間
```

**問題点:**
- 参照画像が多いほど Gemini の応答が遅くなる（タイムアウトの主因）
- retry でも条件を変えないため、同じ理由で再度タイムアウトする可能性が高い
- 150シーン規模 × 参照画像5枚 = 重い処理が連続

---

## 3. 設計提案: 失敗理由別 Fallback ルール表

### 3.1 エラー分類マトリクス

| # | エラー分類 | 判定条件 | 現在の挙動 | 提案する挙動 |
|---|---|---|---|---|
| E1 | **TIMEOUT** | `AbortError` / `TIMEOUT` in error | 504 + retryable → フロント2回リトライ | 参照画像削減 → retry_wait → delayed queue |
| E2 | **RATE_LIMIT_429** | HTTP 429 / `RATE_LIMIT_429` | backoff 5-20s → retry in-request | `retry_wait` → job_queue 管理 (変更なし: 正しい) |
| E3 | **QUOTA_EXHAUSTED** | `quota` / `resource_exhausted` | user→admin fallback | user→admin fallback (quota限定で維持) |
| E4 | **SERVER_ERROR** | HTTP 500/502/503/524 | backoff → retry in-request | `retry_wait` → job_queue 管理 |
| E5 | **CONTENT_POLICY** | `SAFETY` / `policy_violation` | そのまま failed | `attention_required` (リトライしない) |
| E6 | **NO_IMAGE_DATA** | candidates あり but 画像なし | そのまま failed | prompt軽量化 → retry 1回 → failed |
| E7 | **R2_UPLOAD_FAIL** | R2 put エラー | 3回リトライ → failed | 変更なし (正しい) |
| E8 | **WORKER_CONTEXT** | `message port closed` | そのまま failed | `retry_wait` (Workers再起動で解消) |
| E9 | **DECRYPTION_FAIL** | APIキー復号エラー | failed | system key fallback → failed |
| E10 | **UNKNOWN** | 上記に該当しない | failed | `retry_wait` 1回 → failed |

### 3.2 APIキー Fallback ルール（修正版）

| エラー分類 | user key 使用中 | system key 使用中 |
|---|---|---|
| **E1 TIMEOUT** | **同じ key** で参照画像削減リトライ → delayed queue | **同じ key** で参照画像削減リトライ → delayed queue |
| **E2 429** | **同じ key** で retry_wait (job_queue) | **同じ key** で retry_wait (job_queue) |
| **E3 QUOTA** | **system key に fallback** ← 唯一の正当な fallback | user key に fallback しない★ → retry_wait |
| **E4 SERVER** | **同じ key** で retry_wait | **同じ key** で retry_wait |
| **E5 POLICY** | fallback しない | fallback しない |

**変更ポイント:**
1. **system → user 逆fallback を廃止** (P5解消)
2. **timeout で admin fallback しない** (P1防止を確実に)
3. **quota のみが唯一の正当な key fallback トリガー**

### 3.3 参照画像段階劣化ポリシー（新規）

| リトライ回数 | 参照画像枚数 | 備考 |
|---|---|---|
| 1回目 | 最大5枚（現行通り） | フル品質 |
| 2回目 (timeout後) | 最大3枚 | primary キャラのみ |
| 3回目 (再度timeout) | 最大1枚 | 最も重要なキャラのみ |
| 4回目 (再度timeout) | 0枚 | テキスト指示のみ（キャラ特徴テキスト維持）|
| 5回目 (再度timeout) | 0枚 + 簡略prompt | スタイル/ワールド指示も省略 |

**品質への影響:**
- 画像の視覚的一貫性は低下するが、「何も出ない」より圧倒的に良い
- 後からユーザーが手動で高品質再生成可能（現行の再生成UIで対応済み）

---

## 4. 設計提案: ジョブ完了保証アーキテクチャ

### 4.1 Phase 1: 単体生成の即時返却化

**目的:** ユーザーが 500/504 を見ることを根本的になくす

**変更概要:**
```
[現在]
POST /scenes/:id/generate-image
  → 同期的に Gemini API 呼び出し (最大120秒ブロック)
  → 成功: 200 + completed
  → 失敗: 504 + retryable / 500 + error

[提案]
POST /scenes/:id/generate-image
  → image_generations INSERT (status='queued')
  → job_queue にジョブ追加
  → 即座に 202 Accepted + { status: 'queued', generation_id }
  → フロントはポーリングで進捗監視 (既存の pollSceneImageGeneration を拡張)
```

**API レスポンス変更:**
```json
// 現在の成功レスポンス (変更なし)
{ "status": "completed", "r2_url": "/images/...", "image_generation_id": 123 }

// 新: 即時返却レスポンス
{ 
  "status": "queued", 
  "image_generation_id": 123,
  "message": "画像生成をキューに追加しました" 
}

// 新: ポーリング用ステータスエンドポイント (GET /scenes/:id/image-status)
{
  "generation_id": 123,
  "status": "generating" | "retry_wait" | "completed" | "failed",
  "attempt": 2,
  "max_attempts": 5,
  "fallback_level": 1,  // 0=full, 1=3refs, 2=1ref, 3=0refs
  "estimated_wait_sec": 30,
  "r2_url": null | "/images/..."
}
```

**フロントエンド変更:**
```
[現在]
generateSceneImage() → axios.post → 50秒待つ → 成功/失敗 → リトライ

[提案]
generateSceneImage() → axios.post → 即座に202 → pollSceneImageGeneration()
  → 3秒間隔で GET /scenes/:id/image-status をチェック
  → status=completed → カード更新
  → status=retry_wait → "再試行中 (2/5)" 表示
  → status=failed → エラー表示 (ただし attention_required のみ)
```

**影響範囲:**
| ファイル | 変更内容 | 工数 |
|---|---|---|
| `image-generation.ts` | 単体生成を即時返却に変更 + image-status endpoint追加 | 中 |
| `gemini-image-client.ts` | 変更なし | - |
| `job-queue.ts` | 変更なし（既存の仕組みを利用） | - |
| `project-editor.js` | フロントリトライ廃止 → ポーリングのみに統一 | 中 |
| `marunage.ts` | 変更なし（独自ジョブキュー使用中） | - |

---

### 4.2 Phase 2: Fallback ルール分岐の実装

**目的:** 失敗理由ごとに最適な対応を取る

**変更概要:**

`generateImageWithFallback()` を `resolveImageGeneration()` に置換:

```typescript
// 新しい関数シグネチャ
async function resolveImageGeneration(
  c: { env: Bindings },
  prompt: string,
  referenceImages: ReferenceImage[],
  options: ImageGenerationOptions & {
    attempt: number;          // 何回目の試行か
    maxAttempts: number;      // 最大試行回数 (5)
    fallbackLevel: number;    // 参照画像劣化レベル (0-4)
    previousErrorCode?: string; // 前回の失敗理由
  }
): Promise<{
  success: boolean;
  imageData?: ArrayBuffer;
  error?: string;
  errorCode: string;         // 構造化エラーコード
  apiKeySource: 'user' | 'system';
  shouldRetry: boolean;      // job_queue に retry_wait させるか
  nextFallbackLevel: number; // 次回の fallback レベル
  retryDelayMs: number;      // 推奨リトライ待機時間
}>
```

**errorCode 構造化:**
```typescript
type ImageErrorCode =
  | 'SUCCESS'
  | 'TIMEOUT'             // Gemini API 応答タイムアウト
  | 'RATE_LIMIT_429'      // HTTP 429
  | 'QUOTA_EXHAUSTED'     // リソース枯渇
  | 'SERVER_ERROR'        // 500/502/503/524
  | 'CONTENT_POLICY'      // SAFETY / policy_violation
  | 'NO_IMAGE_DATA'       // 画像データなし
  | 'R2_UPLOAD_FAILED'    // R2 保存失敗
  | 'WORKER_CONTEXT'      // Workers コンテキスト終了
  | 'DECRYPTION_FAILED'   // APIキー復号失敗
  | 'UNKNOWN'             // 未分類
```

**key fallback の明確化:**
```typescript
// generateImageWithFallback() 内のfallback判定を置換

function shouldFallbackToSystemKey(errorCode: ImageErrorCode, currentSource: 'user' | 'system'): boolean {
  // ★ ONLY quota exhaustion triggers key fallback
  if (errorCode !== 'QUOTA_EXHAUSTED') return false;
  // ★ ONLY user→system direction (never system→user)
  if (currentSource !== 'user') return false;
  return true;
}
```

**影響範囲:**
| ファイル | 変更内容 | 工数 |
|---|---|---|
| `image-generation.ts` | `generateImageWithFallback` → `resolveImageGeneration` | 大 |
| `gemini-image-client.ts` | エラーコード構造化返却 | 小 |
| `job-queue.ts` | `fallback_level` カラム追加 | 小 |

---

### 4.3 Phase 3: 参照画像段階劣化

**目的:** タイムアウトの根本原因（重い参照画像）に対処

**変更概要:**

`processOneImageJob()` / `resolveImageGeneration()` 内で:

```typescript
function getReducedReferenceImages(
  allRefs: ReferenceImage[],
  fallbackLevel: number
): ReferenceImage[] {
  switch (fallbackLevel) {
    case 0: return allRefs.slice(0, 5);  // フル (現行)
    case 1: return allRefs.slice(0, 3);  // primary キャラのみ
    case 2: return allRefs.slice(0, 1);  // 最重要キャラのみ
    case 3: return [];                    // テキスト指示のみ
    case 4: return [];                    // 簡略テキスト
    default: return [];
  }
}
```

**DB変更案:**
```sql
-- job_queue テーブルに追加カラム
ALTER TABLE job_queue ADD COLUMN fallback_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_queue ADD COLUMN last_error_code TEXT;

-- image_generations テーブルに追加カラム
ALTER TABLE image_generations ADD COLUMN fallback_level INTEGER DEFAULT 0;
ALTER TABLE image_generations ADD COLUMN attempt_number INTEGER DEFAULT 1;
```

**影響範囲:**
| ファイル | 変更内容 | 工数 |
|---|---|---|
| `image-generation.ts` | getReducedReferenceImages() 追加 | 小 |
| `job-queue.ts` | failJob() で fallback_level をインクリメント | 小 |
| migration | 0059_add_fallback_level.sql | 小 |

---

### 4.4 Phase 4: Cron 自動回収

**目的:** ブラウザを閉じても未完了シーンが最終的に完了する

**変更概要:**

既存の cron エンドポイント `/api/admin/cron/collect-render-logs` に追加:

```typescript
// 新規: POST /api/admin/cron/recover-stuck-images
// 5分ごとに実行（Cloudflare Cron Triggers or 外部cron）
//
// 処理:
// 1. retry_wait で next_retry_at が過ぎたジョブを queued に戻す
// 2. generating で 3分以上経過したレコードを failed にクリーンアップ (既存ロジック)
// 3. failed ジョブのうち retry_count < max_retries を retry_wait に戻す
// 4. プロジェクト完了チェック (全scene completed → project.status = 'completed')
```

**影響範囲:**
| ファイル | 変更内容 | 工数 |
|---|---|---|
| `admin.ts` | cron エンドポイント追加 | 中 |
| `job-queue.ts` | recoverExpiredJobs() 追加 | 小 |
| wrangler.jsonc | cron trigger 追加 (5分間隔) | 小 |

---

### 4.5 Phase 5: UI ステータス改善

**目的:** ユーザーに「失敗」を見せず「処理中」として扱う

**変更概要:**

フロントエンドのステータス表示マッピング:

| image_generations.status | job_queue.status | ユーザーに見せる表示 | 色 |
|---|---|---|---|
| pending / generating | queued / processing | 生成中... | 青 |
| - | retry_wait | 再試行中 (2/5) | 黄 |
| failed (retry_count < max) | retry_wait | 再試行待ち | 黄 |
| completed | completed | 完了 | 緑 |
| failed (retry exhausted) | failed | 要確認 | 赤 |
| policy_violation | - | コンテンツポリシー | 赤 |

**プロジェクト全体の進捗表示:**
```
142/150 完了、6件 再試行中、2件 要確認
[████████████████████████████████░░░░░] 94.7%
```

**影響範囲:**
| ファイル | 変更内容 | 工数 |
|---|---|---|
| `project-editor.js` | ステータスバッジ変更 + 自動リトライUI廃止 | 中 |
| `image-generation.ts` | status endpoint にジョブ詳細追加 | 小 |

---

## 5. 実装ロードマップ

### Phase 0: 前準備（最もリスクが低い変更のみ）
**工数: 0.5日 | リスク: 極低**

1. `generateImageWithFallback()` の system→user 逆fallback 削除 (P5)
2. `isQuotaError` 判定を構造化エラーコードに変更 (P1防止)
3. `recordProviderMetric` に error_code を追加
4. 既存テストで動作確認

### Phase 1: 単体生成の即時返却化
**工数: 1日 | リスク: 中（フロント変更あり）**

1. `POST /scenes/:id/generate-image` を 202 返却 + job_queue 投入に変更
2. `GET /scenes/:id/image-status` 追加
3. `project-editor.js` のフロントリトライ廃止 → ポーリング統一
4. フィーチャーフラグで新旧切替可能にする

### Phase 2: Fallback ルール分岐
**工数: 1日 | リスク: 中**

1. エラーコード構造化 (`gemini-image-client.ts`)
2. `resolveImageGeneration()` 実装
3. `shouldFallbackToSystemKey()` 実装
4. 参照画像段階劣化 (`getReducedReferenceImages()`)
5. migration: `job_queue` に `fallback_level`, `last_error_code` 追加

### Phase 3: Cron 自動回収
**工数: 0.5日 | リスク: 低**

1. `POST /api/admin/cron/recover-stuck-images` 追加
2. retry_wait 期限切れジョブの自動回収
3. プロジェクト完了自動判定

### Phase 4: UI ステータス改善
**工数: 0.5日 | リスク: 低（表示のみ）**

1. ステータスバッジのマッピング変更
2. プロジェクト進捗表示の改善
3. 「要確認」ステータスの導入

---

## 6. 目標数値

| 指標 | 現在 | Phase 0-1 後 | Phase 2-4 後 |
|---|---|---|---|
| ユーザーに見える失敗率 | ~34% | < 10% | < 1% |
| 手動やり直し率 | ~34% | < 5% | < 0.5% |
| 最終完了率 (全scene completed) | ~65% | > 90% | > 99.5% |
| APIキー無駄消費 | system→user逆fallback有 | 廃止 | 廃止 |
| 150シーン完了所要時間 | N/A (手動介入必要) | ~30分 | ~20分 (自動回収込) |

---

## 7. コスト影響分析

### 7.1 現状のコスト構造

```
1画像あたり:
  Gemini gemini-3.1-flash-image-preview (1K): $0.067
  
失敗時のコスト:
  タイムアウト → Gemini側で処理が走っているが課金されるか不明
  429 → 課金されない
  成功後のフロントリトライ → 不要な追加課金

150シーンプロジェクト (失敗率34%):
  成功: 150 × $0.067 = $10.05
  失敗分の再試行: 51 × 1.5回 × $0.067 = $5.13 (推定)
  合計: ~$15.18
```

### 7.2 提案後のコスト構造

```
150シーンプロジェクト (失敗率 → 自動回復):
  1回目: 150 × $0.067 = $10.05
  自動リトライ (参照画像削減): ~10回 × $0.067 = $0.67
  合計: ~$10.72

削減額: ~$4.46/プロジェクト (29%削減)
```

**削減理由:**
- タイムアウト後にキー変更なしで同条件再試行 → 同条件再タイムアウトの無駄が消える
- 参照画像段階劣化により、retry時のGemini処理が軽量化 → 成功率向上
- system→user逆fallbackの廃止 → ユーザー側の意図しない課金が消える

---

## 8. リスク評価

| リスク | 影響度 | 確率 | 軽減策 |
|---|---|---|---|
| Phase 1 でフロントの互換性破壊 | 高 | 中 | フィーチャーフラグで段階導入 |
| 参照画像削減で画像品質低下 | 中 | 高 | 後から再生成UIで補完可能 |
| Cron 回収が過負荷になる | 低 | 低 | 1回の回収ジョブ数を制限 (10件/回) |
| Gemini API の仕様変更 | 中 | 低 | エラーコード構造化で早期検知 |
| 逆fallback廃止で一部ユーザーの成功率低下 | 低 | 低 | system→user はそもそも発動条件が稀 |

---

## 9. 未決定事項

1. **marunage.ts の統合**: Phase 2 で `resolveImageGeneration()` に統合するか、別系統のままにするか
2. **APIキー追加**: admin key をもう1本追加すべきか（Phase 2のfallbackルールで十分か要観察）
3. **別モデル/別プロバイダ fallback**: gemini-3.1-flash-image-preview 以外に切替える候補（Imagen 4, DALL-E 3）
4. **max_attempts の値**: 5回が適切か（コストと品質のバランス）
5. **cron の実行頻度**: 5分が適切か（3分? 10分?）

---

## 10. 補足: 現在の `generateImageWithFallback()` の正確なフロー

```
generateImageWithFallback(c, prompt, refs, opts)
│
├─ preferSystemKey=true? → system key 直接使用
│   └─ (現在: バッチ生成でユーザーキーが429した後に設定される)
│
├─ getApiKey(c)
│   ├─ session cookie → user_api_keys.encrypted_key → decrypt → user key
│   └─ なければ env.GEMINI_API_KEY → system key
│
├─ sharedGenerateImage(prompt, key, refs, { maxRetries: 3 })
│   ├─ 成功 → return { success: true, apiKeySource: key.source }
│   └─ 失敗 → isQuotaError 判定
│       │
│       ├─ isQuotaError = true + source=user + system key あり
│       │   → sharedGenerateImage(同じprompt, system_key, 同じrefs, { maxRetries: 3 })
│       │     ★ 全く同じ条件で system key にフォールバック
│       │     ★ maxRetries=3 で再度最大3回リトライ
│       │
│       ├─ isQuotaError = true + source=system
│       │   → getApiKey({ skipUserKey: false }) → user key があれば試す  ★P5: 逆fallback
│       │     ★ 全く同じ条件で user key にフォールバック
│       │
│       └─ isQuotaError = false (timeout等)
│           → return { success: false, error: ... }
│           ★ フォールバックなし → そのまま失敗
│
└─ return result
```

**重要な発見:**
- 現在のコードでは、**タイムアウトで admin key fallback は発動しない**（isQuotaError=false のため）
- しかし **system→user 逆fallback は存在する**（quota系エラーの場合）
- isQuotaError の判定は文字列マッチ依存 → 脆弱（P1の潜在リスク）
