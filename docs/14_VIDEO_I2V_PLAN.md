# 🎬 画像→動画（I2V）機能 最小実装仕様書 v1

**作成日**: 2024-12-26  
**対象**: RILARC Scenario Generator - webapp  
**スコープ**: 画像→動画（I2V）機能の追加（既存機能に影響なし）  
**目的**: シーンごとに「採用中画像（active_image）」を動画に変換し、履歴管理・採用・削除・Exportを可能にする

---

## 0. 原則（既存機能への影響ゼロ）
1. 既存テーブルは変更しない（破壊的変更なし）
2. 新規テーブルのみ追加（マイグレーションは追加SQLで完結）
3. 既存APIは変更しない（新規エンドポイントのみ追加）
4. 画像生成・音声生成と同じ設計思想を踏襲（履歴・採用・Export・状態管理）

---

## 1. 目標（MVP）
- ✅ シーン単位の動画生成（I2V）
- ✅ 動画履歴の管理（生成・一覧・採用・削除）
- ✅ 動画プレビュー（`<video controls>`）
- ✅ 擬似進捗表示（0% → 100%）
- ✅ Exportへの統合（`videos/scene_{idx}.mp4`）
- ⏭️ 一括動画生成（後続フェーズ）
- ⏭️ 動画のプロンプト高度化、運動量プリセット（後続フェーズ）

---

## 2. 安全要件（必須）
### 2.1 completed の定義
- `status='completed'` のとき **r2_url が必須**
- `status='completed'` なのに `r2_url IS NULL` の場合は **強制的に failed に戻す**

### 2.2 競合防止（409）
- 同一 `scene_id` に `status='generating'` の `video_generations` が存在する場合は **409 Conflict**

### 2.3 active は最大1件
- activate 時に同一 `scene_id` の `is_active` を全て 0 → 対象を 1

### 2.4 既存影響ゼロ
- 画像/音声/シーン分割の既存挙動を変更しない
- 追加のみで完結

---

## 3. DB設計（新規テーブル）

### 3.1 マイグレーション
ファイル: `migrations/0010_create_video_generations.sql`

```sql
-- Migration: 0010_create_video_generations
-- Purpose: Add video_generations table for per-scene I2V history and activation

CREATE TABLE IF NOT EXISTS video_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,

  -- Provider settings
  provider TEXT NOT NULL DEFAULT 'google',   -- 'google' (first), then extend
  model TEXT,                                -- e.g. 'veo-3' (string)
  mode TEXT NOT NULL DEFAULT 'i2v',          -- 'i2v' fixed for now

  -- Input (source image)
  source_image_generation_id INTEGER,        -- image_generations.id
  source_image_r2_key TEXT,
  source_image_r2_url TEXT,

  -- Generation params
  duration_sec INTEGER NOT NULL DEFAULT 4,   -- MVP: 4s fixed
  fps INTEGER DEFAULT 24,
  prompt TEXT,                               -- optional motion prompt
  seed INTEGER,                              -- optional

  -- Status
  status TEXT NOT NULL DEFAULT 'pending',    -- 'pending'|'generating'|'completed'|'failed'
  error_message TEXT,

  -- R2 storage
  r2_key TEXT,
  r2_url TEXT,

  -- Activation
  is_active INTEGER NOT NULL DEFAULT 0,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_video_generations_scene_id
  ON video_generations(scene_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_generations_scene_active
  ON video_generations(scene_id, is_active);

CREATE INDEX IF NOT EXISTS idx_video_generations_status
  ON video_generations(status);
```

---

## 4. API設計（新規のみ）

命名規則は TTS v2 と同じ "リソース中心" を踏襲
- generate は scenes 配下
- activate / delete は video リソース直下

### 4.1 POST /api/scenes/:id/generate-video

**目的**: 採用中画像（active_image）から動画生成を開始

**Request（MVP）**

```json
{
  "provider": "google",
  "model": "veo-3",
  "duration_sec": 4,
  "fps": 24,
  "prompt": "カメラがゆっくりズームイン。日本語テキストは維持。"
}
```

**Server-side validation**
- scene が存在しない → 404
- active_image が存在しない（採用画像なし）→ 400
- dialogue が空でも動画生成は可能（※音声と違い必須ではない）
- generating が既に存在 → 409

**Response（開始時）**

