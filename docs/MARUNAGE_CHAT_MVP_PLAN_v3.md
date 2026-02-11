# 丸投げチャット MVP 計画書 v3（最終確定版）

> **ステータス**: 設計確定・実装可能粒度（実装はこのドキュメントの承認後に開始）
> **最終更新**: 2026-02-11
> **前提**: 既存サービスへの影響ゼロ / SSOT 二重化の排除 / 将来共通化を阻害しない

---

## 0. 設計原則（絶対ルール）

### 0-1. 依存方向
- **丸投げ → 既存API/DBを "読む/呼ぶ" のみ**
- **既存 → 丸投げを一切参照しない**（既存コードに marunage の import/参照を入れない）

### 0-2. 禁止事項
| 禁止 | 理由 |
|---|---|
| `projects.status` の CHECK 制約に新値を追加 | DB CHECK 違反 + 既存20箇所以上の `allowedStatuses` が壊れる |
| `image-generation.ts` の "全成功で completed" を変更 | downloads.ts 等が `completed` を前提にしている |
| `bulk-audio.ts` のジョブロック仕様を変更 | 既存の二重起動防止が壊れる |
| `settings_json` を丸投げの SSOT にする | 並行書き込み競合（telop/narration等が同時更新するリスク） |
| 既存ルートファイルに `marunage` 固有のロジックを追加 | 依存方向違反 |

### 0-3. 共通化ポリシー
| 共通にして良い | 分けるべき |
|---|---|
| キャラクター定義 (project_character_models) | オーケストレーション SSOT (marunage_runs) |
| Voice preset 参照 | コスト集計 (experience タグで分離) |
| Output presets | 意図解釈（チャット系。将来共通化はOK） |
| system_audio_library (BGM/SFX) | 進行状態・ロック・リトライ |

---

## 1. MVP スコープ

| 項目 | 決定 | 根拠 |
|---|---|---|
| シーン数 | **固定5シーン** | リスク最小化。AI分割のブレを吸収 |
| 画像 | **静止画生成のみ（Gemini）** | 既存 generate-all-images を再利用 |
| モーション | **既定プリセット（kenburns_soft）** | 自動、既存で対応済み |
| 音声 | **一括音声生成（bulk-audio）** | 既存ジョブ管理をそのまま利用 |
| BGM | **なし**（差し込み口だけ残す） | 最も安全・最速 |
| 動画合成 (Remotion) | **MVP では実行しない** | 後から追加可能な設計 |
| APIキー優先順位 | ユーザー設定 → スポンサー → システム | 既存ロジックを完全再利用 |
| 体験モデル | Lovart風 左ボード＋右チャット | 体験重視、ワンフロー完結 |
| MVP 終点 | **`phase='ready'`**（画像+音声完了） | 動画化は後続フェーズ |

---

## 2. SSOT 設計（案A 確定: `marunage_runs` 新テーブル）

### 2-1. 選定理由
- `settings_json` 同居は並行書き込み競合の温床（telop/narration更新と衝突）
- `projects.status` 拡張は DB CHECK 制約違反 + 既存 `allowedStatuses` の全面改修が必要
- 新テーブルなら既存コードへの影響が **完全にゼロ**
- CHECK 制約で不正フェーズ値を DB レベルで防止
- D1 コンソールで `SELECT * FROM marunage_runs WHERE phase='failed'` で即座にデバッグ可能

### 2-2. `projects.status` との関係

```
projects.status (既存が勝手に動く)     marunage_runs.phase (丸投げ SSOT)
────────────────────────────────────   ────────────────────────────────
  created                                init
  uploaded                               formatting (start で即遷移)
  formatting                             formatting
  formatted                              awaiting_ready
  generating_images                      generating_images
  completed (※画像全成功時に既存が設定)   generating_audio
  completed                              ready (MVP終点)
```

**重要**: `projects.status = 'completed'` は「画像まで完了」の意味として維持。
丸投げ UI は `marunage_runs.phase` を見て状態を表示する。衝突なし。

### 2-3. DDL（確定版）

