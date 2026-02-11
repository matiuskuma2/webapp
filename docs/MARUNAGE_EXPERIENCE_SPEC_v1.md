# 丸投げチャット 体験仕様書 v1（Experience Spec）

> **ステータス**: 設計確定・実装可能粒度
> **最終更新**: 2026-02-11
> **対象**: MVP v1（体験Cのみ: テキスト → 5シーン → 画像 → 音声 → Ready）
> **前提ドキュメント**: `MARUNAGE_CHAT_MVP_PLAN_v3.md`（SSOT/API/運用設計）
> **ページ**: `/marunage-chat`（既存の工事中ページを置き換え）

---

## 0. この文書の目的

`MARUNAGE_CHAT_MVP_PLAN_v3.md` はバックエンド安全設計（SSOT/API/運用）が確定している。
一方で **「ユーザーが画面上で何を見て、何を触って、次に何が起きるか」** が未確定のまま。
この文書は **体験仕様の SSOT** として、以下を固定する：

1. 右チャット×左ボードの **責務境界（絶対ルール）**
2. ユーザー操作 → チャット文言 → ボード状態 → SSOT遷移の **1:1 対応表**
3. 失敗時UX（再試行/中断）
4. デフォルト値と声選択UI
5. 将来拡張（体験A/B/アップロード）の **非実装パス宣言**

**実装者はこの文書の表を見れば「何を作るか」で迷わない状態にする。**

---

## 1. MVP v1 スコープ宣言

### 実装する体験

| 体験 | 内容 | v1 |
|---|---|---|
| **体験C（本丸）** | テキスト → 5シーン → 画像 → 音声 → Ready | **実装する** |

### v1 の入口ルール（確定）

- `/marunage-chat` は **体験C 専用**。体験A/B の入口（ボタン・リンク・Coming soon を含む）は **v1 に一切置かない**。
- 将来予告は idle のウェルカム文に 1 行追加するのみ（→ §5-1 参照）。
- アップロード UI は **v1 に出さない**。v2 以降で `marunage_run_assets` に隔離して導入する（→ §12-3 参照）。

### 実装しない体験（将来パスのみ）

| 体験 | 内容 | 導入予定 |
|---|---|---|
| 体験A（画像単発） | 1枚画像生成（体験の入口） | v1.5〜v2 |
| 体験B（動画生成） | 画像 → Veo 短尺 | v2〜 |
| アップロード（画像） | 背景/差し替え用の画像 UP | v1.5 |
| アップロード（動画） | Veo 用素材 UP | v2 |
| アップロード（音声） | ナレーション差し替え UP | v3 |
| 動画ビルド（Remotion） | Ready → 最終動画出力 | v1.1〜v2 |
| BGM 自動選択 | system_audio_library から自動割当 | v1.1〜 |
| チャット修正指示 | 「画像を変えて」等の自然言語指示 | v2〜 |

---

## 2. 右チャット×左ボード 責務境界（絶対ルール）

> **この表は変えない。** 実装中に「ボードに入力欄を置きたい」「チャットにサムネを出したい」等の誘惑が来ても、この表に従う。

### 2-1. 責務マトリクス

| 領域 | やること | やらないこと |
|---|---|---|
| **右チャット**（操作と会話） | テキスト入力欄 / 声選択 / プリセット選択 / 「丸投げ開始」ボタン / 進捗メッセージ（ステップ完了通知） / エラー通知＋理由説明 / リトライボタン / キャンセルボタン / 完了後アクション導線 | 画像サムネイルの主表示 / 音声プレイヤーの主表示 / シーン一覧の主表示 |
| **左ボード**（結果と状態） | SSOT 現在地の可視化（進捗バー） / シーンカード（テキスト→画像→音声が積み上がる） / 画像サムネイル / 音声再生ボタン / 失敗箇所の赤枠表示 / Ready バッジ | 実行ボタン / 設定変更 / テキスト入力 / エラーのリトライ操作 |

### 2-2. 核心ルール

1. **右は「操作と会話」、左は「結果と状態」**
2. **左ボードに出てないものは未確定**（ユーザーから見て「まだ存在しない」）
3. **チャットメッセージは時系列で積み上がる**（上が古い、下が新しい）
4. **ボードのシーンカードは位置固定**（idx 順で常に同じ場所）
5. **進捗の数値表示は左ボードが SSOT**（チャットの文言は補助）

---

## 3. 画面レイアウト仕様

### 3-1. デスクトップ（1025px〜）

