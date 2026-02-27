# SiliconFlow FLF2V (Before/After動画生成) 実装計画書

**作成日**: 2026-02-27
**対象**: プロジェクト制作ボードにおけるシーン単位の動画生成機能拡張
**目的**: 既存のVeo2/Veo3に加え、SiliconFlow Wan2.1 FLF2V（First-Last Frame to Video）による
Before/After 2枚画像指定の動画生成を追加する

---

## 1. 現状分析

### 1.1 既存の動画生成フロー

```
[制作ボード] → [シーンカード] → [動画プロンプトセクション]
                                     ├─ エンジン選択: Veo2 / Veo3
                                     ├─ プロンプト入力
                                     └─ 「動画化」ボタン
```

**現在の処理フロー**:
1. シーンの **active image（1枚）** を取得
2. 署名付きURL生成 → AWS Video Proxy に送信
3. AWS Lambda → Google Veo2/Veo3 API 呼び出し
4. ポーリングで完了待ち → S3保存 → CloudFront配信

**API エンドポイント（既存）**:
- `POST /api/scenes/:sceneId/generate-video` — 新規動画生成
- `POST /api/scenes/:sceneId/video-regenerate` — 再生成
- `GET /api/scenes/:sceneId/videos` — 動画一覧
- `GET /api/scenes/:sceneId/videos/:videoId/status` — ステータスポーリング
- `POST /api/videos/:videoId/activate` — 動画採用
- `DELETE /api/videos/:videoId` — 動画削除
- `POST /api/videos/:videoId/cancel` — キャンセル

**DB テーブル（既存）**:
- `video_generations` — provider, model, status, duration_sec, prompt, source_image_r2_key, r2_key, r2_url, job_id, is_active
- `api_usage_logs` — コスト追跡（api_type='video_generation'）

**課金モデル（既存）**:
- `billing_source`: 'user' | 'sponsor'
- superadmin操作 → sponsor（運営キー）
- ユーザー操作 → users.api_sponsor_id があればsponsor、なければuser
- Veo2: $0.35/秒（5秒=$1.75）、Veo3: $0.50/秒（8秒=$4.00）

### 1.2 シーンカードUI構造

```
┌─────────────────────────────────────────┐
│ シーン #N                                │
│ ┌─ 画像プロンプト（imagePrompt-{id}）──┐ │
│ │  textarea: 画像生成用プロンプト       │ │
│ └──────────────────────────────────────┘ │
│ ┌─ 画像プレビュー ─────────────────────┐ │
│ │  [生成済み画像 / 未生成プレースホルダ] │ │
│ └──────────────────────────────────────┘ │
│ ┌─ 動画プレビュー ─────────────────────┐ │
│ │  [生成済み動画 / 生成中スピナー]      │ │
│ └──────────────────────────────────────┘ │
│ ┌─ 動画プロンプトセクション ───────────┐ │
│ │  textarea: 動画プロンプト             │ │
│ │  [エンジン: Veo2▼] [🎬 動画化]       │ │
│ └──────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

---

## 2. SiliconFlow API 仕様

### 2.1 利用可能モデル

| モデルID | タイプ | 価格 | 用途 |
|---------|--------|------|------|
| `Wan-AI/Wan2.2-I2V-A14B` | I2V (1枚→動画) | $0.29/動画 | 画像1枚から動画 |
| `Wan-AI/Wan2.2-T2V-A14B` | T2V (テキスト→動画) | $0.29/動画 | テキストから動画 |
| `Wan-AI/Wan2.1-FLF2V-14B-720P` | FLF2V (2枚→動画) | ~$0.21-$0.29/動画 | **Before/After動画 ★新機能** |

> **重要**: SiliconFlow の公式APIドキュメント（2026-02時点）では I2V に `Wan-AI/Wan2.2-I2V-A14B` のみ
> が記載されており、FLF2V モデル（`Wan-AI/Wan2.1-FLF2V-14B-720P`）は一部APIリファレンスに
> 掲載されていない可能性がある。実装前にAPIキー取得後に `/v1/models` エンドポイントで
> 利用可能モデル一覧を確認する必要がある。

### 2.2 API インターフェース

**ステップ1: 動画生成リクエスト送信**
```
POST https://api.siliconflow.cn/v1/video/submit
Authorization: Bearer {API_KEY}
Content-Type: application/json