```sql
-- migrations/0050_create_marunage_runs.sql
-- ============================================================
-- MARUNAGE Chat (MVP) - Pipeline Orchestration SSOT
-- - Existing services must not be affected.
-- - SSOT for "marunage pipeline" lives ONLY in marunage_runs.
-- - Do NOT extend projects.status (CHECK constraint / widespread dependencies).
-- ============================================================
-- Created: 2026-02-11

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS marunage_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Project association
  project_id INTEGER NOT NULL,
  
  -- SSOT phase (MVP)
  phase TEXT NOT NULL DEFAULT 'init'
    CHECK (phase IN (
      'init',              -- created run, text saved, settings snapshotted
      'formatting',        -- formatting running
      'awaiting_ready',    -- formatted, waiting for 5-scene normalization + utterances
      'generating_images', -- image generation running (batch)
      'generating_audio',  -- bulk audio job running
      'ready',             -- MVP complete (images + audio ready)
      'failed',            -- terminal error
      'canceled'           -- terminal user/admin cancellation
    )),

  -- Configuration snapshot frozen at start
  -- {
  --   "target_scene_count": 5,
  --   "split_mode": "ai",
  --   "output_preset": "yt_long",
  --   "narration_voice": { "provider": "google", "voice_id": "ja-JP-Neural2-B" },
  --   "bgm_mode": "none"
  -- }
  config_json TEXT NOT NULL DEFAULT '{}',

  -- Execution context / audit
  started_by_user_id INTEGER NULL,
  started_from TEXT NULL,  -- 'ui' | 'api' | 'admin'

  -- Error tracking
  error_code TEXT NULL,
  error_message TEXT NULL,
  error_phase TEXT NULL,

  retry_count INTEGER NOT NULL DEFAULT 0,

  -- Link to bulk audio job
  audio_job_id INTEGER NULL,

  -- Optimistic locking
  locked_at DATETIME NULL,
  locked_until DATETIME NULL,

  -- Timestamps
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (started_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (audio_job_id) REFERENCES project_audio_jobs(id) ON DELETE SET NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_marunage_runs_project_id
  ON marunage_runs(project_id);

CREATE INDEX IF NOT EXISTS idx_marunage_runs_phase
  ON marunage_runs(phase);

CREATE INDEX IF NOT EXISTS idx_marunage_runs_updated_at
  ON marunage_runs(updated_at);

-- Critical: Only ONE active run per project
-- Active = not in terminal phases (ready, failed, canceled)
CREATE UNIQUE INDEX IF NOT EXISTS uq_marunage_runs_one_active_per_project
  ON marunage_runs(project_id)
  WHERE phase NOT IN ('ready', 'failed', 'canceled');
```

---

## 3. フェーズ遷移図（確定版）

```
                      POST /start
                          |
                          v
                       [init]
                          | (sync: project create + format kick)
                          v
                    [formatting] ─────────────────── (fail) ──> [failed]
                          |                                        |
                    (advance: projects.status='formatted'?)         |
                          |                                        |
                          v                                        |
        ┌──── [awaiting_ready] ───────────────── (fail) ──────> [failed]
        |              |                                           |
        |   (advance: 5 scenes + utterances ready?)                |
        |              |                                           |
        |              v                                           |
        |   [generating_images] ──── (retry<=3) -> (retry)         |
        |              |              (retry>3) -> [failed] <──────|
        |   (advance: 5-scene images completed?)                   |
        |              |                                           |
        |              v                                           |
        |   [generating_audio] ─────────────── (fail) ─────> [failed]
        |              |                                           |
        |   (advance: audio_job completed?)                        |
        |              |                                           |
        |              v                                           |
        |          [ready] <-- MVP endpoint                        |
        |                                                          |
        └──────── (cancel) ──> [canceled]                          |
                                                                   |
                         [failed] <── (retry) ──> rollback target  |
                                                                   |
                                  (cancel) ──> [canceled] <────────┘
```

### 許可されるフェーズ遷移マップ

```typescript
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  'init':              ['formatting'],
  'formatting':        ['awaiting_ready', 'failed'],
  'awaiting_ready':    ['generating_images', 'failed', 'canceled'],
  'generating_images': ['generating_audio', 'failed', 'canceled'],
  'generating_audio':  ['ready', 'failed', 'canceled'],
  'ready':             [],  // terminal
  'failed':            ['formatting', 'awaiting_ready', 'generating_images', 'generating_audio'],  // retry
  'canceled':          [],  // terminal
};
```

---

## 4. 起動方式（確定: 関数 export 最小追加）

### 4-1. 調査結果

