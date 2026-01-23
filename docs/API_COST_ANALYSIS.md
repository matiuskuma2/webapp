# API コスト分析ドキュメント

**最終更新**: 2026-01-23
**対象システム**: RILARC Scenario Generator (webapp)

---

## 1. エグゼクティブサマリー

### コスト負担者の分類

| 分類 | 説明 | 対象API |
|------|------|---------|
| **システム負担** | `wrangler.jsonc` の環境変数で設定されたAPIキーを使用。運営側が全コストを負担 | シーン画像生成、音声生成（TTS）、LLM（シナリオ生成） |
| **ユーザー負担** | ユーザーが自分で登録したAPIキーを使用 | 動画生成（Veo2/Veo3）、キャラクター画像生成（フォールバック時を除く） |
| **スポンサー負担** | `api_sponsor_id` が設定されているユーザーの操作。スポンサー（通常superadmin）のキーを使用 | 動画生成（スポンサー設定時） |

---

## 2. API別詳細分析

### 2.1 画像生成 (Gemini Image)

#### シーン画像生成
- **エンドポイント**: `POST /api/projects/:id/generate-images`, `POST /api/scenes/:id/generate-image`
- **ソースファイル**: `src/routes/image-generation.ts`
- **使用モデル**: `gemini-3-pro-image-preview`
- **APIキー**: `c.env.GEMINI_API_KEY` (システム環境変数)
- **コスト負担**: **システム（運営）**

```typescript
// image-generation.ts:160-166
const imageResult = await generateImageWithRetry(
  finalPrompt,
  c.env.GEMINI_API_KEY,  // ← システムのGEMINI_API_KEY
  3,
  referenceImages,
  isPromptCustomized
)
```

#### キャラクタープレビュー画像生成
- **エンドポイント**: `POST /api/projects/:projectId/characters/generate-preview`
- **ソースファイル**: `src/routes/character-models.ts`
- **使用モデル**: `gemini-3-pro-image-preview`
- **APIキー選択ロジック**:
  1. ユーザーの `user_api_keys` テーブルから `provider='google'` を検索
  2. 見つかれば復号して使用（**ユーザー負担**）
  3. 見つからなければ `c.env.GEMINI_API_KEY` を使用（**システム負担**）
- **コスト負担**: **ユーザー（優先）→ システム（フォールバック）**

```typescript
// character-models.ts:766-795
let apiKey: string | null = null;

// Try to get from user settings
if (sessionId) {
  const keyRecord = await c.env.DB.prepare(`
    SELECT encrypted_key FROM user_api_keys
    WHERE user_id = ? AND provider = 'google'
  `).bind(session.user_id).first();
  
  if (keyRecord?.encrypted_key) {
    apiKey = await decryptApiKey(keyRecord.encrypted_key, c.env.ENCRYPTION_KEY);
  }
}

// Fallback to environment variable
if (!apiKey) {
  apiKey = c.env.GOOGLE_API_KEY || c.env.GEMINI_API_KEY;
}
```

**⚠️ 重要**: キャラクター画像生成でエラー「Quota exceeded」が発生した場合、これはシステムのGemini APIキーの無料枠が超過した可能性があります。ユーザーにAPIキーを登録してもらうことで、システムキーの使用を避けられます。

---

### 2.2 動画生成 (Google Veo2/Veo3)

- **エンドポイント**: `POST /api/scenes/:sceneId/generate-video`
- **ソースファイル**: `src/routes/video-generation.ts`
- **使用モデル**: `veo-2.0-generate-001`, `veo-3.0-generate-preview`
- **プロキシ経由**: AWS API Gateway (SigV4署名)

#### APIキー選択ロジック（SSOT）

```
【優先順位】
1. 実行者が superadmin → superadminのAPIキー or システムGEMINI_API_KEY
2. ターゲットユーザーに api_sponsor_id がある → スポンサーのAPIキー
3. それ以外 → ユーザー自身のAPIキー（必須）
```

