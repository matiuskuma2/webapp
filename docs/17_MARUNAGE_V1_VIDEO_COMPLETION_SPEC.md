# 17_MARUNAGE_V1_VIDEO_COMPLETION_SPEC

> 丸投げチャット「動画完成まで通す」v1 仕様書
> Created: 2026-02-14 | Status: APPROVED (実装前)
> Ref: docs/16_MARUNAGE_VIDEO_BUILD_SSOT.md

---

## 0. 不変条件（ガードレール）

| # | 条件 | 違反時の影響 |
|---|---|---|
| G1 | `/marunage-chat` 内で開始〜完成〜結果閲覧まで完結 | 体験が破綻する |
| G2 | `/projects/:id`（Builder）へのリンク/リダイレクトは一切設置しない | 合流導線が復活する |
| G3 | 通常プロジェクト一覧に丸投げプロジェクトが混ざらない | UI境界が崩壊する |
| G4 | DBは共有（projects/scenes/video_builds）、UI境界で分離 | 設計方針 |
| G5 | v1は"通し体験優先"。個別修正/コマンドは v2 | スコープ膨張を防ぐ |

---

## 1. v1 ゴール定義

**ユーザー体験:**
```
テキスト貼り付け → 5シーン画像 → ナレーション音声 → 動画自動合成 → ダウンロード
すべて /marunage-chat 内で完結。完成後も一覧から再表示・DL可能。
```

**「完成」の定義:**
- 素材完成（phase=ready）は中間状態
- **動画完成（video.state=done + download_url あり）が最終ゴール**
- video.state=off の場合は「動画ビルド無効」と明示（フラグOFF時）

---

## 2. 画面状態マトリクス

### 2.1 ステータスバー（左ペイン上部）

| phase | video.state | バッジテキスト | 色 |
|---|---|---|---|
| init〜generating_audio | - | 各フェーズ名 | purple (進行中) |
| ready | off | 素材完成 | green |
| ready | pending | 動画準備中 | yellow |
| ready | running | 動画レンダリング中 | blue |
| ready | done | 動画完成 | green (太字) |
| ready | failed | 動画エラー | red |
| failed | - | エラー | red |
| canceled | - | 中断 | gray |

### 2.2 チャットメッセージ（右ペイン）

| トリガー | メッセージ | タイプ |
|---|---|---|
| advance response `action=completed` + video.state will be running | `🎉 素材完成！動画の自動合成を開始しました` | success |
| advance response `action=completed` + video flag OFF | `🎉 素材がすべて完成しました（動画ビルドは現在無効です）` | success |
| poll: video.state=done | `✅ 動画が完成しました！下のパネルからダウンロードできます` | success |
| poll: video.state=failed | `⚠️ 動画の生成に失敗しました` | error |

### 2.3 Result View パネル（右ペイン、ready以降に表示）

```
┌─────────────────────────────────────────┐
│ ✅ 処理が完了しました                      │
│                                         │
│ 📷 画像: 5/5  🎙 音声: 5/5              │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ 🎬 動画パネル                        │ │
│ │                                     │ │
│ │ [状態に応じた表示]                    │ │
│ │ - off:   「動画ビルドは無効です」      │ │
│ │ - pending: 「動画ビルド準備中...」     │ │
│ │ - running: プログレスバー + XX%       │ │
│ │ - done:  [📥 動画をダウンロード]       │ │
│ │ - failed: 「動画ビルドに失敗しました」  │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [🆕 新しく作る]  [📋 一覧に戻る]          │
└─────────────────────────────────────────┘
```

---

## 3. API マッピング

### 3.1 既存API（変更不要）

| エンドポイント | 用途 | 丸投げからの利用 |
|---|---|---|
| `GET /api/marunage/:projectId/status` | 進捗取得（全phase対応） | ポーリング（3秒間隔） |
| `POST /api/marunage/:projectId/advance` | フェーズ遷移 | 自動advance |
| `GET /api/marunage/runs` | 一覧取得 | `/marunage` ページ |
| `POST /api/marunage/:projectId/cancel` | キャンセル | チャット内操作 |
| `POST /api/marunage/:projectId/retry` | リトライ | チャット内操作 |
| `GET /api/projects/:projectId/video-builds/preflight` | 動画ビルド事前チェック | `marunageTriggerVideoBuild` 内部 |
| `POST /api/projects/:projectId/video-builds` | 動画ビルド開始 | `marunageTriggerVideoBuild` 内部 |

