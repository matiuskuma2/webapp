# RILARC Scenario Generator - webapp

## プロジェクト概要
音声・テキスト入力から、YouTube/TikTok向けの構造化シナリオ（タイトル・セリフ・画像）を自動生成するWebアプリケーション。

- **プロジェクト名**: webapp
- **テクノロジー**: Hono + Cloudflare Pages/Workers + D1 Database + R2 Storage
- **本番URL**: https://152567a4.webapp-c7n.pages.dev
- **GitHub**: https://github.com/your-org/webapp

---

## 主要機能

### 1. 入力対応
- **音声入力**: MP3/WAV/M4A/OGG/WebM（最大25MB）
- **テキスト入力**: 直接テキストを貼り付け（最大制限なし）

### 2. 自動処理パイプライン
1. **Parse**: 長文を意味単位（500-1500文字）のチャンクに分割
2. **Format**: 各チャンクをOpenAI GPT-4oでシナリオ化
3. **Image Generation**: Gemini APIで各シーンの画像生成
4. **Export**: 画像ZIP、セリフCSV、全ファイルZIPをダウンロード

### 3. スタイルプリセット機能
- プロジェクト全体のデフォルトスタイルを設定
- シーン単位でスタイルを個別上書き可能
- 画像生成時に `prefix + prompt + suffix` の形式で適用
- デフォルトプリセット: 日本アニメ風、インフォマーシャル風、シネマ調

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
- **Google Gemini**: 画像生成

---

## ドキュメント

詳細なドキュメントは `docs/` フォルダを参照してください:

- **00_INDEX.md**: ドキュメント索引
- **04_DB_SCHEMA.md**: データベーススキーマ完全版
- **05_API_SPEC.md**: APIエンドポイント仕様
- **09_AI_DEV_RULES.md**: AI開発者向けルール

---

## ライセンス
Proprietary - All rights reserved

---

最終更新: 2025-01-19