```typescript
// video-generation.ts:446-462
if (isSuperadmin) {
  // Priority 1: Superadmin操作 → 必ず sponsor（運営キー使用）
  billingSource = 'sponsor';
  sponsorUserId = loggedInUserId;
} else {
  // Priority 2/3: 通常ユーザー → users.api_sponsor_id を確認
  const billingInfo = await determineBillingSource(
    c.env.DB, scene.project_id, scene.owner_user_id
  );
  billingSource = billingInfo.billingSource;
  sponsorUserId = billingInfo.sponsorUserId;
}
```

#### コスト負担パターン

| 実行者 | ユーザーの `api_sponsor_id` | コスト負担 |
|--------|---------------------------|-----------|
| superadmin | - | **スポンサー (superadmin)** |
| 一般ユーザー | NULL | **ユーザー自身** |
| 一般ユーザー | 設定あり | **スポンサー** |

#### 推定コスト
- **Veo2**: 約 $0.35/秒 (5秒動画 = $1.75)
- **Veo3**: 約 $0.35/秒 (8秒動画 = $2.80)

---

### 2.3 音声生成 (TTS)

- **エンドポイント**: `POST /api/scenes/:id/generate-audio`
- **ソースファイル**: `src/routes/audio-generation.ts`
- **対応プロバイダー**: Google TTS, Fish Audio, ElevenLabs

#### APIキー

| プロバイダー | 環境変数 | コスト負担 |
|------------|---------|-----------|
| Google TTS | `GOOGLE_TTS_API_KEY` or `GEMINI_API_KEY` | **システム** |
| Fish Audio | `FISH_AUDIO_API_TOKEN` | **システム** |
| ElevenLabs | `ELEVENLABS_API_KEY` | **システム** |

```typescript
// audio-generation.ts:128-140
if (provider === 'fish' && !c.env.FISH_AUDIO_API_TOKEN) {
  return c.json(createErrorResponse(...), 500);
}
const googleTtsKey = c.env.GOOGLE_TTS_API_KEY || c.env.GEMINI_API_KEY;
if (provider === 'google' && !googleTtsKey) {
  return c.json(createErrorResponse(...), 500);
}
if (provider === 'elevenlabs' && !c.env.ELEVENLABS_API_KEY) {
  return c.json(createErrorResponse(...), 500);
}
```

#### 推定コスト
- **Google TTS (WaveNet)**: $16/100万文字
- **Google TTS (Standard)**: $4/100万文字
- **Fish Audio**: $0.015/1000文字
- **ElevenLabs**: $0.24/1000文字

---

### 2.4 LLM (シナリオ生成)

- **エンドポイント**: `POST /api/runs/:runId/format`
- **ソースファイル**: `src/routes/runs-v2.ts`
- **使用モデル**: `gpt-4o-mini`
- **APIキー**: `c.env.OPENAI_API_KEY` (システム環境変数)
- **コスト負担**: **システム（運営）**

```typescript
// runs-v2.ts:305-348
async function generateScenesFromChunk(text: string, apiKey: string) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,  // ← c.env.OPENAI_API_KEY
      ...
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      ...
    })
  })
}
```

#### 推定コスト
- **gpt-4o-mini**: 入力 $0.15/100万トークン, 出力 $0.60/100万トークン

---

### 2.5 動画ビルド (Remotion Lambda)

- **エンドポイント**: `POST /api/projects/:projectId/video-builds`
- **ソースファイル**: `src/routes/video-generation.ts`, `src/utils/aws-video-build-client.ts`
- **処理**: AWS Lambda + Remotion でシーンを合成して最終動画を出力
- **コスト負担**: **AWS課金（サーバー運営費）**

```typescript
// video-generation.ts:170-179
function estimateRemotionBuildCost(totalDurationSec: number, sceneCount: number): number {
  const baseCost = 0.005;
  const perSecondCost = 0.001;
  return baseCost + (totalDurationSec * perSecondCost);
}
```

#### 推定コスト
- **基本**: $0.005/レンダー
- **出力秒数**: $0.001/秒
- **30秒動画の例**: 約 $0.035

---

## 3. データベーステーブル

