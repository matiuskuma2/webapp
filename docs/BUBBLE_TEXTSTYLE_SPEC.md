# 漫画吹き出し textStyle/timing 設計書

作成日: 2026-01-19
目的: Remotion統合に向けた吹き出しスタイル・タイミング制御の入力契約定義

---

## 1. データモデル拡張

### 1.1 bubble.textStyle（新規追加）

```typescript
interface BubbleTextStyle {
  // 書字方向
  writingMode: 'horizontal' | 'vertical';  // 横書き / 縦書き
  
  // フォント設定
  fontFamily: 'gothic' | 'mincho' | 'rounded' | 'handwritten';
  fontWeight: 'normal' | 'bold';
  fontScale: number;  // 0.5 - 2.0（1.0 = 100%）
  
  // テキスト配置（オプション）
  textAlign?: 'left' | 'center' | 'right';
  lineHeight?: number;  // 1.0 - 2.0
}
```

### 1.2 bubble.timing（新規追加）

```typescript
interface BubbleTiming {
  // 表示タイミング（ミリ秒）
  show_from_ms: number;
  show_until_ms: number;
  
  // 表示モード
  mode: 'manual' | 'voice_active' | 'scene_duration';
  // manual: 手動指定（show_from_ms/show_until_ms使用）
  // voice_active: セリフ音声再生中のみ表示
  // scene_duration: シーン全体で表示
  
  // アニメーション（オプション）
  animation?: {
    enter: 'none' | 'fade' | 'pop' | 'slide';
    exit: 'none' | 'fade' | 'pop' | 'slide';
    duration_ms?: number;  // デフォルト: 200
  };
}
```

### 1.3 デフォルト値

```javascript
const DEFAULT_TEXT_STYLE = {
  writingMode: 'horizontal',
  fontFamily: 'gothic',
  fontWeight: 'normal',
  fontScale: 1.0,
  textAlign: 'center',
  lineHeight: 1.4
};

const DEFAULT_TIMING = {
  show_from_ms: 0,
  show_until_ms: -1,  // -1 = シーン終了まで
  mode: 'scene_duration',
  animation: {
    enter: 'fade',
    exit: 'fade',
    duration_ms: 200
  }
};
```

---

## 2. フォントマッピング（Remotion用）

| fontFamily | Remotion CSS | 日本語フォント例 |
|------------|--------------|------------------|
| gothic | `'Noto Sans JP', sans-serif` | ゴシック体 |
| mincho | `'Noto Serif JP', serif` | 明朝体 |
| rounded | `'M PLUS Rounded 1c', sans-serif` | 丸ゴシック |
| handwritten | `'Yomogi', cursive` | 手書き風 |

### 2.1 フォントロード（Remotion Composition）

```tsx
// remotion-composition/fonts.ts
import { loadFonts } from '@remotion/google-fonts/NotoSansJP';
import { loadFonts as loadSerifFonts } from '@remotion/google-fonts/NotoSerifJP';

export const fontLoader = async () => {
  await Promise.all([
    loadFonts('normal', { weights: ['400', '700'] }),
    loadSerifFonts('normal', { weights: ['400', '700'] }),
  ]);
};
```

---

## 3. writingMode 実装

### 3.1 CSS実装

```css
/* 横書き（デフォルト） */
.bubble-text-horizontal {
  writing-mode: horizontal-tb;
  text-orientation: mixed;
}

/* 縦書き */
.bubble-text-vertical {
  writing-mode: vertical-rl;
  text-orientation: upright;
  /* 句読点の位置調整 */
  text-combine-upright: none;
}
```

### 3.2 Remotion コンポーネント

