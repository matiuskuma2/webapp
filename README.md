# MARUMUVI（まるむび） - webapp

## プロジェクト概要
音声・テキスト入力から、YouTube/TikTok向けの構造化シナリオ（タイトル・セリフ・画像・漫画・動画）を自動生成するWebアプリケーション。

- **サービス名**: MARUMUVI（旧: RILARC Scenario Generator）
- **プロジェクト名**: webapp
- **テクノロジー**: Hono + Cloudflare Pages/Workers + D1 Database + R2 Storage
- **本番URL**: https://webapp-c7n.pages.dev
- **GitHub**: https://github.com/matiuskuma2/webapp
- **最終更新**: 2026-02-14（丸投げチャット動画パイプライン完全修復）

---

## 🔧 2026-02-14 修正ログ（丸投げチャット動画パイプライン）

### 修正済みバグ一覧

| # | バグ | 原因 | 修正 (commit) |
|---|------|------|---------------|
| 1 | Gate2 preflight 常に失敗 | レスポンスフィールド `ready` → `is_ready` | `d4c7917` |
| 2 | Gate3 POST 結果パース失敗 | `result.id` → `result.build.id` | `2192489` |
| 3 | UI「素材完成」で 0枚/0枚 表示 | advance が ready 描画→status 未取得 | `2192489` |
| 4 | 進捗バー 100% で止まる | 動画ステップなし (5段階→6段階) | `2192489` |
| 5 | status API が DB 読み取りのみで停止 | inline refresh 未実装 | `9743f4d` |
| 6 | フラグ ON でも videoState=off | flag チェックなし | `e891ce1` |
| 7 | ready 後の自動トリガー不発 | phase 遷移時のみ発火、status 経由なし | `be20798` |
| 8 | 失敗ビルド後リトライ不能 | Gate1 が video_build_id で永久ブロック | `4bf2bd2` |
| 9 | Remotion が画像 URL 取得失敗 (404) | r2_url `/projects/...` に `/images/` 欠落 | `75db5f1` |

### 検証結果
- **Run 21 / Project 252**: Build 175 → **completed** (progress 100%, download_url あり, error なし)
- Build 173: cron 自動キャンセル (submitted で 30分停止 → AWS 側問題)
- Build 174: 画像 URL 404 (修正前の `/projects/...` パス)
- Build 175: `/images/projects/...` パスで成功 ✅

### 設計変更サマリ
1. **進捗バー 6 ステップ**: フォーマット → 確認 → 画像 → 音声 → 動画 → 完成
2. **status API 自動トリガー**: ready + flag ON + build 未開始 → polling 中に自動起動
3. **auto-retry**: failed build → 5分クールダウン後に status API で自動再試行
4. **toAbsoluteUrl 補正**: `/projects/...` パスに自動で `/images/` プレフィックス付加
5. **UI flag 表示**: off (無効) / pending (準備中) / running (進行中) / done (完了) / failed (失敗)

---

## 動画作成フロー（2系統）

### フロー1: プロジェクト作成（既存・稼働中）
シーンを一つずつ作り込む詳細コントロール型。
1. シナリオ入力（音声/テキスト）
2. シーン分割（preserve / AI モード）
3. 画像生成（Gemini API）
4. 動画化（Veo2/Veo3）
5. 合成・エクスポート

### フロー2: 丸投げチャット（稼働中 ✅）
チャットだけで動画完成する全自動型。
1. チャットでシナリオを伝える → AI がシーン分割
2. シーン画像を全自動生成（Gemini API）
3. 音声を全自動生成（TTS）
4. 動画を自動合成（Remotion Lambda → AWS）
5. ダウンロード URL を表示

> `/marunage-chat` でアクセス。6ステップ進捗バー（フォーマット→確認→画像→音声→動画→完成）でリアルタイム表示。
> `MARUNAGE_ENABLE_VIDEO_BUILD` フラグで動画合成の ON/OFF を制御。

---

## 主要機能

### 1. 入力対応
- **音声入力**: MP3/WAV/M4A/OGG/WebM（最大25MB）
- **テキスト入力**: 直接テキストを貼り付け（最大制限なし）

### 2. 自動処理パイプライン
1. **Parse**: 長文を意味単位（500-1500文字）のチャンクに分割
2. **Format**: 各チャンクをOpenAI GPT-4oでシナリオ化（2モード対応）
3. **Image Generation**: Gemini APIで各シーンの画像生成
4. **Export**: 画像ZIP、セリフCSV、全ファイルZIPをダウンロード

### 2.5 シーン分割モード（Format）

#### 2パターンの分割方式

| モード | 名称 | 動作 |
|-------|------|------|
| `preserve` | 原文維持（台本モード） | dialogue=原文そのまま（改変禁止）、改行で分割、image_promptのみAI生成 |
| `ai` | AI整理モード | AIが意図を読み取って整形、30-500文字程度、省略は極力避ける |

#### reset=true の仕様（確定版）

**削除対象（制作物）**:
- scene_balloons（吹き出し）
- scene_audio_cues（SFX）
- scene_telops（テロップ）
- scene_motion（モーション）
- scene_style_settings（シーンスタイル）
- scene_utterances（発話）
- scene_character_map（キャラ割当）
- scene_character_traits（キャラ特徴）
- audio_generations（音声）
- image_generations（画像）
- scenes（シーン本体）

**保持対象（設定）**:
- video_builds（ビルド履歴 - 監査用）
- project_audio_tracks（BGM設定 - project単位）
- project_character_models（キャラ定義 - project単位）
- project_style_settings（スタイル設定 - project単位）

#### API
```
POST /api/projects/:id/format
Body: {
  "split_mode": "preserve" | "ai",
  "target_scene_count": 5,
  "reset": true
}
```

#### preserve モードの詳細
- **改行正規化**: CRLF→LF、NBSP→半角空白、全角空白→半角空白
- **整合性チェック**: 分割後に文字数が変わっていないか検証（空白除く）
- **段落調整**: 段落数 > target → 結合（\n\nで繋ぐ）、段落数 < target → 文境界で分割

#### AI モードの詳細
- **target配分**: `chunkTarget = ceil(remainingTarget / pendingChunks.length)`
- **上限**: MAX_SCENES_PER_CHUNK = 5（1 chunkあたり最大5シーン）
- **文字数制限**: 30-500文字（省略回避のため緩和済み）

### 3. スタイルプリセット機能
- プロジェクト全体のデフォルトスタイルを設定
- シーン単位でスタイルを個別上書き可能
- 画像生成時に `prefix + prompt + suffix` の形式で適用
- デフォルトプリセット: 日本アニメ風、インフォマーシャル風、シネマ調

### 4. テロップ機能（2系統）

#### 4.1 Remotion テロップ（動画字幕）
動画生成時に動的に描画される字幕/テロップ。後から自由に調整可能。

| 設定カテゴリ | 項目 |
|------------|------|
| **プリセット** | minimal / outline / band / pop / cinematic |
| **サイズ** | sm / md / lg |
| **位置** | bottom / center / top |
| **カスタム** | 文字色、縁取り色/太さ、背景色/透過、フォント、太さ |
| **Typography** | 最大行数(1-5)、行間(100-200%)、文字間(-2~6px) |

- **永続化**: `PUT /api/projects/:id/telop-settings` でプロジェクト既定として保存可能
- **SSOT**: `projects.settings_json.telops_remotion`

#### 4.2 漫画焼き込みテロップ
画像(PNG)に焼き込まれる吹き出し/テロップ。再焼き込みが必要。

| 設定 | 項目 |
|-----|------|
| **プリセット** | minimal / outline / band / pop / cinematic |
| **サイズ** | sm / md / lg |
| **位置** | bottom / center / top |

- **保存**: `PUT /api/projects/:id/comic-telop-settings`
- **一括予約**: `POST /api/projects/:id/comic/rebake`
- **ステータス**: 🟡予約中 / 🟠未反映 / ✅最新 / ⚪未公開
- **SSOT**: `projects.settings_json.telops_comic`

> 詳細は [`docs/TELOP_COMPLETE_REFERENCE.md`](docs/TELOP_COMPLETE_REFERENCE.md) を参照

---

## データアーキテクチャ

### データベース（Cloudflare D1）
```
projects (1) ──< (N) transcriptions
    │
    ├──< (N) text_chunks
    │
    ├──< (1) project_style_settings ──> (1) style_presets
    │
    └──< (N) scenes (1) ──< (N) image_generations
                    │
                    └──< (1) scene_style_settings ──> (1) style_presets
```

