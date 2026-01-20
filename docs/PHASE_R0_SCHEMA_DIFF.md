# Phase R0: 実データとRemotionスキーマの差分分析

## 1. 実データ（webapp出力）

**ソース**: R2 `video-builds/24/project.json` (2026-01-19 14:11:10, completed)

### トップレベル構造

```json
{
  "version": "1.1",
  "project_id": 55,
  "project_title": "テスト",
  "output": { "aspect_ratio": "9:16", "fps": 30, "resolution": "1080p" },
  "global": { "captions": {...}, "bgm": {...}, "motion": {...} },
  "scenes": [...],
  "total_duration_ms": 117600,
  "created_at": "2026-01-19T14:11:10.470Z"
}
```

### シーン構造（webapp出力）

```json
{
  "scene_id": 537,
  "idx": 1,
  "role": "hook",
  "title": "謎の真っ白な空間へようこそ",
  "dialogue": "レンは意識を失い...",
  "asset": {
    "type": "comic",
    "src": "https://webapp-c7n.pages.dev/images/55/537/comic_1768779515121.png"
  },
  "audio": {
    "src": "https://webapp-c7n.pages.dev/audio/55/scene_1/26_1768751950693.mp3",
    "duration_ms": 19200
  },
  "duration_ms": 19700,
  "effects": { "ken_burns": false }
}
```

---

## 2. Remotionスキーマ（期待形）

**ソース**: `/video-build-remotion/src/schemas/project-schema.ts`

### トップレベル構造

```typescript
ProjectJsonSchema = z.object({
  schema_version: z.literal('1.1'),
  project_id: z.number(),
  project_title: z.string(),
  created_at: z.string(),
  build_settings: z.object({
    preset: z.string(),
    resolution: z.object({ width: z.number(), height: z.number() }),
    fps: z.number(),
    codec: z.enum(['h264', 'h265']),
    audio: z.object({...}).optional(),
    transition: z.object({...}).optional(),
  }),
  global: z.object({
    default_scene_duration_ms: z.number(),
    transition_duration_ms: z.number(),
  }),
  assets: z.object({ bgm: {...}.optional() }).optional(),
  scenes: z.array(ProjectSceneSchema),
  summary: z.object({
    total_scenes: z.number(),
    total_duration_ms: z.number(),
    has_audio: z.boolean(),
    has_video_clips: z.boolean(),
  }),
});
```

### シーン構造（Remotion期待）

```typescript
ProjectSceneSchema = z.object({
  idx: z.number(),
  role: z.string(),
  title: z.string(),
  dialogue: z.string(),
  timing: z.object({
    start_ms: z.number(),      // ← 必須！
    duration_ms: z.number(),
    head_pad_ms: z.number().default(0),
    tail_pad_ms: z.number().default(0),
  }),
  assets: z.object({
    image: z.object({
      url: z.string(),
      width: z.number(),
      height: z.number(),
    }).optional(),
    audio: z.object({
      url: z.string(),
      duration_ms: z.number(),
      format: z.enum(['mp3', 'wav']),
    }).optional(),
    video_clip: z.object({
      url: z.string(),
      duration_ms: z.number(),
    }).optional(),
  }),
  characters: z.object({
    image: z.array(z.string()).optional(),
    voice: z.string().optional(),
  }).optional(),
});
```

---

## 3. 差分一覧（フィールド単位）

### トップレベル差分

| フィールド | webapp出力 | Remotion期待 | 変換要否 |
|-----------|-----------|-------------|---------|
| version/schema_version | `version: "1.1"` | `schema_version: "1.1"` | ⚠️ rename |
| output | `{ aspect_ratio, fps, resolution }` | `build_settings.resolution: { width, height }` | ⚠️ 変換 |
| global | `{ captions, bgm, motion }` | `{ default_scene_duration_ms, transition_duration_ms }` | ⚠️ 構造違い |
| total_duration_ms | あり | `summary.total_duration_ms` | ⚠️ 移動 |
| summary | なし | **必須** | ❌ 欠損 |

### シーン差分（致命的）

| フィールド | webapp出力 | Remotion期待 | 変換要否 |
|-----------|-----------|-------------|---------|
| scene_id | `scene_id: 537` | なし | 削除OK |
| **timing** | **なし** | **timing.start_ms (必須)** | ❌ **致命的欠損** |
| duration_ms | `duration_ms: 19700` | `timing.duration_ms` | ⚠️ 移動 |
| asset | `asset.type`, `asset.src` | `assets.image.url` | ⚠️ 構造違い |
| audio | `audio.src`, `audio.duration_ms` | `assets.audio.url`, `assets.audio.format` | ⚠️ 構造違い |
| effects | `effects.ken_burns` | なし（Remotion側で処理） | 削除OK |