```
┌──────────────────────────────────────────────────────────────┐
│ MARUMUVI - 丸投げチャット                    [← TOP] [user] │
├───────────────── 50% ──────────┬──────────── 50% ────────────┤
│                                │                              │
│          左ボード               │         右チャット            │
│   (結果と状態: SSOT可視化)      │   (操作と会話)               │
│                                │                              │
│  ┌──────────────────────────┐  │  ┌──────────────────────┐    │
│  │ 全体進捗バー              │  │  │ チャット履歴          │    │
│  │ ████████░░ 80%           │  │  │ (スクロール領域)       │    │
│  │ 音声生成中...             │  │  │                       │    │
│  └──────────────────────────┘  │  │ sys: 開始しました      │    │
│                                │  │ sys: 5シーンに分割     │    │
│  ┌──────────────────────────┐  │  │ sys: 画像生成完了      │    │
│  │ シーン1 [✅ format]       │  │  │ sys: 音声生成中(8/15)  │    │
│  │ [画像サムネ] [🔊 再生]    │  │  │                       │    │
│  ├──────────────────────────┤  │  └──────────────────────┘    │
│  │ シーン2 [✅ format]       │  │                              │
│  │ [画像サムネ] [🔊 再生]    │  │  ┌──────────────────────┐    │
│  ├──────────────────────────┤  │  │ [入力フォーム]          │    │
│  │ シーン3 [🔄 image]       │  │  │ テキストエリア          │    │
│  │ [生成中...]               │  │  │ 声: [Neural2-B ▼]     │    │
│  ├──────────────────────────┤  │  │ PT: [YouTube長尺 ▼]   │    │
│  │ シーン4 [⏳ wait]         │  │  │                       │    │
│  ├──────────────────────────┤  │  │ [🚀 丸投げ開始]       │    │
│  │ シーン5 [⏳ wait]         │  │  └──────────────────────┘    │
│  └──────────────────────────┘  │                              │
│                                │                              │
└────────────────────────────────┴──────────────────────────────┘
```

### 3-2. モバイル（〜640px）

```
┌────────────────────────────────┐
│ MARUMUVI - 丸投げチャット        │
├────────────────────────────────┤
│                                │
│  [タブ切替: ボード | チャット]    │
│                                │
│  (選択中のタブの内容を表示)       │
│                                │
└────────────────────────────────┘
```

- **デフォルト表示**: チャットタブ（入力が先）
- **開始後**: 自動でボードタブに切替（生成物を見せる）
- **切替は自由**（ユーザーがいつでも切り替え可能）

### 3-3. タブレット（641px〜1024px）

- デスクトップと同じ2カラム
- 左右の比率を 40:60 に調整（チャット側を広め）

---

## 4. 画面状態（UI State Machine）

```
                    ページ表示
                        │
                        v
                    [idle]  ←─── (cancel/完了後に新規)
                        │
                 「丸投げ開始」押下
                        │
                        v
                  [processing]  ←─── (retry)
                    │       │
                 (成功)   (失敗)
                    │       │
                    v       v
                [ready]  [error]
                    │       │
                    │    (retry → processing)
                    │    (cancel → idle)
                    v
              (Builder導線 / ダウンロード)
```

### 状態定義

| UI State | 右チャット | 左ボード | ポーリング |
|---|---|---|---|
| **idle** | 入力フォーム表示 / 開始ボタン有効 | 空キャンバス（ウェルカム表示） | OFF |
| **processing** | 入力フォーム非表示 / 進捗メッセージ積み上げ / キャンセルボタン表示 | シーンカード＋進捗バー | 3秒間隔 ON |
| **ready** | 完了メッセージ＋次アクション導線 | 全カード完了＋Ready大バッジ | OFF |
| **error** | エラー理由＋リトライ/キャンセルボタン | 失敗箇所に赤枠 | OFF（リトライで再開） |

### 復帰時（ブラウザを閉じて再訪問）

- `GET /api/marunage/:projectId/status` で最新状態を取得
- `phase` が `formatting`〜`generating_audio` → **processing 状態で復帰**（ポーリング自動再開）
- `phase` が `ready` → ready 状態で表示
- `phase` が `failed` → error 状態で表示
- `phase` が `canceled` → idle 状態（新規入力可能）
- アクティブ run なし → idle 状態

---

## 5. 体験C 完全遷移表（1:1 対応 — 実装のSSOT）

> **この表が実装仕様書そのもの。** 各行が「ユーザーが見るもの」と「裏のSSOT」の完全対応。

### 5-1. Step 0: 初期表示（idle）

| 項目 | 内容 |
|---|---|
| **ユーザー操作** | `/marunage-chat` にアクセス |
| **右チャット** | 入力フォーム表示 |
| **左ボード** | ウェルカム表示：「台本を貼り付けて、丸投げ開始を押してください。5シーンの動画素材を自動で作成します。」＋ 将来予告 1 行：`今後、画像だけ/動画だけの個別生成も追加予定です（v2以降）` |
| **SSOT** | marunage_runs なし（or 前回 run が terminal） |
| **API** | `GET /api/marunage/active` でアクティブ run を検索。あれば processing 状態に復帰。なければ idle 表示。 |

