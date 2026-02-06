# カメラワーク（Motion Preset）仕様書

## バージョン
- **Version**: 1.0
- **最終更新**: 2026-02-06
- **ステータス**: 実装完了

---

## 1. 概要

シーンごとのカメラワーク（モーション効果）を制御する仕様。
seed固定による再現性100%を保証。

---

## 2. SSOT（Single Source of Truth）

### 2.1 データソース
| 項目 | テーブル | カラム |
|------|----------|--------|
| プリセット選択 | scene_motion | preset |
| 詳細パラメータ | scene_motion | params_json |

### 2.2 Remotion での参照
- `MotionWrapper` は `scene.motion.chosen` または `scene.motion.id` を使用
- Remotion 内部でランダム処理を行わない
- `useCurrentFrame()` のみで完結

---

## 3. プリセット一覧

### 3.1 基本プリセット
| ID | 名称 | motion_type | 説明 |
|----|------|-------------|------|
| `none` | なし | none | 静止画のまま |
| `kenburns_soft` | Ken Burns（ソフト） | zoom | scale 1.0 → 1.05 |
| `kenburns_strong` | Ken Burns（強） | zoom | scale 1.0 → 1.15 |

### 3.2 スライド系プリセット
| ID | 名称 | motion_type | 方向 |
|----|------|-------------|------|
| `slide_lr` | スライド（左→右） | pan | x: -5% → 10% |
| `slide_rl` | スライド（右→左） | pan | x: 5% → -10% |
| `slide_tb` | スライド（上→下） | pan | y: -5% → 10% |
| `slide_bt` | スライド（下→上） | pan | y: 5% → -10% |

### 3.3 ホールド＆スライド系
| ID | 名称 | motion_type | 説明 |
|----|------|-------------|------|
| `hold_then_slide_lr` | ホールド→スライド（左→右） | hold_then_pan | 30%静止後スライド |
| `hold_then_slide_rl` | ホールド→スライド（右→左） | hold_then_pan | 30%静止後スライド |
| `hold_then_slide_tb` | ホールド→スライド（上→下） | hold_then_pan | 30%静止後スライド |
| `hold_then_slide_bt` | ホールド→スライド（下→上） | hold_then_pan | 30%静止後スライド |

### 3.4 特殊プリセット
| ID | 名称 | motion_type | 説明 |
|----|------|-------------|------|
| `auto` | 自動選択 | - | seed に基づいて決定論的に選択 |

---

## 4. auto プリセット仕様

### 4.1 選択ロジック
```typescript
function pickMotionBySeed(seed: number): string {
  const candidates = [
    'kenburns_soft',
    'slide_lr',
    'slide_rl',
    'slide_tb',
    'slide_bt'
  ];
  // seed % candidates.length で決定論的に選択
  return candidates[seed % candidates.length];
}
```

### 4.2 seed 生成タイミング
| タイミング | 処理 |
|------------|------|
| シーン作成時 | `seed` を生成して `params_json` に保存 |
| Video Build 開始時 | `chosen` を決定して `params_json` に保存 |
| Remotion レンダリング時 | `chosen` をそのまま使用 |

### 4.3 SSOT 保存形式
```json
{
  "seed": 123456,
  "chosen": "slide_lr",
  "hold_ms": 0
}
```

### 4.4 再現性保証
- 同じ `seed` → 同じ `chosen`
- Remotion では `chosen` のみ参照
- 毎回同じ動画が生成される

---

## 5. scene_motion テーブル

### 5.1 スキーマ
```sql
CREATE TABLE scene_motion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL UNIQUE,
  preset TEXT DEFAULT 'kenburns',  -- プリセットID
  start_scale REAL DEFAULT 1.0,
  end_scale REAL DEFAULT 1.1,
  start_x REAL DEFAULT 0.0,
  start_y REAL DEFAULT 0.0,
  end_x REAL DEFAULT 0.0,
  end_y REAL DEFAULT 0.05,
  ease TEXT DEFAULT 'easeInOut',
  params_json TEXT,                -- seed, chosen, hold_ms など
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);
```

### 5.2 params_json 構造
```typescript
interface MotionParams {
  seed?: number;        // auto 選択用のシード値
  chosen?: string;      // auto で決定されたプリセットID
  hold_ms?: number;     // hold_then_* での静止時間（ミリ秒）
  hold_ratio?: number;  // hold_then_* での静止比率（0.0-1.0）
}
```