// I2V（1枚画像）
{
  "model": "Wan-AI/Wan2.2-I2V-A14B",
  "prompt": "Camera slowly zooms in...",
  "image": "https://example.com/image.png",   // 開始画像URL
  "image_size": "1280x720"                     // 16:9
}

// FLF2V（2枚画像 = Before/After）
{
  "model": "Wan-AI/Wan2.1-FLF2V-14B-720P",
  "prompt": "Smooth transition from start to end frame",
  "image": "https://example.com/before.png",       // Before画像
  "end_image": "https://example.com/after.png",     // After画像
  "image_size": "1280x720"
}
```

**レスポンス**:
```json
{ "requestId": "abc-123-def" }
```

**ステップ2: ステータス確認（ポーリング）**
```
POST https://api.siliconflow.cn/v1/video/status
Authorization: Bearer {API_KEY}
Content-Type: application/json

{ "requestId": "abc-123-def" }
```

**レスポンス**:
```json
{
  "status": "Succeed",      // Succeed | InQueue | InProgress | Failed
  "results": {
    "video": {
      "url": "https://sf-cdn.../video.mp4"  // 有効期限10分〜1時間
    }
  }
}
```

### 2.3 制約事項

- **画像比率**: 1280x720 (16:9), 720x1280 (9:16), 960x960 (1:1)
- **動画の長さ**: 5秒（固定）
- **動画URL有効期限**: 10分〜1時間 → **即座にR2/S3へダウンロード保存が必須**
- **レート制限**: アカウントレベル（L0→L5）で段階的に緩和

---

## 3. 実装計画

### 3.1 アーキテクチャ概要

```
                        ┌──────────────────────────────────┐
                        │       制作ボード (Frontend)        │
                        │                                    │
                        │  ┌──エンジン選択──────────────┐    │
                        │  │ ● Veo2  ● Veo3  ● FLF2V   │    │
                        │  └───────────────────────────┘    │
                        │                                    │
                        │  [FLF2V選択時のみ]                 │
                        │  ┌──After画像セクション────────┐  │
                        │  │ After画像プロンプト          │  │
                        │  │ [After画像生成] [プレビュー]  │  │
                        │  └───────────────────────────┘  │
                        │                                    │
                        │  [動画プロンプト]                   │
                        │  [🎬 Before→After 動画生成]        │
                        └────────────┬───────────────────────┘
                                     │
                     ┌───────────────┼───────────────┐
                     │               │               │
                     ▼               ▼               ▼
              ┌──────────┐   ┌──────────┐   ┌──────────────┐
              │  Veo2/3  │   │ FLF2V    │   │ SiliconFlow  │
              │(既存AWS  │   │ I2V      │   │ 直接API      │
              │ Proxy)   │   │(1枚→動画) │   │ (FLF2V)      │
              └──────────┘   └──────────┘   └──────────────┘
                                                    │
                                                    ▼
                                            ┌──────────────┐
                                            │  ポーリング   │
                                            │  Worker      │
                                            │  (5秒間隔)   │
                                            └──────┬───────┘
                                                   │
                                                   ▼
                                            ┌──────────────┐
                                            │ R2保存       │
                                            │ (永続化)     │
                                            └──────────────┘
```

### 3.2 変更ファイル一覧

#### バックエンド（TypeScript / Hono）

| ファイル | 変更内容 | 影響度 |
|---------|---------|--------|
| `src/types/bindings.ts` | `SILICONFLOW_API_KEY` 追加 | 低 |
| `src/utils/siliconflow-client.ts` | **新規**: SiliconFlow API クライアント | なし（新規） |
| `src/utils/aws-video-client.ts` | `VideoEngine` 型に `'flf2v'` `'siliconflow_i2v'` 追加 | 低 |
| `src/routes/video-generation.ts` | FLF2Vエンドポイント追加、ポーリングワーカー追加 | 中 |
| `src/routes/image-generation.ts` | After画像生成エンドポイント追加（既存流用） | 低 |
| `src/routes/admin.ts` | SiliconFlowコスト表示、使用量ダッシュボード | 低 |
| `src/routes/settings.ts` | SiliconFlow APIキー登録（ユーザー設定） | 低 |

#### フロントエンド（JavaScript / HTML）

| ファイル | 変更内容 | 影響度 |
|---------|---------|--------|
| `public/static/project-editor.js` | FLF2V UI追加（After画像セクション、エンジン選択拡張） | 中 |

#### データベース（D1 / SQLite）

| マイグレーション | 内容 |
|----------------|------|
| `patches.ts` | `video_generations` テーブル拡張（after_image_r2_key, video_engine 追加） |
| `patches.ts` | `user_video_generation_limits` テーブル新規 or `system_settings` に追加 |

#### インフラ

| 項目 | 内容 |
|-----|------|
| Cloudflare Secret | `SILICONFLOW_API_KEY` を `wrangler pages secret put` |
| wrangler.jsonc | 不要（Secretsは Pages Secret で管理） |

---

## 4. DB スキーマ変更

### 4.1 `video_generations` テーブル拡張

```sql
-- 既存カラムに追加
ALTER TABLE video_generations ADD COLUMN video_engine TEXT DEFAULT 'veo2';
  -- 'veo2' | 'veo3' | 'siliconflow_i2v' | 'siliconflow_flf2v'