**復帰フロー（再訪問時）:**
1. ページ読み込み時に `GET /api/marunage/active` を呼ぶ
2. 200 + アクティブ run あり → `run_id`, `project_id` を取得 → processing 状態に復帰 → ポーリング開始
3. 404（アクティブ run なし）→ idle 表示（新規入力フォーム）
4. `GET /api/marunage/active` は session cookie のユーザー ID からアクティブ run を検索

**`GET /api/marunage/active` 仕様（v3 計画書への追記事項）:**
- session cookie 必須
- `marunage_runs WHERE started_by_user_id = ? AND phase NOT IN ('ready', 'failed', 'canceled')` で検索
- ヒット → 200 `{ run_id, project_id, phase }` を返却
- なし → 404

**入力フォーム詳細:**

| UI要素 | 型 | デフォルト | バリデーション |
|---|---|---|---|
| テキストエリア | textarea | 空 | 必須 / 100〜50,000文字 |
| ナレーション声 | select | `google / ja-JP-Neural2-B` | 後述のプリセットリスト |
| 出力プリセット | select | `yt_long` | `yt_long` / `short_vertical` |
| 開始ボタン | button | 有効 | テキスト空時は disabled |

---

### 5-2. Step 1: 開始（init → formatting）

| 項目 | 内容 |
|---|---|
| **ユーザー操作** | 「丸投げ開始」ボタン押下 |
| **右チャット** | ボタン即 disabled → メッセージ追加：`「処理を開始します。まず台本を5シーンに分割します...」` |
| **左ボード** | ウェルカム → 遷移アニメーション → 進捗バー表示（0%）＋シーンカード5枠（スケルトン/placeholder） |
| **SSOT** | `POST /api/marunage/start` → `marunage_runs` INSERT (phase=`init` → `formatting`) |
| **API** | `POST /start` → 201 → `run_id`, `project_id` 取得 → ポーリング開始 |

**入力フォームの状態変化:**
- テキストエリア → 非表示
- 声選択/プリセット → 非表示
- 開始ボタン → 非表示
- キャンセルボタン → 表示

---

### 5-3. Step 2: フォーマット中（formatting）

| 項目 | 内容 |
|---|---|
| **ユーザー操作** | なし（待機） |
| **右チャット** | 3秒ポーリングで進捗更新。チャンク進捗があれば：`「シナリオを分析中... (2/3チャンク完了)」` |
| **左ボード** | 進捗バー 10-30% / シーンカード5枠はスケルトン状態 |
| **SSOT** | `marunage_runs.phase = 'formatting'` / `projects.status` が裏で `formatting` → `formatted` へ変化 |
| **ポーリング** | `GET /status` → `progress.format.state` を監視 |

**shouldAdvance 条件:** `progress.format.state === 'done'`

---

### 5-4. Step 3: 5シーン確定（formatting → awaiting_ready）

| 項目 | 内容 |
|---|---|
| **ユーザー操作** | なし（自動 advance） |
| **右チャット** | メッセージ追加：`「5シーンに分割しました！音声テキストを準備しています...」` |
| **左ボード** | シーンカード5枚が実体化。各カードに：タイトル / dialogue preview（50文字） / 状態バッジ `format ✅` |
| **SSOT** | `POST /advance` → phase `formatting` → `awaiting_ready` / 6件目以降のシーンは `is_hidden=1` |
| **API** | advance が 5シーン収束処理を実行 |

**シーンカードの構造（この時点）:**

```
┌──────────────────────────────┐
│ Scene 1: [タイトル]     ✅   │
│ 「冒頭のナレーション...」    │
│                              │
│ [画像: 未生成]  [音声: 待機]  │
└──────────────────────────────┘
```

---

### 5-5. Step 4: utterances 準備完了（awaiting_ready → generating_images）

| 項目 | 内容 |
|---|---|
| **ユーザー操作** | なし（自動 advance） |
| **右チャット** | メッセージ追加：`「画像生成を開始します (0/5)」` |
| **左ボード** | 進捗バー 30-40% / 各カードの画像エリアに「生成中...」ローディングアニメ |
| **SSOT** | `POST /advance` → phase `awaiting_ready` → `generating_images` / waitUntil で画像生成起動 |
| **ポーリング条件** | `progress.scenes_ready.utterances_ready === true` で advance 発火 |

**shouldAdvance 条件:** `progress.scenes_ready.utterances_ready === true`

---

### 5-6. Step 5: 画像生成中（generating_images）

| 項目 | 内容 |
|---|---|
| **ユーザー操作** | なし（待機）。左ボードで生成済み画像を閲覧可能 |
| **右チャット** | ポーリング毎に更新：`「画像生成中... (3/5)」` → `「画像生成中... (4/5)」` |
| **左ボード** | 各シーンカードに画像サムネが1枚ずつ入る。完了=サムネ表示 / 生成中=ローディング / 失敗=赤枠 |
| **SSOT** | `marunage_runs.phase = 'generating_images'` / `image_generations` の各レコードが個別に進行 |
| **ポーリング** | `GET /status` → `progress.images.completed` / `generating` / `failed` を監視 |

