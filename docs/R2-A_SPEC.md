# R2-A: Remotion Balloon 実装仕様書

## 概要

漫画で作った吹き出しを動画でも同じ位置・同じ内容で表示する。
utterance（発話）と同期して「喋ってる間だけ」吹き出しを表示。

## SSOT（Single Source of Truth）

```
scene_utterances (発話 SSOT)
├── scene_balloons (吹き出し SSOT) - utterance_id で紐付け
├── scene_telops (テロップ SSOT) - Phase R2-B
└── scene_motion (モーション SSOT) - Phase R2-C

scenes
├── text_render_mode: 'remotion' | 'baked' | 'none'
├── motion_preset: 'none' | 'kenburns' | 'pan' | 'parallax'
└── motion_params_json: Ken Burns 詳細パラメータ
```

## 描画レイヤー順（Remotion）

```
1. Background Visual (背景画像/動画)
2. Motion (Ken Burns / Pan / Parallax)
3. Balloons (吹き出し) ← R2-A
4. Telops (テロップ) ← R2-B
5. Subtitles (字幕) ← text_render_mode='remotion' 時のみ
6. UI Overlay (デバッグ情報など)
```

## text_render_mode の役割

| 値 | 説明 | Balloons | Telops | Subtitles |
|---|---|---|---|---|
| `remotion` | Remotion で描画 | ✅ 描画 | ✅ 描画 | ✅ 描画 |
| `baked` | 漫画画像に焼き込み済み | ❌ OFF | ❌ OFF | ❌ OFF |
| `none` | 文字演出なし | ❌ OFF | ❌ OFF | ❌ OFF |

## 吹き出し形状（6種）

漫画エディタ (comic-editor-v2.js) と完全互換:

| shape | 名称 | hasTail | writingMode | category |
|---|---|---|---|---|
| `speech_round` | 通常（丸角） | ✅ | horizontal | serif |
| `speech_oval` | 楕円 | ✅ | horizontal | serif |
| `thought_oval` | 思考（楕円） | ✅ | horizontal | serif |
| `mono_box_v` | モノローグ | ❌ | vertical | serif |
| `caption` | 字幕 | ❌ | horizontal | narration |
| `telop_bar` | テロップ | ❌ | horizontal | narration |

## データモデル

### BalloonAsset（Remotion入力）

```typescript
interface BalloonAsset {
  id: number;
  utterance_id: number | null;
  text: string;                    // 表示テキスト（utterance.text から取得）
  start_ms: number;                // 表示開始（utterance.start_ms）
  end_ms: number;                  // 表示終了（utterance.start_ms + duration_ms）
  position: { x: number; y: number };  // 0-1 正規化座標（中心点）
  size: { w: number; h: number };      // 0-1 正規化サイズ
  shape: 'speech_round' | 'speech_oval' | 'thought_oval' | 'mono_box_v' | 'caption' | 'telop_bar';
  tail: {
    enabled: boolean;
    tip_x: number;                 // 0-1 正規化（吹き出し中心からの相対）
    tip_y: number;
  };
  style: {
    writing_mode: 'horizontal' | 'vertical';
    text_align: 'left' | 'center' | 'right';
    font_family: 'gothic' | 'mincho' | 'rounded' | 'handwritten';
    font_weight: number;           // 400 | 700
    font_size: number;             // px (1000px基準)
    line_height: number;           // px
    padding: number;               // px
    bg_color: string;              // #FFFFFF
    text_color: string;            // #111827
    border_color: string;          // #222222
    border_width: number;          // px
  };
  z_index: number;                 // 重なり順（大きいほど前面）
}
```

### RemotionScene_R1（拡張）

```typescript
interface RemotionScene_R1 {
  // ... 既存フィールド ...
  
  // R2-A 追加
  text_render_mode: 'remotion' | 'baked' | 'none';
  balloons?: BalloonAsset[];
}
```

---

# API 設計

## 1. GET /api/scenes/:sceneId/render-kit

シーンの描画に必要な全データを一括取得（編集UI/動画生成用）

### レスポンス