### ストレージ（Cloudflare R2）
- **audio/**: 音声ファイル
- **images/**: 生成画像（`images/{project_id}/scene_{idx}/{generation_id}_{timestamp}.png`）

---

## API エンドポイント一覧

### プロジェクト管理
- `POST /api/projects` - プロジェクト作成
- `GET /api/projects` - プロジェクト一覧
- `GET /api/projects/:id` - プロジェクト詳細
- `GET /api/projects/:id/scenes` - シーン一覧（`?view=board` でBuilder用最小情報）

### 入力処理
- `POST /api/projects/:id/upload` - 音声アップロード
- `POST /api/projects/:id/source/text` - テキスト保存
- `POST /api/projects/:id/transcribe` - 音声文字起こし（OpenAI Whisper）
- `POST /api/projects/:id/parse` - テキスト分割（chunk化）

### シナリオ生成
- `POST /api/projects/:id/format` - シナリオ生成（chunk単位処理）
- `GET /api/projects/:id/format/status` - 進捗確認

### 画像生成
- `POST /api/scenes/:id/generate-image` - シーン単体画像生成
- `POST /api/projects/:id/generate-images` - バッチ画像生成（1件ずつ処理）
- `GET /api/projects/:id/generate-images/status` - 画像生成進捗

### スタイルプリセット
- `GET /api/style-presets` - アクティブなプリセット一覧
- `GET /api/style-presets/:id` - プリセット詳細
- `POST /api/style-presets` - 新規プリセット作成
- `PUT /api/style-presets/:id` - プリセット更新
- `DELETE /api/style-presets/:id` - プリセット削除（ソフトデリート）
- `GET /api/projects/:id/style-settings` - プロジェクトのデフォルトスタイル取得
- `PUT /api/projects/:id/style-settings` - プロジェクトのデフォルトスタイル設定
- `PUT /api/scenes/:id/style` - シーン個別スタイル設定

### エクスポート
- `GET /api/projects/:id/download/images` - 画像ZIP
- `GET /api/projects/:id/download/csv` - セリフCSV
- `GET /api/projects/:id/download/all` - 全ファイルZIP

### 5. BGM管理機能

#### 5.1 シーン別BGM
シーンごとに個別のBGMを設定可能。プロジェクト全体BGMより優先される。

| フィールド | 説明 |
|----------|------|
| `start_ms` | シーン内の再生開始位置（ms） |
| `end_ms` | シーン内の再生終了位置（ms, null=シーン終了まで） |
| `audio_offset_ms` | BGMファイルの再生開始位置（ms） |
| `volume_override` | 音量（0.0-1.0） |
| `loop_override` | ループ設定（デフォルト: OFF） |

- **API**: `/api/scenes/:sceneId/audio-assignments`
- **SSOT**: `scene_audio_assignments`

#### 5.2 プロジェクト全体BGM
動画全体を通して再生されるBGM。タイムライン制御をサポート。

| フィールド | 説明 |
|----------|------|
| `video_start_ms` | 動画上の再生開始位置（ms） |
| `video_end_ms` | 動画上の再生終了位置（ms, null=動画終了まで） |
| `audio_offset_ms` | BGMファイルの再生開始位置（ms） |
| `volume` | 音量（0.0-1.0） |
| `loop` | ループ設定（デフォルト: OFF） |

- **API**: `/api/projects/:projectId/audio-tracks`
- **SSOT**: `project_audio_tracks`

#### 5.3 BGMダッキング
シーン別BGM再生中は、プロジェクト全体BGMの音量が自動的に下がる（完全ミュート）。
フェードイン/アウト（120ms）でスムーズな切り替えを実現。

---

## 開発環境セットアップ

### 必要な環境変数（`.dev.vars`）
```bash
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
CLOUDFLARE_ACCOUNT_ID=...
```

### インストールと起動
```bash
# 依存関係インストール
npm install

# ローカルDB初期化
npm run db:migrate:local

# ビルド
npm run build

# PM2で起動（sandbox環境）
pm2 start ecosystem.config.cjs

# ローカル開発（Vite dev server）
npm run dev
```

### データベース操作
```bash
# ローカルDB操作
npm run db:console:local

# 本番DB操作（要注意）
npm run db:console:prod

# ローカルDBリセット
npm run db:reset
```

---

## デプロイ

### 前提条件
1. Cloudflare API Key が設定されていること
2. D1 Database `webapp-production` が作成済みであること
3. R2 Bucket が作成済みであること

### デプロイ手順
```bash
# 1. ビルド
npm run build

# 2. デプロイ
npm run deploy:prod

# または直接
npx wrangler pages deploy dist --project-name webapp
```

### 初回デプロイ時
```bash
# 1. D1データベース作成
npx wrangler d1 create webapp-production

# 2. wrangler.jsonc に database_id を設定

# 3. マイグレーション実行
npm run db:migrate:prod
```

---

## プロジェクト構造
```
webapp/
├── src/
│   ├── index.tsx              # Honoアプリエントリーポイント
│   ├── routes/                # APIルート
│   │   ├── projects.ts        # プロジェクト管理
│   │   ├── parsing.ts         # テキスト分割
│   │   ├── transcriptions.ts  # 音声文字起こし
│   │   ├── formatting.ts      # シナリオ生成
│   │   ├── image-generation.ts # 画像生成
│   │   ├── styles.ts          # スタイルプリセット
│   │   ├── downloads.ts       # エクスポート
│   │   └── images.ts          # R2画像配信
│   ├── utils/
│   │   ├── image-prompt-builder.ts  # プロンプト生成（composeStyledPrompt含む）
│   │   ├── rilarc-validator.ts      # RILARCScenarioV1スキーマバリデータ
│   │   └── style-prompt-composer.ts # スタイルプロンプト合成
│   └── types/
│       └── bindings.ts        # Cloudflare Bindings型定義
├── public/
│   └── static/
│       ├── app.js             # フロントエンドメインロジック
│       ├── project-editor.js  # プロジェクトエディタUI
│       └── styles.css         # TailwindCSSコンパイル済み
├── migrations/                # D1マイグレーション
│   ├── 0001_initial_schema.sql
│   ├── 0002_add_source_type.sql
│   ├── 0003_add_error_tracking.sql
│   ├── 0004_add_text_chunks.sql
│   ├── 0005_format_chunked_processing.sql
│   ├── 0006_extend_error_message.sql
│   ├── 0007_add_runs_system.sql
│   └── 0008_add_style_presets.sql
├── docs/                      # プロジェクトドキュメント
│   ├── 00_INDEX.md
│   ├── 04_DB_SCHEMA.md
│   ├── 05_API_SPEC.md
│   └── ...
├── wrangler.jsonc             # Cloudflare設定
├── package.json
├── ecosystem.config.cjs       # PM2設定
└── README.md                  # 本ファイル
```

---

## トラブルシューティング

### 画像生成が途中で止まる
**原因**: UIのポーリングが止まっているか、ブラウザキャッシュが古い
**対処**:
1. ブラウザでハードリロード（`Ctrl+Shift+R` または `Cmd+Shift+R`）
2. 手動でバッチ生成APIを呼び出す:
   ```bash
   curl -X POST https://your-app.pages.dev/api/projects/:id/generate-images
   ```

### Parse APIスキップによるINVALID_STATUSエラー
**原因**: テキストプロジェクトで Parse API が呼ばれていない
**対処**: UIで「シーン分割」ボタンをクリックすると、自動的に Parse → Format が実行されます

### スタイルプリセットが表示されない
**原因**: API レスポンスキーの不一致（修正済み）
**確認**: `GET /api/style-presets` が `{style_presets: [...]}` を返すこと

---

## 技術スタック

### バックエンド
- **Hono**: 軽量Webフレームワーク
- **Cloudflare Pages Functions**: サーバーレス実行環境
- **Cloudflare D1**: SQLiteベースのエッジデータベース
- **Cloudflare R2**: S3互換オブジェクトストレージ

### フロントエンド
- **Vanilla JavaScript**: シンプルなDOM操作
- **TailwindCSS**: ユーティリティファーストCSS
- **Axios**: HTTP クライアント
- **FontAwesome**: アイコン

### 外部API
- **OpenAI GPT-4o**: シナリオ生成
- **OpenAI Whisper**: 音声文字起こし
- **Google Gemini**: 画像生成、Chat Edit会話AI

---

## Chat Edit機能（動画調整AI）

### 概要
完成した動画に対して、自然言語で調整指示を出せるAIチャット機能。ChatGPTのような会話体験で動画編集ができます。

### 対応アクション一覧

| アクション | 説明 | 例文 |
|-----------|------|------|
| `bgm.set_volume` | BGM音量調整 | 「BGMを少し下げて」 |
| `bgm.set_loop` | BGMループ設定 | 「BGMをループOFF」 |
| `sfx.set_volume` | SE音量調整 | 「SEを大きく」 |
| `sfx.add_from_library` | SE追加 | 「驚きのSEを追加して」 |
| `sfx.remove` | SE削除 | 「シーン2のSEを消して」 |
| `balloon.adjust_window` | 吹き出し表示時間 | 「吹き出しをもう少し長く」 |
| `balloon.adjust_position` | 吹き出し位置 | 「吹き出しを上に移動」 |
| `balloon.set_policy` | 吹き出し表示ルール | 「常に表示」「喋る時だけ」 |
| `telop.set_enabled` | テロップ全体ON/OFF | 「テロップを消して」 |
| `telop.set_enabled_scene` | シーン単位テロップON/OFF | 「シーン1のテロップをOFF」 |
| `telop.set_position` | テロップ位置 | 「テロップを上に」 |
| `telop.set_size` | テロップサイズ | 「テロップを大きく」 |

### API エンドポイント

```
POST /api/projects/:projectId/chat-edits/chat
Body: {
  "user_message": "BGMがうるさいかも",
  "context": {
    "scene_idx": 1,
    "balloon_no": 1,
    "video_build_id": 123
  },
  "history": [
    {"role": "user", "content": "よろしくね"},
    {"role": "assistant", "content": "よろしくお願いします！..."}
  ]
}

Response: {
  "ok": true,
  "assistant_message": "BGMが気になりますね。音量を下げましょうか？",
  "suggestion": {
    "needs_confirmation": true,
    "summary": "Before: BGM音量 100%\nAfter: BGM音量 50%",
    "intent": {
      "schema": "rilarc_intent_v1",
      "actions": [{"action": "bgm.set_volume", "volume": 0.5}]
    },
    "rejected_actions": []
  }
}
```

### フロー
1. **会話**: ユーザー入力 → AI会話（assistant_message）
2. **提案**: 編集提案があれば提案カード表示（suggestion）
3. **確認**: 「確認する」→ dry-run（変更プレビュー）
4. **適用**: 「この変更を適用する」→ apply（新ビルド生成）

### テンプレート
UIにはよく使う操作のテンプレートボタンがあります：
- BGM: 小さく / 大きく / ループON/OFF
- テロップ: 全部OFF / 全部ON / このシーンOFF / このシーンON / 位置変更 / サイズ変更

---

## ドキュメント

詳細なドキュメントは `docs/` フォルダを参照してください:

- **00_INDEX.md**: ドキュメント索引
- **04_DB_SCHEMA.md**: データベーススキーマ完全版
- **05_API_SPEC.md**: APIエンドポイント仕様
- **09_AI_DEV_RULES.md**: AI開発者向けルール
- **BUTTON_PROGRESS_FIX.md**: 画像生成ボタンと進捗表示の完全修正ドキュメント ⭐ 重要

---

## ライセンス
Proprietary - All rights reserved

---

最終更新: 2026-01-26

---

## サブシステム構成（動画生成関連）

本リポジトリには、メインのCloudflare Pagesアプリに加えて、動画生成に必要なサブシステムが含まれています。

### アーキテクチャ概要

```
┌─────────────────────────────────────────────────────────────────┐
│  Cloudflare                                                      │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │ webapp           │  │ webapp-cron      │                     │
│  │ (Pages + D1 + R2)│  │ (Workers Cron)   │                     │
│  │                  │  │ 毎日UTC19:00     │                     │
│  │ POST /video/build│  │ 動画30日自動削除 │                     │
│  └────────┬─────────┘  └──────────────────┘                     │
└───────────┼─────────────────────────────────────────────────────┘
            │ HTTPS + SigV4
            ▼
┌─────────────────────────────────────────────────────────────────┐
│  AWS (ap-northeast-1)                                            │
│                                                                  │
│  ┌──────────────────┐    ┌──────────────────────────────────┐   │
│  │ API Gateway      │───▶│ aws-orchestrator (Lambda)        │   │
│  │ POST /video/build│    │ rilarc-video-build-orch          │   │
│  │     /start       │    │ Remotion Lambda を呼び出し        │   │
│  └──────────────────┘    └────────────────┬─────────────────┘   │
│                                           │                      │
│                                           ▼                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Remotion Lambda (remotion-render-4-0-404-mem2048mb...)   │   │
│  │ ・video-build-remotion のコードをバンドル                  │   │
│  │ ・S3にサイトデプロイ済み                                   │   │
│  │ ・動画レンダリング実行                                     │   │
│  └────────────────────────────────────────┬─────────────────┘   │
│                                           │                      │
│                                           ▼                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ S3 Buckets                                                │   │
│  │ ・remotionlambda-apnortheast1-xxx (Remotion内部)          │   │
│  │ ・rilarc-remotion-renders-prod-202601 (出力動画)          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────┐    ┌──────────────────────────────────┐   │
│  │ API Gateway      │───▶│ aws-video-proxy (Lambda)         │   │
│  │ POST /video      │    │ rilarc-video-proxy               │   │
│  │     /generate    │    │ Google Veo APIプロキシ            │   │
│  └──────────────────┘    └──────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### サブシステム一覧

| ディレクトリ | デプロイ先 | 用途 | 本番関数名/URL |
|-------------|-----------|------|---------------|
| `video-build-remotion/` | AWS Lambda (Remotion) | 動画レンダリングロジック | S3サイト: rilarc-video-build |
| `aws-orchestrator/` | AWS Lambda | Remotion呼び出しオーケストレーター | rilarc-video-build-orch |
| `aws-orchestrator-b2/` | AWS Lambda (予備) | Remotion Lambda SDK版 | - |
| `aws-video-proxy/` | AWS Lambda | Google Veo APIプロキシ | rilarc-video-proxy |
| `webapp-cron/` | Cloudflare Workers | 定期ジョブ（動画削除等） | webapp-cron |

### デプロイ手順

#### 1. video-build-remotion（Remotion Lambda）

```bash
cd video-build-remotion
npm install
npm run deploy  # Remotion サイト + Lambda をデプロイ
```

環境変数:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION` (default: ap-northeast-1)

#### 2. aws-orchestrator（オーケストレーター Lambda）

```bash
cd aws-orchestrator
npm install
zip -r function.zip index.mjs node_modules
aws lambda update-function-code \
  --function-name rilarc-video-build-orch \
  --zip-file fileb://function.zip \
  --region ap-northeast-1
```

#### 3. aws-video-proxy（Veoプロキシ Lambda）

```bash
cd aws-video-proxy
npm install
npm run build
npm run package
npm run deploy
```

#### 4. webapp-cron（Cloudflare Workers Cron）

```bash
cd webapp-cron
npm install
npx wrangler deploy
```

### 環境変数・シークレット

#### AWS Lambda共通
- `AWS_REGION`: ap-northeast-1
- `REMOTION_FUNCTION_NAME`: remotion-render-4-0-404-mem2048mb-disk2048mb-240sec
- `REMOTION_SERVE_URL`: S3サイトURL
- `OUTPUT_BUCKET`: rilarc-remotion-renders-prod-202601

#### aws-video-proxy
- `GOOGLE_API_KEY`: Google Veo API キー

#### webapp-cron
- D1バインディング: webapp-production (51860cd3-bfa8-4eab-8a11-aa230adee686)
- R2バインディング: webapp-bucket

---

## Video Build 機能（最新）

### 概要
全シーンの素材（画像/漫画/動画＋音声）を合算して、1本の動画（MP4）を生成する機能。

### SSOT定義
- **表示素材**: `scenes.display_asset_type` ('image' | 'comic' | 'video') に基づいて SSOT を切り替え
  - image → `image_generations` (is_active=1, asset_type='ai' OR NULL)
  - comic → `image_generations` (is_active=1, asset_type='comic')
  - video → `video_generations` (is_active=1, status='completed')
- **音声**: `audio_generations` (is_active=1, status='completed')
- **尺計算**: 音声尺 + 500ms パディング（音声なし: デフォルト3000ms）

---

## シーン合成ルール（Video Build）

### 1. 素材選択ルール（display_asset_type SSOT）

```
┌─────────────────────────────────────────────────────────────┐
│ display_asset_type の判定フロー                              │
│                                                             │
│  scenes.display_asset_type = ?                              │
│     │                                                       │
│     ├── 'image' ──► image_generations (is_active=1)         │
│     │              └─► assets.image.url を使用               │
│     │                                                       │
│     ├── 'comic' ──► image_generations (asset_type='comic')  │
│     │              └─► assets.image.url を使用               │
│     │                                                       │
│     └── 'video' ──► video_generations (is_active=1,         │
│                      status='completed')                    │
│                    └─► assets.video_clip.url を使用          │
│                                                             │
│ ⚠️ 同一シーンに画像と動画の両方があっても、                    │
│    display_asset_type で決まった方のみ使用される              │
└─────────────────────────────────────────────────────────────┘
```

### 2. 音声レイヤー構造（3層）

```
┌───────────────────────────────────────────────────────────────┐
│ Layer 1: BGM（プロジェクト全体）                                │
│ ├── SSOT: project_audio_tracks (track_type='bgm', is_active=1) │
│ ├── ダッキング: 音声再生中は音量を自動低下（0.12）               │
│ └── タイムライン制御: video_start_ms, audio_offset_ms          │
├───────────────────────────────────────────────────────────────┤
│ Layer 2: シーン別BGM（シーン単位で上書き）                       │
│ ├── SSOT: scene_audio_assignments (audio_type='bgm')          │
│ ├── 優先度: シーン別BGM > プロジェクトBGM                       │
│ └── シーン別BGM再生中は全体BGMを完全ダック                       │
├───────────────────────────────────────────────────────────────┤
│ Layer 3: SFX（シーン単位・複数可）                              │
│ ├── SSOT: scene_audio_assignments (audio_type='sfx')          │
│ ├── start_ms: シーン内の開始タイミング                         │
│ └── 複数追加可能（1シーンにN個のSFX）                           │
├───────────────────────────────────────────────────────────────┤
│ Layer 4: Voice（発話音声）                                     │
│ ├── SSOT: scene_utterances + audio_generations                │
│ ├── 複数話者: narration / dialogue 混在可能                    │
│ └── 尺計算の基準: Σ(utterance.duration_ms) + padding           │
└───────────────────────────────────────────────────────────────┘
```

### 3. 尺計算の優先順位（computeSceneDurationMs）

```
1. display_asset_type = 'video' 
   └─► video_generations.duration_sec × 1000
   
2. scene_utterances の音声合計
   └─► Σ(utterances[].duration_ms) + 500ms padding
   
3. duration_override_ms（手動設定）
   └─► シーン編集で設定した無音尺（1-60秒）
   
4. comic_data.utterances の合計尺（後方互換）
   └─► 漫画モードの旧形式
   
5. active_audio.duration_ms（旧式シーン音声）
   └─► 後方互換用
   
6. dialogue テキストから推定
   └─► 文字数 × 300ms（日本語）
   
7. デフォルト
   └─► 5000ms（5秒）

⚠️ 音声がある場合、手動設定より音声尺が優先（セリフ切れ防止）
```

### 4. テロップ表示ルール

```
┌────────────────────────────────────────────────────────────┐
│ テロップ設定（SSOT: projects.settings_json.telops_remotion）│
│                                                            │
│ ├── enabled: true/false（全体ON/OFF）                       │
│ ├── style_preset: outline/minimal/band/pop/cinematic       │
│ ├── size_preset: sm/md/lg                                  │
│ ├── position_preset: bottom/center/top                     │
│ └── scene_overrides: { scene_idx: enabled }               │
│                                                            │
│ 表示テキスト:                                               │
│   scene.dialogue または utterance.text を使用               │
│                                                            │
│ シーン単位のON/OFF:                                         │
│   scene_overrides[scene_idx] が設定されていれば優先         │
└────────────────────────────────────────────────────────────┘
```

### 5. 吹き出し（バルーン）表示ルール

```
┌────────────────────────────────────────────────────────────┐
│ 吹き出し設定（SSOT: scene_balloons）                        │
│                                                            │
│ display_policy:                                            │
│   ├── 'always_on' ──► シーン全体（0〜duration_ms）で表示    │
│   ├── 'voice_window' ──► utterance の start_ms〜end_ms    │
│   └── 'manual_window' ──► timing.start_ms〜end_ms を使用  │
│                                                            │
│ text_render_mode:                                          │
│   ├── 'remotion' ──► Remotion で文字を動的描画             │
│   ├── 'baked' ──► bubble_r2_url の画像をそのまま表示       │
│   └── 'none' ──► バルーン出力しない                        │
│                                                            │
│ ⚠️ comic モードはデフォルト baked（二重表示防止）            │
└────────────────────────────────────────────────────────────┘
```

### 6. モーション（カメラの動き）

#### SSOT: `scene_motion` テーブル
シーン単位のモーション設定は `scene_motion` テーブルに保存され、`resolveMotionPreset()` で解決される。

#### motion_type 分類
| motion_type | 説明 |
|------------|------|
| `none` | 静止（comic モードのデフォルト） |
| `zoom` | ズームイン/アウト（Ken Burns系） |
| `pan` | パン（カメラ移動） |
| `combined` | ズーム + パン複合 |

#### 全20種類のモーションプリセット

| ID | 名前 | motion_type | 説明 |
|----|------|------------|------|
| `none` | 動きなし | none | 静止画のまま表示 |
| `kenburns_soft` | ゆっくりズーム | zoom | 1.0→1.05 |
| `kenburns_strong` | 強めズーム | zoom | 1.0→1.15 |
| `kenburns_zoom_out` | ズームアウト | zoom | 1.1→1.0 |
| `pan_lr` | 左→右パン | pan | x: -5→5 |
| `pan_rl` | 右→左パン | pan | x: 5→-5 |
| `pan_tb` | 上→下パン | pan | y: -5→5 |
| `pan_bt` | 下→上パン | pan | y: 5→-5 |
| `slide_lr` | 左→右スライド | pan | x: -10→10（大きめ移動） |
| `slide_rl` | 右→左スライド | pan | x: 10→-10 |
| `slide_tb` | 上→下スライド | pan | y: -10→10 |
| `slide_bt` | 下→上スライド | pan | y: 10→-10 |
| `hold_then_slide_lr` | 静止→左→右 | pan | 前半静止→後半移動、hold_ratio 0.3 |
| `hold_then_slide_rl` | 静止→右→左 | pan | 前半静止→後半移動 |
| `hold_then_slide_tb` | 静止→上→下 | pan | 前半静止→後半移動 |
| `hold_then_slide_bt` | 静止→下→上 | pan | 前半静止→後半移動 |
| `combined_zoom_pan_lr` | ズーム+右パン | combined | 1.0→1.08 + x: -3→3 |
| `combined_zoom_pan_rl` | ズーム+左パン | combined | 1.0→1.08 + x: 3→-3 |
| `auto` | 自動（ランダム） | 可変 | seed で決定的に選択（再現性あり） |

> **注**: `auto` は `pickAutoMotion(seed)` で9候補から決定的に選択。seed = scene_id XOR projectId。

#### デフォルト動作
| display_asset_type | デフォルトプリセット | 理由 |
|-------------------|-------------------|------|
| `image` | `kenburns_soft` | 静止画に自然な動きを付与 |
| `comic` | `none` | 漫画は静止が自然 |
| `video` | `none` | 動画自体がモーションを持つ |

#### 全シーン一括適用
`POST /api/projects/:id/motion/bulk` で全シーンのモーションを一括設定可能。
- `mode: 'uniform'` — 全シーンに同じプリセットを適用
- `mode: 'random'` — 各シーンに AUTO_MOTION_CANDIDATES からランダム割当
- `mode: 'auto'` — 各シーンに `auto` プリセットを設定（seed で再現性あり）

#### 2パスのモーション適用
1. **シーン編集（per-scene）**: `PUT /api/scenes/:id/motion` — 個別シーンのモーション設定
2. **Video Build**: `buildProjectJson` → `resolveMotionPreset(scene, projectId)` でビルド時に解決
   - `scene.motion` が設定済み → その設定を使用
   - 未設定 → デフォルト（image: kenburns_soft, comic: none）
   - `auto` → seed ベースで9候補から決定的選択

### 7. buildProjectJson 出力構造

```json
{
  "schema_version": "1.5",
  "project_id": 168,
  "build_settings": {
    "aspect_ratio": "16:9",
    "resolution": { "width": 1920, "height": 1080 },
    "telops": { "enabled": true, "style_preset": "outline" }
  },
  "assets": {
    "bgm": { "url": "...", "volume": 0.25, "ducking": {...} }
  },
  "scenes": [
    {
      "idx": 1,
      "timing": { "start_ms": 0, "duration_ms": 5000 },
      "assets": {
        "image": { "url": "..." },      // display_asset_type = 'image'/'comic'
        "video_clip": { "url": "..." }, // display_asset_type = 'video'
        "voices": [...]
      },
      "balloons": [...],
      "sfx": [...],
      "bgm": {...},  // シーン別BGM（あれば）
      "motion": {...}
    }
  ]
}
```

### API エンドポイント
- `GET /api/video-builds/usage` - 利用状況（月間/同時）
- `GET /api/projects/:id/video-builds/preflight` - Preflight検証
- `GET /api/projects/:id/video-builds` - ビルド一覧
- `POST /api/projects/:id/video-builds` - ビルド開始
- `POST /api/video-builds/:id/refresh` - ステータス更新

### 詳細ドキュメント
- `docs/VIDEO_BUILD_SSOT.md` - SSOT & 依存関係ドキュメント

---

## Phase1.7 漫画機能

### 主要機能
- **漫画エディタ**: 6種類の吹き出し（speech_round, speech_oval, thought_oval, telop_bar, caption, whisper）
- **採用切替**: シーンカードで「画像を採用」「漫画を採用」をリアルタイム切替
- **発話ごとの音声**: 漫画モードでは最大3発話、それぞれに音声設定
- **display_image SSOT**: API/UI/エクスポートで採用素材を統一

### SSOT設計
- `scenes.display_asset_type`: 'image' | 'comic'（将来的に 'video' も追加予定）
- `scenes.comic_data`: { draft: {...}, published: {...} }
- `image_generations.asset_type`: 'ai' | 'comic'

### 詳細ドキュメント
- `docs/PHASE17_IMPLEMENTATION_STATUS.md` - 実装状況
- `docs/PHASE17_NEXT_STEPS_ANALYSIS.md` - 次ステップ分析

---

## マイグレーション運用手順（Phase X-2）

### マイグレーション番号衝突の履歴（運用事故防止ドキュメント）

#### 背景

2026-01-01にPhase X-2実装中、`0007_world_character_bible.sql` が既存の `0007_add_runs_system.sql` と番号衝突しました。

#### 解決方針：NO-OP方式

既にGitHubにpush済みのファイルを削除すると環境間で適用履歴が割れるため、以下の方針を採用：

1. **`0007_world_character_bible.sql`**: NO-OP化（`SELECT 1 WHERE 1=0;` のみ）
   - Git履歴を保全
   - 適用済み環境でも無害
   - ドキュメント化で負債化を防止

2. **`0010_world_character_bible.sql`**: 実際のスキーマ適用
   - `world_settings`
   - `project_character_models`
   - `scene_character_map`
   - 全て `IF NOT EXISTS` 付き（環境差で落ちない）

3. **`0011_add_character_aliases.sql`**: `aliases_json` カラム追加

#### 復旧手順

**既に `0007_world_character_bible.sql` を適用した環境の場合**:

```bash
# 1. マイグレーション状態を確認
npx wrangler d1 migrations list webapp-production --local

# 2. 0010を適用（IF NOT EXISTS なので安全）
npx wrangler d1 migrations apply webapp-production --local

# 3. テーブル存在確認
npx wrangler d1 execute webapp-production --local --command="
SELECT name FROM sqlite_master 
WHERE type='table' 
AND name IN ('world_settings', 'project_character_models', 'scene_character_map');
"
```

**クリーン環境の場合**:

```bash
# 通常通り適用（0007はNO-OP、0010が実際の適用）
npx wrangler d1 migrations apply webapp-production --local
```

#### 本番環境への適用

```bash
# 本番DB確認（注意：本番データに影響）
npx wrangler d1 migrations list webapp-production --remote

# 本番適用（必ずバックアップ後に実行）
npx wrangler d1 migrations apply webapp-production --remote
```

#### なぜこの方針か

- **Git履歴の整合性維持**: ファイル削除は環境間の不整合を生む
- **べき等性**: `IF NOT EXISTS` により何度実行しても安全
- **ドキュメント化**: 意図的な設計であることを明示

---

## 2026-01-20 追加機能

### speech_type（セリフ/ナレーション判定）
- **DB**: `scenes.speech_type` カラム追加（'dialogue' | 'narration'）
- **AI判定**: シーン分割時にAIが自動分類
  - dialogue: キャラクターの発言（「」内の台詞）
  - narration: ナレーション、説明、状況描写
- **API**: すべてのシーン取得APIで `speech_type` を返却
- **マイグレーション**: `0019_add_scene_speech_type.sql`

### reset-to-input 安全化
- **ブロック条件追加**:
  - Video Build（最終動画）が存在 → リセット不可
  - 漫画化データが存在 → リセット不可
  - シーン動画が存在 → リセット不可
- **ボタン非活性化**: 上記条件でボタンがグレーアウト + 🔒アイコン
- **R2クリーンアップ**: リセット時に画像/音声/動画のR2ファイルも削除（ストレージリーク防止）
- **警告ダイアログ強化**: 削除件数明示 + 確認チェックボックス必須

### ElevenLabs音声有効化
- **voice-presets.json**: ElevenLabs 8ボイスを `status: 'active'` に変更
- **キャラクター設定UI**: Voice Presetドロップダウンに「Google TTS」「ElevenLabs (Premium)」グループ表示

### その他修正
- シーン分割「やり直す」ボタン重複削除（小ボタンのみ残す）
- シーンカテゴリ日本語化（Hook→導入・つかみ 等）
- S3署名付きURL期限切れハンドリング
- 音声再生成連打防止（確認ダイアログ）
- Google Fonts追加ロード（手書きフォント対応）

### Phase X-4/X-5: キャラクター特徴管理システム

#### 概要
キャラクターの一貫した描写を実現するため、物語全体の共通特徴とシーン別オーバーライドを管理。

#### 優先順位（画像生成時）
1. **参照画像** - 常に使用（視覚的一貫性維持）
2. **シーン別オーバーライド** - あれば最優先
3. **共通特徴（story_traits）** - 物語全体で適用
4. **appearance_description** - 手動設定の外見説明
5. **日本語テキスト指示** - デフォルト追加（カスタムプロンプト時はスキップ）

#### データモデル
```
project_character_models
├── character_key, character_name
├── appearance_description (手動設定)
├── story_traits (物語全体の特徴)
└── reference_image_r2_url (参照画像)

scene_character_traits
├── scene_id, character_key
├── override_type ('transform' など)
└── trait_description (シーン別特徴)

scenes
└── is_prompt_customized (0/1) - カスタムプロンプトフラグ
```

#### 機能
1. **キャラクター特徴サマリー表示**: シーン分割画面で全キャラの共通特徴とシーン別オーバーライドを一覧表示
2. **シーン別オーバーライド追加**: 各シーンで「シーン別特徴を追加」ボタンから設定可能
3. **カスタムプロンプト対応**: Builderでプロンプト編集時は日本語指示・自動特徴追加をスキップ
4. **自動特徴抽出**: シーン分割時にダイアログからキャラクター特徴を自動抽出

#### 使用例
```
キャラクター: ベル
共通特徴: 小さな妖精、キラキラと光る羽、青いドレス
シーン別オーバーライド:
  #10: 人間の姿に変身。妖精の羽は消え、普通の少女の姿
```

#### API
- `GET /api/projects/:id/character-traits-summary` - 特徴サマリー取得
- `PUT /api/projects/:id/characters/:key/story-traits` - 共通特徴更新
- `GET /api/scenes/:id/character-traits` - シーン別オーバーライド取得
- `POST /api/scenes/:id/character-traits` - シーン別オーバーライド追加
- `DELETE /api/scenes/:id/character-traits/:key` - シーン別オーバーライド削除

---

## 2026-01-21 R1.5 追加機能

### 複数話者音声（scene_utterances SSOT）

#### 概要
シーン内の発話を「誰が」「何を」「どの順番で」喋るかを管理するSSOTシステム。
音声とテロップの両方に使用される単一情報源。

#### データモデル
```sql
scene_utterances
├── id (PK)
├── scene_id (FK → scenes.id)
├── order_no (シーン内の再生順)
├── role ('narration' | 'dialogue')
├── character_key (dialogueの場合必須)
├── text (発話テキスト/字幕)
├── audio_generation_id (FK → audio_generations.id)
├── duration_ms (音声長さキャッシュ)
└── created_at, updated_at
```

#### 機能
1. **Lazy Migration**: シーンの音声タブを開くと、既存の`dialogue`から自動的にナレーションutteranceを1件作成
2. **複数話者**: narration（ナレーター）とdialogue（キャラセリフ）を混在可能
3. **発話単位の音声生成**: 各utteranceに個別に音声を生成可能
4. **並び替え**: ドラッグ&ドロップでorder_noを変更可能

#### API
- `GET /api/scenes/:sceneId/utterances` - 発話一覧取得（lazy migrate含む）
- `POST /api/scenes/:sceneId/utterances` - 発話追加
- `PUT /api/utterances/:id` - 発話更新
- `DELETE /api/utterances/:id` - 発話削除
- `PUT /api/scenes/:sceneId/utterances/reorder` - 並び替え
- `POST /api/utterances/:id/generate-audio` - 発話単位の音声生成

#### UI
- **SceneEditModal**: 「キャラ割り当て」「音声」「特徴変化」の3タブ構成
- **音声タブ**: 発話カード表示、追加/編集/削除/並び替え、音声生成/再生

#### SSOT ルール（動画生成時）
1. `scene_utterances`が存在 → `voices[]`として出力
2. `scene_utterances`なし → 既存の`active_audio`をfallbackでnarration変換
3. `duration_ms` = Σ(voices[].duration_ms) + padding（音声なしは推定値）

#### マイグレーション
- `0022_create_scene_utterances.sql`

---

## 2026-01-25 Phase2 UI統合

### 概要
Builder UI を「トップは結果表示のみ、編集はモーダルで完結」の原則に沿ってリファクタリング。二重モーダル問題を根絶。

### Phase1: Builder Scene Card 再構成
- **セリフ概要**: 全文表示 → 120文字省略（参照専用）
- **発話サマリー**: 下部 → 上部に移動、編集ボタン削除
- **映像タイプ**: 画像/漫画を明示表示
- **カード内編集UI**: 全削除（モーダルに集約）
- **詳細情報**: スタイル/プロンプト/要点を折りたたみ表示

### Phase2-PR2a: 漫画発話分割表示
- **Before**: 発話を結合して1行表示
- **After**: `発話1: 〇〇 / 発話2: △△` と行別表示（最大3行 + 「他n件」）

### Phase2-PR2b: 音声キャラクター(1人) 削除
- キャラ割当モーダルから「音声キャラクター（1人）」セクションを削除
- 音声設定はSceneEditModal の「音声タブ」に統一

### Phase2-PR2c: 二重モーダル根絶
- **Before**: 発話編集で別モーダルが `document.body` に追加される問題
  - キャンセルボタンが効かない
  - 連打で複数モーダル生成
- **After**: インライン編集に変更
  - 発話カード内でフォームに変化
  - 同じDOM内で完結
  - 状態ガードで連打防止

### 変更ファイル
- `public/static/project-editor.js`: renderSceneTextContent, renderDialogueSummary等
- `public/static/world-character-modal.js`: openAssign から音声キャラ削除
- `public/static/utterances-tab.js`: インライン編集実装

---

## 2026-01-23 R3-A 追加機能

### 通しBGM（project_audio_tracks）

#### 概要
プロジェクト全体を通して流れるBGMを管理。ダッキング（音声再生時にBGM音量を自動調整）対応。

#### データモデル
```sql
project_audio_tracks
├── id (PK)
├── project_id (FK → projects.id)
├── track_type ('bgm')
├── r2_key, r2_url (R2ストレージ)
├── duration_ms
├── volume (0.0-1.0, default: 0.25)
├── loop (boolean, default: true)
├── fade_in_ms, fade_out_ms (default: 800ms)
├── ducking_enabled (default: false)
├── ducking_volume (0.0-1.0, default: 0.12)
├── ducking_attack_ms, ducking_release_ms
├── is_active
└── created_at, updated_at
```

#### API
- `GET /api/projects/:projectId/audio-tracks` - BGMトラック一覧
- `POST /api/projects/:projectId/audio-tracks/bgm/upload` - BGMアップロード
- `PUT /api/projects/:projectId/audio-tracks/:id` - BGM設定更新
- `DELETE /api/projects/:projectId/audio-tracks/:id` - BGM削除

#### Remotion統合
`buildProjectJson`出力:
```json
{
  "assets": {
    "bgm": {
      "url": "https://.../bgm.mp3",
      "volume": 0.25,
      "loop": true,
      "fade_in_ms": 800,
      "fade_out_ms": 800,
      "ducking": {
        "enabled": true,
        "volume": 0.12,
        "attack_ms": 120,
        "release_ms": 220
      }
    }
  }
}
```

### 無音シーンの尺設定（duration_override_ms）

#### 概要
セリフや音声がないシーン（風景、戦闘、間のシーン等）の尺を手動設定可能に。

#### データモデル
```sql
scenes
└── duration_override_ms (INTEGER, NULL=自動計算)
```

#### 尺計算の優先順位（computeSceneDurationMs）
1. **video mode**: video素材の`duration_sec × 1000`
2. **utterances音声合計**: Σ(utterances[].duration_ms) + padding
3. **duration_override_ms**: 手動設定値（1-60秒）
4. **dialogue推定**: 文字数 × 300ms（最小2秒）
5. **DEFAULT**: 5000ms

#### API
- `PUT /api/scenes/:id` - `duration_override_ms`パラメータ追加（1000-60000ms）

### Preflight 2層検証

#### 概要
preflight判定を「必須条件」と「推奨/警告」の2レイヤーに分離。

#### レイヤー1（必須 - can_generate に影響）
- 素材が全シーンに存在すること

#### レイヤー2（警告 - utterance_errors）
- utterancesが未登録（「セリフがありますが音声パーツが未登録です」）
- 音声が未生成

#### 動作
- **is_ready: true** → 素材OK
- **can_generate: true** → 生成可能（utterance警告があっても止めない）
- **utterance_errors** → 警告として表示、生成は許可

#### マイグレーション
- `0028_add_scene_duration_override_ms.sql`
- `0029_create_project_audio_tracks.sql`

---

## 2026-01-23 R3-B/R4 追加機能

### R3-B: シーン別SFX（scene_audio_cues）

#### 概要
シーンに効果音（SFX）を追加するSSOTシステム。BGMと並行して、シーン固有の音響演出が可能。

#### データモデル
```sql
scene_audio_cues
├── id (PK)
├── scene_id (FK → scenes.id)
├── cue_type ('sfx')
├── name (効果音名)
├── r2_key, r2_url (R2ストレージ)
├── start_ms (開始時刻)
├── end_ms, duration_ms (終了/尺)
├── volume (0.0-1.0, default: 0.8)
├── loop (boolean)
├── fade_in_ms, fade_out_ms
├── is_active
└── created_at, updated_at
```

#### API
- `GET /api/scenes/:sceneId/audio-cues` - SFX一覧取得
- `POST /api/scenes/:sceneId/audio-cues/sfx/upload` - SFXアップロード
- `PUT /api/scenes/:sceneId/audio-cues/:id` - SFX設定更新
- `DELETE /api/scenes/:sceneId/audio-cues/:id` - SFX削除

#### Audio SSOT（最終3レイヤー構成）
1. **BGM**: `project_audio_tracks`（プロジェクト全体）
2. **SFX**: `scene_audio_cues`（シーン単位）
3. **Voice**: `scene_utterances`（発話単位）

#### Preflight UI
- 🎵 BGM / 🔊 SFX(N) / 🎙 Voice(N) の形式で音声状態を1行表示
- 無音の場合は 🔇 音なし（警告表示）

#### マイグレーション
- `0031_create_scene_audio_cues.sql`

---

### R4: SSOT Patch API（チャット修正）

#### 概要
チャット指示をSSOTパッチとして適用するAPI。dry-run → apply の2段階フローで安全に変更を適用。

#### データモデル
```sql
patch_requests
├── id (PK)
├── project_id (FK → projects.id)
├── video_build_id (ソースビルドID、NULL可)
├── source ('chat' | 'api')
├── user_message (ユーザー指示)
├── ops_json (パッチ操作配列)
├── status ('draft' | 'dry_run_ok' | 'dry_run_failed' | 'apply_ok' | 'apply_failed')
├── dry_run_result_json, apply_result_json
└── created_at, updated_at

patch_effects
├── id (PK)
├── patch_request_id (FK)
├── entity, record_id, op
├── before_json, after_json (変更前後のスナップショット)
└── created_at

video_builds（拡張）
├── source_video_build_id (派生元ビルド)
└── patch_request_id (適用されたパッチ)
```

#### API
- `POST /api/projects/:id/patches/dry-run` - プレビュー実行
- `POST /api/projects/:id/patches/apply` - パッチ適用（+ 新ビルド自動生成）
- `GET /api/projects/:id/patches` - パッチ履歴一覧
- `GET /api/projects/:id/patches/:patchId` - パッチ詳細

#### 許可エンティティ（ホワイトリスト）
- `scene_balloons`: タイミング・位置・サイズ
- `scene_audio_cues`: SFXタイミング・音量
- `scene_motion`: モーションプリセット
- `project_audio_tracks`: BGM音量・有効/無効
- `scene_utterances`: 音声タイミング

#### 禁止フィールド（セキュリティ）
- `r2_key`, `r2_url`（ストレージ直接操作禁止）
- `audio_generation_id`（FK操作禁止）
- `text`, `character_key`（コンテンツ操作制限）

#### apply後の自動ビルド生成
パッチ適用成功時に自動で新しい`video_build`を作成:
1. `patch_request.status` = `apply_ok` に更新
2. 新しい`video_build`作成（`patch_request_id`を記録）
3. `project.json`を再生成してR2に保存
4. レスポンスに`new_video_build_id`を返却

#### UI
- VideoBuildタブ内に「修正履歴（パッチ）」セクション
- 日時、メッセージ、変更タイプ、ステータス表示
- 生成されたビルドへのリンク
- 詳細展開で操作内容（ops_json）表示

#### マイグレーション
- `0032_create_patch_requests.sql`
- `0033_add_video_builds_patch_columns.sql`

---

### Safe Chat v1 - テロップコマンド (PR-5-3b)

#### 概要
Safe Chat でテロップ設定を「事故らない範囲だけ」変更可能に。Build単位の上書きで実現（DBエンティティは変更しない）。

#### 許可操作（4つのみ）
| コマンド | 説明 | パラメータ |
|---------|------|-----------|
| `telop.set_enabled` | 全テロップ ON/OFF | `enabled: boolean` |
| `telop.set_position` | 位置プリセット変更 | `position_preset: 'bottom' \| 'center' \| 'top'` |
| `telop.set_size` | サイズプリセット変更 | `size_preset: 'sm' \| 'md' \| 'lg'` |

#### 禁止事項
- 本文 text は一切触らない
- シーン構成（並び替え/分割統合）は触らない
- 字幕（captions）には影響しない

#### SSOT 置き場所
- **Build単位の上書き**: `settings_json.telops.enabled / position_preset / size_preset`
- DBエンティティ（`scene_telops`テーブル）は更新しない

#### UIテンプレート例
```
「テロップを全部OFF」
「テロップを全部ON」
「テロップ位置を上に」
「テロップ位置を中央に」
「テロップサイズを大に」
```

#### 実装ファイル
- `src/routes/patches.ts`: `TelopSetEnabledAction`, `TelopSetPositionAction`, `TelopSetSizeAction` 型定義 + `resolveIntentToOps` でのtelop処理
- `public/static/project-editor.js`: `parseMessageToIntent` にテロップパーサー追加

---

## 2026-01-19 追加機能

### Phase 1: Scene Split無限待ちゼロ化
- **タイムアウト**: 10分でポーリング停止
- **失敗検出**: status='failed' を検出してUI表示
- **ネットワークエラー**: 3回リトライ後にエラー表示
- **LogID表示**: サポート用ログID生成
- **再試行ボタン**: タイムアウト/エラー後の復帰導線
- **ドキュメント**: `docs/SCENE_SPLIT_SSOT.md`

### Phase 2: voice-presets.json更新
- **provider階層化**: Google / Fish / ElevenLabs をグループ化
- **ElevenLabs準備中**: 8ボイスを `status: 'coming_soon'` で追加
- **tier追加**: basic / standard / premium

### Phase 3: 漫画吹き出し設計書
- **textStyle**: 縦書き/横書き、フォント、太字、サイズ
- **timing**: 表示タイミング制御、アニメーション
- **Remotion統合案**: BuildRequest v1.1 拡張
- **ドキュメント**: `docs/BUBBLE_TEXTSTYLE_SPEC.md`

### Phase 4: TTS計測・上限・キャッシュ設計書
- **tts_usage_logs**: 使用量ログテーブル設計
- **上限制御**: 段階警告（70/85/95/100%）
- **キャッシュ**: 同一テキストの再利用
- **ドキュメント**: `docs/TTS_USAGE_LIMITS_SPEC.md`

---

## 2026-01-23 Safe Chat v1

### 概要
チャット修正（Safe Chat）のコスト可視化機能。すべてのオペレーションログを`api_usage_logs`に統一記録し、SuperAdmin画面で追跡可能に。

### コストイベント（api_usage_logs）

| api_type | provider | 用途 | ログタイミング |
|----------|----------|------|--------------|
| bgm_upload | r2 | BGMアップロード | POST /api/projects/:id/audio-tracks/bgm/upload |
| sfx_upload | r2 | SFXアップロード | POST /api/scenes/:id/audio-cues/sfx/upload |
| patch_apply | ssot | APIパッチ適用 | POST /api/projects/:id/patches/apply |
| chat_edit_apply | ssot | チャット修正適用 | POST /api/projects/:id/chat-edits/apply |
| video_build_render | remotion_lambda | 動画レンダリング | POST /api/video-builds/:id/refresh (完了時) |
| llm_intent | openai等 | LLM Intent生成 | (将来実装) |

### userId 正規化（NOT NULL維持）

| イベント | userId 決定ルール |
|---------|-----------------|
| video_build_render | video_builds.owner_user_id → project.user_id → スキップ |
| bgm_upload / sfx_upload | session.user_id (認証必須) |
| patch_apply / chat_edit_apply | session.user_id → project.user_id |
| backfill / cron | owner_user_id → project.user_id |

### API
- `GET /api/admin/usage/operations` - オペレーション統計（種別/プロジェクト/ユーザー別）
- `POST /api/admin/backfill-render-logs` - 過去ビルドのログ回収
- `POST /api/admin/cron/collect-render-logs` - Cron用回収エンドポイント
- `GET /api/admin/orphan-builds` - userId不明ビルド一覧

### Cron 回収設定

#### GitHub Actions（推奨）
`.github/workflows/cron-collect-render-logs.yml`:
```yaml
name: Collect Render Logs
on:
  schedule:
    - cron: '0 3 * * *'  # 03:00 UTC = 12:00 JST
  workflow_dispatch:
jobs:
  collect-logs:
    runs-on: ubuntu-latest
    steps:
      - name: Collect unlogged render events
        run: |
          curl -X POST \
            -H "X-Cron-Secret: ${{ secrets.CRON_SECRET }}" \
            "https://webapp-c7n.pages.dev/api/admin/cron/collect-render-logs"
```

**必要なGitHub Secret**: `CRON_SECRET`

#### Stuck Build Cleanup（5分間隔で実行推奨）

`.github/workflows/cron-cleanup-stuck-builds.yml`:
```yaml
name: Cleanup Stuck Builds
on:
  schedule:
    - cron: '*/5 * * * *'  # 5分ごと
  workflow_dispatch:
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Cleanup stuck builds
        run: |
          curl -X POST \
            -H "X-Cron-Secret: ${{ secrets.CRON_SECRET }}" \
            "https://webapp-c7n.pages.dev/api/admin/cron/cleanup-stuck-builds"