ALTER TABLE video_generations ADD COLUMN after_image_r2_key TEXT;
  -- FLF2V用: After画像のR2キー（Before画像は既存の source_image_r2_key）

ALTER TABLE video_generations ADD COLUMN sf_request_id TEXT;
  -- SiliconFlow の requestId（ポーリング用）

ALTER TABLE video_generations ADD COLUMN actual_cost_usd REAL;
  -- SiliconFlowは固定料金のため、実コスト = $0.29/動画
```

### 4.2 ユーザー動画生成制限

既存の `system_settings` テーブルに追加:

```sql
INSERT INTO system_settings (key, value) VALUES ('sf_video_monthly_limit', '30');
  -- 1ユーザーあたりの月間SiliconFlow動画生成上限

INSERT INTO system_settings (key, value) VALUES ('sf_video_enabled', '1');
  -- SiliconFlow動画生成の有効/無効フラグ
```

**制限チェック方法**:
```sql
SELECT COUNT(*) FROM video_generations
WHERE user_id = ?
  AND video_engine IN ('siliconflow_i2v', 'siliconflow_flf2v')
  AND created_at >= datetime('now', 'start of month')
  AND status != 'failed'
```

---

## 5. コスト設計

### 5.1 単価比較

| エンジン | 1動画あたりコスト | 5秒動画 | 8秒動画 | 課金先 |
|---------|-------------------|---------|---------|-------|
| Veo2 | $0.35/秒 | **$1.75** | - | ユーザーAPIキー |
| Veo3 | $0.50/秒 | - | **$4.00** | ユーザーAPIキー |
| SiliconFlow I2V | **$0.29/動画** | $0.29 | - | **運営負担** |
| SiliconFlow FLF2V | **$0.21〜$0.29/動画** | $0.21〜$0.29 | - | **運営負担** |

### 5.2 コスト試算（運営負担分）

| ユーザー数 | 月間制限 | 最大動画数/月 | 最大コスト/月 |
|-----------|---------|-------------|-------------|
| 10人 | 30本/人 | 300本 | **$87 (約¥13,000)** |
| 50人 | 30本/人 | 1,500本 | **$435 (約¥65,000)** |
| 100人 | 30本/人 | 3,000本 | **$870 (約¥130,000)** |

### 5.3 推奨制限設定

| 設定 | 値 | 理由 |
|-----|-----|------|
| 月間上限 | **30本/ユーザー** | 1日1本ペースで余裕あり |
| 同時生成 | **1本** | SiliconFlowのレート制限対策 |
| 有効化 | superadmin が ON/OFF | コスト管理 |

### 5.4 実コスト追跡

SiliconFlow APIはレスポンスにコスト情報を含まないため:
- **推定コスト**: モデルIDから定額計算（I2V=$0.29, FLF2V=$0.29）
- **実コスト確認**: SiliconFlow ダッシュボード（https://cloud.siliconflow.cn/）で月次確認
- `api_usage_logs` に `estimated_cost_usd` として記録
- admin ダッシュボードに SiliconFlow 月間使用量サマリーを追加

---

## 6. UI/UX 設計

### 6.1 新しいシーンカード構造

```
┌─────────────────────────────────────────┐
│ シーン #N                                │
│                                          │
│ ┌─ 画像プロンプト ─────────────────────┐ │
│ │  [textarea] 画像生成用プロンプト      │ │
│ │  [画像を生成] ボタン                  │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ ┌─ Before画像プレビュー ───────────────┐ │
│ │  [生成済み画像]                        │ │
│ │  左上バッジ: 🖼 画像                  │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ ┌─ 動画プロンプトセクション ───────────┐ │
│ │                                        │ │
│ │  [エンジン選択]                        │ │
│ │  ┌────────────────────────────────┐   │ │
│ │  │ 🎬 Veo2(5秒) │ 🚀 Veo3(8秒) │   │ │
│ │  │─────────────────────────────── │   │ │
│ │  │ 🔄 Before→After(5秒) ★NEW    │   │ │
│ │  └────────────────────────────────┘   │ │
│ │                                        │ │
│ │  [動画プロンプト textarea]             │ │
│ │                                        │ │
│ │  ┌─ FLF2V選択時のみ表示 ────────┐    │ │
│ │  │ After画像プロンプト           │    │ │
│ │  │ [textarea]                     │    │ │
│ │  │ [After画像を生成] [プレビュー] │    │ │
│ │  │                                │    │ │
│ │  │ ┌─ After画像プレビュー ──┐    │    │ │
│ │  │ │ [サムネイル] 🏁 After  │    │    │ │
│ │  │ └───────────────────────┘    │    │ │
│ │  │                                │    │ │
│ │  │ 💡 Before: 上の生成済み画像    │    │ │
│ │  │    After: ここで生成した画像    │    │ │
│ │  └────────────────────────────────┘    │ │
│ │                                        │ │
│ │  [🎬 Before→After 動画を生成]         │ │
│ │                                        │ │
│ │  📊 残り: 27/30本（今月）             │ │
│ │  💰 運営負担（APIキー不要）            │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ ┌─ 動画プレビュー ─────────────────────┐ │
│ │  [生成済み動画]                        │ │
│ └──────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### 6.2 エンジン選択UI

