# デプロイメント手順書

このドキュメントは、サンドボックス環境がなくなっても本番環境を復元・再デプロイできるようにするための手順書です。

---

## 前提条件

### 必要なアカウント・認証情報
- **Cloudflare**: API Token（Pages/Workers/D1/R2権限）
- **AWS**: Access Key + Secret Key（Lambda/S3権限、リージョン: ap-northeast-1）
- **GitHub**: リポジトリへのpush権限

### 必要なツール
```bash
# Node.js 20+
node --version  # v20.x.x

# npm
npm --version

# Wrangler (Cloudflare CLI)
npm install -g wrangler
wrangler --version

# AWS CLI
aws --version
```

---

## アーキテクチャ概要

```
┌─────────────────────────────────────────────────────────────────┐
│  Cloudflare                                                      │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │ webapp           │  │ webapp-cron      │                     │
│  │ (Pages + D1 + R2)│  │ (Workers Cron)   │                     │
│  │                  │  │ 毎日UTC19:00     │                     │
│  │ メインアプリ     │  │ 動画30日自動削除 │                     │
│  └────────┬─────────┘  └──────────────────┘                     │
└───────────┼─────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│  AWS (ap-northeast-1)                                            │
│  ┌──────────────────┐    ┌──────────────────────────────────┐   │
│  │ API Gateway      │───▶│ rilarc-video-build-orch          │   │
│  └──────────────────┘    │ (動画ビルドオーケストレーター)    │   │
│                          └────────────────┬─────────────────┘   │
│                                           ▼                      │
│                          ┌──────────────────────────────────┐   │
│                          │ remotion-render-4-0-404-...      │   │
│                          │ (Remotion動画レンダリング)        │   │
│                          └──────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────┐    ┌──────────────────────────────────┐   │
│  │ API Gateway      │───▶│ rilarc-video-proxy               │   │
│  └──────────────────┘    │ (Google Veo APIプロキシ)          │   │
│                          └──────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. Cloudflare webapp (Pages)

### 本番URL
- https://webapp-c7n.pages.dev/

### 環境変数（Cloudflare Dashboard で設定）
| 変数名 | 説明 | 設定場所 |
|--------|------|----------|
| `OPENAI_API_KEY` | OpenAI API Key | Pages > Settings > Environment variables |
| `GEMINI_API_KEY` | Google Gemini API Key | Pages > Settings > Environment variables |
| `AWS_ACCESS_KEY_ID` | AWS Access Key | Pages > Settings > Environment variables |
| `AWS_SECRET_ACCESS_KEY` | AWS Secret Key | Pages > Settings > Environment variables |
| `AWS_REGION` | AWS Region (ap-northeast-1) | Pages > Settings > Environment variables |

### バインディング（wrangler.jsonc で設定済み）
- **D1**: `webapp-production` (ID: 51860cd3-bfa8-4eab-8a11-aa230adee686)
- **R2**: `webapp-bucket`

### デプロイ手順
```bash
# 1. リポジトリをクローン
git clone https://github.com/matiuskuma2/webapp.git
cd webapp

# 2. 依存関係インストール
npm ci

# 3. Cloudflare認証
wrangler login
# または
export CLOUDFLARE_API_TOKEN="your-api-token"

# 4. ビルド
npm run build

# 5. デプロイ
npx wrangler pages deploy dist --project-name webapp

# 6. （初回のみ）マイグレーション実行
npx wrangler d1 migrations apply webapp-production --remote
```

### 確認方法
```bash
curl -s -o /dev/null -w "%{http_code}" https://webapp-c7n.pages.dev/
# 200 が返ればOK
```

---

## 2. Cloudflare webapp-cron (Workers Cron)

### 本番URL
- https://webapp-cron.polished-disk-21bf.workers.dev

### スケジュール
- `0 19 * * *` (UTC 19:00 = JST 04:00、毎日実行)

### バインディング（wrangler.toml で設定済み）
- **D1**: `webapp-production` (ID: 51860cd3-bfa8-4eab-8a11-aa230adee686)
- **R2**: `webapp-bucket`

### デプロイ手順
```bash
cd webapp-cron

# 1. 依存関係インストール
npm ci

# 2. Cloudflare認証（親ディレクトリで実行済みなら不要）
wrangler login