```json
{
  "scene": {
    "id": 1,
    "idx": 1,
    "role": "main_point",
    "title": "タイトル",
    "dialogue": "ダイアログ",
    "display_asset_type": "comic",
    "text_render_mode": "remotion",
    "motion_preset": "kenburns"
  },
  "utterances": [
    {
      "id": 1,
      "order_no": 1,
      "role": "narration",
      "character_key": null,
      "character_name": null,
      "text": "これはナレーションです",
      "audio_generation_id": 10,
      "audio_url": "https://...",
      "duration_ms": 3000,
      "start_ms": 0,
      "end_ms": 3000
    },
    {
      "id": 2,
      "order_no": 2,
      "role": "dialogue",
      "character_key": "taro",
      "character_name": "太郎",
      "text": "こんにちは！",
      "audio_generation_id": 11,
      "audio_url": "https://...",
      "duration_ms": 2500,
      "start_ms": 3000,
      "end_ms": 5500
    }
  ],
  "balloons": [
    {
      "id": 1,
      "utterance_id": 1,
      "display_mode": "voice_window",
      "position": { "x": 0.5, "y": 0.3 },
      "size": { "w": 0.36, "h": 0.18 },
      "shape": "caption",
      "tail": { "enabled": false, "tip_x": 0, "tip_y": 0 },
      "style": {
        "writing_mode": "horizontal",
        "text_align": "center",
        "font_family": "gothic",
        "font_weight": 400,
        "font_size": 24,
        "line_height": 32,
        "padding": 12,
        "bg_color": "transparent",
        "text_color": "#FFFFFF",
        "border_color": "#000000",
        "border_width": 0
      },
      "z_index": 10
    }
  ],
  "telops": [],
  "motion": null,
  "orphaned": {
    "balloons_without_utterance": [],
    "utterances_without_balloon": [2]
  }
}
```

### SQL

```sql
-- Scene基本情報
SELECT id, idx, role, title, dialogue, display_asset_type, 
       text_render_mode, motion_preset, motion_params_json
FROM scenes 
WHERE id = ?

-- Utterances（発話）
SELECT 
  su.id, su.order_no, su.role, su.character_key, su.text,
  su.audio_generation_id,
  ag.r2_url as audio_url,
  ag.duration_ms
FROM scene_utterances su
LEFT JOIN audio_generations ag ON su.audio_generation_id = ag.id AND ag.status = 'completed'
WHERE su.scene_id = ?
ORDER BY su.order_no ASC

-- Balloons（吹き出し）
SELECT 
  id, utterance_id, display_mode,
  x, y, w, h,
  shape, tail_enabled, tail_tip_x, tail_tip_y,
  writing_mode, text_align, font_family, font_weight,
  font_size, line_height, padding,
  bg_color, text_color, border_color, border_width,
  z_index
FROM scene_balloons
WHERE scene_id = ?
ORDER BY z_index ASC

-- Telops（テロップ）- R2-B
SELECT * FROM scene_telops WHERE scene_id = ? ORDER BY order_no ASC

-- Motion（モーション）- R2-C
SELECT * FROM scene_motion WHERE scene_id = ?
```

---

## 2. scene_balloons CRUD API

### POST /api/scenes/:sceneId/balloons

```json
{
  "utterance_id": 1,
  "display_mode": "voice_window",
  "x": 0.5,
  "y": 0.3,
  "w": 0.36,
  "h": 0.18,
  "shape": "speech_round",
  "tail_enabled": true,
  "tail_tip_x": 0.0,
  "tail_tip_y": 0.3,
  "style": {
    "writing_mode": "horizontal",
    "text_align": "center",
    "font_family": "gothic",
    "font_weight": 400,
    "font_size": 18,
    "line_height": 26,
    "padding": 16,
    "bg_color": "#FFFFFF",
    "text_color": "#111827",
    "border_color": "#222222",
    "border_width": 2.5
  },
  "z_index": 10
}
```

### PUT /api/scenes/:sceneId/balloons/:balloonId

同上（部分更新も可）

### DELETE /api/scenes/:sceneId/balloons/:balloonId

### POST /api/scenes/:sceneId/balloons/reorder

```json
{
  "balloon_ids": [3, 1, 2]
}
```

### バリデーションルール

1. `utterance_id` が指定された場合、同一 scene_id の scene_utterances に存在すること
2. `display_mode = 'voice_window'` の場合、`utterance_id` 必須
3. `display_mode = 'manual_window'` の場合、`start_ms` / `end_ms` 必須
4. `x, y, w, h` は 0-1 の範囲
5. `shape` は定義済みの6種のみ
6. `z_index` は整数（デフォルト: 10）

---

## 3. PATCH /api/scenes/:sceneId/render-settings

```json
{
  "text_render_mode": "remotion",
  "motion_preset": "kenburns"
}
```

---

# Remotion 実装

## Balloon.tsx