現在の `<select>` を拡張:

```html
<select id="videoEngineInline-{sceneId}">
  <option value="veo2">🎬 Veo2 (5秒・あなたのAPIキー)</option>
  <option value="veo3">🚀 Veo3 (8秒・あなたのAPIキー)</option>
  <optgroup label="── Before→After 動画 ──">
    <option value="siliconflow_flf2v">🔄 FLF2V (5秒・運営負担) ★NEW</option>
  </optgroup>
</select>
```

### 6.3 FLF2V選択時の動的UI表示

エンジン `siliconflow_flf2v` が選択されたとき:

1. **After画像セクションを表示**（slide down アニメーション）
2. **APIキーチェックをスキップ**（運営負担のため）
3. **コスト表示を変更**: 「運営負担・APIキー不要」
4. **残り回数を表示**: 「今月: X/30本」
5. **ボタンテキスト変更**: 「🔄 Before→After 動画を生成」

Veo2/Veo3 に戻したとき:
1. After画像セクションを非表示
2. 既存のAPIキーチェックを復活
3. コスト表示を元に戻す

### 6.4 After画像生成フロー

```
1. ユーザーがFLF2Vエンジンを選択
2. After画像プロンプトを入力
   (デフォルト: Before画像のプロンプト + " - final state, ending pose")
3. [After画像を生成] クリック
   → Nano Banana 2 で画像生成 ($0.067/枚・運営負担)
   → サムネイルプレビュー表示
4. Before画像（= シーンのactive image）とAfter画像が揃った状態で
   [🔄 Before→After 動画を生成] が有効化
```

---

## 7. 実装ステップ（フェーズ分割）

### Phase 1: バックエンド基盤（影響: 既存機能に変更なし）

**目標**: SiliconFlow API クライアントとエンドポイント追加

1. **`src/types/bindings.ts`** — `SILICONFLOW_API_KEY` 追加
2. **`src/utils/siliconflow-client.ts`** — 新規作成
   - `submitVideo(params)` — 動画生成リクエスト送信
   - `getVideoStatus(requestId)` — ステータス取得
   - `downloadAndSaveToR2(videoUrl, r2Bucket, r2Key)` — 動画DL→R2保存
3. **`src/utils/aws-video-client.ts`** — `VideoEngine` 型拡張
   ```typescript
   export type VideoEngine = 'veo2' | 'veo3' | 'siliconflow_i2v' | 'siliconflow_flf2v';
   ```
4. **DB マイグレーション** (`src/routes/patches.ts`)
   - `video_generations` に `video_engine`, `after_image_r2_key`, `sf_request_id`, `actual_cost_usd` カラム追加
   - `system_settings` に `sf_video_monthly_limit`, `sf_video_enabled` 追加

### Phase 2: 動画生成API（影響: 新規エンドポイントのみ）

**目標**: SiliconFlow経由の動画生成エンドポイント

