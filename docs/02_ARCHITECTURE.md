# アーキテクチャ仕様

## 🏗️ 採用スタック（固定・変更禁止）

### フロントエンド
- **フレームワーク**: なし（Vanilla JavaScript）
- **スタイリング**: Tailwind CSS（CDN）
- **アイコン**: Font Awesome（CDN）
- **HTTP Client**: Axios（CDN）

### バックエンド
- **フレームワーク**: Hono（Cloudflare Workers用軽量フレームワーク）
- **ランタイム**: Cloudflare Workers
- **デプロイ**: Cloudflare Pages

### データベース
- **プロバイダ**: Cloudflare D1
- **タイプ**: SQLite（グローバル分散）
- **マイグレーション**: Wrangler CLI

### ストレージ
- **プロバイダ**: Cloudflare R2
- **用途**: 音声ファイル・生成画像の保存
- **アクセス**: 署名付き一時URL（1時間有効）

---

## 🌐 外部API（固定・変更禁止）

### 1. 音声 → 文字起こし
- **プロバイダ**: OpenAI
- **API**: `POST https://api.openai.com/v1/audio/transcriptions`
- **モデル**: `whisper-1`（固定）
- **用途**: 音声ファイル → テキスト変換
- **制約**: このAPI以外で文字起こしを行わないこと

### 2. テキスト整形・シーン分割
- **プロバイダ**: OpenAI
- **API**: `POST https://api.openai.com/v1/chat/completions`
- **モデル**: `gpt-4o-mini`（固定）
- **出力形式**: JSON（`response_format: { type: "json_object" }`）
- **用途**: 文字起こしテキスト → RILARCシナリオJSON
- **制約**: このAPI・モデル以外で整形を行わないこと

### 3. 画像生成（インフォグラフィック）
- **プロバイダ**: Google Gemini
- **API**: Gemini Image Generation API
- **モデル**: 
  - 標準: `gemini-3-pro-image-preview`
  - 高速: `gemini-2.5-flash-image`（オプション）
- **用途**: シーンごとのニュース風インフォグラフィック画像生成
- **制約**: 
  - **画像生成以外でGeminiを使用しないこと**
  - テキスト生成にGeminiを使用しないこと

---

## 📐 システムアーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│                    ユーザー（ブラウザ）                   │
└─────────────────┬───────────────────────────────────────┘
                  │
                  │ HTTPS
                  ▼
┌─────────────────────────────────────────────────────────┐
│             Cloudflare Pages（静的ホスティング）           │
│  - HTML / CSS / JavaScript                              │
│  - Tailwind CSS (CDN)                                   │
└─────────────────┬───────────────────────────────────────┘
                  │
                  │ Fetch API
                  ▼
┌─────────────────────────────────────────────────────────┐
│            Cloudflare Workers（Hono App）                │
│  ┌───────────────────────────────────────────────────┐  │
│  │  API Routes                                       │  │
│  │  - POST /api/projects           （プロジェクト作成）│  │
│  │  - POST /api/projects/:id/upload（音声アップロード）│  │
│  │  - POST /api/projects/:id/transcribe（文字起こし） │  │
│  │  - POST /api/projects/:id/format（整形・分割）     │  │
│  │  - POST /api/scenes/:id/generate-image（画像生成）│  │
│  │  - POST /api/projects/:id/generate-all-images     │  │
│  │  - PUT  /api/scenes/:id/image-prompt（プロンプト編集）│  │
│  │  - GET  /api/projects                （一覧取得）  │  │
│  │  - GET  /api/projects/:id            （詳細取得）  │  │
│  │  - GET  /api/projects/:id/scenes     （シーン一覧）│  │
│  │  - GET  /api/projects/:id/download/images（画像ZIP）│  │
│  │  - GET  /api/projects/:id/download/csv（セリフCSV）│  │
│  │  - GET  /api/projects/:id/download/all（全ZIP）   │  │
│  └───────────────────────────────────────────────────┘  │
└───┬─────────────────┬─────────────────┬─────────────────┘
    │                 │                 │
    │                 │                 │
    ▼                 ▼                 ▼
┌─────────┐    ┌─────────────┐   ┌──────────────────────┐
│ D1 DB   │    │  R2 Storage │   │   External APIs      │
│ (SQLite)│    │  (S3-like)  │   │  - OpenAI Whisper    │
│         │    │             │   │  - OpenAI Chat       │
│ Tables: │    │ Buckets:    │   │  - Gemini Image Gen  │
│ - projects   │ - audio/    │   └──────────────────────┘
│ - transcriptions│ - images/ │
│ - scenes │    │             │
│ - image_generations │       │
└─────────┘    └─────────────┘
```

---

## 🔄 データフロー

### 1. アップロード → 文字起こし
```
User → Upload Audio → R2 Storage (audio/{project_id}/{filename}_{timestamp}_{random}.{ext})
  ↓