```tsx
// video-build-remotion/src/components/Balloon.tsx

import React from 'react';
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

interface BalloonProps {
  balloon: BalloonAsset;
  canvasWidth: number;
  canvasHeight: number;
}

const FADE_DURATION_FRAMES = 6; // 0.2s @ 30fps

// フォントファミリーマッピング
const FONT_FAMILY_MAP: Record<string, string> = {
  gothic: '"Noto Sans JP", sans-serif',
  mincho: '"Noto Serif JP", serif',
  rounded: '"M PLUS Rounded 1c", sans-serif',
  handwritten: '"Yomogi", cursive',
};

export const Balloon: React.FC<BalloonProps> = ({ balloon, canvasWidth, canvasHeight }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // frame → ms 変換
  const currentMs = (frame / fps) * 1000;

  // 表示判定
  const isVisible = currentMs >= balloon.start_ms && currentMs < balloon.end_ms;
  if (!isVisible) return null;

  // フェードイン/アウト計算
  const durationFrames = ((balloon.end_ms - balloon.start_ms) / 1000) * fps;
  const startFrame = (balloon.start_ms / 1000) * fps;
  const relativeFrame = frame - startFrame;

  const fadeInOpacity = interpolate(
    relativeFrame,
    [0, FADE_DURATION_FRAMES],
    [0, 1],
    { extrapolateRight: 'clamp' }
  );
  const fadeOutOpacity = interpolate(
    relativeFrame,
    [durationFrames - FADE_DURATION_FRAMES, durationFrames],
    [1, 0],
    { extrapolateLeft: 'clamp' }
  );
  const opacity = Math.min(fadeInOpacity, fadeOutOpacity);

  // 正規化座標 → px 変換
  const x = balloon.position.x * canvasWidth;
  const y = balloon.position.y * canvasHeight;
  const w = balloon.size.w * canvasWidth;
  const h = balloon.size.h * canvasHeight;

  // スタイル
  const { style } = balloon;
  const fontFamily = FONT_FAMILY_MAP[style.font_family] || FONT_FAMILY_MAP.gothic;

  // 形状別のスタイル
  const shapeStyle = getShapeStyle(balloon.shape, style);

  return (
    <div
      style={{
        position: 'absolute',
        left: x - w / 2,
        top: y - h / 2,
        width: w,
        height: h,
        opacity,
        zIndex: balloon.z_index,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...shapeStyle.container,
      }}
    >
      {/* 吹き出し形状（SVG） */}
      <svg
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          overflow: 'visible',
        }}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
      >
        {renderBubbleShape(balloon, w, h)}
      </svg>

      {/* テキスト */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          padding: style.padding,
          fontFamily,
          fontSize: style.font_size,
          fontWeight: style.font_weight,
          lineHeight: `${style.line_height}px`,
          color: style.text_color,
          textAlign: style.text_align as any,
          writingMode: style.writing_mode === 'vertical' ? 'vertical-rl' : 'horizontal-tb',
          textOrientation: style.writing_mode === 'vertical' ? 'mixed' : undefined,
          ...shapeStyle.text,
        }}
      >
        {balloon.text}
      </div>
    </div>
  );
};

// 形状別スタイル
function getShapeStyle(shape: string, style: any) {
  switch (shape) {
    case 'caption':
    case 'telop_bar':
      return {
        container: {},
        text: {
          textShadow: `
            -${style.border_width}px -${style.border_width}px 0 ${style.border_color},
            ${style.border_width}px -${style.border_width}px 0 ${style.border_color},
            -${style.border_width}px ${style.border_width}px 0 ${style.border_color},
            ${style.border_width}px ${style.border_width}px 0 ${style.border_color}
          `,
        },
      };
    default:
      return { container: {}, text: {} };
  }
}

// SVG形状描画
function renderBubbleShape(balloon: BalloonAsset, w: number, h: number) {
  const { shape, style, tail } = balloon;

  switch (shape) {
    case 'speech_round':
      return (
        <>
          <rect
            x={style.border_width / 2}
            y={style.border_width / 2}
            width={w - style.border_width}
            height={h - style.border_width}
            rx={20}
            ry={20}
            fill={style.bg_color}
            stroke={style.border_color}
            strokeWidth={style.border_width}
          />
          {tail.enabled && renderTail(balloon, w, h)}
        </>
      );

    case 'speech_oval':
      return (
        <>
          <ellipse
            cx={w / 2}
            cy={h / 2}
            rx={w / 2 - style.border_width / 2}
            ry={h / 2 - style.border_width / 2}
            fill={style.bg_color}
            stroke={style.border_color}
            strokeWidth={style.border_width}
          />
          {tail.enabled && renderTail(balloon, w, h)}
        </>
      );

    case 'thought_oval':
      return (
        <>
          <ellipse
            cx={w / 2}
            cy={h / 2}
            rx={w / 2 - style.border_width / 2}
            ry={h / 2 - style.border_width / 2}
            fill={style.bg_color}
            stroke={style.border_color}
            strokeWidth={style.border_width}
            strokeDasharray="8 4"
          />
          {tail.enabled && renderThoughtBubbles(balloon, w, h)}
        </>
      );

    case 'mono_box_v':
      return (
        <rect
          x={style.border_width / 2}
          y={style.border_width / 2}
          width={w - style.border_width}
          height={h - style.border_width}
          rx={6}
          ry={6}
          fill={style.bg_color}
          stroke={style.border_color}
          strokeWidth={style.border_width}
        />
      );

    case 'caption':
      // 字幕: 背景なし、テキストストロークのみ
      return null;

    case 'telop_bar':
      return (
        <rect
          x={0}
          y={0}
          width={w}
          height={h}
          rx={12}
          fill={style.bg_color}
        />
      );

    default:
      return (
        <rect
          x={0}
          y={0}
          width={w}
          height={h}
          rx={10}
          fill={style.bg_color}
          stroke={style.border_color}
          strokeWidth={style.border_width}
        />
      );
  }
}

// 吹き出しの尻尾
function renderTail(balloon: BalloonAsset, w: number, h: number) {
  const { tail, style } = balloon;
  const tipX = w / 2 + tail.tip_x * w;
  const tipY = h + tail.tip_y * h;

  return (
    <polygon
      points={`${w / 2 - 15},${h - 5} ${tipX},${tipY} ${w / 2 + 15},${h - 5}`}
      fill={style.bg_color}
      stroke={style.border_color}
      strokeWidth={style.border_width}
    />
  );
}

// 思考吹き出しの小さな丸
function renderThoughtBubbles(balloon: BalloonAsset, w: number, h: number) {
  const { tail, style } = balloon;
  const tipX = w / 2 + tail.tip_x * w;
  const tipY = h + tail.tip_y * h;

  return (
    <>
      <circle cx={w / 2} cy={h + 8} r={6} fill={style.bg_color} stroke={style.border_color} strokeWidth={style.border_width} />
      <circle cx={tipX * 0.7 + w * 0.15} cy={tipY * 0.5 + h * 0.25} r={4} fill={style.bg_color} stroke={style.border_color} strokeWidth={style.border_width} />
      <circle cx={tipX * 0.9 + w * 0.05} cy={tipY * 0.8 + h * 0.1} r={3} fill={style.bg_color} stroke={style.border_color} strokeWidth={style.border_width} />
    </>
  );
}

export default Balloon;
```