### 3.2 新規API（v1で追加）

| エンドポイント | メソッド | 用途 | レスポンス |
|---|---|---|---|
| `GET /api/marunage/runs/:runId` | GET | run_id → project_id 逆引き | `{ run_id, project_id, phase, created_at }` |

**実装詳細:**
```
File: src/routes/marunage.ts
SQL: SELECT id AS run_id, project_id, phase, created_at
     FROM marunage_runs WHERE id = ?
認証: session必須 + started_by_user_id チェック
エラー: 404 if not found, 403 if not owner
```

### 3.3 status API レスポンス → UI マッピング

```json
{
  "progress": {
    "video": {
      "state": "off|pending|running|done|failed",
      "build_id": null | number,
      "build_status": null | string,
      "progress_percent": null | number,
      "download_url": null | string
    }
  }
}
```

| video.state | UI表示 | ポーリング | 根拠 |
|---|---|---|---|
| `off` | 「動画ビルドは無効です」 | 停止 | `video_build_id` なし OR フラグOFF |
| `pending` | 「準備中...」 | 継続 | build 作成直後 |
| `running` | プログレスバー + XX% | 継続 | `build_status` in (rendering, uploading, submitted, queued, validating) |
| `done` | DLボタン | 停止 | `build_status = completed`, `download_url` あり |
| `failed` | エラー表示 | 停止 | `build_status` in (failed, cancelled) |

---

## 4. DB 変更

### 4.1 マイグレーション適用（本番ブロッカー）

| ファイル | 内容 | リスク |
|---|---|---|
| `migrations/0054_marunage_runs_add_video_phase.sql` | `ALTER TABLE marunage_runs ADD COLUMN video_build_id INTEGER NULL` + index | ADD COLUMN のみ、既存データ無傷 |
| `migrations/0055_marunage_runs_add_video_build_retry_cols.sql` | `video_build_attempted_at DATETIME NULL`, `video_build_error TEXT NULL` | 同上 |

**適用コマンド:**
```bash
npx wrangler d1 migrations apply webapp-production --remote
```

**ロールバック（D1はALTER TABLE DROP COLUMNをサポートしないため）:**
- カラムは残るが、フラグOFFで無害
- 緊急時はフラグを `false` に戻すだけで動画ビルドを停止可能

### 4.2 フラグ登録

```sql
-- 段階的ON (推奨手順)
-- Step 1: フラグ登録（OFF）
INSERT INTO system_settings (key, value) VALUES ('MARUNAGE_ENABLE_VIDEO_BUILD', 'false');

-- Step 2: preflight 確認（手動で1件テスト）
-- curl -b "session=..." https://webapp-c7n.pages.dev/api/projects/246/video-builds/preflight

-- Step 3: 問題なければ ON
UPDATE system_settings SET value = 'true' WHERE key = 'MARUNAGE_ENABLE_VIDEO_BUILD';
```

### 4.3 config_json 構造（既存 + v2拡張予定）

```json
// 現在の本番データ (run_id=18)
{
  "experience_tag": "marunage_chat_v1",
  "target_scene_count": 5,
  "split_mode": "ai",
  "output_preset": "yt_long",
  "narration_voice": { "provider": "google", "voice_id": "ja-JP-Neural2-B" },
  "bgm_mode": "none"
}

// v2 で追加予定
{
  ...,
  "video_settings": {
    "captions": { "enabled": true, "position": "bottom", "show_speaker": false },
    "bgm": { "enabled": false },
    "motion": { "preset": "gentle-zoom", "transition": "crossfade" },
    "telops": { "enabled": false }
  }
}
```

---

## 5. フロントエンド変更一覧

### 5.1 `public/static/marunage-chat.js`

