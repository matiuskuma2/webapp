# MARUMUVIAI 運用状況レポート & 改善計画
## 作成日: 2026-03-12
## 対象: https://app.marumuviai.com

---

# Part 1: 現状把握

## 1.1 報告されている障害

### 障害 A: 画像生成が95%で止まる
- **報告元**: P404, P465, P467
- **症状**: 画像生成ボタンを押すと202が返り、ポーリングが始まるが `status=pending` のまま永久に進まない
- **コンソールログ**: `[Poll-ById] Gen #7623 scene 5829: status=pending, progress=5%, elapsed=192s`
- **ユーザー体験**: プログレスバーが95%で止まり、画像が表示されない

### 障害 B: 音声一括生成が16件で止まる
- **報告元**: P444 (285 utterances)
- **症状**: `[BulkAudio] Job 98 status: running, progress: 16/285` → `status: failed`
- **履歴**: Job 96〜100 全て16件で停止（waitUntil 30秒制限）
- **コンソールログ (P444)**: 旧バージョン `v=9dfd795` のまま

### 障害 C: 画像生成履歴に画像が表示されない
- **報告元**: P404 スクリーンショート (画像生成履歴ダイアログ)
- **症状**: 4件の生成履歴が全て「画像なし」、プロンプトのみ表示
- **DB確認**: scene 5829 に6件の `pending` レコード、全て `is_active=0`, `r2_url=NULL`

## 1.2 ユーザー要望

### 要望 1: 音声一覧編集ページ
- 現状: シーンごとに「話者の詳細」→「音声」→ 編集と3クリック必要
- 要望: 全シーンの音声を一覧で確認・修正できるページ

### 要望 2: 動画生成シーン数上限の引き上げ
- 現状: 100シーン上限
- 要望: 200シーンまで
- 確認対象: P444 (120シーン → 上限超過エラー)

## 1.3 バージョン問題

| 項目 | 期待値 | 実際 |
|---|---|---|
| 本番バージョン | `v=c17fed9` | `v=c17fed9` ✅ |
| P444 コンソール | `v=c17fed9` | `v=9dfd795` ❌ (キャッシュ) |
| P404 エラーログ | `v=c17fed9` | `v=c17fed9` ✅ |

P444は古いバージョンをブラウザキャッシュで使用中。Ctrl+Shift+R で解消するが、POLL-FIXは画像の根本問題には効かない。

---

# Part 2: 根本原因の特定

## 原因 1 (Critical): 画像生成ジョブの実行者が存在しない

**これが最大の問題です。**

### 現在のフロー
```
ブラウザ: POST /scenes/:id/generate-image
  ↓
サーバー: image_generations レコード作成 (status=pending, is_active=0)
  ↓
サーバー: job_queue にジョブ作成 (status=queued)
  ↓
サーバー: 202 Accepted を返す
  ↓
ブラウザ: GET /image-generations/:id/status をポーリング開始
  ↓
→ ⛔ 誰もジョブを取り出して実行しない
→ status=pending のまま永久に停滞
→ 95%で止まって見える
```

### なぜこうなったか
- `processOneImageJob()` は `POST /generate-all-images` の **HTTP リクエスト内** でしか呼ばれない
- 単体画像生成 (`POST /scenes/:id/generate-image`) は `createJob()` でキューに入れるだけ
- **Cron ジョブや Queue Consumer が存在しない**ため、`job_queue` テーブルの `queued` ジョブは誰も処理しない
- 結果: job_queue に **160件の queued ジョブ** が滞留中

### 影響範囲
- 単体画像生成（Builderタブの生成ボタン）: **完全に壊れている**
- 一括画像生成（generate-all-images）: 1リクエストで1件だけ処理可能（設計上の制約）

## 原因 2 (Resolved): 音声一括生成の waitUntil 制限

- Pages Function の `waitUntil()` は最大30秒
- TTS 1件 ≈ 2秒 → 最大16件で停止
- **Phase Q1 で Queue Consumer に移行済み**
- ただし `FISH_AUDIO_API_TOKEN` が Consumer Worker に未設定だった → **設定完了**
- P444 はブラウザキャッシュで旧バージョン使用中 → Ctrl+Shift+R で解消

## 原因 3 (Resolved): status エンドポイントの 500 エラー

- `image_generations.error_code` カラムが本番 D1 に存在しなかった
- `ALTER TABLE` で追加済み → HTTP 200 に復帰

---

# Part 3: DB上の現在の問題データ

## job_queue 滞留
```
status=queued: 160件 (全て generate_image)
status=completed: 99件
→ 160件は永久に処理されない
```

## P404 の image_generations
```
completed: 121件
failed:     32件
pending:     6件 (全て scene 5829、全て is_active=0)
→ 6回生成ボタンを押したが全て pending で放置
```

## P444 の project_audio_jobs
```
Job 96-100: 全て failed (16/285〜16/317)
→ waitUntil 限界で停止、stale cleanup済み
```

---

# Part 4: 改善計画

## Phase Fix-1 (Urgent): 画像生成ジョブの実行基盤