## BalloonLayer.tsx

```tsx
// video-build-remotion/src/components/BalloonLayer.tsx

import React from 'react';
import { Balloon } from './Balloon';

interface BalloonLayerProps {
  balloons: BalloonAsset[];
  textRenderMode: 'remotion' | 'baked' | 'none';
  canvasWidth: number;
  canvasHeight: number;
}

export const BalloonLayer: React.FC<BalloonLayerProps> = ({
  balloons,
  textRenderMode,
  canvasWidth,
  canvasHeight,
}) => {
  // 二重表示事故防止: remotion 以外は描画しない
  if (textRenderMode !== 'remotion') {
    return null;
  }

  // z_index でソート
  const sortedBalloons = [...balloons].sort((a, b) => a.z_index - b.z_index);

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: canvasWidth,
        height: canvasHeight,
        pointerEvents: 'none',
      }}
    >
      {sortedBalloons.map((balloon) => (
        <Balloon
          key={balloon.id}
          balloon={balloon}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
        />
      ))}
    </div>
  );
};
```

## Scene.tsx 統合

```tsx
// video-build-remotion/src/components/Scene.tsx (抜粋)

import { BalloonLayer } from './BalloonLayer';

export const Scene: React.FC<SceneProps> = ({ scene, canvasWidth, canvasHeight }) => {
  return (
    <div style={{ position: 'relative', width: canvasWidth, height: canvasHeight }}>
      {/* 1. Background Visual */}
      <BackgroundLayer scene={scene} />
      
      {/* 2. Motion (Ken Burns / Pan) */}
      <MotionWrapper scene={scene}>
        <ImageLayer scene={scene} />
      </MotionWrapper>
      
      {/* 3. Balloons (R2-A) */}
      <BalloonLayer
        balloons={scene.balloons || []}
        textRenderMode={scene.text_render_mode || 'remotion'}
        canvasWidth={canvasWidth}
        canvasHeight={canvasHeight}
      />
      
      {/* 4. Telops (R2-B) - 将来実装 */}
      {/* <TelopLayer ... /> */}
      
      {/* 5. Subtitles */}
      {scene.text_render_mode === 'remotion' && (
        <SubtitleLayer scene={scene} />
      )}
    </div>
  );
};
```