```tsx
// remotion-composition/BubbleText.tsx
import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';

interface BubbleTextProps {
  text: string;
  textStyle: BubbleTextStyle;
  timing: BubbleTiming;
  position: { x: number; y: number };
}

export const BubbleText: React.FC<BubbleTextProps> = ({
  text,
  textStyle,
  timing,
  position
}) => {
  const frame = useCurrentFrame();
  const fps = 30;
  
  const showFromFrame = Math.floor((timing.show_from_ms / 1000) * fps);
  const showUntilFrame = timing.show_until_ms === -1 
    ? Infinity 
    : Math.floor((timing.show_until_ms / 1000) * fps);
  
  // 表示判定
  if (frame < showFromFrame || frame > showUntilFrame) {
    return null;
  }
  
  // アニメーション
  const enterDuration = (timing.animation?.duration_ms || 200) / 1000 * fps;
  const opacity = interpolate(
    frame,
    [showFromFrame, showFromFrame + enterDuration],
    [0, 1],
    { extrapolateRight: 'clamp' }
  );
  
  const fontFamilyMap = {
    gothic: '"Noto Sans JP", sans-serif',
    mincho: '"Noto Serif JP", serif',
    rounded: '"M PLUS Rounded 1c", sans-serif',
    handwritten: '"Yomogi", cursive'
  };
  
  return (
    <div
      style={{
        position: 'absolute',
        left: `${position.x * 100}%`,
        top: `${position.y * 100}%`,
        transform: 'translate(-50%, -50%)',
        opacity,
        writingMode: textStyle.writingMode === 'vertical' ? 'vertical-rl' : 'horizontal-tb',
        fontFamily: fontFamilyMap[textStyle.fontFamily],
        fontWeight: textStyle.fontWeight === 'bold' ? 700 : 400,
        fontSize: `${textStyle.fontScale * 24}px`,
        textAlign: textStyle.textAlign || 'center',
        lineHeight: textStyle.lineHeight || 1.4,
      }}
    >
      {text}
    </div>
  );
};
```

---

## 4. BuildRequest v1.1 拡張案

### 4.1 BuildBubbleV1 拡張

```typescript
interface BuildBubbleV1_1 {
  // 既存フィールド（v1.0）
  id: string;
  text: string;
  type: 'speech' | 'thought' | 'narration' | 'shout' | 'whisper' | 'effect';
  position: { x: number; y: number };
  
  // 新規フィールド（v1.1）
  textStyle?: BubbleTextStyle;  // 未設定時はデフォルト
  timing?: BubbleTiming;        // 未設定時はデフォルト
}
```

### 4.2 マイグレーション戦略

1. **DB変更なし**: comic_data JSON に textStyle/timing を追加
2. **後方互換**: 未設定の場合はデフォルト値を適用
3. **UI先行**: 漫画エディタで設定可能にする
4. **Remotion対応**: BuildRequest生成時に textStyle/timing を含める

---

## 5. UI変更案

### 5.1 吹き出し選択時の右パネル

```
┌─────────────────────────────────────┐
│ 吹き出しスタイル設定                │
├─────────────────────────────────────┤
│                                     │
│ 書字方向:                           │
│ [横書き] [縦書き]                   │
│                                     │
│ フォント:                           │
│ [▼ ゴシック体        ]             │
│    - ゴシック体                     │
│    - 明朝体                         │
│    - 丸ゴシック                     │
│    - 手書き風                       │
│                                     │
│ 太字: [ ] 有効                      │
│                                     │
│ 文字サイズ:                         │
│ [─────●─────] 100%                 │
│ 50%       150%                      │
│                                     │
├─────────────────────────────────────┤
│ 表示タイミング                      │
├─────────────────────────────────────┤
│                                     │
│ モード:                             │
│ [▼ シーン全体で表示  ]             │
│    - シーン全体で表示               │
│    - セリフ再生中のみ               │
│    - 手動指定                       │
│                                     │
│ (手動指定時のみ表示)                │
│ 開始: [  0  ] ms                    │
│ 終了: [ 2000 ] ms                   │
│                                     │
│ アニメーション:                     │
│ 入場: [▼ フェード ]                │
│ 退場: [▼ フェード ]                │
│                                     │
└─────────────────────────────────────┘
```

### 5.2 comic-editor-v2.js への追加