```

#### 外部 Cron サービス（UptimeRobot / cron-job.org）

1. **UptimeRobot** (無料プランで5分間隔可能)
   - URL: `https://webapp-c7n.pages.dev/api/admin/cron/cleanup-stuck-builds`
   - Method: `POST`
   - Custom HTTP Header: `X-Cron-Secret: your-secret`

2. **cron-job.org** (無料・1分間隔も可能)
   - URL: `https://webapp-c7n.pages.dev/api/admin/cron/cleanup-stuck-builds`
   - Request method: `POST`
   - Header: `X-Cron-Secret: your-secret`

#### 手動実行
```bash
# Stuck Build Cleanup
curl -X POST \
  -H "X-Cron-Secret: your-secret" \
  "https://webapp-c7n.pages.dev/api/admin/cron/cleanup-stuck-builds"

# Render Log Collection
curl -X POST \
  -H "X-Cron-Secret: your-secret" \
  "https://webapp-c7n.pages.dev/api/admin/cron/collect-render-logs"
```

### Cron エンドポイント一覧

| エンドポイント | 用途 | 推奨間隔 |
|---------------|------|---------|
| `POST /api/admin/cron/cleanup-stuck-builds` | 30分以上 stuck のビルドを自動キャンセル | 5分 |
| `POST /api/admin/cron/collect-render-logs` | 未記録のレンダーログを回収 | 1日1回 |