| ファイル | 内部関数 | 引数 | 現在の export |
|---|---|---|---|
| `formatting.ts` | `processTextChunks()` | `c: any` (Hono ctx) | なし（ファイルスコープ） |
| `formatting.ts` | `autoMergeScenes()` | `c: any` | なし |
| `image-generation.ts` | generate-all-images ハンドラ | ルートハンドラ（抽出不可） | Hono router のみ |
| `bulk-audio.ts` | `runBulkGenerationJob()` | `env: Bindings` | なし |

### 4-2. 決定

| パイプライン | 起動方式 | 既存への変更 |
|---|---|---|
| **Format** | `processTextChunks` を named export に追加 | **1行追加**: `export { processTextChunks }` |
| **画像生成** | marunage.ts 側で DB 操作を独自実装 | **ゼロ**（既存の `generate-all-images` の核心ロジックは「シーン取得→プロンプト構築→Gemini呼び出し→R2保存」だが、丸投げ用に同じDB操作を独自に書く） |
| **音声生成** | `runBulkGenerationJob` を named export に追加 | **1行追加**: `export { runBulkGenerationJob }` |

### 4-3. 画像生成の代替案（既存改修ゼロ）

`generate-all-images` は Hono ルートハンドラなので関数抽出が困難。代わりに:

```typescript
// marunage.ts 内で独自に画像生成ループを実装
// ※ 既存の generate-all-images と同じ「DB読み→Gemini API→R2保存」の流れを
//    丸投げ専用として再実装する。
// メリット: 既存ファイルへの変更がゼロ
// デメリット: ロジック重複（ただし丸投げは5シーン固定なのでシンプル版で十分）

async function marunageGenerateImages(env: Bindings, projectId: number, config: MarunageConfig) {
  // 1. 5シーン取得（is_hidden=0）
  // 2. 各シーンの image_prompt でGemini呼び出し（既存utils再利用可能）
  // 3. R2保存 + image_generations INSERT
  // 4. APIキー解決は既存の resolveApiKey ユーティリティを使用
  //    (image-prompt-builder.ts, output-presets.ts は既存 utils で export 済み)
}
```

### 4-4. 判断ポイント

```
トレードオフ（実装時に最終判断）:
  A) 画像生成を丸投げ側で独自実装 (既存変更ゼロ、ロジック重複)
  B) generate-all-images の核心を関数化して export (既存に1関数追加、重複なし)

推奨: MVP は A（独自実装）で始める。
  理由: 5シーン固定なのでループが単純。既存の複雑なバッチロジック
       （quota切替、mode分岐、failedリトライ等）は丸投げに不要。
  将来: 安定後に共通関数化を検討。
```

### 4-5. Service Binding は使わない

- Cloudflare Pages Functions では Service Binding は利用不可（Workers 専用機能）
- 現在の構成は `pages_build_output_dir: ./dist` のため Pages デプロイ

---

## 5. API 仕様（確定版）

### 5-0. 共通

- ルート: `/api/marunage/*`
- 認証: 全エンドポイントで session cookie 必須
- ルート登録: `src/index.tsx` に `app.route('/api/marunage', marunage)` 追加
- 実装ファイル: `src/routes/marunage.ts`（新規）

### エラーレスポンス統一形式
```json
{ "error": { "code": "MACHINE_CODE", "message": "人間可読メッセージ", "details": {} } }
```

### 共通エラーコード
| code | HTTP | 意味 |
|---|---|---|
| UNAUTHORIZED | 401 | セッション無効 |
| NOT_FOUND | 404 | project/run 不存在 |
| FORBIDDEN | 403 | 他ユーザーのプロジェクト |
| INVALID_REQUEST | 400 | バリデーション失敗 |
| CONFLICT | 409 | アクティブrun存在 / ロック中 |
| INVALID_PHASE | 400 | 現在のphaseでは実行不可 |
| INTERNAL_ERROR | 500 | 内部エラー |

---

### 5-1. GET `/api/marunage/active`

**目的**: 現在ログインユーザーのアクティブ run を検索する。ページ復帰時にどの projectId でポーリングを再開するかを決定する。

**処理:**
1. session cookie からユーザー ID 取得
2. `marunage_runs WHERE started_by_user_id = ? AND phase NOT IN ('ready', 'failed', 'canceled') ORDER BY created_at DESC LIMIT 1`

**Response (200):**
```json
{
  "run_id": 1,
  "project_id": 123,
  "phase": "generating_images"
}
```