| 箇所 | 行 | 変更内容 | 目的 |
|---|---|---|---|
| `mcResumeRun` | L173-197 | active API が 404 → 新規 `/api/marunage/runs/:runId` で project_id 取得 → status API でフル情報取得 → ready なら即 Result View 表示 | 停止ポイント③解消 |
| `completed` case | L452-458 | メッセージを video フラグ状態で分岐 | 停止ポイント④解消 |
| `mcGetProgressMsg` ready case | L97-98 | video.state で分岐（running → '動画レンダリング中', done → '動画完成！'） | 停止ポイント④解消 |
| `mcStartNew` | L978 | 先頭に `if (!confirm(...)) return;` 追加 | 停止ポイント⑤解消 |
| `mcUpdateFromStatus` ready case | L519-525 | video.state=done 時にチャットバブル追加（「動画が完成しました！」） | v1ゴール達成 |

### 5.2 変更しないファイル（Non-Impact）

| ファイル | 理由 |
|---|---|
| `src/routes/projects.ts` | P1で json_extract フィルタ済み |
| `src/routes/video-generation.ts` | 共有エンジン、変更不要 |
| `src/routes/formatting.ts` | 丸投げと無関係 |
| `src/routes/image-generation.ts` | 丸投げと無関係 |
| `public/static/app.js` | Builder用、変更不要 |

---

## 6. バックエンド変更一覧

### 6.1 `src/routes/marunage.ts`

| 箇所 | 変更内容 | 行数 |
|---|---|---|
| 新規 `GET /runs/:runId` | run_id → project_id 逆引き（認証付き） | +15行 |

### 6.2 変更しないバックエンド

| ファイル/関数 | 理由 |
|---|---|
| `marunageTriggerVideoBuild` | 既存実装で十分。DB適用+フラグONで自動起動 |
| `recordVideoBuildAttempt` | 既存実装で十分。0054/0055適用で動作する |
| `isVideoBuildEnabled` | 既存実装で十分 |
| status API (`/:projectId/status`) | 既存実装で video 情報を返す |
| advance API (`/:projectId/advance`) | 既存実装で ready 遷移 + video build trigger |

---

## 7. ポーリングフロー（タイムライン）

```
[ユーザーがテキスト入力]
    ↓
POST /api/marunage/start → run作成 → phase=formatting
    ↓
[ポーリング開始: 3秒間隔]
    ↓
advance: formatting → awaiting_ready → generating_images → generating_audio
    ↓
advance: generating_audio → ready
    ↓ (バックエンド: isVideoBuildEnabled?)
    ↓
    ├── flag ON  → waitUntil(marunageTriggerVideoBuild)
    │              → GATE1 (duplicate check)
    │              → GATE2 (preflight)
    │              → GATE3 (POST /video-builds)
    │              → video_build_id 保存
    │
    └── flag OFF → video.state = off (UIに「無効」表示)

[ポーリング継続条件]
    phase=ready AND video.state IN (pending, running)
    → ポーリング継続

[ポーリング停止条件]
    phase=ready AND video.state IN (off, done, failed)
    OR phase IN (failed, canceled)
    → ポーリング停止

[video.state=done]
    → チャットバブル: 「動画が完成しました！」
    → Result View パネル: DLボタン表示
    → ポーリング停止
```

---

## 8. エラー時挙動

| エラー | 検出方法 | UI表示 | リカバリ |
|---|---|---|---|
| GATE1: 重複ビルド | `video_build_id` 既存 | 静かにスキップ（UIは progress 表示） | 自動 |
| GATE1: クールダウン中 | `video_build_attempted_at` + 30分 | 「前回の試行から30分待機中」 | 時間経過で自動リトライ |
| GATE2: preflight 失敗 | HTTP 4xx/5xx | `video.state=off`（UIは「無効」） | ログ確認→手動対応 |
| GATE2: Cookie 期限切れ | HTTP 401/403 | `video.state=off` | セッション再取得後に再アクセス |
| GATE3: ビルド開始失敗 | POST 4xx/5xx | `video_build_error` に記録、state=off | 30分後に自動リトライ |
| ビルド中にレンダリング失敗 | `video_builds.status=failed` | `video.state=failed` + エラーメッセージ | v2 で再ビルドボタン |
| run_id が見つからない | `/api/marunage/runs/:runId` → 404 | 「処理が見つかりません」 | 一覧に戻る |
| run の所有者でない | `/api/marunage/runs/:runId` → 403 | 「アクセス権がありません」 | 一覧に戻る |