---

## 6. buildProjectJson での処理

### 6.1 motion オブジェクト生成
```typescript
// scene.motion が存在する場合
const motion = {
  id: scene.motion.preset_id,
  motion_type: scene.motion.motion_type,
  params: scene.motion.params
};

// auto の場合は chosen を使用
if (motion.id === 'auto' && motion.params?.chosen) {
  motion.id = motion.params.chosen;
  motion.motion_type = MOTION_PRESETS[motion.id]?.motion_type || 'pan';
}
```

### 6.2 デフォルト値
| display_asset_type | デフォルト motion |
|--------------------|-------------------|
| image | kenburns_soft |
| video | none |
| comic | none |

---

## 7. MotionWrapper (Remotion)

### 7.1 コンポーネント概要
```typescript
interface MotionWrapperProps {
  motion_type: 'none' | 'zoom' | 'pan' | 'combined' | 'hold_then_pan';
  preset_id?: string;
  params?: {
    start_scale?: number;
    end_scale?: number;
    start_x?: number;
    end_x?: number;
    start_y?: number;
    end_y?: number;
    hold_ratio?: number;
  };
  durationFrames: number;
  children: React.ReactNode;
}
```

### 7.2 トランスフォーム計算
```typescript
function calculateTransform(frame: number, durationFrames: number, preset: MotionPreset): string {
  const transforms: string[] = [];
  
  // hold_then_pan の場合
  if (preset.hold_ratio) {
    const holdFrames = Math.floor(durationFrames * preset.hold_ratio);
    if (frame < holdFrames) {
      return ''; // 静止
    }
    // 残りフレームで補間
  }
  
  // zoom
  if (preset.start_scale !== undefined && preset.end_scale !== undefined) {
    const scale = interpolate(frame, [0, durationFrames], [preset.start_scale, preset.end_scale], { extrapolateRight: 'clamp' });
    transforms.push(`scale(${scale})`);
  }
  
  // pan
  if (preset.start_x !== undefined || preset.start_y !== undefined) {
    const x = interpolate(frame, [0, durationFrames], [preset.start_x || 0, preset.end_x || 0], { extrapolateRight: 'clamp' });
    const y = interpolate(frame, [0, durationFrames], [preset.start_y || 0, preset.end_y || 0], { extrapolateRight: 'clamp' });
    transforms.push(`translate(${x}%, ${y}%)`);
  }
  
  return transforms.join(' ');
}
```

---

## 8. UI（Builder）

### 8.1 モーション設定パネル
```
┌─────────────────────────────────────────┐
│ カメラワーク設定                          │
├─────────────────────────────────────────┤
│ プリセット: [▼ 自動選択（auto）]          │
│                                          │
│ ・なし                                   │
│ ・Ken Burns（ソフト）                    │
│ ・Ken Burns（強）                        │
│ ・スライド（左→右）                      │
│ ・スライド（右→左）                      │
│ ・スライド（上→下）                      │
│ ・スライド（下→上）                      │
│ ・ホールド→スライド（左→右）             │
│ ・自動選択 ← 選択中                      │
│                                          │
│ [プレビュー] [保存]                       │
└─────────────────────────────────────────┘
```

### 8.2 auto 選択時の表示
```
プリセット: 自動選択（auto）
↓
決定済み: スライド（左→右） [seed: 123456]
```

---

## 9. テストケース

### 9.1 再現性テスト
```
1. プロジェクト126でVideo Buildを実行
2. scene_motion.params_json に chosen が保存される
3. 同じプロジェクトで再度Video Buildを実行
4. 結果: 同じカメラワークが適用される
```

### 9.2 SSOT 整合性テスト
```sql
-- auto だが chosen が未設定のケース（理想: 0件）
SELECT sm.scene_id, sm.preset, sm.params_json
FROM scene_motion sm
WHERE sm.preset = 'auto'
  AND (sm.params_json IS NULL OR sm.params_json NOT LIKE '%chosen%');
```

---

## 10. 関連ドキュメント
- [VIDEO_GENERATION_SSOT.md](./VIDEO_GENERATION_SSOT.md) - 動画生成SSOT
- [AUDIO_BULK_SSOT_SPEC.md](./AUDIO_BULK_SSOT_SPEC.md) - 音声一括生成SSOT