# 3. デプロイ
npx wrangler deploy --config wrangler.toml
```

### 確認方法
```bash
# Cloudflare Dashboardでcron実行ログを確認
# または手動トリガー
curl -X POST https://webapp-cron.polished-disk-21bf.workers.dev/trigger
```

---

## 3. AWS rilarc-video-build-orch (Lambda)

### 関数名
- `rilarc-video-build-orch`

### リージョン
- `ap-northeast-1`

### 環境変数（AWS Lambda Console で設定）
| 変数名 | 説明 | 値 |
|--------|------|-----|
| `AWS_REGION` | リージョン | ap-northeast-1 |
| `REMOTION_FUNCTION_NAME` | Remotion Lambda関数名 | remotion-render-4-0-404-mem2048mb-disk2048mb-240sec:live |
| `REMOTION_SERVE_URL` | RemotionサイトURL | S3のURL |
| `OUTPUT_BUCKET` | 出力バケット | rilarc-remotion-renders-prod-202601 |

### デプロイ手順
```bash
cd aws-orchestrator

# 1. 依存関係インストール
npm ci

# 2. デプロイパッケージ作成
zip -r function.zip index.mjs node_modules

# 3. Lambda更新
aws lambda update-function-code \
  --function-name rilarc-video-build-orch \
  --zip-file fileb://function.zip \
  --region ap-northeast-1

# 4. 確認
aws lambda get-function --function-name rilarc-video-build-orch --region ap-northeast-1
```

---

## 4. AWS rilarc-video-proxy (Lambda)

### 関数名
- `rilarc-video-proxy`

### リージョン
- `ap-northeast-1`

### 環境変数（AWS Lambda Console で設定）
| 変数名 | 説明 |
|--------|------|
| `GOOGLE_API_KEY` | Google Veo API Key |

### デプロイ手順
```bash
cd aws-video-proxy

# 1. 依存関係インストール
npm ci

# 2. TypeScriptビルド
npm run build

# 3. デプロイパッケージ作成
npm run package
# または手動で:
# cd dist && zip -r ../function.zip . && cd .. && zip -r function.zip node_modules

# 4. Lambda更新
aws lambda update-function-code \
  --function-name rilarc-video-proxy \
  --zip-file fileb://function.zip \
  --region ap-northeast-1
```

---

## 5. Remotion Lambda (video-build-remotion)

### 関数名
- `remotion-render-4-0-404-mem2048mb-disk2048mb-240sec`

### S3サイト
- `remotionlambda-apnortheast1-ucgr0eo7k7/sites/rilarc-video-build/`

### 環境変数（deploy.mjs内で設定）
| 変数名 | 説明 |
|--------|------|
| `AWS_ACCESS_KEY_ID` | AWS Access Key |
| `AWS_SECRET_ACCESS_KEY` | AWS Secret Key |
| `AWS_REGION` | ap-northeast-1 |
| `SITE_BUCKET` | rilarc-remotion-site-prod-202601 |
| `RENDERS_BUCKET` | rilarc-remotion-renders-prod-202601 |

### デプロイ手順
```bash
cd video-build-remotion

# 1. 依存関係インストール
npm ci

# 2. 環境変数設定
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="ap-northeast-1"

# 3. デプロイ（サイト + Lambda）
npm run deploy
```

---

## トラブルシューティング

### 本番が動かない場合のチェックリスト

1. **Cloudflare Pages**
   - Dashboard > Pages > webapp > Deployments で最新デプロイを確認
   - Functions > Logs でエラーログを確認

2. **AWS Lambda**
   ```bash
   # 関数の状態確認
   aws lambda get-function --function-name <function-name> --region ap-northeast-1
   
   # ログ確認
   aws logs tail /aws/lambda/<function-name> --region ap-northeast-1 --follow
   ```

3. **D1 Database**
   ```bash
   # テーブル一覧
   npx wrangler d1 execute webapp-production --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
   ```

### よくあるエラー

| エラー | 原因 | 対処 |
|--------|------|------|
| `CLOUDFLARE_API_TOKEN not set` | 認証切れ | `wrangler login` を再実行 |
| `Lambda function not found` | 関数名間違い | AWS Consoleで正確な名前を確認 |
| `D1 database not found` | ID間違い | wrangler.jsonc の database_id を確認 |

---

## 緊急時の連絡先

- **Cloudflare Status**: https://www.cloudflarestatus.com/
- **AWS Status**: https://status.aws.amazon.com/

---

最終更新: 2026-01-20