**Response (404):**
```json
{ "error": { "code": "NOT_FOUND", "message": "No active run found" } }
```

**冪等性**: GET なので常に冪等。

---

### 5-2. POST `/api/marunage/start`

**目的**: テキスト受け取り → プロジェクト作成 → marunage_run 作成 → フォーマット起動

**Request:**
```json
{
  "title": "string (任意, 1-200文字)",
  "text": "string (必須, 100-50000文字)",
  "narration_voice": {
    "provider": "google | elevenlabs | fish",
    "voice_id": "string"
  },
  "output_preset": "yt_long (任意)"
}
```

**処理フロー（同期部分）:**
1. 入力バリデーション
2. 認証チェック (getSessionUser)
3. `projects` INSERT (status='created', source_type='text')
4. `projects` UPDATE (status='uploaded', source_text=text)
5. `settings_json` に default_narration_voice を書き込み
6. `project_style_settings` INSERT (デフォルトスタイル)
7. `runs` INSERT (run_no=1, state='draft')
8. `marunage_runs` INSERT (phase='init', config_json 凍結)
   - UNIQUE INDEX が同一 project の二重 start を防止
9. `marunage_runs` UPDATE phase='formatting'
10. レスポンス返却

**非同期部分 (waitUntil):**
11. `processTextChunks(c, projectId, project, 'ai', 5)` を呼び出し
12. 完了後 autoMergeScenes が `projects.status='formatted'` に更新（既存動作）
13. waitUntil 内で utterances も生成される（既存動作）

**Response (201):**
```json
{
  "run_id": 1,
  "project_id": 123,
  "phase": "formatting",
  "config": { "target_scene_count": 5, "split_mode": "ai", ... }
}
```

**エラー:**
| 状況 | code | HTTP |
|---|---|---|
| text 空/短すぎ(100文字未満) | INVALID_REQUEST | 400 |
| text 50000文字超 | INVALID_REQUEST | 400 |
| output_preset 無効 | INVALID_REQUEST | 400 |
| 同一 project にアクティブ run あり | CONFLICT | 409 |

**冪等性**: 冪等ではない（毎回新規作成）。二重送信はフロントUI disable + UNIQUE INDEX で防止。

---

### 5-3. GET `/api/marunage/:projectId/status`

**目的**: 丸投げ体験の統合進捗を返す。副作用なし。

**処理:**
1. アクティブ run 取得 (なければ最新 run)
2. DB 実データから進捗を集計（4クエリ、N+1禁止）

**Response (200):**
```json
{
  "run_id": 1,
  "project_id": 123,
  "phase": "generating_images",
  "config": { ... },
  "error": null,
  "progress": {
    "format": {
      "state": "done",
      "scene_count": 5,
      "chunks": { "total": 3, "done": 3, "failed": 0, "pending": 0 }
    },
    "scenes_ready": {
      "state": "done",
      "visible_count": 5,
      "utterances_ready": true,
      "scenes": [
        { "id": 10, "idx": 1, "title": "冒頭", "has_image": true, "image_url": "...", "has_audio": false, "utterance_count": 3 }
      ]
    },
    "images": {
      "state": "running",
      "total": 5, "completed": 2, "generating": 1, "failed": 0, "pending": 2
    },
    "audio": {
      "state": "pending",
      "job_id": null, "job_status": null,
      "total_utterances": 0, "completed": 0, "failed": 0
    }
  },
  "timestamps": { "created_at": "...", "updated_at": "...", "completed_at": null }
}
```

---

### 5-4. POST `/api/marunage/:projectId/advance`

**目的**: 現在 phase の完了条件をチェックし、次フェーズへ遷移 + 処理起動。**冪等。**

**phase 別分岐:**

| 現在 phase | 完了条件 | 成功時の遷移 | 起動する処理 |
|---|---|---|---|
| `formatting` | `projects.status = 'formatted'` | → `awaiting_ready` | 5シーン収束処理 |
| `awaiting_ready` | 5シーン全て utterance_count > 0 | → `generating_images` | 画像一括生成 |
| `generating_images` | 5シーン全て active image completed | → `generating_audio` | bulk-audio ジョブ起動 |
| `generating_audio` | audio_job.status = 'completed' | → `ready` | (完了) |

