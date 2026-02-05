# Sponsor & Billing SSOT（課金・スポンサー機能の設計書）

**最終更新**: 2026-02-05

---

## 0. 概要

この文書は、まるむビAIの**課金・スポンサー機能**の設計と依存関係を定義するSSOT（Single Source of Truth）です。

### 課金モデルの種類

| 課金対象 | billing_source | 判定方法 | 課金者 |
|---------|---------------|---------|-------|
| 動画生成（シーン単位） | `user` / `sponsor` | `users.api_sponsor_id` | ユーザー本人 / スポンサー |
| Video Build（プロジェクト単位） | `platform` | なし（固定） | プラットフォーム運営 |

---

## 1. スポンサー判定 SSOT

### 1.1 データベーススキーマ（真実）

```sql
-- users テーブル
users.api_sponsor_id        -- API課金のスポンサーID（画像/音声/動画生成）
users.video_build_sponsor_id -- Video Build課金のスポンサーID（※現在未使用）
```

### 1.2 判定ロジック（優先順位）

```
┌─────────────────────────────────────────────────────────────┐
│ 1. executor が superadmin?                                  │
│    → YES: billing_source = 'sponsor', sponsorUserId = 自分  │
│                                                             │
│ 2. user.api_sponsor_id が設定されている?                     │
│    → YES: billing_source = 'sponsor',                       │
│           sponsorUserId = api_sponsor_id                    │
│                                                             │
│ 3. それ以外                                                  │
│    → billing_source = 'user', sponsorUserId = null          │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 実装関数

```typescript
// src/routes/video-generation.ts: 264-286
async function determineBillingSource(
  db: D1Database,
  projectId: number,
  userId: number
): Promise<{ billingSource: BillingSource; sponsorUserId: number | null }>
```

---

## 2. APIキー選択 SSOT

### 2.1 キー選択の優先順位

```
┌─────────────────────────────────────────────────────────────┐
│ billing_source = 'sponsor' の場合:                          │
│   1. superadmin自身のキー (getUserApiKey)                    │
│   2. sponsorUserId のキー (getUserApiKey)                   │
│   3. システム環境変数 (GEMINI_API_KEY)                       │
│   4. エラー: SPONSOR_KEY_NOT_CONFIGURED                     │
│                                                             │
│ billing_source = 'user' の場合:                             │
│   1. executorUserId のキー (getUserApiKey)                  │
│   2. エラー: USER_KEY_ERROR (redirect: /settings?focus=...) │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 プロバイダー別キー

| videoEngine | provider | キーソース |
|------------|----------|----------|
| veo2 | google | `user_api_keys.provider = 'google'` or `GEMINI_API_KEY` |
| veo3 | vertex | `user_api_keys.provider = 'vertex'` |

---

## 3. 対象API別課金フロー

### 3.1 動画生成API（シーン単位）

**エンドポイント**: `POST /api/scenes/:sceneId/generate-video`

```
フロー:
1. セッション認証 → loggedInUserId, loggedInUserRole 取得
2. シーン情報取得 → scene.owner_user_id, scene.project_id 取得
3. determineBillingSource() 呼び出し → billingSource, sponsorUserId 決定
4. APIキー取得（上記2.1の優先順位）
5. AWS Worker 呼び出し（apiKey, vertexSaJson 渡す）
6. api_usage_logs 記録:
   - user_id: owner_user_id
   - sponsored_by_user_id: billingSource='sponsor' ? billingUserId : null
   - metadata_json.billing_source: billingSource
   - metadata_json.billing_user_id: billingUserId
```

### 3.2 Video Build API（プロジェクト単位）

**エンドポイント**: `POST /api/projects/:projectId/video-builds`

```
フロー:
1. セッション認証
2. プロジェクト情報取得 → project.user_id
3. ※ スポンサー判定なし（billing_source='platform' 固定）
4. AWS Orchestrator 呼び出し
5. api_usage_logs 記録:
   - billing_source: 'platform'
   - owner_user_id: project.user_id || userId
   - executor_user_id: userId
```

**重要**: Video Build は `video_build_sponsor_id` を**使用していない**。
プラットフォーム運営が一律で負担する設計。

### 3.3 画像生成API

**エンドポイント**: `POST /api/scenes/:sceneId/generate-image`

```
スポンサー判定: users.api_sponsor_id を使用
APIキー: google (Imagen) / openai (DALL-E)
```

### 3.4 音声生成API

**エンドポイント**: `POST /api/scenes/:sceneId/generate-audio`

```
スポンサー判定: users.api_sponsor_id を使用
APIキー: elevenlabs / google-tts
```

---

## 4. データベーステーブル