5. **`src/routes/video-generation.ts`** — 新規エンドポイント追加
   - `POST /api/scenes/:sceneId/generate-video-sf` — SiliconFlow動画生成
     - リクエストボディ:
       ```typescript
       {
         video_engine: 'siliconflow_i2v' | 'siliconflow_flf2v';
         prompt?: string;
         after_image_r2_key?: string;  // FLF2V用
       }
       ```
     - Before画像: 既存の `getSceneActiveImage()` から取得
     - After画像: `after_image_r2_key` から取得
     - 制限チェック: 月間上限 / 同時生成数
     - `video_generations` にレコード作成
     - SiliconFlow API 呼び出し → `sf_request_id` 保存
   
6. **SiliconFlowポーリングワーカー**
   - 既存のフロントエンドポーリング (`pollVideoGeneration`) を活用
   - `GET /api/scenes/:sceneId/videos/:videoId/status` を拡張
     - `video_engine` が `siliconflow_*` の場合:
       - SiliconFlow `/v1/video/status` API を呼び出し
       - `Succeed` → 動画URLからダウンロード → R2保存 → `completed` に更新
       - `InProgress` / `InQueue` → `generating` のまま返却
       - `Failed` → `failed` に更新

7. **After画像生成API**
   - 既存の画像生成API (`/api/scenes/:sceneId/generate-image`) を流用
   - After画像は `image_generations` テーブルに `asset_type='flf2v_after'` で保存
   - または新規: `POST /api/scenes/:sceneId/generate-after-image`

### Phase 3: フロントエンドUI（影響: 既存UIに条件分岐追加）

**目標**: シーンカード上のFLF2V UI

8. **`public/static/project-editor.js`** — UI拡張
   - エンジン選択に `siliconflow_flf2v` オプション追加
   - FLF2V選択時の動的UI（After画像セクション）
   - After画像生成ボタン + プレビュー
   - 残り回数表示（`/api/video-builds/sf-usage` から取得）
   - `generateVideoInline()` を拡張してSiliconFlow APIを呼び出し

### Phase 4: 管理画面・制限管理（影響: admin画面のみ）

**目標**: コスト管理と制限設定

9. **`src/routes/admin.ts`** — SiliconFlow管理
   - 月間使用量ダッシュボード
   - ユーザーごとの使用状況一覧
   - 月間上限の変更（`sf_video_monthly_limit`）
   - 有効/無効の切り替え（`sf_video_enabled`）

10. **`src/routes/video-generation.ts`** — 使用量API
    - `GET /api/video-builds/sf-usage` — 現在のユーザーのSF使用状況

---

## 8. データフロー詳細

### 8.1 FLF2V 動画生成フロー

```
[ユーザー] エンジン「FLF2V」選択
    │
    ▼
[ユーザー] After画像プロンプト入力 → [After画像を生成]
    │
    ├── POST /api/scenes/:sceneId/generate-after-image
    │   └── Nano Banana 2 で画像生成 → R2保存 → after_image_r2_key
    │
    ▼
[ユーザー] [Before→After 動画を生成] クリック
    │
    ├── POST /api/scenes/:sceneId/generate-video-sf
    │   ├── 1. 制限チェック（月間上限、同時生成数）
    │   ├── 2. Before画像 = getSceneActiveImage() → 署名付きURL
    │   ├── 3. After画像 = after_image_r2_key → 署名付きURL
    │   ├── 4. video_generations にレコード作成（status=generating）
    │   ├── 5. SiliconFlow /v1/video/submit 呼び出し
    │   │       {model:"Wan-AI/Wan2.1-FLF2V-14B-720P",
    │   │        prompt:"...",
    │   │        image: beforeImageUrl,
    │   │        end_image: afterImageUrl,
    │   │        image_size:"1280x720"}
    │   ├── 6. sf_request_id 保存
    │   └── 7. api_usage_logs にコスト記録（$0.29）
    │
    ▼
[フロントエンド] ポーリング開始（5秒間隔）
    │
    ├── GET /api/scenes/:sceneId/videos/:videoId/status
    │   ├── SiliconFlow /v1/video/status 呼び出し
    │   ├── status = InProgress → { status: 'generating' }
    │   ├── status = Succeed →
    │   │   ├── 動画URLからダウンロード
    │   │   ├── R2にアップロード（r2_key生成）
    │   │   ├── video_generations 更新（completed, r2_key, r2_url）
    │   │   └── { status: 'completed', r2_url: '...' }
    │   └── status = Failed → { status: 'failed' }
    │
    ▼
[フロントエンド] 動画プレビュー表示 / 採用ボタン
```