```json
{
  "video_generation": {
    "id": 123,
    "scene_id": 306,
    "status": "generating",
    "r2_url": null
  }
}
```

**処理方針（524対策）**
- Handler 内では DB insert までで返す（速く返す）
- 実際の動画生成＋R2保存＋DB update は waitUntil() などで非同期実行
- 完了後 status='completed' をセットし、r2_url 検証（空なら failed）

---

### 4.2 GET /api/scenes/:id/video

**目的**: シーンの動画履歴と採用動画を返す

**Response**

```json
{
  "video_generations": [
    {
      "id": 123,
      "scene_id": 306,
      "provider": "google",
      "model": "veo-3",
      "duration_sec": 4,
      "fps": 24,
      "prompt": "...",
      "status": "completed",
      "error_message": null,
      "r2_url": "https://...",
      "is_active": true,
      "created_at": "..."
    }
  ],
  "active_video": {
    "id": 123,
    "scene_id": 306,
    "r2_url": "https://...",
    "is_active": true
  }
}
```

---

### 4.3 POST /api/video/:videoId/activate

**目的**: 動画の採用切替（active最大1件）
- completed以外は activate 不可（400）
- 同 scene の active を 0 → 指定 videoId を 1

---

### 4.4 DELETE /api/video/:videoId

**目的**: 動画履歴の削除
- active=1 のものは削除不可（400）
- r2_key があれば R2 delete
- DB からレコード削除（物理削除）

---

## 5. R2設計

### 5.1 R2キー規約

```
video/{project_id}/scene_{idx}/{generation_id}_{timestamp}.mp4
```

例:
```
video/30/scene_3/123_1766717000000.mp4
```

### 5.2 r2_url の規約（推奨）
- 既存の images/audio と同様に "自前配信ルート" で揃えるのが安全
- 例：`/video/${r2_key}` のような形
- もし R2_PUBLIC_URL を使う場合もOK（環境変数で切替）

---

## 6. UI/UX（Builderカード増築）

### 6.1 追加する UI（Scene cardの右側に Video セクション）
- `<video controls>` プレビュー（active_video があれば表示）
- `videoPrimaryBtn-${sceneId}`（固定DOM）
- `videoHistoryBtn-${sceneId}`（履歴）

### 6.2 状態管理（画像ボタン方式を踏襲）

```javascript
setVideoButtonState(sceneId, state, percent)
```

| state | 色 | 表示 | icon |
|-------|---|------|------|
| idle | 青 | 動画生成 | fa-magic |
| generating | 黄 | 生成中…XX% | fa-spinner |
| completed | 緑 | 再生成 | fa-redo |
| failed | 赤 | 再生成 | fa-redo |

### 6.3 擬似進捗
- API待機中に 0→80→95→100
- 同期・非同期どちらでも UX が崩れない
- 524/長時間の場合は 95% で粘ってポーリング復帰（画像/音声の方針と一致）

---

## 7. 実装順序（最短で動かす）

### Phase V1（DB → API → UI → Export）
1. Migration `0010_create_video_generations.sql`
2. 新規 route `src/routes/video-generation.ts`（API 4本）
3. R2配信用 `src/routes/video.ts`（`/video/*`）
4. Builder UI：Video セクション追加
5. Export：`videos/scene_{idx}.mp4` を `all.zip` に追加（activeのみ）

---

## 8. 受け入れテスト（最短）

### Test 1: 生成開始
- active_image があるシーンで「動画生成」
- 生成中（黄色・0%）になる
- しばらくして completed（緑・再生成）になる
- video プレビューが表示される

### Test 2: 履歴
- 履歴モーダルが開く
- 過去の動画が一覧で表示される

### Test 3: 採用
- 別動画を activate
- active_video が差し替わる
- is_active が最大1件になっている

### Test 4: 削除
- active 以外の動画を削除できる
- active は削除不可になる（400）

### Test 5: Export
- `all.zip` に `videos/scene_{idx}.mp4` が含まれる（activeのみ）

---

## 9. 将来拡張（v2）
- 一括動画生成（画像の一括生成と同じ擬似進捗方式）
- 動画プリセット（動き/カメラ/尺）
- provider切替（Runway/Luma等）
- 実進捗（SSE/WS/DO/Queue）

---

**最終更新**: 2024-12-26  
**作成者**: モギモギ & AI
