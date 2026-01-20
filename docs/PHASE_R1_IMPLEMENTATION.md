# Phase R1: video-only 完走実装

## 概要

Phase R1 の目的は、Remotion で全シーンを時系列に連結した MP4 を必ず出力することです。

- **対象**: video-only（静止画 + 音声）
- **除外**: comic 吹き出し / テロップ / BGM
- **SSOT**: `start_ms` を webapp 側で確定

## 実装完了日

2026-01-20

## 変更ファイル

### `/src/utils/video-build-helpers.ts`

#### 新規追加型

```typescript
// Phase R1 用シーン型（Remotion ProjectSceneSchema 準拠）
interface RemotionScene_R1 {
  idx: number;
  role: string;
  title: string;
  dialogue: string;
  timing: {
    start_ms: number;       // ★ 必須: 累積計算
    duration_ms: number;    // ★ 必須: SSOT
    head_pad_ms: number;
    tail_pad_ms: number;
  };
  assets: {
    image?: { url, width, height };
    audio?: { url, duration_ms, format };
    video_clip?: { url, duration_ms };  // Phase R3 用
  };
  characters?: { image?: string[]; voice?: string };  // Phase R2+ 用
}

// Phase R1 用プロジェクトJSON型（Remotion ProjectJsonSchema 準拠）
interface RemotionProjectJson_R1 {
  schema_version: '1.1';
  project_id: number;
  project_title: string;
  created_at: string;
  build_settings: {...};
  global: {...};
  assets?: {...};
  scenes: RemotionScene_R1[];
  summary: {...};
}
```

#### 修正関数

```typescript
// buildProjectJson() - Remotionスキーマ完全準拠版
export function buildProjectJson(
  project: ProjectData,
  scenes: SceneData[],
  settings: VideoBuildSettings,
  options?: {...}
): RemotionProjectJson_R1
```

## SSOT ルール

### duration_ms の決定

```typescript
// 優先順位:
// 1. scene.active_audio?.duration_ms + AUDIO_PADDING_MS (500ms)
// 2. computeSceneDurationMs(scene) - 既存ロジック
//    - video: duration_sec * 1000
//    - comic: utterances 合計 + padding
//    - dialogue: text.length * 300ms + padding
//    - default: 3000ms
```

### start_ms の累積計算

```typescript
let currentMs = 0;
scenes.map((scene) => {
  const durationMs = scene.active_audio?.duration_ms 
    ? scene.active_audio.duration_ms + AUDIO_PADDING_MS
    : computeSceneDurationMs(scene);
  
  const startMs = currentMs;
  currentMs += durationMs;
  
  return {
    timing: {
      start_ms: startMs,      // 累積値
      duration_ms: durationMs,
      head_pad_ms: 0,
      tail_pad_ms: 0,
    }
  };
});
```

## 検証結果

### タイミング計算テスト

```
Scene 1: start_ms=0, duration_ms=2500
Scene 2: start_ms=2500, duration_ms=5500
Scene 3: start_ms=8000, duration_ms=4500
Scene 4: start_ms=12500, duration_ms=2500
Scene 5: start_ms=15000, duration_ms=6500
Scene 6: start_ms=21500, duration_ms=2500

Total duration: 24000ms

✅ start_ms is cumulative and increases correctly!
```

## デプロイ状況

- **Cloudflare Pages**: https://webapp-c7n.pages.dev ✅
- **GitHub**: matiuskuma2/webapp ✅ (commit 89d7f42)

## 手動テスト手順

### 1. ビルド実行

```bash
# プロジェクトIDを指定してビルドAPI呼び出し
# (要: 認証セッション)
POST https://webapp-c7n.pages.dev/api/projects/{projectId}/video-builds

# Body
{
  "aspect_ratio": "9:16",
  "resolution": "1080p",
  "fps": 30
}
```

### 2. 生成されたproject.jsonの確認

```bash
# R2からproject.jsonを取得
npx wrangler r2 object get webapp-bucket/video-builds/{buildId}/project.json --remote

# 確認ポイント:
# 1. schema_version: '1.1'
# 2. 各シーンに timing.start_ms が存在
# 3. start_ms が累積（0, n, n+m, ...）
# 4. summary.total_duration_ms が正しい
```

### 3. 生成MP4の確認

- 全シーンが順番に再生される（重ならない）
- 音声ありシーンは音声が再生される
- 総尺が summary.total_duration_ms と一致

## 次のフェーズ

### Phase R2: comic-only

- comic パネルを静止画として扱う（Phase R1 で対応済み）
- 吹き出し (balloons) の Remotion 側レンダリング
- utterances の音声タイミング同期

### Phase R3: hybrid

- generated video (video_generations) の混在
- video_clip.duration_ms の SSOT 決定
- トリミング (start_ms/end_ms) 対応

## 関連ドキュメント

- [PHASE_R0_GAP_ANALYSIS.md](./PHASE_R0_GAP_ANALYSIS.md) - スキーマ差分分析
- [PHASE_R0_SCHEMA_DIFF.md](./PHASE_R0_SCHEMA_DIFF.md) - 実データとRemotionスキーマの差分