### SuperAdmin UI
管理画面 → コスト管理 → オペレーション使用量:
- オペレーション種別ごとのカード表示（リクエスト数、推定コスト）
- ユニークプロジェクト数/ユーザー数
- 最近のオペレーション一覧

### マイグレーション
- `0034_add_video_builds_render_usage_logged.sql` - 二重計上防止フラグ

---

## AWS Webhook (Callback) 仕様

### エンドポイント
`POST /api/webhooks/video-build`

### 認証
- **Header**: `X-Webhook-Signature: HMAC-SHA256(body, WEBHOOK_SECRET)`
- 環境変数 `WEBHOOK_SECRET` または `CRON_SECRET` を使用

### Payload
```json
{
  "video_build_id": 123,
  "status": "rendering|uploading|completed|failed",
  "progress_percent": 50,
  "progress_stage": "Rendering frames",
  "progress_message": "Processing scene 3 of 10",
  "download_url": "https://...",
  "download_expires_at": "2026-01-25T12:00:00Z",
  "error_code": "RENDER_ERROR",
  "error_message": "Failed to render scene 5",
  "render_metadata": {
    "render_id": "remotion-render-id",
    "started_at": "2026-01-24T10:00:00Z",
    "completed_at": "2026-01-24T10:05:00Z",
    "duration_sec": 300,
    "estimated_cost_usd": 0.05
  }
}
```