**ボード表示パターン:**

| 画像状態 | カード表示 |
|---|---|
| pending | グレー背景＋時計アイコン |
| generating | ブルー枠＋ローディングスピナー |
| completed | 画像サムネイル表示 |
| failed | 赤枠＋エラーアイコン＋「再試行待ち」テキスト |

**shouldAdvance 条件（精密版）:**

```javascript
// generating_images の advance 判定
case 'generating_images': {
  const img = p.images;
  if (img.generating > 0) return false;            // まだ生成中 → 待機
  if (img.completed === img.total_scenes) return true; // 全成功 → 次へ
  if (img.failed > 0) return true;                 // 失敗あり → advance に判断委譲
  return false;
}
```

**advance 側の画像失敗ハンドリング（バックエンド）:**

| 状況 | advance の動作 | UI 影響 |
|---|---|---|
| `completed === 5` | phase → `generating_audio`（次フェーズ） | 右: 「全ての画像が完成しました！」 |
| `failed > 0 && retry_count < 3` | `retry_count++` → 失敗画像を再生成起動 → phase はそのまま `generating_images` | 右: 「シーン{idx}を再試行中... ({retry}/3)」 |
| `failed > 0 && retry_count >= 3` | phase → `failed`, error_phase=`generating_images` | 右: エラーメッセージ + [リトライ][キャンセル] |
| `completed === 0`（全滅） | phase → `failed`, error_phase=`generating_images` | 右: 「画像生成に失敗しました」 |

**重要**: 自動リトライは **advance API 内（バックエンド）** で実行する。フロント側は shouldAdvance=true を検知して advance を POST するだけ。リトライ判断はバックエンドに閉じる。

---

### 5-7. Step 6: 音声生成中（generating_audio）

| 項目 | 内容 |
|---|---|
| **ユーザー操作** | なし（待機）。左ボードで生成済み音声を再生可能 |
| **右チャット** | `「音声生成を開始しました」` → ポーリング毎に：`「音声生成中... (8/15)」` |
| **左ボード** | 進捗バー 70-90% / 各カードに音声アイコン付加（完了分は再生ボタン有効） |
| **SSOT** | `marunage_runs.phase = 'generating_audio'` / `project_audio_jobs.status` が SSOT |
| **ポーリング** | `GET /status` → `progress.audio.job_status` を監視 |

**ボードの音声表示:**

| 音声状態 | カード表示 |
|---|---|
| 待機（job未開始） | グレー音符アイコン |
| 生成中 | ブルー音符＋ローディング |
| 完了 | グリーン音符＋再生ボタン（▶） |
| 失敗 | 赤音符アイコン |

**shouldAdvance 条件:** `progress.audio.job_status === 'completed'`

---

### 5-8. Step 7: 完了（ready — MVP 終点）

| 項目 | 内容 |
|---|---|
| **ユーザー操作** | 完了画面を確認 → 次アクション選択 |
| **右チャット** | メッセージ追加：`「🎉 完成しました！画像と音声の準備が整いました。」` ＋ 次アクションボタン |
| **左ボード** | 進捗バー 100%（グリーン） / 全カード ✅ / 画面上部に大きな **Ready** バッジ |
| **SSOT** | `marunage_runs.phase = 'ready'` / `marunage_runs.completed_at` 設定 |
| **ポーリング** | OFF |

**完了後アクション（右チャットに表示）:**

| ボタン | 動作 | v1 |
|---|---|---|
| **Builderで微調整** | `/project/:projectId` に遷移（既存 Builder 画面） | ✅ 有効 |
| **画像をダウンロード** | 既存 `GET /api/projects/:id/downloads/images-zip` を呼ぶ | ✅ 有効 |
| **動画化へ進む** | Remotion ビルド起動（v1.1〜v2 で実装） | ❌ 非表示 |
| **新しい丸投げを開始** | idle 状態にリセット（新規入力画面） | ✅ 有効 |

---

## 6. 失敗時 UX（確定版）

> MVP v1 では **「スキップ」は原則なし**（品質を落とすため）。**リトライと中断のみ。**

### 6-1. 失敗パターンと UI 対応

| 失敗場面 | 右チャット表示 | 左ボード表示 | ユーザー操作 | SSOT |
|---|---|---|---|---|
| **format 失敗** | `「シーン分割に失敗しました。[理由]」` ＋ リトライボタン | 進捗バー赤色 / カード全てエラー状態 | 「リトライ」or「キャンセル」 | `phase='failed'`, `error_phase='formatting'` |
| **画像 1枚失敗**（部分） | `「シーン3の画像生成に失敗しました。自動で再試行します...」` | カード3が赤枠 / 他は正常 | 自動リトライ（3回まで） | phase 変わらず（generating_images 内で retry） |
| **画像 自動リトライ上限** | `「画像生成が一部失敗しました（3回再試行済み）」` ＋ リトライボタン | 失敗カードが赤枠で残る | 「失敗だけ再試行」or「キャンセル」 | `phase='failed'`, `error_phase='generating_images'` |
| **画像 全滅** | `「画像生成に失敗しました。[理由]」` ＋ リトライボタン | 全カード赤枠 | 「リトライ」or「キャンセル」 | `phase='failed'`, `error_phase='generating_images'` |
| **音声失敗** | `「音声生成に失敗しました。[理由]」` ＋ リトライボタン | 音声アイコン赤 | 「リトライ」or「キャンセル」 | `phase='failed'`, `error_phase='generating_audio'` |

