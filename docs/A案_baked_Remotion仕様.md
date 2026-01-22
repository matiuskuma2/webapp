# A案 baked - Remotion 表示仕様

## 概要

A案 baked は「文字入りバブル画像」を素材として使用し、Remotion はタイミング制御のみを行うモードです。

### 仕様固定ルール

| 項目 | 内容 |
|------|------|
| **定義** | 漫画制作で「文字入りバブルPNG」を作成し、Remotion はその画像を表示 |
| **文字描画** | Remotion では「描かない」、画像として表示 |
| **見た目** | 漫画制作側で 100% 確定（SSOT） |

### text_render_mode の意味

| 値 | Remotion の動作 |
|----|----------------|
| `remotion` | style を使って文字を描画（従来方式） |
| `baked` | `bubble_image_url` の画像を表示（文字描画なし） |
| `none` | balloons を出力しない |

---

## project.json 構造（A案 baked 対応）

### scene 構造

```typescript
interface RemotionScene {
  idx: number;
  role: string;
  title: string;
  dialogue: string;
  timing: {
    start_ms: number;
    duration_ms: number;
    head_pad_ms: number;
    tail_pad_ms: number;
  };
  
  // ★ A案 baked の判定に使用
  text_render_mode: 'remotion' | 'baked' | 'none';
  
  assets: {
    image?: { url: string; width: number; height: number; };
    audio?: { url: string; duration_ms: number; format: string; };
    voices?: VoiceAsset[];
  };
  
  // ★ A案 baked: balloons に bubble_image_url が含まれる
  balloons?: BalloonAsset[];
  
  motion?: { id: string; motion_type: string; params: object; };
}
```

### BalloonAsset 構造（A案 baked 対応）

```typescript
interface BalloonAsset {
  id: string;
  utterance_id: number;
  text: string;
  
  // タイミング（utterance の時間窓）
  start_ms: number;
  end_ms: number;
  
  // 位置・サイズ（0-1 正規化座標）
  position: { x: number; y: number };
  size: { w: number; h: number };
  
  // 形状
  shape: 'round' | 'square' | 'thought' | 'shout' | 'caption';
  
  // しっぽ
  tail: {
    enabled: boolean;
    tip_x: number;
    tip_y: number;
  };
  
  // スタイル（remotion モード時のみ使用）
  style: {
    writing_mode: 'horizontal' | 'vertical';
    text_align: 'left' | 'center' | 'right';
    font_family: string;
    font_weight: number;
    font_size: number;
    line_height: number;
    padding: number;
    bg_color: string;
    text_color: string;
    border_color: string;
    border_width: number;
  };
  
  z_index: number;
  
  // ========================================
  // ★ A案 baked 専用フィールド
  // ========================================
  
  /** 文字入りバブル画像URL（baked モード時に使用） */
  bubble_image_url?: string;
  
  /** バブル画像の実サイズ（ピクセル） */
  bubble_image_size?: {
    width: number;
    height: number;
  };
}
```

---

## Remotion 実装ガイド

### 1. BalloonOverlay コンポーネント

```tsx
import { Img } from 'remotion';

interface BalloonOverlayProps {
  balloon: BalloonAsset;
  textRenderMode: 'remotion' | 'baked' | 'none';
  frame: number;
  fps: number;
  videoWidth: number;
  videoHeight: number;
}

export const BalloonOverlay: React.FC<BalloonOverlayProps> = ({
  balloon,
  textRenderMode,
  frame,
  fps,
  videoWidth,
  videoHeight,
}) => {
  // 現在時刻（ミリ秒）
  const currentMs = (frame / fps) * 1000;
  
  // 表示判定：start_ms <= currentMs < end_ms
  const isVisible = balloon.start_ms <= currentMs && currentMs < balloon.end_ms;
  
  if (!isVisible) return null;
  
  // ========================================
  // A案 baked: 画像があれば画像を表示
  // ========================================
  if (textRenderMode === 'baked' && balloon.bubble_image_url) {
    return (
      <Img
        src={balloon.bubble_image_url}
        style={{
          position: 'absolute',
          left: `${balloon.position.x * 100}%`,
          top: `${balloon.position.y * 100}%`,
          width: `${balloon.size.w * 100}%`,
          height: `${balloon.size.h * 100}%`,
          transform: 'translate(-50%, -50%)', // 中心配置
          zIndex: balloon.z_index,
          objectFit: 'contain',
        }}
      />
    );
  }
  
  // ========================================
  // remotion モード: style で描画（従来のロジック）
  // ========================================
  if (textRenderMode === 'remotion') {
    return (
      <BalloonWithText
        balloon={balloon}
        videoWidth={videoWidth}
        videoHeight={videoHeight}
      />
    );
  }
  
  // none モード: 何も表示しない
  return null;
};
```

