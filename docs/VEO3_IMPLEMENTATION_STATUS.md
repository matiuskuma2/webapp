# Veo3 実装状況レポート (2026-01-17)

## 📊 現状サマリー

### 実装完了度
| コンポーネント | 完了度 | 詳細 |
|---------------|--------|------|
| **AWS Lambda** | ✅ 100% | Veo2/Veo3ルーティング、Vertex AI認証、GCSダウンロード完了 |
| **D1 本番DB** | ✅ 100% | video_generations, video_builds, api_usage_logs.video_engine 存在 |
| **マイグレーション** | ⚠️ 部分的 | video関連SQLファイルがmigrations/に存在しない（本番DBには直接適用済み） |
| **Cloudflare API** | ❌ 0% | video-generation.ts が存在しない |
| **フロントエンドUI** | ❌ 0% | 動画生成モーダル未実装 |

---

## 🏗️ インフラ構成

### Cloudflare
- **Pages URL**: https://webapp-c7n.pages.dev
- **D1 Database**: webapp-production (51860cd3-bfa8-4eab-8a11-aa230adee686)
- **R2 Bucket**: webapp-audio

### AWS
- **Region**: ap-northeast-1
- **API Gateway**: sddd2nwesf.execute-api.ap-northeast-1.amazonaws.com/prod
- **Lambda Functions**:
  - rilarc-video-proxy (API Gateway統合)
  - rilarc-video-worker (SQS起動、Veo API呼び出し)
- **DynamoDB**: rilarc-video-jobs
- **S3**: rilarc-video-results

---

## 📁 コード構成

### AWS側 (aws-video-proxy/) - ✅ 完了

```
aws-video-proxy/
├── src/
│   ├── index.ts           # API Lambda エントリポイント
│   ├── worker-index.ts    # Worker Lambda エントリポイント
│   ├── types.ts           # VideoEngine, StartVideoRequest, JobItem 型定義
│   ├── handlers/
│   │   ├── start.ts       # POST /video/start - ジョブ登録
│   │   ├── status.ts      # GET /video/status/{jobId} - ステータス確認
│   │   ├── worker.ts      # SQS Worker - Veo2/Veo3ルーティング ✅ PR-4
│   │   └── generate.ts    # 旧API (非推奨)
│   ├── services/
│   │   ├── veo-generator.ts   # Veo2 (Gemini API) 生成
│   │   ├── veo3-client.ts     # Veo3 (Vertex AI) 生成 ✅ PR-4
│   │   ├── vertex-auth.ts     # SA JSON → access_token ✅ PR-4
│   │   └── gcs-download.ts    # GCS → bytes ダウンロード ✅ PR-4
│   └── utils/
│       ├── job-store.ts   # DynamoDB操作
│       ├── s3.ts          # S3アップロード、署名付きURL
│       ├── validation.ts  # リクエストバリデーション
│       └── logger.ts      # ログユーティリティ
├── package.json
├── tsconfig.json
├── deploy.sh
└── README.md
```

### Cloudflare側 (src/) - ⚠️ Video機能なし

```
src/
├── index.tsx              # メインHono App (video route なし)
├── routes/
│   ├── audio-generation.ts # 音声生成 (参考パターン)
│   ├── image-generation.ts # 画像生成 (参考パターン)
│   └── [video-generation.ts] # ❌ 存在しない → 実装必要
├── utils/
│   └── [aws-video-client.ts] # ❌ 存在しない → 実装必要
└── types/
    └── bindings.ts
```

---

## 🗄️ データベース設計