### 4.1 users（スポンサー設定）

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  api_sponsor_id INTEGER,          -- APIスポンサー（使用中）
  video_build_sponsor_id INTEGER,  -- Video Buildスポンサー（未使用）
  -- ...
  FOREIGN KEY (api_sponsor_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (video_build_sponsor_id) REFERENCES users(id) ON DELETE SET NULL
);
```

### 4.2 user_api_keys（APIキー保存）

```sql
CREATE TABLE user_api_keys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,       -- 'google', 'vertex', 'openai', 'elevenlabs'
  encrypted_key TEXT NOT NULL,  -- 暗号化済みキー
  is_active INTEGER DEFAULT 1,
  UNIQUE(user_id, provider)
);
```

### 4.3 api_usage_logs（課金ログ）

```sql
CREATE TABLE api_usage_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,              -- 対象ユーザー（プロジェクトオーナー）
  project_id INTEGER,
  api_type TEXT,                -- 'video_generation', 'video_build', 'image_generation', 'audio_generation'
  provider TEXT,                -- 'google', 'vertex', 'remotion-lambda'
  sponsored_by_user_id INTEGER, -- スポンサー課金時のみ（billing_source='sponsor'）
  estimated_cost_usd REAL,
  metadata_json TEXT            -- { billing_source, billing_user_id, executor_user_id, ... }
);
```

---

## 5. 管理画面からのスポンサー設定

### 5.1 スポンサー設定トグル

**エンドポイント**: `POST /api/admin/users/:id/sponsor`

```typescript
// src/routes/admin.ts
// 現在のスポンサー状態を取得して反転
const newSponsorId = targetUser.api_sponsor_id ? null : user.id;

// UPDATE users SET api_sponsor_id = ? WHERE id = ?
```

**UI**: 管理画面でユーザー一覧から「スポンサー有効/無効」をトグル

### 5.2 表示される情報

```
GET /api/admin/users
→ { users: [{ id, email, api_sponsor_id, video_build_sponsor_id, ... }] }
```

---

## 6. フロントエンドからの参照

### 6.1 認証状態

```typescript
// GET /api/auth/me
{
  authenticated: true,
  user: {
    id: 1,
    api_sponsor_id: 2,           // スポンサーされている場合
    video_build_sponsor_id: null, // 未使用だが返却はされる
    // ...
  }
}
```

### 6.2 UI表示

- `api_sponsor_id` がある → 「スポンサー対象」バッジ表示
- APIキー設定画面でスポンサー状態を表示

---

## 7. 依存関係マップ

```
┌─────────────────────────────────────────────────────────────┐
│                     スポンサー機能                          │
├─────────────────────────────────────────────────────────────┤
│ DB                                                          │
│   users.api_sponsor_id        ←── SSOT                     │
│   users.video_build_sponsor_id ←── 未使用                  │
│   user_api_keys.encrypted_key ←── 暗号化済みAPIキー        │
│   api_usage_logs              ←── 課金ログ                 │
├─────────────────────────────────────────────────────────────┤
│ API                                                         │
│   determineBillingSource()    ←── スポンサー判定            │
│   getUserApiKey()             ←── キー取得・復号            │
│                                                             │
│   POST /api/scenes/:id/generate-video                       │
│     └── billingSource = 'user' | 'sponsor'                 │
│                                                             │
│   POST /api/projects/:id/video-builds                       │
│     └── billingSource = 'platform' (固定)                  │
├─────────────────────────────────────────────────────────────┤
│ 管理画面                                                    │
│   POST /api/admin/users/:id/sponsor                         │
│     └── api_sponsor_id トグル                              │
├─────────────────────────────────────────────────────────────┤
│ フロントエンド                                              │
│   GET /api/auth/me                                          │
│     └── user.api_sponsor_id 表示                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 8. 廃止された機能

### 8.1 system_settings.default_sponsor_user_id

**廃止理由**: 全ユーザーが自動的にスポンサー化される事故を防止

```typescript
// ※ system_settings.default_sponsor_user_id は廃止（全員スポンサー化の事故防止）
```

### 8.2 video_build_sponsor_id の実装

**現状**: DBカラムは存在するが、Video Build APIでは使用されていない
- Video Build は `billing_source: 'platform'` で固定
- 将来的にVideo Buildの課金モデルを変更する場合に活用予定

---

## 9. コード品質チェックリスト

### 入力の安全性
- [x] `api_sponsor_id` が NULL の場合は `'user'` 課金
- [x] APIキー復号失敗時は明示的エラー（フォールバック禁止）
- [x] `sponsorUserId` が設定されていても `billingSource` が `'user'` なら無視

### ロジックの正確性
- [x] superadmin判定 → スポンサー判定 → ユーザー課金の優先順位
- [x] Video Build は常に `'platform'` 課金
- [x] `sponsored_by_user_id` は `billingSource='sponsor'` 時のみ設定

### エラーハンドリング
- [x] `SPONSOR_KEY_NOT_CONFIGURED`: システムキー未設定
- [x] `USER_KEY_ERROR`: ユーザーキー未設定/復号失敗
- [x] リダイレクト付きエラーレスポンス（設定画面へ誘導）

---

## 10. 変更履歴

| 日付 | 変更内容 |
|------|---------|
| 2026-02-05 | 初版作成。依存関係の全体チェック完了。 |

---

## 11. 関連ドキュメント

- `docs/VIDEO_BUILD_ASSET_SSOT.md` - Video Build素材選択SSOT
- `docs/VIDEO_BUILD_OPERATIONS_RUNBOOK.md` - Video Build運用手順書