### レスポンス
```json
{
  "success": true,
  "message": "Build updated",
  "status": "completed"
}
```

### 特徴
- **冪等性**: 同じステータスの再送は無視
- **二重計上防止**: `render_usage_logged` フラグで lock-first パターン
- **自動ログ記録**: completed/failed 時に `api_usage_logs` へ記録

---

## AWS Webhook Integration

AWS Orchestrator からのコールバックでステータスをリアルタイム更新（ポーリング依存脱却）。

### Webhook エンドポイント

`POST /api/webhooks/video-build`

**認証**: HMAC-SHA256 署名検証
```
X-Webhook-Signature: HMAC-SHA256(body, WEBHOOK_SECRET)
```

**Payload**:
```json
{
  "video_build_id": 123,
  "status": "completed",
  "progress_percent": 100,
  "progress_stage": "Completed",
  "download_url": "https://...",
  "download_expires_at": "2026-01-25T12:00:00Z",
  "render_metadata": {
    "render_id": "...",
    "started_at": "2026-01-24T10:00:00Z",
    "completed_at": "2026-01-24T10:05:00Z",
    "duration_sec": 300,
    "estimated_cost_usd": 0.50
  }
}
```

**Status 値**: `rendering`, `uploading`, `completed`, `failed`

### 環境変数