### D1本番: video_generations
```sql
CREATE TABLE video_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL DEFAULT 'google_veo',
    model TEXT,                        -- veo-2.0-generate-001 or veo-3.0-generate-preview
    status TEXT NOT NULL DEFAULT 'pending',  -- pending/generating/completed/failed
    duration_sec INTEGER NOT NULL DEFAULT 5,
    prompt TEXT,
    source_image_r2_key TEXT NOT NULL, -- 元画像のR2キー
    r2_key TEXT,                       -- 結果動画のR2キー
    r2_url TEXT,                       -- /video/{r2_key}
    error_message TEXT,
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    job_id TEXT,                       -- AWS job_id (リンク)
    FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### D1本番: api_usage_logs (video_engine追加済み)
```sql
CREATE TABLE api_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  project_id INTEGER,
  api_type TEXT NOT NULL,        -- 'video_generation' for Veo
  provider TEXT NOT NULL,        -- 'google'
  model TEXT,                    -- 'veo-2.0-...' or 'veo-3.0-...'
  video_engine TEXT,             -- 'veo2' or 'veo3' ✅ PR-2
  sponsored_by_user_id INTEGER,  -- スポンサーID
  -- ... other fields
);
```

### D1本番: user_api_keys
```sql
CREATE TABLE user_api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,        -- 'gemini' or 'vertex' ✅
    encrypted_key TEXT NOT NULL,   -- 暗号化済みキー or SA JSON
    is_active INTEGER NOT NULL DEFAULT 1,
    -- ...
    UNIQUE(user_id, provider)
);
```

---

## 📋 PR計画 (再整理版)

### PR-0: ドキュメント確定 ✅ 完了
- [x] VEO2_SUCCESS_IMPLEMENTATION.md (既存)
- [x] 14_VIDEO_I2V_PLAN.md (既存)
- [x] VEO3_IMPLEMENTATION_STATUS.md (本ドキュメント)

### PR-1: Provider抽象化 ⚠️ AWS側完了、Cloudflare側未着手
- [x] AWS: types.ts に VideoEngine 型追加
- [ ] Cloudflare: types/bindings.ts に VideoEngine 型追加

### PR-2: DB/ログ拡張 ✅ 本番DB適用済み
- [x] video_generations テーブル作成
- [x] api_usage_logs.video_engine カラム追加
- [ ] migrations/*.sql ファイル追加（復旧用）

### PR-3: 設定画面API (Vertex provider追加) ❌ 未着手
- [ ] user_api_keys で provider='vertex' サポート
- [ ] API: GET/POST /api/users/:id/api-keys
- [ ] UI: 設定画面に Vertex SA JSON 入力欄

### PR-4: Veo3対応 ⚠️ AWS側完了、Cloudflare側未着手
**AWS側 ✅ 完了:**
- [x] vertex-auth.ts: SA JSON → JWT → access_token
- [x] veo3-client.ts: Vertex AI predictLongRunning
- [x] gcs-download.ts: GCS出力 → bytes
- [x] worker.ts: Veo2/Veo3ルーティング
- [x] start.ts: video_engine判定、DDB保存

**Cloudflare側 ❌ 未着手:**
- [ ] src/routes/video-generation.ts 作成
- [ ] src/utils/aws-video-client.ts 作成
- [ ] index.tsx に route 追加

### PR-5: 動画生成モーダル ❌ 未着手
- [ ] UI: 動画生成ボタン、モーダル、進捗表示
- [ ] Veo3選択UI
- [ ] localStorage復元

### PR-6: superadminダッシュボード ❌ 未着手
- [ ] コスト分離表示 (Veo2/Veo3)
- [ ] executor別内訳

### PR-7: ガードレール ❌ 未着手
- [ ] 同時実行制限
- [ ] 日次上限
- [ ] 生成中の再生成禁止

### PR-8: 段階リリース ❌ 未着手
- [ ] FEATURE_VEO3_ENABLED
- [ ] FEATURE_VEO3_SUPERADMIN_ONLY

---

## 🔗 Cloudflare → AWS API契約

### POST /video/start
```json
{
  "project_id": 123,
  "scene_id": 456,
  "owner_user_id": 1,
  "executor_user_id": 1,
  "billing_user_id": 1,
  "billing_source": "user",
  "provider": "google",
  "model": "veo-3.0-generate-preview",
  "duration_sec": 8,
  "prompt": "Camera slowly zooms in...",
  "image_url": "https://webapp-c7n.pages.dev/images/signed/...",
  
  // Veo2用
  "video_engine": "veo2",
  "api_key": "AIza...",
  
  // OR Veo3用
  "video_engine": "veo3",
  "vertex_sa_json": "{...}",
  "vertex_project_id": "my-project",
  "vertex_location": "us-central1"
}
```

### GET /video/status/{jobId}
```json
{
  "success": true,
  "job": {
    "job_id": "uuid-...",
    "status": "completed",
    "presigned_url": "https://s3.../video.mp4?X-Amz-..."
  }
}
```

---

## 🚀 次のアクション（優先順）

1. **マイグレーションファイル作成** - video_generations, video_engine追加分をSQL化
2. **src/routes/video-generation.ts** - Cloudflare API実装
3. **src/utils/aws-video-client.ts** - AWS API呼び出しクライアント
4. **index.tsx 更新** - video route追加
5. **UI実装** - 動画生成モーダル

---

## ⚠️ 運用インシデント防止チェックリスト

- [ ] Veo2回帰テスト: 既存Veo2フローが壊れていないこと
- [ ] SA JSON セキュリティ: ログに出力しない、短TTL
- [ ] 409競合防止: 同一sceneで生成中の場合はブロック
- [ ] completed定義: r2_url必須、nullならfailedに戻す
- [ ] 画像署名URL: AWS Workerが取得できる形式 (10分TTL)

---

*最終更新: 2026-01-17*