**楽観ロック:**
```sql
UPDATE marunage_runs
SET phase = ?, updated_at = CURRENT_TIMESTAMP
WHERE id = ? AND phase = ?
-- changes() = 0 → already transitioned (idempotent)
```

**二重起動防止:**
- 画像: phase 楽観ロック + `locked_until` 5分
- 音声: bulk-audio.ts が `project_audio_jobs` で 409（既存の強み）
- advance 連打: `locked_until` チェック → CONFLICT 返却

**Response (200):**
```json
{
  "run_id": 1,
  "previous_phase": "awaiting_ready",
  "new_phase": "generating_images",
  "action": "started_images",
  "message": "画像生成を開始しました"
}
```

---

### 5-5. POST `/api/marunage/:projectId/retry`

**目的**: failed run を巻き戻して再開。

**巻き戻しマップ:**
| error_phase | 巻き戻し先 | 次の advance で実行される処理 |
|---|---|---|
| `formatting` | → `formatting` | 再フォーマット |
| `generating_images` | → `awaiting_ready` | 画像再生成 (mode=pending) |
| `generating_audio` | → `generating_images` | 音声再生成 |

**ガード**: retry_count >= 5 なら RETRY_EXHAUSTED (400)

---

### 5-6. POST `/api/marunage/:projectId/cancel`

**目的**: アクティブ run を中断。

**処理**: phase → `canceled`。audio_job が running なら cancel 試行。

---

## 6. フェーズ別完了判定 SQL（確定版）

### 6-1. Format 完了

```sql
-- projects.status が 'formatted' かどうかが SSOT
SELECT id, status FROM projects WHERE id = ?;

-- 補助: chunks 統計
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
  SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS active
FROM text_chunks WHERE project_id = ?;
```

判定: `projects.status = 'formatted'` なら完了。

### 6-2. 5シーン確定（advance: formatting → awaiting_ready 時に実行）

```sql
-- 可視シーンを idx 順で取得
SELECT id, idx FROM scenes
WHERE project_id = ? AND (is_hidden = 0 OR is_hidden IS NULL)
ORDER BY idx ASC;
```

アプリ側: 6件目以降を `is_hidden = 1` に更新。

```sql
UPDATE scenes SET is_hidden = 1, updated_at = CURRENT_TIMESTAMP WHERE id IN (?, ?, ...);
```

監査ログ:
```typescript
await logAudit({
  db, userId: run.started_by_user_id, userRole: 'system',
  entityType: 'project', entityId: projectId, projectId,
  action: 'marunage.scene_trim',
  details: { hidden_scene_ids: excessIds, kept: 5, original_total: scenes.length }
});
```

### 6-3. utterances_ready

```sql
SELECT s.id, s.idx,
  (SELECT COUNT(*) FROM scene_utterances su WHERE su.scene_id = s.id) AS utt_count
FROM scenes s
WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
ORDER BY s.idx ASC;
```

判定: 5行返却 AND 全行 `utt_count > 0`。

### 6-4. 画像進捗

```sql
SELECT
  COUNT(*) AS total_scenes,
  SUM(CASE WHEN ig.id IS NULL THEN 1 ELSE 0 END) AS no_image,
  SUM(CASE WHEN ig.status='completed' THEN 1 ELSE 0 END) AS completed,
  SUM(CASE WHEN ig.status IN ('pending','generating') THEN 1 ELSE 0 END) AS generating,
  SUM(CASE WHEN ig.status='failed' OR ig.status='policy_violation' THEN 1 ELSE 0 END) AS failed
FROM scenes s
LEFT JOIN image_generations ig
  ON ig.scene_id = s.id AND ig.is_active = 1
WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL);
```

判定:
- `generating > 0` → waiting
- `completed = 5` → done (次フェーズへ)
- `completed = 0` → all failed → run.failed
- `0 < completed < 5 && failed > 0` → retry (上限3回)

### 6-5. 音声進捗

```sql
-- ジョブ状態（SSOT）
SELECT * FROM project_audio_jobs
WHERE id = ?;  -- marunage_runs.audio_job_id

-- 補助: utterance 単位の進捗
SELECT
  COUNT(*) AS total_utterances,
  SUM(CASE WHEN ag.status='completed' THEN 1 ELSE 0 END) AS completed,
  SUM(CASE WHEN ag.status='failed' THEN 1 ELSE 0 END) AS failed
FROM scene_utterances su
JOIN scenes s ON s.id = su.scene_id
LEFT JOIN audio_generations ag ON ag.id = su.audio_generation_id
WHERE s.project_id = ? AND (s.is_hidden = 0 OR s.is_hidden IS NULL);
```