### 6-2. リトライ時の挙動

| 操作 | API | 巻き戻し先 | ボード表示 |
|---|---|---|---|
| 「リトライ」押下 | `POST /api/marunage/:projectId/retry` | error_phase に応じた巻き戻し（v3 計画書 §5-5 参照） | 失敗箇所を「生成中」に戻し、ポーリング再開 |
| retry_count >= 5 | 400 RETRY_EXHAUSTED | — | `「リトライ回数の上限に達しました。Builderで個別に対応してください。」` |

### 6-3. キャンセル時の挙動

| 操作 | API | ボード表示 | 右チャット |
|---|---|---|---|
| 「キャンセル」押下 | `POST /api/marunage/:projectId/cancel` | 最後の完了状態で凍結（生成済みの画像/音声はそのまま） | `「処理を中断しました。」` ＋ 「Builderで続ける」/「新しい丸投げを開始」 |

---

## 7. チャットメッセージ文言テンプレート（確定版）

> 実装時にこの文言をそのまま使う。変更する場合はこの表を先に更新してから実装。

### 7-1. 正常系メッセージ

| タイミング | メッセージ（日本語） | トリガー |
|---|---|---|
| 開始直後 | `処理を開始します。まず台本を5シーンに分割します...` | start API 201 受信 |
| format チャンク進捗 | `シナリオを分析中... ({done}/{total}チャンク完了)` | ポーリング: format.chunks 更新時 |
| format 完了 | `5シーンに分割しました！音声テキストを準備しています...` | advance: formatting → awaiting_ready |
| utterances 準備完了 | `画像生成を開始します (0/{scene_count})` | advance: awaiting_ready → generating_images |
| 画像進捗 | `画像生成中... ({completed}/{total})` | ポーリング: images.completed 変化時 |
| 画像完了 | `全ての画像が完成しました！音声生成に進みます。` | advance: generating_images → generating_audio |
| 音声開始 | `音声生成を開始しました。` | advance 直後 |
| 音声進捗 | `音声生成中... ({completed}/{total_utterances})` | ポーリング: audio.completed 変化時 |
| 完了 | `🎉 完成しました！画像と音声の準備が整いました。` | advance: generating_audio → ready |

### 7-2. エラー系メッセージ

| タイミング | メッセージ | 付随UI |
|---|---|---|
| format 失敗 | `シーン分割に失敗しました。テキストの形式を確認してください。` | [リトライ] [キャンセル] |
| 画像部分失敗（自動リトライ） | `シーン{idx}の画像生成に失敗しました。自動で再試行します... ({retry}/{max})` | なし（自動） |
| 画像部分失敗（上限到達） | `シーン{idx}の画像生成が{max}回失敗しました。` | [失敗だけ再試行] [キャンセル] |
| 画像全滅 | `画像生成に失敗しました。しばらく時間をおいて再試行してください。` | [リトライ] [キャンセル] |
| 音声失敗 | `音声生成に失敗しました。` | [リトライ] [キャンセル] |
| リトライ上限 | `リトライ回数の上限に達しました。Builderで個別に対応してください。` | [Builderを開く] |

### 7-3. メッセージ表示ルール

- **システムメッセージ**: 左寄せ / グレー背景 / アイコン付き（✅ 🔄 ❌）
- **同じフェーズの進捗メッセージ**: 新しいメッセージで **上書き**（チャット履歴を埋めない）
  - 例: `「画像生成中... (2/5)」` → `「画像生成中... (3/5)」` （置換、追加ではない）
- **フェーズ遷移メッセージ**: **追加**（履歴に残る）
  - 例: `「5シーンに分割しました！」` は消えない

---

## 8. 声選択 UI 仕様

### 8-1. MVP 推奨プリセット（固定リスト）

> 既存 `GET /api/audio-generation/voices` は Google 8種 + ElevenLabs(動的) + Fish 1種 を返すが、
> 丸投げ MVP では **情報過多を避ける** ため、推奨プリセットのみ表示。

| 表示名 | provider | voice_id | 性別 |
|---|---|---|---|
| **おまかせ（男性・落ち着き）** | google | `ja-JP-Neural2-B` | male |
| 女性・落ち着き | google | `ja-JP-Neural2-C` | female |
| 男性・自然 | google | `ja-JP-Wavenet-C` | male |
| 女性・自然 | google | `ja-JP-Wavenet-A` | female |

