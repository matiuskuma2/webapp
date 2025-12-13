# GensPark開発環境ブリーフ

## 🏗️ GensPark環境概要

GensParkは、Cloudflare Pages + Honoを使用した軽量Webアプリケーション開発に最適化された環境です。

---

## 📁 プロジェクト配置

### ディレクトリ構造
```
/home/user/webapp/
├── docs/              # ドキュメント（本フォルダ）
├── src/               # ソースコード
├── migrations/        # D1マイグレーション
├── public/            # 静的ファイル
├── .git/              # Gitリポジトリ
├── .gitignore
├── .dev.vars          # ローカル環境変数
├── wrangler.jsonc     # Cloudflare設定
├── package.json
└── README.md
```

### 重要な制約
- ✅ **すべてのコードは `/home/user/webapp/` 以下に配置**
- ✅ Bashコマンド実行時は `cd /home/user/webapp && コマンド`

---

## 🚀 開発ワークフロー

### 1. プロジェクト作成
```bash
# Honoプロジェクト作成（300s+ timeout推奨）
cd /home/user && npm create -y hono@latest webapp -- --template cloudflare-pages --install --pm npm
```

### 2. Git初期化
```bash
cd /home/user/webapp && git init
cd /home/user/webapp && git add .
cd /home/user/webapp && git commit -m "Initial commit"
```

### 3. D1データベース作成
```bash
# 本番データベース作成
cd /home/user/webapp && npx wrangler d1 create webapp-production

# database_id を wrangler.jsonc にコピー
```

### 4. R2バケット作成
```bash
cd /home/user/webapp && npx wrangler r2 bucket create webapp-bucket
```

### 5. ローカル開発
```bash
# D1マイグレーション（初回のみ）
cd /home/user/webapp && npx wrangler d1 migrations apply webapp-production --local

# ビルド
cd /home/user/webapp && npm run build

# PM2で起動
cd /home/user/webapp && pm2 start ecosystem.config.cjs

# テスト
curl http://localhost:3000

# ログ確認
pm2 logs webapp --nostream
```

### 6. 本番デプロイ
```bash
# Cloudflare認証設定（初回のみ）
# setup_cloudflare_api_key ツールを使用

# D1マイグレーション（初回のみ）
cd /home/user/webapp && npx wrangler d1 migrations apply webapp-production

# デプロイ
cd /home/user/webapp && npm run deploy
```

---

## 🔧 必須設定ファイル

### wrangler.jsonc
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
      "database_id": "your-database-id-from-wrangler-d1-create"
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

### .dev.vars（ローカル開発用）
```bash
OPENAI_API_KEY=sk-proj-xxxxx
GEMINI_API_KEY=AIzaSyXXXXX
```

### .gitignore
```
node_modules/
.dev.vars
.wrangler/
dist/
*.log
.DS_Store
```

### ecosystem.config.cjs（PM2設定）
```javascript
module.exports = {
  apps: [
    {
      name: 'webapp',
      script: 'npx',
      args: 'wrangler pages dev dist --ip 0.0.0.0 --port 3000',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
```

---

## 🔐 GitHub連携

### 1. GitHub認証設定（初回のみ）
```bash
# setup_github_environment ツールを使用
```

### 2. リポジトリ作成＆プッシュ
```bash
cd /home/user/webapp
git remote add origin https://github.com/username/webapp.git
git push -f origin main  # 初回
git push origin main     # 2回目以降
```

---

## 📊 Cloudflare連携

### 1. Cloudflare認証設定（初回のみ）
```bash
# setup_cloudflare_api_key ツールを使用
```

### 2. Secrets設定
```bash
cd /home/user/webapp && npx wrangler pages secret put OPENAI_API_KEY --project-name webapp
cd /home/user/webapp && npx wrangler pages secret put GEMINI_API_KEY --project-name webapp
```

---

## 🛠️ 便利なコマンド

### PM2管理
```bash
pm2 list                     # サービス一覧
pm2 logs webapp --nostream   # ログ確認
pm2 restart webapp           # 再起動
pm2 delete webapp            # 削除
```

### D1データベース
```bash
# ローカルDB操作
cd /home/user/webapp && npx wrangler d1 execute webapp-production --local --command="SELECT * FROM projects"

# 本番DB操作
cd /home/user/webapp && npx wrangler d1 execute webapp-production --command="SELECT * FROM projects"
```

### R2ストレージ
```bash
# バケット一覧
cd /home/user/webapp && npx wrangler r2 bucket list

# オブジェクト一覧
cd /home/user/webapp && npx wrangler r2 object list webapp-bucket
```

---

## ⚠️ よくあるエラーと対処法

### 1. "Port 3000 already in use"
```bash
cd /home/user/webapp && fuser -k 3000/tcp 2>/dev/null || true
```

### 2. "Module not found"
```bash
cd /home/user/webapp && npm install
```

### 3. "Database not found"
```bash
cd /home/user/webapp && npx wrangler d1 migrations apply webapp-production --local
```

---

最終更新: 2025-01-13
