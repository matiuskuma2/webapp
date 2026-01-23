# RILARC Scenario Generator - webapp

## プロジェクト概要
音声・テキスト入力から、YouTube/TikTok向けの構造化シナリオ（タイトル・セリフ・画像・漫画・動画）を自動生成するWebアプリケーション。

- **プロジェクト名**: webapp
- **テクノロジー**: Hono + Cloudflare Pages/Workers + D1 Database + R2 Storage
- **本番URL**: https://webapp-c7n.pages.dev
- **GitHub**: https://github.com/matiuskuma2/webapp
- **最終更新**: 2026-01-23（R3-B SFX + R4 SSOT Patch API + apply後自動ビルド生成）

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

最終更新: 2026-01-20

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

#### 手動実行
```bash
curl -X POST \
  -H "X-Cron-Secret: your-secret" \
  "https://webapp-c7n.pages.dev/api/admin/cron/collect-render-logs"
```

### SuperAdmin UI
管理画面 → コスト管理 → オペレーション使用量:
- オペレーション種別ごとのカード表示（リクエスト数、推定コスト）
- ユニークプロジェクト数/ユーザー数
- 最近のオペレーション一覧

### マイグレーション
- `0034_add_video_builds_render_usage_logged.sql` - 二重計上防止フラグ

---