### 問題
`job_queue` テーブルの `queued` ジョブを誰も処理していない

### 選択肢

#### A案: 単体生成を同期処理に戻す (最小変更)
- `POST /scenes/:id/generate-image` 内で `processOneImageJob()` を直接呼ぶ
- 202 → 200 に変更、画像生成を同期で完了してから返す
- メリット: 既存のポーリングUIがそのまま使える（completed が即返る）
- デメリット: 1リクエストが15〜30秒かかる（Gemini API待ち）

#### B案: waitUntil で非同期実行 (中間案)
- `POST /scenes/:id/generate-image` 内で `c.executionCtx.waitUntil(processOneImageJob(...))` を呼ぶ
- 202 を即返し、バックグラウンドで処理
- メリット: 高速レスポンス + 既存ポーリングUIが動く
- デメリット: waitUntil 30秒制限（画像1枚なら十分）

#### C案: Cloudflare Queue Consumer (音声と同じ方式)
- 画像生成用の Queue を追加
- メリット: 最も堅牢、15分の壁time
- デメリット: 追加のWorkerが必要、開発コスト大

### 推奨: B案 (waitUntil)
- 画像1枚の生成は通常10〜20秒 → waitUntil 30秒に収まる
- job_queue テーブルは段階的に廃止（一括生成もwaitUntil内で処理可能）
- 実装コストが最小

### 実装内容
1. `POST /scenes/:id/generate-image` に `waitUntil(processOneImageJob())` 追加
2. 既存の160件 queued ジョブをクリーンアップ
3. P404 の6件 pending レコードをクリーンアップ

## Phase Fix-2 (Important): 音声 Queue Consumer の実運用確認

### 状態
- Queue / DLQ / Consumer Worker 全てデプロイ済み
- FISH_AUDIO_API_TOKEN 設定完了
- P472 での初回テストは token 未設定で失敗 → 再テスト必要

### 実施内容
1. P472 で bulk audio を再実行
2. watch-bulk-audio.sh でリアルタイム監視
3. 完走確認 → Phase Q1 完了判定

## Phase Fix-3 (Enhancement): 音声一覧編集ページ

### 現状の課題
- シーンごとに3クリック必要（話者の詳細 → 音声タブ → 編集）
- シーン数が多い場合に非常に手間

### 提案
- `/projects/:id/audio-editor` に新規ページを追加
- 全シーンの utterance を一覧表示
- インライン編集（テキスト、話者、声質、再生成ボタン）

### 優先度: Medium (UX改善)

## Phase Fix-4 (Enhancement): 動画生成シーン数上限

### 現状
- `MAX_SCENES = 100` （コード内のハードコード値）

### 変更内容
- 上限を200に引き上げ
- または設定可能にする

### 影響確認
- Remotion ビルド時のメモリ使用量
- ビルド時間（200シーン → 推定5〜10分）
- Cloudflare Pages / Lambda の制約確認

### 優先度: Medium

---

# Part 5: 実施優先度

| 順位 | Phase | 内容 | 緊急度 | 工数 |
|---|---|---|---|---|
| 1 | Fix-1 | 画像生成ジョブ実行基盤 | 🔴 Critical | 小 (2h) |
| 2 | Fix-2 | 音声 Queue Consumer 実運用確認 | 🟡 Important | 小 (1h) |
| 3 | Fix-4 | シーン数上限 100→200 | 🟡 Important | 極小 (30min) |
| 4 | Fix-3 | 音声一覧編集ページ | 🟢 Enhancement | 中 (1-2日) |

---

# Part 6: 技術負債の整理

## 現在の既知の技術負債

| 項目 | 状態 | リスク |
|---|---|---|
| job_queue に160件の orphan ジョブ | 滞留中 | DB肥大化 |
| P404 に6件の永久 pending レコード | 残存中 | UI表示の混乱 |
| P444 のブラウザキャッシュ (v=9dfd795) | 残存中 | ユーザー混乱 |
| image_generations の重複レコード蓄積 | 累積中 | DB肥大化 |
| waitUntil vs Queue の二重経路 | 共存中 | 保守性低下 |
| migration 0059 の duration_ms 二重追加 | 無害 | 紛らわしい |

---

# Part 7: 今回変更しない項目

以下は今回のスコープ外とし、変更しない。

1. **P1 (format ジョブ化)** — 未着手、今回は不要
2. **Queue Consumer の Cloudflare 画像版** — B案(waitUntil)で十分
3. **fairness 制御** — ユーザー数が少ないため不要
4. **Comic Editor** — 正常動作中
5. **Video Build** — シーン数上限以外は正常

---

# Appendix: 確認用コマンド

## 画像生成の滞留確認
```sql
SELECT status, COUNT(*) FROM job_queue GROUP BY status;
SELECT status, COUNT(*) FROM image_generations WHERE scene_id IN
  (SELECT id FROM scenes WHERE project_id = 404) GROUP BY status;
```

## 音声 Queue 状態確認
```bash
bash scripts/verify-bulk-audio.sh 472
bash scripts/watch-bulk-audio.sh 472
```
