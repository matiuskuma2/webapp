# Video Generation Architecture

## 概要

動画生成（I2V: Image-to-Video）のアーキテクチャ定義書。
技術負債防止のため、provider名・SSOT方針・データフローを明確化。

---

## 1. Provider名の統一

### user_api_keys.provider 値

| provider | 用途 | 備考 |
|----------|------|------|
| `google` | Veo2 (Gemini API) | Gemini API Key |
| `vertex` | Veo3 (Vertex AI) | Service Account JSON |
| `openai` | OpenAI関連 | Whisper, Chat API用 |

**禁止**: `gemini` は使用しない（過去に混在あり、`google`に統一）

### video_engine 値

| video_engine | Provider | Model |
|--------------|----------|-------|
| `veo2` | google | veo-2.0-generate-001 |
| `veo3` | vertex | veo-3.0-generate-preview |

---

## 2. SSOT (Single Source of Truth)

### データの権威

| データ | SSOT | 補助ストア | 更新ルール |
|--------|------|-----------|-----------|
| **ジョブ状態** | DynamoDB (rilarc-video-jobs) | D1 (video_generations) | DynamoDB更新 → D1キャッシュ更新 |
| **動画ファイル** | S3 | - | Presigned URL配信 |
| **画像ファイル** | R2 | - | 署名付きURL配信 |
| **ユーザーAPIキー** | D1 (user_api_keys) | - | AES-GCM暗号化保存 |

### ジョブ状態遷移（DynamoDB SSOT）

```
queued → processing → completed
                   ↘ failed
```

### D1キャッシュ更新タイミング

- **generate-video API**: D1に`generating`で作成、job_id保存
- **status API**: DynamoDBから取得 → D1にキャッシュ更新
- **completed時**: presigned_url をD1に保存（表示用キャッシュ）

---

## 3. 課金ソース (billing_source)

| billing_source | 説明 | APIキー取得元 |
|----------------|------|--------------|
| `user` | ユーザー自身の課金 | user_api_keys（復号必須） |
| `sponsor` | 運営負担 | system_settings or env |

### 判定ロジック

```
1. system_settings.default_sponsor_user_id があれば sponsor
2. なければ user
```

**重要**: `user` モードでAPIキー復号失敗時は **明示的エラー**（フォールバック禁止）

---

## 4. 画像URL署名

### 署名付きURL形式

```
/images/signed/{r2_key}?exp={timestamp}&sig={signature}
```

- **exp**: 有効期限（Unix timestamp）
- **sig**: HMAC-SHA256署名
- **TTL**: 10分（AWS Workerの処理時間考慮）
- **Secret**: `IMAGE_URL_SIGNING_SECRET`

### なぜ署名が必要か

- URL推測攻撃を防止
- 機微な生成画像の漏洩防止
- 外部サービス（AWS Worker）との連携を安全に

---

## 5. データフロー

### 動画生成フロー

```
[Cloudflare Worker]
    │
    ├── 1. POST /api/scenes/:sceneId/generate-video
    │   ├── billing_source判定
    │   ├── APIキー取得・復号
    │   ├── D1に video_generations 作成 (status=generating)
    │   ├── 署名付き画像URL生成
    │   └── AWS API Gateway呼び出し (start)
    │
[AWS API Gateway]
    │
    ├── 2. Lambda (start)
    │   ├── DynamoDB に job 作成
    │   └── SQS にメッセージ送信
    │
[AWS SQS → Lambda Worker]
    │
    ├── 3. Worker
    │   ├── 署名付きURLから画像取得
    │   ├── Veo2/Veo3 API呼び出し
    │   ├── S3に動画保存
    │   └── DynamoDB 更新 (completed)
    │
[Cloudflare Worker]
    │
    └── 4. GET /api/videos/:videoId/status
        ├── AWS API Gateway呼び出し (status)
        ├── Presigned URL取得
        └── D1キャッシュ更新
```

### ステータス確認フロー

```
Client → Cloudflare → AWS (DynamoDB) → Presigned URL → Client (再生)
                   ↓
              D1 (キャッシュ)
```

---

## 6. 環境変数

### Cloudflare Pages Secrets

| 変数名 | 用途 | 必須 |
|--------|------|------|
| `ENCRYPTION_KEY` | user_api_keys復号 | ✓ |
| `IMAGE_URL_SIGNING_SECRET` | 画像URL署名 | ✓ |
| `GEMINI_API_KEY` | Sponsor用Veo2キー | sponsor時のみ |
| `AWS_ACCESS_KEY_ID` | AWS API Gateway認証 | ✓ |
| `AWS_SECRET_ACCESS_KEY` | AWS API Gateway認証 | ✓ |
| `AWS_ORCH_BASE_URL` | AWS API Gatewayエンドポイント | ✓ |
| `AWS_REGION` | AWSリージョン | ✓ |

---

## 7. 禁止事項（技術負債防止）

1. **フォールバック禁止**: user課金でシステムキーを使わない
2. **provider名混在禁止**: `google`/`vertex`に統一、`gemini`禁止
3. **D1をSSOTにしない**: ジョブ状態はDynamoDBが権威
4. **公開URL禁止**: 外部サービスへは署名付きURLのみ
5. **巨大差分コミット禁止**: 機能ごとに分割コミット

---

## 8. エラーハンドリング

### Cloudflare側エラーコード

| コード | 意味 | 対応 |
|--------|------|------|
| `USER_KEY_ERROR` | ユーザーキー取得/復号失敗 | 設定ページへ誘導 |
| `SPONSOR_KEY_NOT_CONFIGURED` | Sponsorキー未設定 | サーバー設定確認 |
| `SERVER_CONFIG_ERROR` | 署名Secret未設定 | サーバー設定確認 |
| `AWS_CONFIG_ERROR` | AWS認証情報未設定 | サーバー設定確認 |
| `GENERATION_IN_PROGRESS` | 同一シーンで生成中 | 完了を待つ |

---

最終更新: 2026-01-17