---

## 9. ready run 再開フロー（v1 で修正する箇所）

### 現在の問題フロー
```
/marunage-chat?run=18
  → mcResumeRun(18)
    → GET /api/marunage/active     ← ready は active でない
      → 404
        → 「既に完了しています」   ← Result View 出ない
```

### v1 修正後フロー
```
/marunage-chat?run=18
  → mcResumeRun(18)
    → GET /api/marunage/active
      → 404 (ready は active でない)
        → fallback: GET /api/marunage/runs/18  ← 新規API
          → { run_id: 18, project_id: 246, phase: 'ready' }
            → MC.projectId = 246, MC.phase = 'ready'
              → GET /api/marunage/246/status  ← 既存API (ready も取れる)
                → フル status 取得
                  → mcSetUIState('ready') + mcShowReadyActions()
                    → Result View 表示 (video panel 含む)
                      → video.state に応じてポーリング継続/停止
```

---

## 10. v1 実装順序（依存関係順）

```
Step 0: 0054 + 0055 を本番適用 (ブロッカー解除)
  ↓
Step 1: フラグ登録 (OFF → preflight テスト → ON)
  ↓
Step 2: GET /api/marunage/runs/:runId 追加 (backend, +15行)
  ↓
Step 3: mcResumeRun フォールバック実装 (frontend, +20行)
  ↓
Step 4: 完了メッセージ分岐 (frontend, +10行, -5行)
  ↓
Step 5: mcStartNew 確認ダイアログ (frontend, +2行)
  ↓
Step 6: video.state=done 時のチャットバブル追加 (frontend, +8行)
  ↓
Step 7: ビルド → テスト → コミット → デプロイ
  ↓
Step 8: フラグ ON → 本番 E2E 確認
```

### 変更量見積もり

| 区分 | ファイル | 行数 |
|---|---|---|
| DB | migrations 適用 (既存ファイル) + SQL 1行 | 0 新規コード |
| Backend | `src/routes/marunage.ts` | +15 |
| Frontend | `public/static/marunage-chat.js` | +40 / -5 |
| **合計** | **2ファイル** | **+55 / -5** |

---

## 11. v1 完了チェックリスト

| # | チェック項目 | 確認方法 |
|---|---|---|
| 1 | 0054/0055 本番適用済み | `PRAGMA table_info(marunage_runs)` に `video_build_id` あり |
| 2 | フラグ ON | `SELECT value FROM system_settings WHERE key='MARUNAGE_ENABLE_VIDEO_BUILD'` → `true` |
| 3 | 新規 run 開始 → ready → 動画ビルド自動開始 | ログに `[Marunage:Video] GATE3: Video build XX created` |
| 4 | video.state=running → UI にプログレスバー表示 | 目視確認 |
| 5 | video.state=done → DL ボタン表示 + チャットバブル | 目視確認 |
| 6 | ready run を一覧からクリック → Result View 表示 | `/marunage-chat?run=XX` で結果が見える |
| 7 | 「新しく作る」→ 確認ダイアログ表示 | 目視確認 |
| 8 | 通常一覧に丸投げが混ざらない | `GET /api/projects` に丸投げ無し |
| 9 | `/projects/:id` 直打ち → リダイレクト | curl -v → 302 |
| 10 | Builder 内に丸投げリンク 0件 | grep 確認 |

---

## 12. v2 ロードマップ（v1 完了後）

| # | 機能 | 概要 |
|---|---|---|
| v2-A | チャットコマンド | 「字幕消して」「BGM入れて」等 → config_json.video_settings 更新 |
| v2-B | 再ビルドボタン | Result View に「再生成」ボタン → video_build_id クリア → 再トリガー |
| v2-C | 音声プレビュー | Status API に audio_url 追加 → Result View に再生ボタン |
| v2-D | `is_marunage` 専用カラム | `json_extract` → 専用カラムに移行（プロジェクト数1万超時） |

---

## 13. 本番確認URL

```bash
SITE_URL="https://webapp-c7n.pages.dev"
# ※ カスタムドメイン運用の場合は置き換え
```
