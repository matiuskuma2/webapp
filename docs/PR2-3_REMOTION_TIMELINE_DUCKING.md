# PR2-3: Remotion Timeline Ducking 実装仕様書

## 概要

Remotion側で `projectJson.build_settings.audio_automation.timeline_bgm` を読み取り、
指定された区間でprojectBGMの音量を動的に変更する機能を実装する。

## SSOT（確定仕様）

### 基本ルール

1. **二重BGMは基本しない**（映画と同じ）
   - sceneBGM が鳴っている区間は projectBGM を 0 にしてミュート
   
2. **Timeline ducking は "必要な時だけ"**
   - 「セリフが聞こえないからこの区間だけBGM下げて」等の用途
   
3. **SFX/音声はBGMと重なるのが普通**
   - 下げない（必要なら別途指示）
   
4. **ダッキング対象は projectBGM のみ**
   - sceneBGM・SFX・voice は PR2-3 では触らない

### 優先順位（音量決定ロジック）

```
1. sceneBGM区間 → projectBGM = 0 （最優先でミュート）
2. timeline_bgm 区間 → そのカーブを適用（フェードイン/アウト含む）
3. それ以外 → baseVolume（デフォルト音量）
```

## 入力データ構造

`projectJson.build_settings.audio_automation.timeline_bgm` に以下の配列が入る：

```typescript
interface TimelineBgmEntry {
  id: string;                    // 一意ID（例: "auto_1706660000000_abc123"）
  type: 'duck' | 'set_volume';   // 操作タイプ
  start_ms: number;              // 開始時間（ミリ秒）
  end_ms: number;                // 終了時間（ミリ秒）
  volume: number;                // 目標音量 (0-1)
  fade_in_ms?: number;           // フェードイン時間（デフォルト: 200ms）
  fade_out_ms?: number;          // フェードアウト時間（デフォルト: 200ms）
}
```

### 例

```json
{
  "build_settings": {
    "audio_automation": {
      "timeline_bgm": [
        {
          "id": "auto_1706660000000_abc123",
          "type": "duck",
          "start_ms": 70000,
          "end_ms": 85000,
          "volume": 0.15,
          "fade_in_ms": 200,
          "fade_out_ms": 200
        }
      ]
    }
  }
}
```

## 実装コード例

### 1. 音量計算関数

```typescript
type TimelineBgmEntry = {
  id: string;
  type: 'duck' | 'set_volume';
  start_ms: number;
  end_ms: number;
  volume: number;
  fade_in_ms?: number;
  fade_out_ms?: number;
};

/**
 * Timeline BGM エントリから現在フレームでの音量を計算
 * 
 * @param frame 現在のフレーム
 * @param fps FPS
 * @param baseVolume ベース音量
 * @param entries Timeline BGM エントリ配列
 * @returns 適用後の音量
 */
function volumeFromTimeline(
  frame: number,
  fps: number,
  baseVolume: number,
  entries: TimelineBgmEntry[] | undefined
): number {
  if (!entries || entries.length === 0) return baseVolume;

  // 複数区間が重なったら「一番小さい音量」を採用（＝最も強いduckが勝つ）
  let minVol = baseVolume;

  for (const e of entries) {
    const fadeIn = e.fade_in_ms ?? 200;
    const fadeOut = e.fade_out_ms ?? 200;

    // ms → frame 変換
    const startF = Math.round((e.start_ms / 1000) * fps);
    const endF = Math.round((e.end_ms / 1000) * fps);
    
    if (endF <= startF) continue;

    const fadeInF = Math.max(1, Math.round((fadeIn / 1000) * fps));
    const fadeOutF = Math.max(1, Math.round((fadeOut / 1000) * fps));

    // 区間が短すぎる場合は半分ずつに丸める
    const len = endF - startF;
    const fi = Math.min(fadeInF, Math.floor(len / 2));
    const fo = Math.min(fadeOutF, Math.floor(len / 2));

    const targetVol = Math.max(0, Math.min(1, e.volume));

    // 4フェーズ（外→フェードイン→保持→フェードアウト→外）
    let v = baseVolume;

    if (frame >= startF && frame < startF + fi) {
      // フェードIN（base → target）
      const t = (frame - startF) / fi;
      v = baseVolume + (targetVol - baseVolume) * t;
    } else if (frame >= startF + fi && frame < endF - fo) {
      // 保持
      v = targetVol;
    } else if (frame >= endF - fo && frame < endF) {
      // フェードOUT（target → base）
      const t = (frame - (endF - fo)) / fo;
      v = targetVol + (baseVolume - targetVol) * t;
    }

    minVol = Math.min(minVol, v);
  }

  return minVol;
}
```

### 2. globalBgmVolume への組み込み

```typescript
const globalBgmVolume = useMemo(() => {
  const baseVolume = projectJson?.build_settings?.audio?.bgm_volume ?? 0.3;

  // 1) sceneBGM区間は最優先でミュート（=0）
  if (isInSceneBgmInterval) return 0;

  // 2) timeline ducking（必要な時だけ）
  const timeline = projectJson?.build_settings?.audio_automation?.timeline_bgm as TimelineBgmEntry[] | undefined;
  const v = volumeFromTimeline(frame, fps, baseVolume, timeline);

  return v;
}, [frame, fps, isInSceneBgmInterval, projectJson]);
```

### 3. Audio コンポーネントでの使用

```tsx
{projectJson?.assets?.bgm?.url && (
  <Audio
    src={projectJson.assets.bgm.url}
    volume={globalBgmVolume}
    loop={projectJson.assets.bgm.loop ?? true}
    // ... other props
  />
)}
```

## テスト観点

### ケース1: timeline_bgm が存在しない場合
- 期待: 今まで通り（baseVolume）

### ケース2: timeline_bgm がある場合
- 期待: 該当区間だけ下がる（フェードでパツッを防ぐ）
- 確認: 1:10〜1:25 の区間で BGM が 15% に下がる

### ケース3: sceneBGM 区間と被った場合
- 期待: 必ず 0（二重BGMを防ぐ）
- sceneBGM > timeline_bgm > baseVolume の優先順位

### ケース4: 複数の timeline_bgm 区間が重なる場合
- 期待: 最も小さい音量が採用される

## チャットからの操作例

ユーザー発話 → Intent → 適用

| ユーザー発話 | Intent Action | 結果 |
|-------------|---------------|------|
| 「1:10〜1:25までBGMを下げて」 | `timeline_bgm.duck` | 70000-85000ms で 15% |
| 「30秒から1分までBGMを20%にして」 | `timeline_bgm.set_volume` | 30000-60000ms で 20% |
| 「ここのBGMを少し下げて」 | `timeline_bgm.duck` | 現在再生位置の前後で下げる |

## 永続化

- 設定は `projects.settings_json.audio_automation.timeline_bgm` に永続保存
- 次回ビルド時も同じ設定が適用される
- 同一区間は上書き、新規区間は追加

## 変更履歴

- 2026-01-31: PR2-3 初版作成
