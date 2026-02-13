# Phase責務表・ロック設計表・Preserveモード仕様

作成日: 2026-02-13
目的: 可視化・整理が不足していた 3 つの設計領域を 1 冊にまとめ、開発・レビュー・運用のリファレンスとする

---

## 目次

1. [Phase × 責務マトリクス](#1-phase--責務マトリクス)
2. [ロック設計表](#2-ロック設計表)
3. [Preserve モード仕様](#3-preserve-モード仕様)
4. [SSOT 決定記録（B案）](#4-ssot-決定記録b案)
5. [スキーマ不整合 分類表](#5-スキーマ不整合-分類表)
6. [AI 駆動開発用コード品質チェックガイドライン](#6-ai-駆動開発用コード品質チェックガイドライン)
7. [変更履歴](#7-変更履歴)

---

## 1. Phase × 責務マトリクス

### 1.1 丸投げチャット（Marunage Chat）

```
init ──► formatting ──► awaiting_ready ──► generating_images ──► generating_audio ──► ready
  │          │                │                    │                     │              │
  │          └── failed ◄─────┴────────────────────┴─────────────────────┘              │
  │                                                                                     │
  └─────────────────────────────── canceled ◄───────────────────────────────────────────┘
```

| Phase | トリガー | サーバー側の責務 | 完了判定 | 次アクション（UI表示） | ロック |
|-------|---------|-----------------|---------|---------------------|--------|
| `init` | `POST /api/marunage/:projectId/start` | プロジェクト作成、config 保存、run レコード作成 | 即座（同期） | advance ポーリング開始 | なし |
| `formatting` | `transitionPhase(init→formatting)` + `waitUntil(formatLoop)` | 既存 `/api/projects/:id/format` を HTTP 呼び出し（ポーリング最大30回×3秒） | `project.status === 'formatted'` | 「整形中…」プログレスバー | なし（formatLoop が waitUntil 内で完結） |
| `awaiting_ready` | `advance` → formatting 完了を確認 | scene の utterance を検証 (`utt_count > 0` 全シーン)。超過シーンを `is_hidden=1` に設定 | 全シーンに utterance 存在 | 「準備確認中…」 | なし |
| `generating_images` | `advance` → awaiting_ready 完了を確認 | **1回の advance で 1枚ずつ生成**（Gemini API → R2 upload → DB更新）。60秒超えの generating レコードは auto-fail。失敗は最大3回 auto-retry | `completed === total && noImage === 0 && generating === 0` | 「画像生成中 (3/5)」プログレス | なし（フロントのポーリングが制御） |
| `generating_audio` | `advance` → 画像完了を確認 + `waitUntil(marunageStartAudioGeneration)` | bulk-audio API を呼び出し、`project_audio_jobs` レコード作成。advance は job status をポーリング | `audioJob.status === 'completed'` | 「音声生成中…」 | なし（`transitionPhase` がロック解除） |
| `ready` | `transitionPhase(generating_audio→ready)` | `completed_at` を記録 | 終端状態 | **「🎉 素材完成！プロジェクト詳細を開く」ボタン** | N/A |
| `failed` | いずれの phase からもエラー時 | `error_code`/`error_message`/`error_phase` を記録 | 終端状態（retry 可能） | 「エラー: {message}」+ 再試行ボタン | ロック解除済み |
| `canceled` | `POST /:projectId/cancel` | `locked_at/locked_until` をクリア。audio_job も best-effort でキャンセル | 終端状態 | 「キャンセルされました」 | ロック解除済み |

### 1.2 制作ボード（Production Board）

```
created → uploaded → [transcribing → transcribed →] parsing → parsed → formatting → formatted
                                                                                        │
                                                              generating_images → completed
```

| Phase | トリガー | サーバー側の責務 | 完了判定 | 次アクション（UIボタン） |
|-------|---------|-----------------|---------|---------------------|
| `created` | `POST /api/projects` | プロジェクト作成 | 即座 | 「テキスト入力」or「音声アップロード」 |
| `uploaded` | テキスト/音声保存 | source_text 保存 or R2 に音声保存 | 即座 | 「シーン分割を実行」ボタン |
| `transcribing` | `POST /api/projects/:id/transcribe` | Whisper API 呼び出し | transcription 完了 | 自動遷移 |
| `transcribed` | Whisper 完了 | transcriptions レコード作成 | 即座 | 「シーン分割を実行」ボタン |
| `formatting` | `POST /api/projects/:id/format` | chunk 単位で AI/preserve 処理 | 全 chunk が done | 自動マージ → formatted |
| `formatted` | autoMergeScenes | シーン一覧確定 | 即座 | 「画像一括生成」ボタン |
| `generating_images` | `POST /api/projects/:id/generate-images` | バッチ画像生成（Gemini API） | 全シーン completed | 自動遷移 → completed |
| `completed` | 全画像完了 | N/A | 終端 | 「動画ビルド」ボタン |

### 1.3 フロー分離の確認結果

| 観点 | 丸投げチャット | 制作ボード | 分離状態 |
|------|-------------|-----------|---------|
| **プロジェクト作成** | 独自（`POST /api/marunage/:id/start`） | 独自（`POST /api/projects`） | ✅ 完全分離 |
| **Run 管理** | `marunage_runs` テーブル | なし | ✅ 完全分離 |
| **Format API** | HTTP 経由で `/api/projects/:id/format` を消費 | 直接 `POST /api/projects/:id/format` | ⚠️ **共有**（パラメータ空間は独立） |
| **Image 生成** | `advance` 内で直接 Gemini API 呼び出し | `/api/projects/:id/generate-images` バッチ API | ✅ 実質分離 |
| **Audio 生成** | `waitUntil` + bulk-audio API | UIポーリング + 個別 API | ⚠️ **bulk-audio API を共有** |
| **DB テーブル** | `projects`, `scenes`, `image_generations` を共有 | 同左 | ⚠️ **共有**（`project_id` で分離） |

---

## 2. ロック設計表

### 2.1 ロックの目的

`marunage_runs.locked_at` / `locked_until` は **二重実行防止** を唯一の目的とする。

### 2.2 Phase 別ロック状態

| Phase | ロック設定 | ロック期間 | 解除タイミング | 解除責務 |
|-------|----------|----------|-------------|---------|
| `init` | なし | — | — | — |
| `formatting` | なし | — | — | formatLoop は `waitUntil` 内で完結。二重起動は `phase` チェックで防止 |
| `awaiting_ready` | なし | — | — | advance は冪等（utterance チェックのみ） |
| `generating_images` | **なし**（v4f40a05 で廃止） | — | — | advance が 1枚ずつ同期生成。フロントのポーリング間隔（10秒）が実質的な排他制御 |
| `generating_audio` | **設定されない**（`transitionPhase` が `generating_audio` へ遷移時にロック解除） | — | 遷移時にクリア | `transitionPhase()` L133-136 |
| `ready` | **クリア** | — | 遷移時 | `transitionPhase()` (TERMINAL_PHASES) |
| `failed` | **クリア** | — | retry/cancel 時 | `retry` エンドポイント L1920、`cancel` エンドポイント L1963 |
| `canceled` | **クリア** | — | cancel 時 | `cancel` エンドポイント L1963 |

### 2.3 ロック解除のコードパス

```
1. transitionPhase()          — TERMINAL_PHASES (ready/failed/canceled) + generating_audio 遷移時
2. POST /:projectId/retry     — failed → rollback phase 遷移時に locked_at/locked_until = NULL
3. POST /:projectId/cancel    — 任意の非終端 phase → canceled 遷移時に locked_at/locked_until = NULL
4. advance() Lock bypass      — generating_images: stuck 検出時（noImage > 0 && inProgress === 0）
5. advance() Lock bypass      — generating_audio: 常にクリア（audio polling 許可）
```

### 2.4 歴史的経緯と現在の状態

| バージョン | 状態 | 説明 |
|-----------|------|------|
| v1 (初期) | 全 phase にロック | `transitionPhaseWithLock()` で 10 分ロックを設定 |
| v2 (409 CONFLICT バグ修正) | generating_audio のロック廃止 | 10 分ロックが audio polling を阻害していた |
| v3 (Issue-2 修正) | generating_images のロック廃止 | 1 枚ずつ同期生成に変更、waitUntil 不使用 |
| **v4 (現在)** | **全 phase ロックなし** | `transitionPhaseWithLock()` は存在するが呼び出し元なし。Dead code |

### 2.5 推奨アクション

1. **`transitionPhaseWithLock()` を削除** — Dead code。呼び出し箇所なし
2. **`locked_at`/`locked_until` カラムは維持** — retry/cancel の NULL クリアに使用。将来の安全弁
3. **ドキュメント更新** — 「ロックは使用していない」ことを明記

---

## 3. Preserve モード仕様

### 3.1 概要

preserve モード（UI表示名: 「原文そのまま」「Raw」）は、ユーザーの原文テキストを **一切改変せずに** シーンに分割するモード。

### 3.2 SSOT（Single Source of Truth）

```
+-------------------+     HTTP POST body      +-------------------+
| project-editor.js | ──────────────────────► | formatting.ts     |
| (フロント)         |   split_mode            | (バックエンド)     |
|                   |   target_scene_count    |                   |
+-------------------+                         +-------------------+
        │                                             │
        │ UI: #targetSceneCount                       │ Default:
        │     input value                             │   ai mode → 5
        │                                             │   preserve mode → 段落数
        │                                             │   (bodyTarget 未指定時)
        │                                             │
        ▼                                             ▼
  ┌─────────────────┐                      ┌─────────────────────┐
  │ scene_split_     │  ★ 参照されない       │ projects テーブル     │
  │ settings テーブル │  （B案で廃止予定）     │   split_mode         │
  │   target_scene_  │                      │   target_scene_count │
  │   count          │                      │   （結果を記録）       │
  └─────────────────┘                      └─────────────────────┘
```

**B案（採用済み）**: `/format` API のリクエストボディが唯一の真実。`scene_split_settings` テーブルは参照しない。

### 3.3 分割アルゴリズム

```
入力: sourceText (原文), targetSceneCount (目標シーン数)

1. 改行正規化 (NBSP → 半角, CRLF → LF)
2. 空行 (\n\s*\n) で段落分割
3. 空段落を除去、各段落を trim()

4. if targetSceneCount === 0 (未指定センチネル):
     targetSceneCount = paragraphs.length  // 段落数を自動採用

5. if paragraphs.length > targetSceneCount:
     mergeParagraphsPreserve()  // 段落を結合（省略なし）
   elif paragraphs.length < targetSceneCount:
     splitParagraphsPreserve()  // 文境界で分割（省略・言い換え禁止）

6. 整合性チェック: 
     original文字数 === 処理後文字数 (空白除外)
     失敗時: 400 PRESERVE_INTEGRITY_ERROR

7. 各段落 → scene レコード作成 (dialogue = 原文そのまま)
```

### 3.4 段落結合ロジック（mergeParagraphsPreserve）

```
例: 8段落 → 5シーン
配分: [2, 2, 2, 1, 1]

1. base = floor(8 / 5) = 1
2. extra = 8 % 5 = 3
3. 先頭 3 グループは base+1 = 2 段落
4. 残り 2 グループは base = 1 段落
5. 各グループ内の段落を \n\n で結合
```

### 3.5 段落分割ロジック（splitParagraphsPreserve）

```
例: 3段落 → 5シーン
追加分割: 5 - 3 = 2 回

1. 最も長い段落を選択
2. 文境界（。！？.!?）で分割
3. 2回繰り返し
4. 省略・言い換えは一切禁止
```

### 3.6 「11段落→5シーン」問題の原因と修正

| 項目 | 修正前 | 修正後 (v=4f40a05) |
|------|--------|-------------------|
| `formatting.ts` デフォルト | `body.target_scene_count \|\| 5` → 常に5 | `bodyTarget` 未指定 → preserve モードは段落数自動採用（センチネル0） |
| `project-editor.js` 初期値 | `value="5"` ハードコード | `initialTarget = raw ? paragraphCount : (savedTarget \|\| 5)` |
| `project-editor.js` モード切替 | `onSplitModeChange` で targetSceneCount 変更なし | raw 切替時に段落数を input に自動設定 |
| `/format` レスポンス | 使用した target 値を返さない | `received_target_scene_count` を追加 |

### 3.7 原文不変ガード

preserve モードでは以下のガードルールを厳守:

1. **dialogue は AI に渡さない** — `image_prompt` 生成のみ AI 使用
2. **dialogue を再整形しない** — `trim()` 以外の文字列操作禁止
3. **句読点・改行を維持** — 結合時は `\n\n`
4. **文字数整合性チェック** — 処理前後の非空白文字数が一致しない場合は 400 エラー

---

## 4. SSOT 決定記録（B案）

### 4.1 選択肢

| 案 | 方針 | メリット | デメリット |
|----|------|---------|-----------|
| A案 | `/format` が `scene_split_settings` テーブルを読む | 設定の永続化 | テーブル同期問題、複雑化 |
| **B案（採用）** | **リクエストボディが唯一の真実。`scene_split_settings` は参照しない** | シンプル、バグ低減 | 設定の永続化は別途 |

### 4.2 B案の実装ルール

1. `formatting.ts` の `/format` API は `body.target_scene_count` と `body.split_mode` のみ使用
2. `scene_split_settings` テーブルは UI の「次回デフォルト値」保持用に残す（将来削除可能）
3. `world-character-ui.js` の設定 UI は UI のデフォルト値を変更するのみ
4. 実行時に使用された値は `/format` レスポンスの `received_target_scene_count` で確認可能
5. `projects` テーブルの `target_scene_count` は結果の記録用（SSOTではない）

### 4.3 丸投げチャットへの影響

- **影響なし**: `marunage.ts` は常に `config.target_scene_count`（デフォルト5）を明示送信
- `bodyTargetSceneCount` が number かつ > 0 → センチネル0にならない
- 既存動作と完全に同一

---

## 5. スキーマ不整合 分類表

`npm run check:schema` で検出された 18 件（うち MISSING_COLUMN 11 件）の分類:

### 5.1 影響度別分類

| # | ファイル | テーブル.カラム | 種別 | 丸投げ影響 | 制作ボード影響 | 対処方針 |
|---|---------|---------------|------|----------|-------------|---------|
| 1 | admin.ts | `api_usage_logs.operation` | MISSING_COLUMN | ❌ なし | ❌ なし（管理画面のみ） | migration 追加 or コード削除 |
| 2 | patches.ts | `project_audio_tracks.track_url` | MISSING_COLUMN | ❌ なし | ⚠️ 低（パッチ適用時） | コード削除（r2_url に統一済み） |
| 3 | patches.ts | `project_audio_tracks.original_filename` | MISSING_COLUMN | ❌ なし | ⚠️ 低 | コード削除（不要カラム） |
| 4 | patches.ts | `project_audio_tracks.source_type` | MISSING_COLUMN | ❌ なし | ⚠️ 低 | コード削除（audio_library_type に統一済み） |
| 5 | patches.ts | `scene_audio_cues.audio_url` | MISSING_COLUMN | ❌ なし | ⚠️ 低 | コード削除（r2_url に統一済み） |
| 6 | patches.ts | `scene_audio_cues.original_filename` | MISSING_COLUMN | ❌ なし | ⚠️ 低 | コード削除 |
| 7 | patches.ts | `scene_audio_cues.trigger_type` | MISSING_COLUMN | ❌ なし | ⚠️ 低 | コード削除 |
| 8 | patches.ts | `scene_audio_cues.source_type` | MISSING_COLUMN | ❌ なし | ⚠️ 低 | コード削除 |
| 9 | patches.ts | `scene_audio_cues.system_audio_id` | MISSING_COLUMN | ❌ なし | ⚠️ 低 | migration 追加 |
| 10 | runs-v2.ts | `text_chunks.length` | MISSING_COLUMN | ❌ なし | ⚠️ 中（runs v2） | `.length` はプロパティ参照の誤検出の可能性あり。要確認 |
| 11 | webhooks.ts | `api_usage_logs.operation` | MISSING_COLUMN | ❌ なし | ❌ なし（webhook のみ） | #1 と同一。migration 追加 or コード削除 |
| 12-18 | projects.ts, scenes.ts | `utterances`, `scene_characters` | UNKNOWN_TABLE | ❌ なし | ⚠️ 低 | テーブル名の別名 or 存在するが検出漏れ。WARNING のみ |

### 5.2 CI ゲート段階導入計画

| フェーズ | 対象 | ゲート条件 | 時期 |
|---------|------|----------|------|
| Phase 1 | `src/routes/marunage.ts` のみ | MISSING_COLUMN = 0 | 即座 |
| Phase 2 | `src/routes/formatting.ts`, `src/routes/scenes.ts` | MISSING_COLUMN = 0 | P0 完了後 |
| Phase 3 | 全 `src/routes/*.ts` | MISSING_COLUMN = 0 | スキーマ不整合修正後 |
| Phase 4 | 全ファイル + UNKNOWN_TABLE | 全 issue = 0 | 長期目標 |

### 5.3 即座に修正可能な不整合

- **patches.ts**: 6 件すべて旧カラム名の参照。patches.ts は DB マイグレーション用なので、旧バージョン向けパッチコードを削除可能
- **admin.ts + webhooks.ts**: `api_usage_logs.operation` → migration で `operation TEXT` を追加するか、コードから参照を削除

---

## 6. AI 駆動開発用コード品質チェックガイドライン

### 6.1 目的

AI（Copilot / Claude / GPT）がコードを生成・修正する際に、品質低下を防ぐためのチェックリスト。

### 6.2 SQL 整合性

1. **INSERT/UPDATE の対象カラムが DB スキーマに存在するか確認**
2. **SELECT の参照カラムが実テーブルに存在するか確認**
3. **JOIN 条件のカラムが両テーブルに存在するか確認**
4. **`npm run check:schema` を実行して MISSING_COLUMN = 0 を確認**
5. **新テーブル/カラム追加時は migration ファイルを先に作成**

### 6.3 SSOT 遵守

6. **同一データの真実は 1 箇所のみ**（例: `target_scene_count` は `/format` のリクエストボディのみ）
7. **UI の表示値と API の送信値が一致していることを確認**
8. **デフォルト値のハードコードは 1 箇所のみ**（型定義 or 定数ファイル）
9. **レスポンスに「サーバーが実際に使用した値」を含める**

### 6.4 Phase 遷移の安全性

10. **`ALLOWED_TRANSITIONS` マップに定義された遷移のみ許可**
11. **終端状態（ready/failed/canceled）からの遷移は retry/cancel エンドポイントのみ**
12. **ロック解除忘れがないか確認（特に error パス）**
13. **`transitionPhase()` の戻り値（boolean）を必ずチェック**

### 6.5 原文保全ガード（Preserve モード）

14. **dialogue を AI に渡さない**
15. **文字列操作は `trim()` のみ**
16. **処理前後の文字数整合性チェックを省略しない**
17. **`normalizeWhitespace()` は空白の種類統一のみ。内容変更禁止**

### 6.6 フロー分離

18. **丸投げチャットのコードが制作ボードに影響しないことを確認**
19. **共有 API（`/format`, bulk-audio）を変更する場合は両フローでテスト**
20. **`marunage_runs` テーブルのカラムを他のルートから参照しない**

### 6.7 フロントエンド

21. **CDN ライブラリ（Tailwind 等）非依存のフォールバック CSS を用意**
22. **`onerror` ハンドラで画像/音声の読込失敗を処理**
23. **ポーリングにはタイムアウト（10 分）を設定**
24. **グローバル処理中はすべての個別ボタンを disabled 化**

### 6.8 セキュリティ

25. **API キーをフロントエンドに露出しない**
26. **セッション認証を全エンドポイントで実施**
27. **エラーレスポンスに内部情報（スタックトレース等）を含めない**
28. **SQL インジェクション防止: パラメータバインドを必ず使用**

---

## 7. 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-02-13 | 初版作成（P1-4 phase 責務表、P1-5 ロック設計表、P2-7 preserve モード仕様を統合） |
| 2026-02-13 | SSOT B 案決定記録、スキーマ不整合分類、AI 開発ガイドライン追加 |