```bash
# Webhook 署名検証用（CRON_SECRET と共用可能）
WEBHOOK_SECRET=your-webhook-secret
```

### 二重計上防止

- `render_usage_logged` フラグで冪等性を保証
- Webhook と Cron のどちらが先に処理しても同じ結果

### Orchestrator側 Webhook送信コード（コピペ用）

AWS Lambda / Node.js 18+ 向けの署名付きWebhook送信実装:

```typescript
// Orchestrator側に追加する Webhook 送信コード
import crypto from 'crypto';

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://webapp-c7n.pages.dev/api/webhooks/video-build';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // Cloudflare側と同じ値

interface WebhookPayload {
  video_build_id: number;
  status: 'rendering' | 'uploading' | 'completed' | 'failed';
  progress_percent?: number;
  progress_stage?: string;
  progress_message?: string;
  download_url?: string;
  download_expires_at?: string; // ISO8601
  error_code?: string;
  error_message?: string;
  render_metadata?: {
    render_id?: string;
    started_at?: string;
    completed_at?: string;
    duration_sec?: number;
    duration_ms?: number;
    estimated_cost_usd?: number;
  };
}

async function postWebhook(payload: WebhookPayload): Promise<void> {
  if (!WEBHOOK_SECRET) {
    console.warn('[Webhook] WEBHOOK_SECRET not configured, skipping');
    return;
  }

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${timestamp}.${body}`;
  
  const signature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(message)
    .digest('hex');

  const eventId = crypto.randomUUID();

  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Rilarc-Timestamp': timestamp,
      'X-Rilarc-Signature': `sha256=${signature}`,
      'X-Rilarc-Event-Id': eventId,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Webhook failed: ${response.status} ${text}`);
  }

  console.log(`[Webhook] Sent ${payload.status} for build ${payload.video_build_id}`);
}

// 使用例 - completed
await postWebhook({
  video_build_id: 123,
  status: 'completed',
  progress_percent: 100,
  progress_stage: 'Completed',
  download_url: 'https://your-bucket.s3.amazonaws.com/video.mp4?presigned...',
  download_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  render_metadata: {
    render_id: 'remotion-render-abc123',
    started_at: startTime.toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: totalDurationMs,
    estimated_cost_usd: estimatedCost,
  },
});

// 使用例 - failed
await postWebhook({
  video_build_id: 123,
  status: 'failed',
  error_code: 'RENDER_ERROR',
  error_message: 'Failed to render scene 5: Out of memory',
  render_metadata: {
    render_id: 'remotion-render-abc123',
    started_at: startTime.toISOString(),
  },
});
```

**重要ポイント**:
- `X-Rilarc-Timestamp` は秒単位のUNIXタイムスタンプ
- 署名は `timestamp.body` を HMAC-SHA256 で計算
- タイムスタンプが ±5分 を超えると拒否される（リプレイ対策）
- `X-Rilarc-Event-Id` は監査ログ追跡用

---

## 復旧手順（サンドボックス再開用）

### 方法1: GitHubからクローン（推奨）

```bash
# GitHub からクローン
cd /home/user
git clone https://github.com/matiuskuma2/webapp.git
cd webapp

# 依存関係インストール（5分程度かかる場合あり）
npm install

# ローカルDB初期化（38個のマイグレーション適用）
npm run db:migrate:local

# ビルド
npm run build

# ローカル開発サーバー起動
pm2 start ecosystem.config.cjs

# 動作確認
curl http://localhost:3000/api/settings/motion-presets
```

### 方法2: バックアップから復元

```bash
# バックアップダウンロード（最新のtar.gzを使用）
curl -o backup.tar.gz "https://www.genspark.ai/api/files/s/LATEST_BACKUP_ID"

# 展開（/home/userに展開）
tar -xzf backup.tar.gz -C /home/user/

# 依存関係インストール
cd /home/user/webapp
npm install

# ローカルDB初期化
npm run db:migrate:local

# ビルド＆起動
npm run build
pm2 start ecosystem.config.cjs
```

### 本番デプロイ手順

```bash
# 1. Cloudflare API設定確認
npx wrangler whoami

# 2. 本番DBマイグレーション（初回のみ）
npm run db:migrate:prod

# 3. デプロイ
npm run build
npx wrangler pages deploy dist --project-name webapp
```

### 環境変数（.dev.vars）

```bash
# 必須
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...

# オプション（動画生成用）
AWS_REGION=ap-northeast-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
VIDEO_BUILD_ORCHESTRATOR_URL=...

# 管理用
CRON_SECRET=...
WEBHOOK_SECRET=...
```

---

## 2026-01-30 PR-Audio-Video 追加機能

### 動画素材の元音声ミュート
Remotion Lambda側の`bundle.js`を修正し、動画クリップ素材の元音声を自動ミュートするように変更。

**修正内容**:
- `Video`コンポーネントに`muted: true`を追加
- 最終動画では素材動画の元音声（エフェクト音等）は消音される
- TTS音声とBGMのみが最終出力に含まれる

**S3バケット**: `remotionlambda-apnortheast1-ucgr0eo7k7`
**修正ファイル**: `sites/rilarc-video-build/bundle.js`

### display_asset_type 3択切替UI（Phase1.8）
シーンカードで画像/漫画/動画を選択できるUIを追加。

**表示条件**:
- 漫画ボタン: 公開済み漫画がある場合に表示（オレンジ）
- 動画ボタン: 完了済み動画がある場合に表示（紫）
- 画像ボタン: 常に表示（青）

**バックエンド対応**:
- `PUT /api/scenes/:id/display-asset-type` で `video` タイプをサポート
- 完了済み動画の存在チェックを追加

### 音声一括生成機能

#### Preflightからの一括生成
Video Build画面の準備状況表示に「音声を一括生成」ボタンを追加。

**表示条件**: 未生成音声（AUDIO_MISSING/NO_UTTERANCES）がある場合
**機能**: 全シーンの未生成utteranceに対して音声生成を順次実行

#### シーンカードからの音声生成
各シーンカードに「音声生成 N件」ボタンを追加。

**表示条件**: 未生成のutteranceがある場合
**機能**: 該当シーンの未生成utteranceに対して音声生成を実行

#### 動画ビルド前確認ダイアログ
動画生成開始時に未生成音声がある場合、3択ダイアログを表示。

**選択肢**:
1. **先に音声を生成する（推奨）**: 一括音声生成を実行
2. **無音のまま動画を作成**: そのまま続行
3. **キャンセル**: ビルドをキャンセル

### utterance個別音声生成API修正
`generateSceneAudio`関数を修正し、utterance個別のAPIエンドポイントを使用するように変更。

**問題**: 以前は`/api/scenes/:id/generate-audio`を使用しており、`order_no=1`のutteranceのみが更新されていた
**修正**: `/api/utterances/:id/generate-audio`を使用し、各utteranceに個別に音声を生成

### 変更ファイル一覧
- `public/static/project-editor.js`: UI追加（display_asset_type切替、音声生成ボタン、確認ダイアログ）
- `src/routes/comic.ts`: display-asset-type APIで'video'をサポート
- **Remotion S3**: `bundle.js`にmuted設定追加

### Gitコミット
```
e8d1963 fix(PR-Audio-Fix): Use utterance-specific audio generation API
cd508c1 feat(PR-Audio-Video): Add video asset type selector and audio confirm dialog
3486880 feat(PR-Audio-Bulk): Preflight画面から一括音声生成ボタンを追加
a706a3c feat(PR-Audio-Direct): シーンカードから直接音声生成ボタンを追加
```

---

## 2026-01-30 P0: BGM/SFX SSOT化 + 音声ライブラリ設計

### P0-1: SFX再生サポート（Remotion）
RemotionのScene.tsxコンポーネントでシーン単位のSFX再生をサポート。

**追加ファイル**:
- `video-build-remotion/src/schemas/project-schema.ts`: SfxAssetスキーマ追加
- `video-build-remotion/src/components/Scene.tsx`: SFX再生ロジック追加