- デフォルト: **おまかせ（男性・落ち着き）**
- 将来（v1.5〜）: 「詳細選択」リンクで全ボイス一覧を展開

### 8-2. 出力プリセット選択

| 表示名 | preset_id | 説明 |
|---|---|---|
| **YouTube 長尺** | `yt_long` | 16:9 横型（デフォルト） |
| 縦型ショート | `short_vertical` | 9:16 縦型（Shorts/Reels/TikTok） |

- デフォルト: **YouTube 長尺**
- 将来（v1.5〜）: `yt_shorts`, `reels`, `tiktok`, `custom` を追加

### 8-3. 設定のスナップショット

- 開始ボタン押下時、選択された声＋プリセットが `marunage_runs.config_json` にスナップショットされる
- 実行中の設定変更は不可（config は run 作成時に凍結）

---

## 9. シーンカード仕様（左ボード）

### 9-1. カード構造

```
┌─────────────────────────────────────────┐
│ [idx] [タイトル]              [状態バッジ] │
├─────────────────────────────────────────┤
│                                         │
│  [画像エリア]           [音声エリア]      │
│  ┌─────────────┐       🔊 再生 (0:03)   │
│  │             │       発話数: 3         │
│  │  (サムネ)   │                         │
│  │  or ロード  │                         │
│  │  or エラー  │                         │
│  └─────────────┘                         │
│                                         │
│  dialogue: 「冒頭のナレーション...」      │
│                                         │
└─────────────────────────────────────────┘
```

### 9-2. 状態バッジの定義

| バッジ | 色 | 表示条件 |
|---|---|---|
| `待機` | グレー | phase < generating_images かつこのシーンは未処理 |
| `分割完了` | グリーン薄 | シーンテキスト確定済み |
| `画像生成中` | ブルーアニメ | image_generations.status = 'generating' |
| `画像完了` | グリーン | image_generations.status = 'completed' |
| `画像失敗` | レッド | image_generations.status = 'failed' |
| `音声生成中` | ブルーアニメ | phase = generating_audio かつ音声未完了 |
| `完了` | グリーン濃 | 画像＋音声の両方が completed |
| `エラー` | レッド | 画像 or 音声が failed |

### 9-3. 画像サムネイル

- **サイズ**: 16:9 比率のサムネイル（`yt_long` の場合）/ 9:16（`short_vertical` の場合）
- **ソース**: `image_generations.r2_key` から signed URL で取得
- **クリック動作**: 拡大表示（モーダル or lightbox）
- **エラー時**: 赤背景＋エラーアイコン＋「生成失敗」テキスト

### 9-4. 音声再生

- **再生ボタン**: 小さい ▶ ボタン / クリックで `audio_generations.r2_key` の音声を再生
- **表示情報**: 発話数（utterance_count） / 推定再生時間
- **未生成時**: グレーアウトした音符アイコン

---

## 10. 進捗バー仕様（左ボード上部）

### 10-1. フェーズ別の進捗率マッピング

| phase | 進捗率範囲 | 計算方法 |
|---|---|---|
| `formatting` | 0% 〜 30% | `30 * (chunks_done / chunks_total)` |
| `awaiting_ready` | 30% 〜 35% | 30 + 5（utterances_ready で 35%） |
| `generating_images` | 35% 〜 70% | `35 + 35 * (images_completed / 5)` |
| `generating_audio` | 70% 〜 100% | `70 + 30 * (audio_completed / audio_total)` |
| `ready` | 100% | 固定 |
| `failed` | 最後の進捗値で停止 | 赤色に変化 |

### 10-2. 表示フォーマット

```
████████████████░░░░░░░░░░ 65%
画像生成中... (3/5)
```

- **通常**: ブルー → グリーン（完了時）
- **エラー**: レッド
- **テキスト**: 現在のフェーズ名 ＋ 進捗数値

---

## 11. ポーリング仕様（詳細）

### 11-1. ポーリングサイクル

```javascript
// ポーリングのライフサイクル
let pollingTimer = null;
let currentProjectId = null;

function startPolling(projectId) {
  currentProjectId = projectId;
  pollingTimer = setInterval(() => pollAndAdvance(projectId), 3000);
}

function stopPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = null;
}

async function pollAndAdvance(projectId) {
  const data = await fetch(`/api/marunage/${projectId}/status`).then(r => r.json());
  
  // 1. UI更新（左ボード＋右チャット）
  updateBoard(data);
  updateChat(data);
  
  // 2. 終了条件チェック
  if (['ready', 'failed', 'canceled'].includes(data.phase)) {
    stopPolling();
    return;
  }
  
  // 3. 自動advance判定
  if (shouldAdvance(data)) {
    await fetch(`/api/marunage/${projectId}/advance`, { method: 'POST' });
    // 次のポーリングで結果反映（即時再fetchはしない）
  }
}
```