### 2. SceneComposition での使用

```tsx
export const SceneComposition: React.FC<SceneProps> = ({
  scene,
  frame,
  fps,
}) => {
  const textRenderMode = scene.text_render_mode || 'remotion';
  
  return (
    <AbsoluteFill>
      {/* ベース画像（漫画 or AI画像） */}
      {scene.assets.image && (
        <Img
          src={scene.assets.image.url}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}
      
      {/* バルーンオーバーレイ */}
      {scene.balloons?.map((balloon) => (
        <BalloonOverlay
          key={balloon.id}
          balloon={balloon}
          textRenderMode={textRenderMode}
          frame={frame}
          fps={fps}
          videoWidth={scene.assets.image?.width || 1080}
          videoHeight={scene.assets.image?.height || 1920}
        />
      ))}
      
      {/* 音声再生 */}
      {scene.assets.voices?.map((voice) => (
        <VoicePlayer key={voice.id} voice={voice} frame={frame} fps={fps} />
      ))}
    </AbsoluteFill>
  );
};
```

### 3. 表示タイミングの計算

```typescript
// utterance の時間窓で表示/非表示を制御
function shouldShowBalloon(
  balloon: BalloonAsset,
  sceneStartMs: number,
  frame: number,
  fps: number
): boolean {
  // シーン内の相対時刻
  const sceneRelativeMs = (frame / fps) * 1000;
  
  // バルーンの表示区間（シーン内の相対時刻）
  const balloonStart = balloon.start_ms;
  const balloonEnd = balloon.end_ms;
  
  return balloonStart <= sceneRelativeMs && sceneRelativeMs < balloonEnd;
}
```

---

## 事故防止ルール

### 二重表示の防止

| シーン種別 | text_render_mode | 字幕コンポーネント | バルーン表示 |
|-----------|------------------|-------------------|--------------|
| 漫画（comic） | `baked`（デフォルト） | OFF | bubble_image_url を表示 |
| 静止画（image） | `remotion` | ON（任意） | style で描画 |
| 静止画（image） | `baked` | OFF | bubble_image_url を表示 |
| すべて | `none` | OFF | なし |

### 警告条件

```typescript
// 二重表示の警告
if (scene.display_asset_type === 'comic' && scene.text_render_mode === 'remotion') {
  console.warn(
    `[Warning] Scene ${scene.idx}: comic with text_render_mode='remotion' may cause double text.`
  );
}

// baked モードで画像がない
if (scene.text_render_mode === 'baked') {
  for (const balloon of scene.balloons || []) {
    if (!balloon.bubble_image_url) {
      console.warn(
        `[Warning] Balloon ${balloon.id}: baked mode but no bubble_image_url, skipping.`
      );
    }
  }
}
```

---

## まとめ

A案 baked の核心は：

1. **漫画制作側で文字入りバブル画像（PNG）を作成**
2. **Remotion はその画像を `start_ms` ～ `end_ms` の間だけ表示**
3. **Remotion で文字を描画しない（テキストレンダリングなし）**
4. **見た目は漫画制作側で 100% 確定（SSOT）**

これにより、フォント・縦書き・サイズ・配置などの見た目を完全に維持したまま動画化が可能になります。