**SfxAssetスキーマ**:
```typescript
{
  id: string,
  name?: string,
  url: string,
  start_ms: number,  // シーン内の開始タイミング
  end_ms?: number,
  duration_ms?: number,
  volume: number,    // 0.0-1.0 (default: 0.8)
  loop: boolean,
  fade_in_ms: number,
  fade_out_ms: number,
}
```

**Remotion統合**:
- scene.sfx[]配列をSequence + Audioコンポーネントで再生
- start_msでシーン内の開始タイミングを指定
- duration_msがあればその長さ、なければシーン終了まで再生
- volume/loopの設定を反映

### 音声ライブラリ設計（P1/P2準備）

#### 0040: user_audio_library（ユーザー音素材ライブラリ）
BGM/SFXをプロジェクト横断で再利用可能にするテーブル。

**特徴**:
- user_idベース（プロジェクトではなくユーザーに紐付く）
- tags/mood/categoryでAI提案に対応
- use_countで使用回数トラッキング
- キャラクターと同じ「再利用前提アセット」として設計

**カラム**:
```sql
id, user_id, audio_type('bgm'|'sfx'), name, description,
category, mood, tags(JSON),
r2_key, r2_url, duration_ms, file_size,
default_volume, default_loop, default_fade_in_ms, default_fade_out_ms,
is_active, use_count, created_at, updated_at
```

#### 0041: scene_audio_assignments（シーンへの音素材割当）
シーンとBGM/SFXの紐付けを管理するテーブル。

**特徴**:
- ライブラリ参照（system/user）または直接アップロード（direct）に対応
- audio_type='bgm'は1シーン1件のみ、'sfx'は複数可
- volume/loop/fade設定のオーバーライド可能
- 既存project_audio_tracksからのフォールバックパスを確保

**カラム**:
```sql
id, scene_id,
audio_library_type('system'|'user'|'direct'),
system_audio_id, user_audio_id,
direct_r2_key, direct_r2_url, direct_name, direct_duration_ms,
audio_type('bgm'|'sfx'),
start_ms, end_ms,
volume_override, loop_override, fade_in_ms_override, fade_out_ms_override,
is_active, created_at, updated_at
```

### Audio SSOTアーキテクチャ（最終形）

```
┌─────────────────────────────────────────────────────────┐
│  Audio Sources (SSOT)                                    │
│                                                          │
│  ┌────────────────────┐  ┌────────────────────┐        │
│  │ system_audio_library │  │ user_audio_library │        │
│  │ (管理者登録)         │  │ (ユーザー登録)      │        │
│  └─────────┬──────────┘  └─────────┬──────────┘        │
│            │                        │                   │
│            └───────────┬────────────┘                   │
│                        ▼                                │
│            ┌─────────────────────────┐                 │
│            │ scene_audio_assignments │                 │
│            │ (シーン割当SSOT)        │                 │
│            └───────────┬─────────────┘                 │
│                        │                                │
│  ┌─────────────────────┴─────────────────────┐        │
│  │                                            │        │
│  ▼                                            ▼        │
│  ┌────────────────────┐  ┌────────────────────┐        │
│  │ project_audio_tracks │  │ scene_audio_cues   │        │
│  │ (BGM: 移行期間中)    │  │ (SFX: 移行期間中)  │        │
│  └────────────────────┘  └────────────────────┘        │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
        ┌───────────────────────────────────┐
        │ buildProjectJson()               │
        │ (video-build-helpers.ts)         │
        │ ・assets.bgm: プロジェクトBGM    │
        │ ・scene[].sfx: シーンSFX配列     │
        └───────────────────────────────────┘
                         │
                         ▼
        ┌───────────────────────────────────┐
        │ Remotion                          │
        │ (RilarcVideo.tsx + Scene.tsx)    │
        │ ・BGM: projectJson.assets.bgm    │
        │ ・SFX: scene.sfx[]               │
        │ ・Voice: scene.assets.voices[]   │
        └───────────────────────────────────┘
```

### P1: User Audio Library API（実装完了）

ユーザーがアップロードしたBGM/SFXをプロジェクト横断で再利用するAPI。

**エンドポイント**:
- `GET /api/audio-library` - 一覧取得（type=bgm|sfx, category, mood, search, sort）
- `GET /api/audio-library/system` - **システムライブラリ一覧**（管理者登録、category=bgm|sfx）⭐ P3追加
- `GET /api/audio-library/user` - **ユーザーライブラリ一覧**（個人音素材、category=bgm|sfx）⭐ P3追加
- `GET /api/audio-library/:id` - 単一取得
- `POST /api/audio-library/upload` - アップロード（FormData: file, audio_type, name, tags等）
- `PUT /api/audio-library/:id` - メタデータ更新
- `DELETE /api/audio-library/:id` - 削除（R2ファイルも削除）
- `POST /api/audio-library/:id/increment-use` - 使用回数インクリメント

**レスポンス例**:
```json
{
  "items": [{
    "id": 1,
    "audio_type": "bgm",
    "name": "Calm Piano",
    "tags": ["calm", "piano", "background"],
    "r2_url": "https://app.marumuviai.com/audio/library/user_1/bgm/xxx.mp3",
    "duration_ms": 120000,
    "default_volume": 0.25,
    "default_loop": true,
    "use_count": 5
  }],
  "pagination": { "total": 10, "limit": 50, "offset": 0, "has_more": false },
  "filters": { "categories": ["bgm", "relaxing"], "moods": ["calm", "happy"] }
}
```

### P2: Scene Audio Assignments API（実装完了）

シーンへのBGM/SFX割当を管理するAPI。ライブラリ参照 or 直接アップロードに対応。

**エンドポイント**:
- `GET /api/scenes/:sceneId/audio-assignments` - シーンの音割当一覧（bgm + sfx[]）
- `POST /api/scenes/:sceneId/audio-assignments` - 新規割当（ライブラリから）
- `PUT /api/scenes/:sceneId/audio-assignments/:id` - 割当設定更新
- `DELETE /api/scenes/:sceneId/audio-assignments/:id` - 割当削除
- `POST /api/scenes/:sceneId/audio-assignments/direct` - 直接アップロード＆割当
- `POST /api/scenes/:sceneId/audio-assignments/deactivate-all` - 全音割当を無効化

**ライブラリタイプ**:
- `system`: system_audio_library（管理者登録）
- `user`: user_audio_library（ユーザー登録）
- `direct`: 直接アップロード（ライブラリ未登録）

**ルール**:
- BGM: 1シーン最大1つ（新規追加時は既存を自動無効化）
- SFX: 1シーンに複数可能（start_msでタイミング指定）

**リクエスト例（ライブラリから割当）**:
```json
POST /api/scenes/123/audio-assignments
{
  "audio_library_type": "user",
  "user_audio_id": 5,
  "audio_type": "bgm",
  "volume_override": 0.3
}
```

**レスポンス例**:
```json
{
  "scene_id": 123,
  "bgm": {
    "id": 1,
    "audio_library_type": "user",
    "audio_type": "bgm",
    "library": {
      "type": "user",
      "id": 5,
      "name": "Calm Piano",
      "r2_url": "https://...",
      "duration_ms": 120000,
      "default_volume": 0.25
    },
    "effective": {
      "r2_url": "https://...",
      "name": "Calm Piano",
      "volume": 0.3,
      "loop": true
    }
  },
  "sfx": [],
  "total": 1
}
```

### P3: BGM/SFXライブラリUI（実装完了）

シーン編集モーダルでBGM/SFXをライブラリから選択またはアップロードする機能。

**BGMタブの機能**:
1. **システムBGM選択**: 管理者登録のBGMライブラリから選択
2. **マイBGM選択**: ユーザー自身がアップロードしたBGMライブラリから選択
3. **アップロード**: 新しいBGMファイルを直接アップロード（最大50MB）
4. **設定変更**: 音量・ループの調整
5. **削除**: 割当解除

**SFXタブの機能**:
1. **システムSFX選択**: 管理者登録のSFXライブラリから選択
2. **マイSFX選択**: ユーザー自身がアップロードしたSFXライブラリから選択
3. **アップロード**: 新しいSFXファイルを直接アップロード（最大10MB）
4. **設定変更**: 開始時間、音量、ループの調整
5. **複数追加可能**: 1シーンに複数のSFXを設定可能

**アップロード仕様**:
| 項目 | BGM | SFX |
|------|-----|-----|
| 最大サイズ | 50MB | 10MB |
| 対応形式 | MP3, WAV, M4A, OGG | MP3, WAV, M4A, OGG |
| デフォルト音量 | 0.25 | 0.8 |
| ループ | デフォルトON | デフォルトOFF |

### P4: シーン別BGM選択モーダル（P3に統合済み）

シーン編集モーダルのBGMタブ内にライブラリモーダルを統合。

### P5: 動画ビルドでscene_audio_assignmentsを優先取得（実装完了）

`video-generation.ts`でprojectJson生成時にscene_audio_assignmentsからシーン別BGMを取得。

### P6: Remotionでシーン別BGM再生（実装完了）

- **Scene.tsx**: シーン別BGMがあれば優先再生
- **RilarcVideo.tsx**: シーン別BGM再生中は全体BGMを0.12（ダッキング）

### 依存関係図（BGM/SFXデータフロー）

