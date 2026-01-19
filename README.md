# RILARC Scenario Generator - webapp

## プロジェクト概要
音声・テキスト入力から、YouTube/TikTok向けの構造化シナリオ（タイトル・セリフ・画像・漫画・動画）を自動生成するWebアプリケーション。

- **プロジェクト名**: webapp
- **テクノロジー**: Hono + Cloudflare Pages/Workers + D1 Database + R2 Storage
- **本番URL**: https://webapp-c7n.pages.dev
- **GitHub**: https://github.com/matiuskuma2/webapp
- **最終更新**: 2026-01-19（Scene Split無限待ちゼロ化・設計書追加）

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
- **BUTTON_PROGRESS_FIX.md**: 画像生成ボタンと進捗表示の完全修正ドキュメント ⭐ 重要

---

## ライセンス
Proprietary - All rights reserved

---

最終更新: 2026-01-19

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