---

## 4. 根本原因（確定）

### 致命的欠損: `timing.start_ms`

**webapp出力には `start_ms` がない。**

```json
// webapp出力（現状）
{ "duration_ms": 19700 }

// Remotion期待
{ "timing": { "start_ms": 0, "duration_ms": 19700 } }
```

Remotionの `RilarcVideo.tsx` は `scene.timing.start_ms` を使ってシーケンス開始位置を決定：

```tsx
const scenesWithFrames = projectJson.scenes.map((scene) => {
  const startFrame = msToFrames(scene.timing.start_ms, fps);  // ← ここ
  const durationFrames = msToFrames(scene.timing.duration_ms, fps);
  return { scene, startFrame, durationFrames };
});
```

**start_ms が全て undefined/0 になると、全シーンが0フレーム目から開始 → 重なって表示される**

---

## 5. 素材マトリクス（実データから抽出）

### project_id=55 の6シーン

| scene_id | idx | image | audio | comic | video | duration_ms |
|----------|-----|-------|-------|-------|-------|-------------|
| 537 | 1 | - | ✅ 19200ms | ✅ comic | - | 19700 |
| 538 | 2 | ✅ | - | - | - | 18800 |
| 539 | 3 | ✅ | - | - | - | 21200 |
| 540 | 4 | ✅ | - | - | - | 20000 |
| 541 | 5 | ✅ | - | - | - | 18500 |
| 542 | 6 | ✅ | - | - | - | 19400 |

### 観測

- scene_id=537 のみ audio あり（19200ms）
- scene_id=537 のみ comic（type="comic"）
- 他5シーンは image のみ、audio なし
- **全シーンの duration_ms は設定済み**（audio があればaudio+500ms、なければデフォルト推定）

---

## 6. Phase R1: 最小修正範囲（video-only完走）

### 修正ファイル

**1. `/home/user/webapp/src/utils/video-build-helpers.ts`**

`buildProjectJson()` を修正して Remotion スキーマ準拠の JSON を出力する。

### 必須変換

1. **timing オブジェクト追加**
   ```typescript
   // 累積計算
   let currentMs = 0;
   scenes.map(scene => {
     const startMs = currentMs;
     currentMs += scene.duration_ms;
     return {
       timing: {
         start_ms: startMs,
         duration_ms: scene.duration_ms,
         head_pad_ms: 0,
         tail_pad_ms: 0,
       }
     };
   });
   ```

2. **asset → assets 変換**
   ```typescript
   // webapp形式
   { asset: { type: "image", src: "..." } }
   
   // Remotion形式
   { assets: { image: { url: "...", width: 1080, height: 1920 } } }
   ```

3. **audio 構造変換**
   ```typescript
   // webapp形式
   { audio: { src: "...", duration_ms: 19200 } }
   
   // Remotion形式
   { assets: { audio: { url: "...", duration_ms: 19200, format: "mp3" } } }
   ```

4. **トップレベル構造変換**
   ```typescript
   // version → schema_version
   // output → build_settings.resolution
   // total_duration_ms → summary.total_duration_ms
   // summary オブジェクト追加
   ```

### 変換しなくてよいもの（削除OK）

- `scene_id`（Remotionでは不要）
- `effects.ken_burns`（Remotion側で別途処理）
- `global.captions`, `global.bgm`, `global.motion`（Remotionスキーマと構造違い）

---

## 7. 検証方法

### ビルド後の確認

1. R2 に保存される project.json を取得
2. Remotion の `ProjectJsonSchema.parse()` でバリデーション
3. Remotion Lambda のログで「全シーンの start_ms が累積されているか」確認

### 生成MP4の確認

1. 6シーン分の尺があるか（117600ms ≒ 117秒）
2. シーンが順番に切り替わるか（重ならない）
3. scene_id=537 の audio が再生されるか

---

## 8. 次のアクション

```bash
# 1. video-build-helpers.ts の修正
# buildProjectJson() → Remotion スキーマ準拠に変換

# 2. ローカルテスト
npm run build
pm2 restart webapp

# 3. プレビュー動作確認（Preflight API）
curl https://webapp-c7n.pages.dev/api/projects/55/video-builds/preflight

# 4. 本番デプロイ
npm run deploy

# 5. テストビルド実行
# POST /api/projects/55/video-builds
```