```
┌─────────────────────────────────────────────────────────────────┐
│ 管理者画面                                                        │
│ /admin                                                          │
│ ┌─────────────────────────────────┐                             │
│ │ system_audio_library            │                             │
│ │ - BGM（音楽）                    │                             │
│ │ - SFX（効果音）                  │                             │
│ │ ※管理者がSunoAI等で作成してURLで登録│                             │
│ └─────────────────────────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
                       │
                       ▼ /api/audio-library/system
┌─────────────────────────────────────────────────────────────────┐
│ ユーザー画面                                                      │
│ /projects/:id                                                   │
│                                                                 │
│ ┌─────────────────────────────────┐                             │
│ │ user_audio_library              │ ← /api/audio-library/user   │
│ │ - ユーザーがアップロードしたBGM/SFX │                             │
│ │ - プロジェクト横断で再利用可能     │                             │
│ └─────────────────────────────────┘                             │
│                       │                                         │
│                       ▼ POST /api/scenes/:id/audio-assignments  │
│ ┌─────────────────────────────────┐                             │
│ │ scene_audio_assignments (SSOT)  │                             │
│ │ - シーン毎のBGM/SFX割当          │                             │
│ │ - audio_library_type: system/user/direct                      │
│ │ - volume_override, loop_override │                             │
│ └─────────────────────────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
                       │
                       ▼ /api/projects/:id/video-build/start
┌─────────────────────────────────────────────────────────────────┐
│ 動画生成 (Remotion)                                              │
│                                                                 │
│ projectJson.scenes[].bgm ← scene_audio_assignments から取得      │
│ projectJson.assets.bgm  ← project_audio_tracks から取得（全体BGM） │
│                                                                 │
│ ┌─────────────────────────────────┐                             │
│ │ 再生ルール                       │                             │
│ │ 1. シーン別BGM優先              │                             │
│ │ 2. シーン別BGM再生中は全体BGMをダック（0.12）                    │
│ │ 3. シーン別BGMなしの場合は全体BGMを通常再生                      │
│ └─────────────────────────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

### Gitコミット
```
a500998 P0: Add SFX playback support to Remotion + Audio library schema
acee3aa P1/P2: User Audio Library & Scene Audio Assignments API
c6b5ad9 P3: シーンカードUI改善 - BGM/SFX詳細表示とSceneEditModalへのリンク
285e77d P6: Remotionでシーン別BGM再生と全体BGMのduck処理を実装
ed49664 P5: シーン別BGMを新SSOT優先で取得・projectJsonに反映
d47dfa0 P3-5: SceneEditModal.open(source)でチャット修正ボタンの表示をSSOT化
33254e2 P3: BGM/SFXライブラリAPI追加とSFXタブのUI改善
```

---

## 2026-02-05 SSOT整合 & 一括音声生成機能

### 概要
SFX/音声生成のSSOT整合確認と、一括音声生成機能（Step3）の完全実装。

### Step1: 画像プロンプト途切れ修正
**問題**: formatting.ts の `max_tokens: 100` が原因で画像プロンプトが途中で切れる
**修正**: max_tokens を 100 → 500 に変更、生成後の短文ガード（30文字未満は再生成扱い）を追加
**ファイル**: `src/routes/formatting.ts`

### Step2: ナレーション音声SSOT化
**問題**: utterances.ts でナレーション voice がハードコード（ja-JP-Neural2-B）
**修正**: `projects.settings_json.default_narration_voice` を導入

**音声決定ロジックの優先順位（SSOT）**:
1. dialogue + character_key → `project_character_models.voice_preset_id`
2. narration → `projects.settings_json.default_narration_voice`
3. fallback → `ja-JP-Neural2-B`

**新規API**:
- `PUT /api/projects/:id/narration-voice` - デフォルトナレーション音声を設定

### Step3: 一括音声生成機能

#### PR1: project_audio_jobs テーブル（マイグレーション 0049）
```sql
project_audio_jobs
├── id, project_id, mode, force_regenerate
├── status ('queued' | 'running' | 'completed' | 'failed' | 'canceled')
├── total_utterances, processed_utterances, success_count, failed_count, skipped_count
├── last_error, error_details_json
├── locked_until (スタック回復用)
└── created_at, started_at, completed_at, updated_at
```

#### PR2: Bulk実行エンジン（API + waitUntil）
**API**:
- `POST /api/projects/:projectId/audio/bulk-generate` - ジョブ開始
  - `mode`: missing（デフォルト）, pending, all
  - `force_regenerate`: false（デフォルト）
  - 202 レスポンスで job_id を返却
- `GET /api/projects/:projectId/audio/bulk-status` - ジョブ状態取得
  - 進捗: total, processed, success, failed, skipped
  - エラー詳細: error_details（最大50件保存）
- `POST /api/projects/:projectId/audio/bulk-cancel` - ジョブキャンセル
- `GET /api/projects/:projectId/audio/bulk-history` - ジョブ履歴

**設計方針（ユーザー確認済み）**:
- 単位: utterance（発話）レベル
- 失敗時: 最後まで走らせて、最終的にまとめて報告
- デフォルト: 未生成のみ（forceは明示操作のみ）
- 並列度: 2（レート制限対策）

#### PR3: フロントエンドUI
**変更点**:
- クライアント側ループ → バックエンドAPI呼び出しに置換
- 2秒ごとのポーリングで進捗表示
- ページリロード時に実行中ジョブがあれば自動再開
- キャンセル機能追加

#### PR4: 運用ガード（スタック検知・audit_logs）
**Admin API**:
- `POST /api/admin/cron/cleanup-stuck-audio-jobs` - 30分以上stuck のジョブを自動キャンセル
- `GET /api/admin/stuck-audio-jobs` - stuck ジョブ一覧

**Audit Logging**:
- ジョブ完了時に `api_usage_logs` へ記録（api_type: 'bulk_audio_generation'）
- メタデータ: job_id, mode, counts, narration_voice 等

### Veo3 コスト修正
**問題**: Veo3のコスト推定値が $0.35/秒（Veo2と同じ）のまま
**修正**: Veo3は $0.50/秒（audio off）、$0.75/秒（audio on - 将来対応）
**ファイル**: `src/routes/video-generation.ts`

### AWS Cost Explorer & Cloudflare Analytics 統合
**追加ファイル**: `src/utils/infrastructure-cost.ts`

**機能**:
- AWS Cost Explorer API でLambda/S3/Data Transfer実コストを取得
- Cloudflare GraphQL Analytics API でWorkers/R2/D1メトリクスを取得
- Admin UIに「インフラコスト」タブを追加

**必要な環境変数**:
- `CF_ACCOUNT_ID`: Cloudflare Account ID
- `CF_API_TOKEN`: Cloudflare API Token（Analytics Read権限）

### Gitコミット
```
61b296b fix: update Veo 3 cost estimation to $0.50/sec
f98334e feat: add AWS Cost Explorer and Cloudflare Analytics integration
9cccf04 feat: implement bulk audio generation API (Step3-PR2)
b83b62d feat: update frontend to use bulk-audio API (Step3-PR3)
75493ca feat: add stuck audio job detection and audit logging (Step3-PR4)
```

---

## 2026-02-07 音声同期修正 & MP3 Duration正確化

### 問題
- **動画終了後の黒画面**: 動画が5秒でも音声が9.888秒の場合、動画終了後に黒画面が表示されていた
- **音声途中切れ**: DB上の`duration_ms`が実際のMP3ファイルの長さと異なっていた（6890ms vs 9888ms）
- **モーションプリセット不足**: UIで選択できるモーションが3種類のみだった

### 修正内容

#### 1. 動画終了後のサムネイル表示
**ファイル**: `video-build-remotion/src/components/Scene.tsx`
- 動画終了後は`thumbnail_url`（元の画像）を表示するよう変更
- `shouldFreezeLastFrame`フラグで動画モードと画像モードを切り替え

#### 2. MP3 Duration正確化
**新規ファイル**: `src/utils/mp3-duration.ts`
- MP3ヘッダー解析によるビットレート取得
- VBR/CBR両対応
- フレーム解析による正確なduration計算

**修正ファイル**: `src/routes/audio-generation.ts`, `src/routes/bulk-audio.ts`
- 従来: `bytesLength / 16000 * 1000`（推定）
- 改善: `calculateMP3Duration(audioBuffer)`（正確）

#### 3. モーションプリセット追加
**ファイル**: `public/static/project-editor.js`
- 3種類 → 17種類に拡張
- slide_* / pan_* / hold_then_* / combined_* / auto を追加

### Gitコミット
```
50911cf fix: Accurate MP3 duration parsing for audio files
6a5a302 fix: Video freeze shows thumbnail instead of black screen, add more motion presets to UI
28d7724 chore: Update deployment-info.json with video freeze feature
144081f fix: Freeze video at last frame when audio is longer than video
```

---

## 2026-02-08 モーション全プリセット対応 + 全シーン一括適用

### 概要
画像100枚規模の動画で、各シーンのモーション（カメラの動き）をランダムまたは一括で設定できるよう機能を拡張。シーン編集・Video Build・チャットすべてのパスで20種類のプリセットをフルサポート。

### Phase A: 全プリセット対応

#### A-1: DB マイグレーション（0038_add_motion_presets_full.sql）
- `motion_presets` テーブルに残り13種類を追加（合計20種類）
- `motion_type` の CHECK制約に `hold_then_pan` を追加
- slide系 / hold_then_slide系 / combined_zoom_pan系 / auto を網羅

#### A-2: ビルダーUI拡張（project-editor.js）
- シーンカードの `motionLabels` を7種 → 20種に拡張
- 各プリセットにアイコン・日本語ラベル・ツールチップを設定

#### A-3: チャット対応拡張（patches.ts, project-editor.js, index.tsx）
- `motion.set_preset` のテンプレートボタンを全プリセット分追加（6グループ）
- ローカルパーサーの `motionPresetMap` を全20種に拡張
- Geminiパーサーのスキーマに全 preset_id を列挙
- `resolveIntentToOps` の motion.set_preset ハンドラーで全ID対応

### Phase B: 全シーン一括適用

#### B-1: バルクAPIエンドポイント
```
POST /api/projects/:id/motion/bulk
Body: {
  "mode": "uniform" | "random" | "auto",
  "preset_id": "kenburns_soft"  // mode=uniform の場合のみ
}
```
- `uniform`: 全シーンに同じプリセットを一括適用
- `random`: 各シーンに AUTO_MOTION_CANDIDATES（9候補）からランダム割当
- `auto`: 各シーンに `auto` プリセットを設定（seed で再現性あり）
- レスポンス: 更新件数、mode、各シーンの適用結果

#### B-2: Video Build UI 拡張
- モーションセレクトの下に「全シーンに適用」ボタンを追加
- `applyMotionToAllScenes()` 関数で bulk API を呼び出し
- 確認ダイアログ付き、進捗表示あり

#### B-3: チャットコマンド対応
- `motion.set_preset_bulk` アクション追加
- インターフェース: `{ action, mode, preset_id? }`
- `ALLOWED_CHAT_ACTIONS` に追加
- ローカルパーサー: 「全シーン」「ランダム」「自動」キーワード検出
- Geminiパーサー: スキーマ + 会話例追加
- `generateDiffSummary` で一括変更のサマリ表示

### 変更ファイル一覧
| ファイル | 変更内容 |
|---------|---------|
| `migrations/0038_add_motion_presets_full.sql` | 13プリセット追加 + CHECK制約拡張 |
| `public/static/project-editor.js` | motionLabels 20種 + applyMotionToAllScenes() |
| `src/index.tsx` | テンプレートボタン追加 + 全シーン適用ボタン |
| `src/routes/projects.ts` | `POST /:id/motion/bulk` エンドポイント追加 |
| `src/routes/patches.ts` | motion.set_preset_bulk 対応 + パーサー拡張 |

### Gitコミット
```
2919ffd Phase A+B: モーション全プリセット対応 + 全シーン一括適用
```

---

## 🔄 再開方法（サンドボックス復旧手順）

### 前提条件
- GitHub: https://github.com/matiuskuma2/webapp
- 本番URL: https://webapp-c7n.pages.dev
- AWS Remotion Lambda: ap-northeast-1 (rilarc-video-build)

### 手順

#### 1. リポジトリのクローン
```bash
cd /home/user
git clone https://github.com/matiuskuma2/webapp.git
cd webapp
```

#### 2. 依存関係のインストール
```bash
# メインアプリ
npm install

# Remotionプロジェクト（動画生成が必要な場合）
cd video-build-remotion && npm install && cd ..
```

#### 3. 環境変数の設定（必要に応じて）
```bash
# Cloudflare認証（デプロイ時）
# → setup_cloudflare_api_key ツールを使用

# GitHub認証（Push時）
# → setup_github_environment ツールを使用

# AWS認証（Remotion Lambda）
export AWS_ACCESS_KEY_ID="your-key"
export AWS_SECRET_ACCESS_KEY="your-secret"
export AWS_REGION="ap-northeast-1"
```

#### 4. ビルド & デプロイ
```bash
# Cloudflare Pages
npm run build
npx wrangler pages deploy dist --project-name webapp-c7n

# Remotion Lambda（変更がある場合）
cd video-build-remotion
npm run build
npx remotion lambda sites create --site-name=rilarc-video-build --region=ap-northeast-1
```

#### 5. ローカル開発サーバー
```bash
npm run build
pm2 start ecosystem.config.cjs
curl http://localhost:3000
```

### 重要なパス
| 項目 | パス |
|------|------|
| メインアプリ | `/home/user/webapp/` |
| Remotionプロジェクト | `/home/user/webapp/video-build-remotion/` |
| MP3 Duration計算 | `src/utils/mp3-duration.ts` |
| 音声生成API | `src/routes/audio-generation.ts` |
| 動画ビルドAPI | `src/routes/video-generation.ts` |
| フロントエンド | `public/static/project-editor.js` |

### 既知の課題（進行中）
1. **音声途中切れ**: Scene 1338のduration修正済み（9888ms）、他シーンは再生成で修正
2. **進捗時間表示**: 99%表示時の残り時間計算ロジックの改善が必要
3. ~~**モーション自動適用**~~: ✅ 解決済み（Phase A+B: 全20プリセット対応、一括適用API、チャットコマンド対応）

---