判定: `project_audio_jobs.status = 'completed'` → ready。

---

## 7. 5シーン超過処理（ブロッカー#1 解決策）

### 問題
`autoMergeScenes()` は全シーンのインデックスを正規化するだけで、シーン数を切り詰めない。
AI の `generateMiniScenesAI` が `chunkTargetScenes` を目標にするが、保証はない。

### 解決策
丸投げ advance で `formatting → awaiting_ready` 遷移時に強制カット:

1. `scenes(is_hidden=0)` を `idx` 順で取得
2. 6件目以降を `is_hidden = 1` に更新
3. 監査ログに記録
4. **既存UIへの影響**: is_hidden はソフトデリート。既存 Builder でも非表示になるだけでデータは保持。

### エッジケース
| 状況 | 対応 |
|---|---|
| シーンが5未満 | そのまま進行（1シーンでも画像/音声は生成可能） |
| シーンが0 | `error_code='NO_SCENES'` で failed |
| シーンがちょうど5 | 何もしない |

---

## 8. 二重起動ガード（確定版）

### 8-1. marunage_runs の二重起動
- `uq_marunage_runs_one_active_per_project` (partial unique index) が最終防衛線
- INSERT 時に既存アクティブ run があれば DB エラー → 409 CONFLICT

### 8-2. advance の二重実行
- `locked_until` チェック: ロック中なら 409
- `WHERE phase = ?` の楽観ロック: 同時呼び出しで片方だけ `changes > 0`

### 8-3. 画像生成の二重起動
- phase 楽観ロックで起動は1回に限定
- advance 再呼び出し時は `generating > 0` → waiting (何もしない)

### 8-4. 音声生成の二重起動
- `bulk-audio.ts` が `project_audio_jobs` テーブルで独自に 409 を返す（既存の強み）
- advance 再呼び出し時は `audio_job_id` の status を確認するだけ

---

## 9. コストタグ仕様（確定版）

### 9-1. experience_tag 固定値

- **v1 の experience_tag**: `marunage_chat_v1`（定数）
- run 作成時に `marunage_runs.config_json.experience_tag` として固定記録する
- API ログへの `experience` タグは短縮形 `'marunage'` を使用（集計クエリ簡易化のため）
- `'marunage'` | `'builder'` を全ログに付与

### 9-2. 記録箇所一覧

| 記録先 | フィールド | 値 | 書込タイミング |
|---|---|---|---|
| `marunage_runs.config_json` | `experience_tag` | `"marunage_chat_v1"` | run 作成時（凍結） |
| `api_usage_logs.metadata_json` | `experience` | `"marunage"` | 画像生成 API 呼出時 |
| `tts_usage_logs` (既存 metadata) | `experience` | `"marunage"` | 音声生成 API 呼出時 |
| `audit_logs` | event 名接頭辞 | `marunage.*` | 各フェーズ遷移時 |

### 9-3. 記録ポイント

| イベント | テーブル | タグ |
|---|---|---|
| run 開始 | audit_logs | `marunage.run_started` |
| format 完了 | audit_logs | `marunage.format_completed` |
| 画像生成(各シーン) | api_usage_logs.metadata_json | `experience: 'marunage'` |
| 音声生成(各utterance) | tts_usage_logs (既存) | metadata に experience 追加 |
| run 完了 | audit_logs | `marunage.run_completed` |
| run 失敗 | audit_logs | `marunage.run_failed` |

### 9-4. 既存への変更
- `api_usage_logs` / `tts_usage_logs` のスキーマ変更は**不要**（metadata_json に含めるだけ）
- 丸投げ側のラッパーで metadata にタグを追加してから既存関数を呼ぶ
- **UI**: 左ボードフッターに `exp: marunage_chat_v1` を常時表示（Experience Spec v1 §13-3 参照）

---

## 10. UI フロー仕様

> **⚠️ SSOT 移管済み**: UI/体験仕様の詳細は **`MARUNAGE_EXPERIENCE_SPEC_v1.md`** を唯一の正とする。
> 本セクションは概要のみ残す。画面構成・チャット文言・シーンカード仕様・進捗バー・
> ポーリングロジック・失敗時UX・声選択UI・モバイル対応の全てが Experience Spec に定義済み。