### 11-2. shouldAdvance ロジック（確定版）

```javascript
function shouldAdvance(data) {
  const p = data.progress;
  switch (data.phase) {
    case 'formatting':
      return p.format.state === 'done';
    case 'awaiting_ready':
      return p.scenes_ready.utterances_ready === true;
    case 'generating_images':
      // generating > 0 → まだ生成中、待機
      if (p.images.generating > 0) return false;
      // 全成功 OR 失敗あり → advance に判断委譲
      // （advance 側で自動リトライ or failed 遷移を決定）
      if (p.images.completed > 0 || p.images.failed > 0) return true;
      return false;
    case 'generating_audio':
      return p.audio.job_status === 'completed';
    default:
      return false;
  }
}
```

> **重要**: `generating_images` の shouldAdvance は「生成が止まった（generating=0）」を検知するだけ。
> 成功/失敗の判断と自動リトライは **advance API（バックエンド）** に閉じる。
> フロントは「advance を呼ぶかどうか」だけを決める。

### 11-3. チャットメッセージ更新ロジック

```javascript
// 同一フェーズ内の進捗 → 上書き（最後のメッセージを置換）
// フェーズ遷移 → 追加（新しいメッセージ）

let lastPhase = null;
let lastProgressMessage = null;

function updateChat(data) {
  const newPhase = data.phase;
  
  if (newPhase !== lastPhase) {
    // フェーズ遷移 → メッセージ追加
    appendChatMessage(getPhaseTransitionMessage(newPhase, data));
    lastPhase = newPhase;
    lastProgressMessage = null;
  } else {
    // 同一フェーズ → 進捗メッセージ上書き
    const progressMsg = getProgressMessage(data);
    if (progressMsg !== lastProgressMessage) {
      replaceLastProgressMessage(progressMsg);
      lastProgressMessage = progressMsg;
    }
  }
}
```

---

## 12. 将来拡張パス（非実装宣言）

> 以下は v1 では **実装しない**。ただし v1 の設計が将来を **阻害しない** ことを確認済み。

### 12-1. 体験A: 画像単発生成（v1.5〜v2）

- 右チャットで「何を作る？」→ スタイル選択 → 画像1枚生成
- プロジェクトを作らないルートも可（軽量 run）
- `marunage_runs.config_json` に `{ "mode": "image_only" }` を追加
- 左ボードに画像カード1枚表示
- **v1 との共存**: phase に `image_only_done` を追加する CHECK 拡張で対応

### 12-2. 体験B: 動画生成（v2〜）

- 画像アップ or 既存シーン画像 → Veo で短尺動画生成
- 左ボードに入力画像＋出力動画を並列表示
- `video_generations.is_active` の切替操作（「この動画を採用」）
- **v1 との共存**: marunage_runs に `video_generation_ids` を持たせる

### 12-3. アップロード導入（v1.5〜v3）

| Version | 入力 | SSOT ルール |
|---|---|---|
| v1.5 | テキスト + 画像アップ | `marunage_run_assets` 一時テーブル |
| v2 | + 動画アップ | `marunage_run_assets.type='video'` |
| v3 | + 音声アップ | `marunage_run_assets.type='audio'` |

**採用ルール（全バージョン共通）:**
1. アップ素材は `marunage_run_assets` に一時保持（run 専用）
2. 既存の `image_generations` / `video_generations` / `audio_generations` への書き込みは **「採用」操作のみ**
3. 丸投げの実験が既存プロジェクト資産を汚さない
4. run が canceled された場合、一時素材は orphan として残る（cron で cleanup）

**`marunage_run_assets` テーブル（v1.5 で作成予定）:**

```sql
-- ※ v1 では作成しない。v1.5 マイグレーションとして予約
CREATE TABLE IF NOT EXISTS marunage_run_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('image', 'video', 'audio')),
  r2_key TEXT NOT NULL,
  original_filename TEXT,
  mime_type TEXT,
  adopted_at DATETIME NULL,  -- NULL=未採用、日時=採用済み
  adopted_to_table TEXT NULL, -- 'image_generations' | 'video_generations' | etc.
  adopted_to_id INTEGER NULL, -- 採用先レコードの ID
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES marunage_runs(id) ON DELETE CASCADE
);
```

### 12-4. 動画ビルド（v1.1〜v2）

- Ready 状態から「動画化へ進む」ボタンで Remotion ビルド起動
- `marunage_runs.phase` に `building_video` → `video_ready` を追加
- 左ボードにプレビュー動画プレイヤー表示
- **v1 の phase CHECK 制約拡張が必要**（マイグレーションで対応）

### 12-5. BGM 自動選択（v1.1〜）