### user_api_keys テーブル
ユーザーごとのAPIキーを暗号化して保存。

```sql
CREATE TABLE user_api_keys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,           -- 'google', 'gemini', 'vertex', 'openai'
  encrypted_key TEXT NOT NULL,      -- AES-256-GCM で暗号化
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, provider)
);
```

### users テーブル（スポンサー関連）

```sql
-- スポンサー設定
api_sponsor_id INTEGER,        -- このユーザーのAPI使用をスポンサーするユーザーID
video_build_sponsor_id INTEGER -- 動画ビルドのスポンサー
```

### tts_usage_logs テーブル
TTS使用量を記録（コスト追跡用）。

```sql
CREATE TABLE tts_usage_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  project_id INTEGER,
  scene_id INTEGER,
  character_key TEXT,
  provider TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  model TEXT,
  text_length INTEGER NOT NULL,
  audio_duration_ms INTEGER,
  audio_bytes INTEGER,
  estimated_cost_usd REAL,
  billing_unit TEXT,
  billing_amount INTEGER,
  status TEXT NOT NULL,        -- 'success', 'failed', 'cached'
  cache_hit INTEGER DEFAULT 0,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 4. 環境変数一覧

`wrangler.jsonc` で設定するシステムAPIキー:

| 変数名 | 用途 | コスト発生 |
|--------|------|-----------|
| `OPENAI_API_KEY` | LLMシナリオ生成 (gpt-4o-mini) | 高 |
| `GEMINI_API_KEY` | 画像生成、TTS (フォールバック) | 高 |
| `GOOGLE_TTS_API_KEY` | Google TTS (優先) | 中 |
| `FISH_AUDIO_API_TOKEN` | Fish Audio TTS | 低 |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS | 高 |
| `AWS_ACCESS_KEY_ID` | 動画プロキシ/Remotion Lambda | AWS従量 |
| `AWS_SECRET_ACCESS_KEY` | 動画プロキシ/Remotion Lambda | AWS従量 |

---

## 5. コスト最適化の推奨事項

### 5.1 ユーザーへのAPIキー登録推奨

- **動画生成**: ユーザーが自分の Google AI Studio APIキーを登録しない限り利用不可（必須）
- **キャラクター画像**: ユーザーのAPIキーが優先されるため、登録を促すことでシステム負荷を軽減

### 5.2 スポンサー制度の活用

`api_sponsor_id` を設定することで、特定ユーザーの動画生成コストをスポンサーに転嫁可能。
- **用途**: デモユーザー、パートナー、テスター向け

### 5.3 TTS使用量のモニタリング

`tts_usage_logs` テーブルで使用量を追跡:

```sql
-- 日別コスト集計
SELECT 
  DATE(created_at) as date,
  provider,
  SUM(estimated_cost_usd) as total_cost
FROM tts_usage_logs
WHERE status = 'success'
GROUP BY date, provider
ORDER BY date DESC;
```

### 5.4 画像生成のバッチ処理

現在は1シーンずつ生成（`BATCH_SIZE = 1`）。API制限とコストバランスを考慮して設計済み。

---

## 6. トラブルシューティング

### 「Quota exceeded」エラー

**原因**: Gemini API の無料枠超過

**対処法**:
1. 時間を置いて再試行（無料枠はリセットされる）
2. ユーザーに自分のAPIキーを登録してもらう
3. Google Cloud Console で有料プランに切り替え

### 「No API key found」エラー

**原因**: ユーザーがAPIキーを登録していない

**対処法**:
1. `/settings` 画面でAPIキーを登録
2. スポンサー設定がある場合はスポンサーのキーが使用される

---

## 7. 監査ログ

### API使用量の確認（管理画面）

- `GET /api/admin/usage` - API使用量サマリー
- `GET /api/admin/usage/daily` - 日別使用統計
- `GET /api/admin/usage/sponsor` - スポンサー別使用量

---

## 更新履歴

| 日付 | 内容 |
|------|------|
| 2026-01-23 | 初版作成。全APIのコスト構造を分析・文書化 |
