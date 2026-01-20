# Phase R0: SceneAsset Gap分析

## 現状の整理

### 1. 現在のDB Schema (scenes table)

| Field | Type | 完成形SceneAsset対応 |
|-------|------|---------------------|
| id | INTEGER PK | ✅ sceneId |
| project_id | INTEGER FK | ✅ プロジェクト紐付け |
| idx | INTEGER | ✅ order |
| role | TEXT | ❌ Remotionでは未使用 |
| title | TEXT | ⚠️ telop用途のみ |
| dialogue | TEXT | ⚠️ narration/subtitle用 |
| display_asset_type | TEXT | ✅ visual type判定 |
| comic_data | TEXT (JSON) | ⚠️ 部分対応 |
| speech_type | TEXT | ❌ Remotionでは未使用 |
| is_prompt_customized | INTEGER | ❌ 生成用メタ |

### 2. 関連テーブル対応状況

| Table | 完成形対応 | 問題点 |
|-------|-----------|--------|
| image_generations | ✅ backgroundImage | r2_url, is_active |
| audio_generations | ✅ narrationAudio | duration_ms 必須 |
| video_generations | ⚠️ 部分対応 | trimが未実装 |
| comic_data (JSON) | ⚠️ 部分対応 | utterancesの構造が曖昧 |

---

## 3. 現在のBuildRequest v1 vs 完成形SceneAsset

### 現在: BuildRequestV1 (video-build-helpers.ts)

```typescript
interface BuildSceneV1 {
  scene_id: number;
  order: number;
  duration_ms: number;
  
  visual: {
    type: 'image' | 'comic' | 'video';
    source: { image_url?: string; video_url?: string; };
    effect?: { type: 'kenburns' | 'none'; };
  };
  
  audio?: {
    voice?: { audio_url: string; speed: number; };
  };
  
  bubbles: BuildBubbleV1[];
  telop: { enabled: boolean; text?: string; };
}
```

### 完成形: SceneAsset (提案)

```typescript
interface SceneAsset {
  sceneId: number;
  order: number;
  durationMs: number;  // SSOT: これが尺の真実
  style?: 'video' | 'comic' | 'hybrid';  // 明示的モード
  
  // 視覚素材
  backgroundImage?: {
    url: string;
    effect: 'kenburns' | 'none' | 'pan';
  };
  
  characterImages?: Array<{
    url: string;
    position: { x: number; y: number };
    layer: number;
  }>;
  
  generatedVideo?: {
    url: string;
    startMs: number;
    endMs: number;  // trim対応
  };
  
  // 音声素材
  narrationAudio?: {
    url: string;
    startMs: number;
    durationMs: number;
    volume: number;
  };
  
  characterVoices?: Array<{
    characterKey: string;
    url: string;
    startMs: number;
    durationMs: number;
    volume: number;
  }>;
  
  // テキスト表示
  subtitles?: Array<{
    text: string;
    startMs: number;
    endMs: number;
    position: 'bottom' | 'top';
  }>;
  
  speechBalloons?: Array<{
    id: string;
    text: string;
    type: 'speech' | 'thought' | 'whisper' | 'shout';
    position: { x: number; y: number };
    startMs: number;
    endMs: number;
    voiceUrl?: string;
  }>;
  
  telops?: Array<{
    text: string;
    style: 'emphasis' | 'point' | 'title';
    startMs: number;
    endMs: number;
  }>;
}
```

---

## 4. Gap一覧（優先度順）

### P0: 致命的欠損（動画が繋がらない原因候補）

| Gap | 現状 | 完成形 | 修正内容 |
|-----|------|--------|----------|
| **durationMs SSOT** | 毎回計算 | 明示的に保存 | scenes.duration_ms カラム追加 |
| **start_ms累積計算** | フロント任せ | BuildRequestで累積 | timeline計算をサーバー側で |
| **全シーン結合** | scene[0]のみ | 全scene連結 | Remotion側のtimeline検証 |

### P1: 機能不足

| Gap | 現状 | 完成形 | 修正内容 |
|-----|------|--------|----------|
| generatedVideo trim | なし | startMs/endMs | video_generationsにtrim情報 |
| characterVoices | なし | 配列 | comic_data.utterances拡張 |
| subtitles自動生成 | なし | audio→text | 字幕API追加 |

### P2: 将来拡張

| Gap | 現状 | 完成形 | 修正内容 |
|-----|------|--------|----------|
| characterImages合成 | なし | レイヤー合成 | Remotion側対応 |
| telops配列 | 単一text | 配列 | telop専用テーブル |
| BGM ducking | flag only | 詳細設定 | build_settings拡張 |

---

## 5. Remotion側の確認事項

### 現在のRemotionスキーマ (project-schema.ts)

```typescript
const ProjectSceneSchema = z.object({
  idx: z.number(),
  timing: z.object({
    start_ms: z.number(),
    duration_ms: z.number(),
    head_pad_ms: z.number().default(0),
    tail_pad_ms: z.number().default(0),
  }),
  assets: z.object({
    image: z.object({ url, width, height }).optional(),
    audio: z.object({ url, duration_ms, format }).optional(),
    video_clip: z.object({ url, duration_ms }).optional(),
  }),
  // ...
});
```

### 問題点

1. **timing.start_ms が必須** → 現在のBuildRequestV1には含まれていない
2. **スキーマ不一致** → webapp側のBuildRequestV1とRemotion側のProjectJsonSchemaが別物
3. **シーン1しか処理されない原因** → start_msが全て0になっている可能性

---

## 6. 調査が必要な箇所

### A. webapp → Remotion のJSONマッピング