### 8.2 After画像の保存場所

**方針**: 既存の `image_generations` テーブルを活用

```sql
INSERT INTO image_generations (
  scene_id, user_id, provider, model, status, prompt,
  r2_key, r2_url, asset_type, is_active
) VALUES (
  ?, ?, 'gemini', 'gemini-3.1-flash-image-preview', 'completed', ?,
  ?, ?, 'flf2v_after', 0  -- is_active=0: After画像はシーンの通常表示には使わない
)
```

---

## 9. セキュリティ・リスク管理

### 9.1 APIキー管理

- `SILICONFLOW_API_KEY` は Cloudflare Pages Secretに保存
- ユーザーにAPIキーを入力させない（運営負担）
- `.dev.vars` に開発用キーを設定

### 9.2 コスト暴走防止

1. **月間上限**: `sf_video_monthly_limit`（デフォルト30本）
2. **同時生成制限**: 1ユーザー1本まで
3. **管理画面から即時無効化**: `sf_video_enabled = '0'`
4. **アラート**: 月間使用量が80%に達したらadminに通知（Phase 5以降）

### 9.3 動画URL有効期限対策

SiliconFlowの動画URLは10分〜1時間で失効するため:
- ステータス `Succeed` 確認時に **即座に** 動画をダウンロード
- R2バケットに保存 → 永続URL発行
- 失敗時はリトライ（最大3回、10秒間隔）

---

## 10. 既存機能への影響分析

| 機能 | 影響 | 詳細 |
|-----|------|------|
| 一括画像生成 | **変更なし** | 1枚画像生成の仕組みは完全に既存のまま |
| Veo2/Veo3動画生成 | **変更なし** | 既存の `generate-video` エンドポイントは無変更 |
| 丸投げ（marunage） | **変更なし** | 丸投げフローはVeo2/Veo3のまま |
| video_builds（最終動画） | **変更なし** | Remotion Lambda は無変更 |
| 画像生成（Nano Banana 2） | **間接利用** | After画像生成に流用 |
| ポーリング | **拡張** | `video_engine` に応じてSiliconFlowステータスも確認 |
| DB | **拡張のみ** | 既存カラムは無変更、新カラム追加のみ |

---

## 11. 確認事項（実装前に必要）

### ✅ 確認済み
- [x] 既存の動画生成フロー理解
- [x] `video_generations` テーブル構造
- [x] シーンカードのUI構造（project-editor.js）
- [x] 課金モデル（billing_source, sponsor）
- [x] Veo2/Veo3のAPIキー管理方式

### ⚠️ 要確認（モギモギさんへ）
1. **SiliconFlow APIキー**: 登録済みですか？キーを取得して `.dev.vars` に `SILICONFLOW_API_KEY=sk_xxx` として設定が必要です
2. **月間上限**: 30本/ユーザーで良いですか？（変更はadmin画面からいつでも可能）
3. **FLF2Vモデルの利用可能性**: SiliconFlow の `/v1/models` で `Wan-AI/Wan2.1-FLF2V-14B-720P` が利用可能か確認が必要（ドキュメントには未掲載の可能性）
4. **I2V（1枚画像→動画）も追加しますか？**: FLF2V（2枚）に加えて、SiliconFlow I2V（1枚・$0.29）も追加すると、Veo2（$1.75）の安価代替になります
5. **動画の保存期間**: 既存のVeo動画と同じ30日で良いですか？

---

## 12. 実装優先順位

```
Phase 1: バックエンド基盤     → 2-3時間（既存影響なし、安全）
Phase 2: 動画生成API          → 3-4時間（新規エンドポイント、テスト含む）
Phase 3: フロントエンドUI     → 3-4時間（条件分岐追加、UX調整）
Phase 4: 管理画面・制限管理   → 1-2時間（admin画面のみ）
────────────────────────────────────────
合計: 約9-13時間（2-3セッション）
```

---

## まとめ

- **既存機能への影響は最小限**: 新規エンドポイント追加が中心
- **DB変更は追加のみ**: 既存カラムの変更なし
- **UI変更は条件分岐**: FLF2V選択時のみ新UIが表示
- **コスト管理**: 月間上限 + admin制御 + 即時無効化
- **安全性**: まずPhase 1でバックエンド基盤を作り、テストしてからUI追加