```javascript
// 吹き出しスタイル編集UI
function renderBubbleStylePanel(bubble) {
  return `
    <div class="bubble-style-panel p-4 bg-white border rounded-lg">
      <h4 class="font-bold mb-3">吹き出しスタイル設定</h4>
      
      <!-- 書字方向 -->
      <div class="mb-4">
        <label class="block text-sm font-medium mb-2">書字方向</label>
        <div class="flex gap-2">
          <button 
            class="px-3 py-2 rounded ${bubble.textStyle?.writingMode !== 'vertical' ? 'bg-blue-600 text-white' : 'bg-gray-200'}"
            onclick="setBubbleWritingMode('${bubble.id}', 'horizontal')"
          >横書き</button>
          <button 
            class="px-3 py-2 rounded ${bubble.textStyle?.writingMode === 'vertical' ? 'bg-blue-600 text-white' : 'bg-gray-200'}"
            onclick="setBubbleWritingMode('${bubble.id}', 'vertical')"
          >縦書き</button>
        </div>
      </div>
      
      <!-- フォント選択 -->
      <div class="mb-4">
        <label class="block text-sm font-medium mb-2">フォント</label>
        <select 
          class="w-full p-2 border rounded"
          onchange="setBubbleFont('${bubble.id}', this.value)"
        >
          <option value="gothic" ${bubble.textStyle?.fontFamily === 'gothic' ? 'selected' : ''}>ゴシック体</option>
          <option value="mincho" ${bubble.textStyle?.fontFamily === 'mincho' ? 'selected' : ''}>明朝体</option>
          <option value="rounded" ${bubble.textStyle?.fontFamily === 'rounded' ? 'selected' : ''}>丸ゴシック</option>
          <option value="handwritten" ${bubble.textStyle?.fontFamily === 'handwritten' ? 'selected' : ''}>手書き風</option>
        </select>
      </div>
      
      <!-- 太字 -->
      <div class="mb-4">
        <label class="flex items-center gap-2">
          <input 
            type="checkbox" 
            ${bubble.textStyle?.fontWeight === 'bold' ? 'checked' : ''}
            onchange="setBubbleBold('${bubble.id}', this.checked)"
          >
          <span class="text-sm">太字</span>
        </label>
      </div>
      
      <!-- 文字サイズ -->
      <div class="mb-4">
        <label class="block text-sm font-medium mb-2">
          文字サイズ: <span id="fontScaleValue-${bubble.id}">${Math.round((bubble.textStyle?.fontScale || 1.0) * 100)}%</span>
        </label>
        <input 
          type="range" 
          min="50" max="200" step="10"
          value="${Math.round((bubble.textStyle?.fontScale || 1.0) * 100)}"
          class="w-full"
          oninput="setBubbleFontScale('${bubble.id}', this.value)"
        >
      </div>
    </div>
  `;
}
```

---

## 6. 実装フェーズ

### Phase 3-A: データモデル（1-2日）
- [ ] comic_data の JSON スキーマに textStyle/timing を追加
- [ ] デフォルト値の定義
- [ ] 後方互換性の確保

### Phase 3-B: UI実装（2-3日）
- [ ] comic-editor-v2.js にスタイルパネル追加
- [ ] 書字方向トグル
- [ ] フォント選択
- [ ] 太字・サイズ設定
- [ ] タイミングモード選択

### Phase 3-C: Remotion統合（3-5日）
- [ ] BuildRequest v1.1 に textStyle/timing を追加
- [ ] video-build-helpers.ts の更新
- [ ] Remotion コンポーネント実装
- [ ] フォントロード設定

### Phase 3-D: テスト（1-2日）
- [ ] 縦書き・横書きの表示確認
- [ ] フォント切り替えの動作確認
- [ ] タイミング制御の動作確認
- [ ] E2Eテスト: 漫画モード動画生成

---

## 7. 関連ファイル

| ファイル | 役割 |
|----------|------|
| `src/routes/comic.ts` | 漫画データAPI |
| `public/static/comic-editor-v2.js` | 漫画エディタUI |
| `src/utils/video-build-helpers.ts` | BuildRequest生成 |
| `docs/VIDEO_BUILD_SSOT.md` | BuildRequest仕様 |
| `docs/BUBBLE_TEXTSTYLE_SPEC.md` | この文書 |

---

## 8. 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-01-19 | 初版作成（textStyle/timing設計） |