Projects Table (DB) - status: 'uploaded'
  ↓
OpenAI Whisper API
  ↓
Transcriptions Table (DB) - raw_text, language, word_count
  ↓
Projects Table (DB) - status: 'transcribed'
```

### 2. 整形 → シーン分割
```
Transcription Text (from DB)
  ↓
OpenAI Chat API (gpt-4o-mini + JSON mode)
  - System Prompt: RILARCシナリオ生成指示
  - Response Format: JSON Schema準拠
  ↓
RILARC Scenario JSON (validation)
  ↓
Scenes Table (DB) - 3〜50 scenes (トランザクション)
  ↓
Projects Table (DB) - status: 'formatted'
```

### 3. 画像生成
```
For each Scene:
  Scene.image_prompt (from DB)
    ↓
  12_IMAGE_PROMPT_TEMPLATE.md のスタイル指定を付与
    ↓
  Gemini Image Generation API
    - model: gemini-3-pro-image-preview
    - prompt: scene_prompt + style_template
    ↓
  R2 Storage (images/{scene_id}/gen_{image_generation_id}_{timestamp}.png)
    ↓
  Image_Generations Table (DB)
    - r2_key, r2_url (署名付き1時間)
    - status: 'completed'
    - is_active: 1
    ↓
  既存のアクティブ画像を無効化 (is_active = 0)
```

### 4. ダウンロード
```
User Request (GET /api/projects/:id/download/*)
  ↓
Query DB (scenes, image_generations where is_active=1)
  ↓
Fetch Images from R2 (複数画像を取得)
  ↓
Generate ZIP / CSV (メモリ内で生成)
  ↓
Return as Download (Content-Disposition: attachment)
```

---

## 🔐 環境変数

### 本番環境（Cloudflare Secrets）
```bash
OPENAI_API_KEY=sk-proj-xxxxx
GEMINI_API_KEY=AIzaSyXXXXX
```

### ローカル開発（.dev.vars）
```bash
OPENAI_API_KEY=sk-proj-xxxxx
GEMINI_API_KEY=AIzaSyXXXXX
```

---

## 🚀 デプロイメント

### ローカル開発
```bash
# D1マイグレーション（初回のみ）
cd /home/user/webapp && npx wrangler d1 migrations apply webapp-production --local

# ビルド
cd /home/user/webapp && npm run build

# 開発サーバー起動
cd /home/user/webapp && pm2 start ecosystem.config.cjs

# テスト
curl http://localhost:3000
```

### 本番デプロイ
```bash
# D1マイグレーション（初回のみ）
cd /home/user/webapp && npx wrangler d1 migrations apply webapp-production

# ビルド＆デプロイ
cd /home/user/webapp && npm run deploy

# Secrets設定（初回のみ）
cd /home/user/webapp && npx wrangler pages secret put OPENAI_API_KEY --project-name webapp
cd /home/user/webapp && npx wrangler pages secret put GEMINI_API_KEY --project-name webapp
```

---

## 📦 依存関係

### Backend（package.json）
```json
{
  "dependencies": {
    "hono": "^4.0.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "4.20250705.0",
    "@hono/vite-cloudflare-pages": "^0.4.2",
    "vite": "^5.0.0",
    "wrangler": "^3.78.0",
    "typescript": "^5.0.0"
  }
}
```

### Frontend（CDN）
- Tailwind CSS: `https://cdn.tailwindcss.com`
- Font Awesome: `https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css`
- Axios: `https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js`

---

## 🔧 Cloudflare設定（wrangler.jsonc）

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "webapp",
  "compatibility_date": "2024-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "pages_build_output_dir": "./dist",
  
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "webapp-production",
      "database_id": "your-database-id"
    }
  ],
  
  "r2_buckets": [
    {
      "binding": "R2",
      "bucket_name": "webapp-bucket"
    }
  ]
}
```

---

## ⚠️ Cloudflare Workers制限

### CPU時間制限
- 無料プラン: 10ms/リクエスト
- 有料プラン: 30ms/リクエスト
- 対処: 外部API呼び出しはCPU時間に含まれない

### 実行時制約
- ファイルシステムアクセス不可
- Node.js APIは限定的（`nodejs_compat`フラグで一部利用可）
- 同期処理のみ（非同期はPromise/async-await）

---

最終更新: 2025-01-13