### 10-0. 参照先

| 項目 | 参照ドキュメント | セクション |
|---|---|---|
| 右/左の責務境界 | Experience Spec v1 | §2 |
| 画面レイアウト（デスクトップ/モバイル/タブレット） | Experience Spec v1 | §3 |
| UI State Machine（idle/processing/ready/error） | Experience Spec v1 | §4 |
| 完全遷移表（操作→文言→ボード→SSOT） | Experience Spec v1 | §5 |
| 失敗時 UX（リトライ/中断） | Experience Spec v1 | §6 |
| チャット文言テンプレート | Experience Spec v1 | §7 |
| 声選択 UI・出力プリセット | Experience Spec v1 | §8 |
| シーンカード仕様 | Experience Spec v1 | §9 |
| 進捗バー仕様 | Experience Spec v1 | §10 |
| ポーリング仕様・shouldAdvance | Experience Spec v1 | §11 |
| 将来拡張パス（体験A/B/アップロード） | Experience Spec v1 | §12 |
| experience_tag 仕様・フッター表示 | Experience Spec v1 | §13 |

### 10-1. 画面構成（概要）

```
┌──────────────────────────────────────────────────────────┐
|  MARUMUVI - 丸投げチャット                                |
├──────────────────────┬───────────────────────────────────┤
|                      |                                    |
|   [左ボード]          |     [右チャット]                    |
|   プレビュー & 進捗   |     入力 & 操作                    |
|                      |                                    |
|  ┌────────────────┐  |  ┌────────────────────────────┐    |
|  | 進捗バー       |  |  | テキストエリア              |    |
|  | ████░░░░ 60%  |  |  | (台本貼り付け)              |    |
|  | 画像生成中...   |  |  |                            |    |
|  └────────────────┘  |  | ナレーション声: [選択]       |    |
|                      |  | プリセット: [YouTube長尺 v] |    |
|  ┌────────────────┐  |  |                            |    |
|  | シーン1 [done]  |  |  | [丸投げ開始]               |    |
|  | [画像サムネ]   |  |  └────────────────────────────┘    |
|  ├────────────────┤  |                                    |
|  | シーン2 [done]  |  |  ┌────────────────────────────┐    |
|  | [画像サムネ]   |  |  | [done] シナリオ分割 (5)     |    |
|  ├────────────────┤  |  | [run]  画像生成 (3/5)       |    |
|  | シーン3 [run]   |  |  | [wait] 音声生成             |    |
|  | [生成中...]    |  |  └────────────────────────────┘    |
|  ├────────────────┤  |                                    |
|  | シーン4 [wait]  |  |  [エラー時: リトライボタン]        |
|  | シーン5 [wait]  |  |                                    |
|  └────────────────┘  |  [完了時:]                         |
|                      |  | Builderで微調整 |               |
|                      |  | 動画化へ進む (将来) |           |
└──────────────────────┴───────────────────────────────────┘
```

### 10-2. ポーリング仕様
- `GET /api/marunage/:projectId/status` を 3秒間隔
- `shouldAdvance(data)` が true なら `POST /advance` を呼ぶ
- `phase = 'ready'` or `'failed'` or `'canceled'` で停止
- **ブラウザを閉じたら進行は止まる**（MVP仕様として確定）
- 次回アクセス時に `GET /api/marunage/active` で自動再開

### 10-3. shouldAdvance ロジック

> **詳細版は Experience Spec v1 §11-2 を参照。** 以下は概要。

```javascript
function shouldAdvance(data) {
  const p = data.progress;
  switch (data.phase) {
    case 'formatting':
      return p.format.state === 'done';
    case 'awaiting_ready':
      return p.scenes_ready.utterances_ready === true;
    case 'generating_images':
      // generating > 0 → 待機。それ以外 → advance に判断委譲
      if (p.images.generating > 0) return false;
      if (p.images.completed > 0 || p.images.failed > 0) return true;
      return false;
    case 'generating_audio':
      return p.audio.job_status === 'completed';
    default:
      return false;
  }
}
```

---

## 11. 実装 Issue 分割（確定版）

> 各 Issue に **参照セクション** を明記。実装時はこのセクションを確認してから着手。