- `system_audio_library` から mood ベースで自動選択
- `project_audio_tracks` に INSERT
- 右チャットで「BGM を変えたい」→ 候補3曲提示 → 選択
- **v1 の `config_json` に `bgm_mode: 'none'` が入っているので拡張時に `bgm_mode: 'auto'` に切替**

### 12-6. チャット修正指示（v2〜）

- Ready 後に「画像を変えて」「声を変えて」等の自然言語指示
- 既存の `patches` / `chat-edits` パターンを踏襲
- intent 解析 → dry-run → apply の 3ステップ
- **v1 の右チャットは入力→実行の直線なので、ここに会話ループを追加する形**

---

## 13. experience_tag 仕様（確定）

### 13-1. 固定値

- **v1 の experience_tag**: `marunage_chat_v1`（定数。run 作成時に `config_json` へ記録）

### 13-2. 記録箇所

| 記録先 | フィールド | 値 |
|---|---|---|
| `marunage_runs.config_json` | `experience_tag` | `"marunage_chat_v1"` |
| `api_usage_logs.metadata_json` | `experience` | `"marunage"` |
| `tts_usage_logs` (既存 metadata) | `experience` | `"marunage"` |
| `audit_logs` | event 名接頭辞 | `marunage.*`（例: `marunage.run_started`） |

### 13-3. 左ボードのフッター表示

- 左ボード最下部にフッター行を常時表示：
  ```
  exp: marunage_chat_v1
  ```
- フォント: 10px / カラー: `#9ca3af`（gray-400）/ 右寄せ
- 目的: 管理者が画面キャプチャからバージョンを追跡可能にする
- ユーザー向けの説明は不要（開発者/管理者向け情報）

---

## 14. 設計根拠（なぜこうしたか）

### 14-1. なぜ右=チャット、左=ボードか

- **Lovart の実績パターン** に合わせた（ユーザーが慣れている）
- チャット（会話型）は時系列情報に強い → 進捗報告に最適
- ボード（空間型）は並列情報に強い → 5シーン一覧に最適
- 責務を分けることで「どこに何を実装するか」で迷わない

### 14-2. なぜ進捗メッセージは「上書き」か

- 「画像生成中 (1/5)」「(2/5)」「(3/5)」... が全部残るとチャットが埋まる
- 重要なのは「今どこか」であって「過去の進捗」ではない
- **フェーズ遷移メッセージだけ残す** ことで、チャット履歴が「何が起きたか」の時系列ログになる

### 14-3. なぜ MVPで「スキップ」を入れないか

- 5シーン固定で画像1枚抜けると品質が明らかに下がる
- 「スキップして音声だけ作る」は体験として中途半端
- リトライで回復できないケースは Builder 送り（既存体験で補完）

### 14-4. なぜ声選択を4プリセットに絞るか

- 既存 API は Google 8種 + ElevenLabs(動的) + Fish 1種 = 10種以上
- 丸投げの「1ボタンで完了」体験に10種選択は情報過多
- Neural2-B/C（高品質）+ Wavenet-A/C（自然）の 4つで 男女×2品質 をカバー
- 将来「詳細選択」リンクで全一覧を開放

---

## 15. この文書と v3 計画書の関係

| ドキュメント | 担当領域 | 参照先 |
|---|---|---|
| `MARUNAGE_CHAT_MVP_PLAN_v3.md` | SSOT/API/DDL/運用/コスト/Issue分割 | バックエンド実装の SSOT |
| **この文書（Experience Spec v1）** | 画面遷移/チャット文言/ボード状態/UI State/失敗UX | **フロントエンド実装の SSOT** |

**両方を満たして初めて「実装可能粒度」が完成。**

---

## Appendix A: 実装チェックリスト（Issue-5 用）

Issue-5（フロントエンド UI）の実装時に、この文書から確認すべき項目：

- [ ] 右チャット×左ボードの責務境界（§2）を違反していないか
- [ ] 全 UI State（§4）が実装されているか（idle/processing/ready/error）
- [ ] 1:1 対応表（§5）の全ステップが網羅されているか
- [ ] チャットメッセージ文言（§7）がテンプレート通りか
- [ ] 声選択 UI（§8）が推奨プリセット4つか
- [ ] シーンカード（§9）の状態バッジが全パターン対応しているか
- [ ] 進捗バー（§10）のフェーズ別進捗率が正しいか
- [ ] ポーリング（§11）の shouldAdvance ロジックが v3 計画書と一致しているか
- [ ] 失敗時 UX（§6）のリトライ/キャンセル導線が実装されているか
- [ ] モバイル対応（§3-2）のタブ切替が実装されているか
- [ ] 復帰時（§4 復帰時）の状態復元が正しいか
- [ ] 左ボードフッターに `exp: marunage_chat_v1` が表示されているか（§13-3）
- [ ] experience_tag が `config_json` にスナップショットされているか（§13-2）
- [ ] 体験A/Bの入口が v1 画面に一切存在しないか（§1）
- [ ] アップロード UI が v1 画面に存在しないか（§1）