```
webapp (video-build-helpers.ts)
  ↓ buildBuildRequestV1()
BuildRequestV1 JSON
  ↓ S3にアップロード
  ↓ Lambda経由でRemotionに渡す
Remotion (project-schema.ts)
  ↓ ProjectJsonSchema.parse()
ProjectJson
  ↓ RilarcVideo.tsx
レンダリング
```

**確認必要**: BuildRequestV1 → ProjectJson の変換ロジックはどこにあるか？

### B. start_ms の計算

現在の `buildBuildRequestV1()` は `duration_ms` のみ出力し、`start_ms` を出力していない。
→ これが「シーン1しか繋がらない」原因の可能性大

---

## 7. 根本原因特定 ✅

### 調査結果: スキーマ完全不一致

**webapp側 (aws-video-build-client.ts) が出力するJSON:**
```typescript
interface ProjectJsonScene {
  scene_id: number;
  idx: number;
  role: string;
  title: string;
  dialogue: string;
  asset: { type: 'image' | 'comic' | 'video'; src: string; };
  audio?: { src: string; duration_ms: number; };
  duration_ms: number;  // ← timing オブジェクトではなく直接
  effects: { ken_burns: boolean; };
}
```

**Remotion側 (project-schema.ts) が期待するJSON:**
```typescript
const ProjectSceneSchema = z.object({
  idx: z.number(),
  role: z.string(),
  timing: z.object({
    start_ms: z.number(),     // ← 必須！
    duration_ms: z.number(),  // ← 必須！
    head_pad_ms: z.number().default(0),
    tail_pad_ms: z.number().default(0),
  }),
  assets: z.object({
    image: z.object({ url, width, height }).optional(),
    audio: z.object({ url, duration_ms, format }).optional(),
    video_clip: z.object({ url, duration_ms }).optional(),
  }),
});
```

### 問題の原因（確定）

1. **スキーマが完全に異なる**
   - webapp: `scene.duration_ms`, `scene.asset.src`
   - Remotion: `scene.timing.start_ms`, `scene.assets.image.url`

2. **変換レイヤーが存在しない**
   - `aws-orchestrator-b2` は `project_json` をそのまま Remotion に渡している
   - Remotion の `ProjectJsonSchema.parse()` でバリデーションエラーが発生

3. **start_ms が未計算**
   - webapp は `start_ms` を一切出力していない
   - 累積計算ロジックがどこにも存在しない

---

## 8. 修正方針（Phase R1）

### 推奨: webapp側でRemotionスキーマに合わせる

`buildProjectJson()` を修正して Remotion の `ProjectJsonSchema` に準拠したJSONを出力する。

```typescript
// video-build-helpers.ts 修正案
export function buildProjectJsonForRemotion(
  project: ProjectData,
  scenes: SceneData[],
  settings: VideoBuildSettings
): RemotionProjectJson {
  let currentMs = 0;
  
  const remotionScenes = scenes.map((scene) => {
    const durationMs = computeSceneDurationMs(scene);
    const startMs = currentMs;
    currentMs += durationMs;
    
    return {
      idx: scene.idx,
      role: scene.role || 'main_point',
      title: scene.title || '',
      dialogue: scene.dialogue || '',
      timing: {
        start_ms: startMs,
        duration_ms: durationMs,
        head_pad_ms: 0,
        tail_pad_ms: 0,
      },
      assets: {
        image: scene.active_image ? {
          url: scene.active_image.r2_url,
          width: 1080,
          height: 1920,
        } : undefined,
        audio: scene.active_audio ? {
          url: scene.active_audio.audio_url,
          duration_ms: scene.active_audio.duration_ms,
          format: 'mp3' as const,
        } : undefined,
        video_clip: scene.active_video ? {
          url: scene.active_video.r2_url,
          duration_ms: (scene.active_video.duration_sec || 5) * 1000,
        } : undefined,
      },
      characters: {},
    };
  });
  
  return {
    schema_version: '1.1',
    project_id: project.id,
    project_title: project.title,
    created_at: new Date().toISOString(),
    build_settings: {
      preset: settings.motion?.preset || 'gentle-zoom',
      resolution: { width: 1080, height: 1920 },
      fps: 30,
      codec: 'h264',
      audio: {
        bgm_enabled: settings.bgm?.enabled || false,
        bgm_volume: settings.bgm?.volume || 0.3,
        narration_volume: 1.0,
        duck_bgm_on_voice: true,
      },
      transition: { type: 'fade', duration_ms: 300 },
    },
    global: {
      default_scene_duration_ms: 5000,
      transition_duration_ms: 300,
    },
    scenes: remotionScenes,
    summary: {
      total_scenes: scenes.length,
      total_duration_ms: currentMs,
      has_audio: scenes.some(s => s.active_audio),
      has_video_clips: scenes.some(s => s.active_video),
    },
  };
}
```

---

## 9. 次のアクション（Phase R1実装）

### Step 1: 修正ファイル

1. `/home/user/webapp/src/utils/video-build-helpers.ts`
   - `buildProjectJson()` → Remotionスキーマ準拠に修正
   - start_ms 累積計算を追加

2. `/home/user/webapp/src/routes/video-generation.ts`
   - `buildProjectJson()` の呼び出し箇所を確認

### Step 2: 実装とテスト

```bash
# 1. ローカルビルド
npm run build
pm2 restart webapp

# 2. 本番デプロイ
npm run deploy

# 3. テストビルド実行
# プロジェクト全体をビルドして、全シーンが繋がるか確認
```

### Step 3: 検証項目

1. [ ] Remotion Lambda のログで受信JSONを確認
2. [ ] 生成MP4で全シーンが連続再生されることを確認
3. [ ] 音声同期を確認