### Issue-0: DDL & 型定義（設計 Fix）
- `migrations/0050_create_marunage_runs.sql` 作成
- `src/types/marunage.ts` 新規（MarunageConfig, ALLOWED_TRANSITIONS）
- ローカル D1 マイグレーション実行
- **参照**: v3 §2-3（DDL）, v3 §3（フェーズ遷移）

### Issue-1: API バックエンド最小（active + start + status + advance）
- `src/routes/marunage.ts` 新規
- `src/index.tsx` にルート登録
- active: ユーザーのアクティブ run 検索 **[v3 §5-1]**
- start: project 作成 + format 起動（processTextChunks export 追加）
- status: 集計クエリ実装
- advance: phase 分岐 + 楽観ロック + 5シーン収束処理 + **画像自動リトライ [Exp §5-6]**
- **参照**: v3 §5（API 仕様）, Exp §5（遷移表）, Exp §11（shouldAdvance）

### Issue-2: 画像生成オーケストレーション
- marunage.ts 内に `marunageGenerateImages()` 独自実装
- 既存 utils（image-prompt-builder, output-presets）を再利用
- APIキー解決は既存ロジック踏襲
- **参照**: v3 §4-3（画像生成代替案）, Exp §5-6（画像自動リトライフロー）

### Issue-3: 音声生成オーケストレーション
- `runBulkGenerationJob` export 追加（bulk-audio.ts に1行）
- advance の generating_audio 分岐
- audio_job_id の追跡
- **参照**: v3 §4-2（起動方式）, v3 §6-5（音声進捗SQL）

### Issue-4: retry + cancel
- retry: failed → 巻き戻しマップに従い phase リセット
- cancel: phase → canceled + audio job cancel 試行
- **参照**: v3 §5-5, §5-6（API 仕様）, Exp §6（失敗時UX）

### Issue-5: フロントエンド UI
- marunage-chat 画面の HTML/CSS（左ボード + 右チャット）
- テキスト入力 + 声選択 + start ボタン
- ポーリング + shouldAdvance + 進捗表示
- エラー表示 + リトライ UI
- **参照**: **Exp §2〜§11 全セクション** + Exp Appendix A（実装チェックリスト）

### Issue-6: 運用・監査・コストタグ
- audit_logs に marunage イベント記録
- api_usage_logs.metadata_json に experience タグ追加
- `marunage_runs.config_json.experience_tag = 'marunage_chat_v1'` を run 作成時に固定
- 左ボードフッターに `exp: marunage_chat_v1` 表示
- admin ダッシュボードでの丸投げ run 一覧（将来）
- **参照**: v3 §9（コストタグ仕様・experience_tag 固定値と記録箇所）, Exp §13（experience_tag UI 仕様）

### Issue-7: 統合テスト & デプロイ
- ローカル E2E テスト（5シーンパイプライン全通し）
- エッジケーステスト（短文、長文、キャラ名不一致、API failure）
- Cloudflare Pages デプロイ
- 本番 D1 マイグレーション
- **参照**: v3 §6（完了判定SQL）, Exp §5（全ステップ網羅確認）

---

## 12. 未解決 / 実装時判断ポイント

| # | 項目 | 推奨案 | ブロッカー? |
|---|---|---|---|
| 1 | 画像生成を独自実装 vs 既存関数 export | MVP: 独自実装（5シーンなので単純版で十分） | No |
| 2 | ユーザー Gemini キーなしの場合 | MVP: システムキーで実行（上限監視で対応） | No |
| 3 | 画像生成が30秒超えた場合 | waitUntil で非同期。advance は起動だけして即レスポンス | No |
| 4 | ポーリング間隔の最適値 | 3秒 (MVP) → SSE (将来) | No |
| 5 | 同時丸投げプロジェクト数の上限 | ユーザーあたり 1 プロジェクト (partial unique index で保証) | No |

---

## 13. 推定コスト（1プロジェクトあたり）

| リソース | 量 | 推定コスト |
|---|---|---|
| OpenAI (format AI分割) | 3チャンク | ~$0.003 |
| Gemini (画像生成) | 5シーン | ~$0.05 |
| Google TTS (音声) | ~15 utterances | ~$0.005 |
| D1 reads/writes | ~80 ops | 無料枠内 |
| R2 storage | 5画像 + 15音声 ~20MB | ~$0.0003 |
| **合計** | | **~$0.06 / プロジェクト** |