---

# 漫画エディタ → DB保存 移行計画

## 現状

- 吹き出しデータは `comic_data` JSON に保存
- `comic_data.utterances[]` に発話と吹き出し情報が混在

## 目標

- `scene_utterances` に発話 SSOT
- `scene_balloons` に吹き出し SSOT
- `comic_data` は後方互換のため当面維持

## Lazy Migration

```typescript
// GET /api/scenes/:sceneId/render-kit で呼び出し

async function lazyMigrateComicData(sceneId: number, comicData: any, db: D1Database) {
  // 既に移行済みならスキップ
  const existingBalloons = await db.prepare(
    'SELECT COUNT(*) as count FROM scene_balloons WHERE scene_id = ?'
  ).bind(sceneId).first<{ count: number }>();
  
  if (existingBalloons && existingBalloons.count > 0) {
    return; // 既に移行済み
  }
  
  const utterances = comicData?.utterances || [];
  if (utterances.length === 0) return;
  
  // 1. scene_utterances の作成/確認
  for (let i = 0; i < utterances.length; i++) {
    const utt = utterances[i];
    
    // 既存の utterance を検索または作成
    let utteranceId = await findOrCreateUtterance(db, sceneId, utt, i + 1);
    
    // 2. scene_balloons の作成
    if (utt.bubble) {
      await db.prepare(`
        INSERT INTO scene_balloons (
          scene_id, utterance_id, display_mode,
          x, y, w, h, shape,
          tail_enabled, tail_tip_x, tail_tip_y,
          writing_mode, text_align, font_family, font_weight,
          font_size, line_height, padding,
          bg_color, text_color, border_color, border_width,
          z_index, order_no
        ) VALUES (?, ?, 'voice_window', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        sceneId,
        utteranceId,
        utt.bubble.x || 0.5,
        utt.bubble.y || 0.5,
        utt.bubble.w || 0.3,
        utt.bubble.h || 0.2,
        utt.bubble.type || 'speech_round',
        utt.bubble.tail?.enabled ?? true,
        utt.bubble.tail?.tip_x ?? 0,
        utt.bubble.tail?.tip_y ?? 0.3,
        utt.bubble.style?.writingMode || 'horizontal',
        utt.bubble.style?.textAlign || 'center',
        utt.bubble.style?.fontFamily || 'gothic',
        utt.bubble.style?.fontWeight || 400,
        utt.bubble.style?.fontSize || 18,
        utt.bubble.style?.lineHeight || 26,
        utt.bubble.style?.padding || 16,
        utt.bubble.style?.bgColor || '#FFFFFF',
        utt.bubble.style?.textColor || '#111827',
        utt.bubble.style?.borderColor || '#222222',
        utt.bubble.style?.borderWidth || 2.5,
        10 + i,
        i + 1
      ).run();
    }
  }
}
```

---

# テスト手順

## 最短テスト（R2-A 検証）

1. テストデータ準備
   - シーン1つ（text_render_mode='remotion'）
   - utterance 2つ（ナレーション + 対話）
   - balloon 2つ（utterance に紐付け）
   - 音声生成完了

2. API 確認
   ```bash
   curl http://localhost:3000/api/scenes/1/render-kit | jq
   ```

3. buildProjectJson 出力確認
   ```bash
   curl http://localhost:3000/api/projects/57/video-builds/preflight | jq '.scenes[0].balloons'
   ```

4. Remotion プレビュー
   - balloons が表示されること
   - utterance 区間でのみ表示されること
   - フェードイン/アウトが動作すること

---

# 次のステップ

## R2-B: テロップ対応
- scene_telops CRUD
- TelopLayer.tsx 実装

## R2-C: モーション対応
- scene_motion CRUD
- MotionWrapper.tsx 拡張（parallax 等）

## 漫画エディタ統合
- comic-editor-v2.js → DB 保存に完全移行
- リアルタイムプレビュー
