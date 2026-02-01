# テロップ (Telop) SSOT 設計書

**Version**: 1.0  
**Created**: 2026-02-01  
**Status**: 設計中（Phase 1 実装準備）

---

## 1. 概要

### 1.1 目的
テロップ定義を壊さず再設計し、**生成前UI**と**生成後チャット編集**の両方で一貫運用する。  
2系統（漫画焼き込み / Remotion字幕）を**同じ設定でコントロール可能**にする。

### 1.2 対象の経路整理

| 経路 | 説明 | 編集可否 |
|------|------|----------|
| **Remotion字幕** | 動画レンダリング時に字幕を描画 | ✅ 編集可能 |
| **漫画焼き込み** | 静止画に文字を焼き込み | ⚠️ 再生成が必要 |
| **動画素材焼き込み** | 動画生成元に字幕が焼き込まれている | ❌ 編集不可 |

---

## 2. 現状の実装分析

### 2.1 既存のデータ構造

#### Output Presets (`src/utils/output-presets.ts`)
```typescript
interface OutputPresetConfig {
  telop_style: 'bottom_bar' | 'center_large' | 'top_small';
  // 他の設定...
}
```

| Preset | telop_style |
|--------|-------------|
| yt_long | bottom_bar |
| short_vertical | center_large |
| yt_shorts | center_large |
| reels | center_large |
| tiktok | top_small |

#### Build Settings (`video_builds.settings_json`)
```typescript
interface BuildSettings {
  telops: {
    enabled: boolean;            // デフォルト: true
    position_preset: 'bottom' | 'center' | 'top';  // デフォルト: 'bottom'
    size_preset: 'sm' | 'md' | 'lg';               // デフォルト: 'md'
    scene_overrides?: Record<number, boolean>;      // シーン単位のON/OFF
  };
}
```

#### BuildRequestV1 (`src/utils/video-build-helpers.ts`)
```typescript
interface BuildSceneV1 {
  telop: {
    enabled: boolean;
    text?: string;
  };
}
```

#### RemotionProjectJson_R1 (`src/utils/video-build-helpers.ts`)
```typescript
interface RemotionProjectJson_R1 {
  build_settings: {
    telops?: {
      enabled?: boolean;
      position_preset?: 'bottom' | 'center' | 'top';
      size_preset?: 'sm' | 'md' | 'lg';
      scene_overrides?: Record<number, boolean>;
    };
  };
}
```

### 2.2 text_render_mode の役割

| 値 | 説明 | 用途 |
|----|------|------|
| `remotion` | Remotion側で字幕を描画 | 通常の画像シーン |
| `baked` | 画像に文字が焼き込み済み | 漫画シーン（comic） |
| `none` | 字幕なし | 特殊ケース |

**自動判定ロジック** (`video-build-helpers.ts:624-625`):
```typescript
const textRenderMode = scene.text_render_mode || 
  (displayType === 'comic' ? 'baked' : 'remotion');
```

### 2.3 チャット修正アクション (`patches.ts`)

| アクション | 説明 |
|------------|------|
| `telop.set_enabled` | 全テロップのON/OFF |
| `telop.set_enabled_scene` | シーン単位のON/OFF |
| `telop.set_position` | 位置変更（bottom/center/top） |
| `telop.set_size` | サイズ変更（sm/md/lg） |

---

## 3. SSOT 設計（3階層モデル）

### 3.1 階層構造

```
┌──────────────────────────────────────────────────┐
│                   Project                         │
│  (projects.settings_json.telop_defaults)          │
│  デフォルト出力設定                                │
└──────────────────────────────────────────────────┘
                        ↓ 上書き
┌──────────────────────────────────────────────────┐
│                    Build                          │
│  (video_builds.settings_json.telops)              │
│  今回のレンダリング設定                            │
└──────────────────────────────────────────────────┘
                        ↓ 上書き (将来対応)
┌──────────────────────────────────────────────────┐
│                    Scene                          │
│  (scene_telops テーブル / 将来対応)               │
│  シーン個別設定                                   │
└──────────────────────────────────────────────────┘
```

### 3.2 TelopSettings SSOT (v1)

```typescript
interface TelopSettings {
  // 基本設定
  enabled: boolean;                          // デフォルト: true
  mode: 'remotion_subtitle' | 'comic_baked' | 'both' | 'none';  // 将来対応
  
  // 位置・サイズ
  position_preset: 'bottom' | 'center' | 'top';  // デフォルト: 'bottom'
  size_preset: 'sm' | 'md' | 'lg';               // デフォルト: 'md'
  
  // スタイル（Phase 1 拡張）
  style_preset?: 'minimal' | 'outline' | 'band' | 'pop' | 'cinematic';
  
  // カスタムスタイル（Phase 2 以降）
  custom_style?: {
    font_family?: string;
    font_size?: number;
    font_weight?: 'normal' | 'bold';
    text_color?: string;
    stroke_color?: string;
    stroke_width?: number;
    background_color?: string;
    background_opacity?: number;
    padding?: { top: number; right: number; bottom: number; left: number };
    safe_area?: { top: number; bottom: number; left: number; right: number };
  };
  
  // ルール
  rule?: 'voice_only' | 'always' | 'manual';     // 将来対応
  
  // シーン単位のオーバーライド
  scene_overrides?: Record<number, {
    enabled?: boolean;
    position_preset?: 'bottom' | 'center' | 'top';
    size_preset?: 'sm' | 'md' | 'lg';
  }>;
}
```

### 3.3 スタイルプリセット定義 (Phase 1)

```typescript
const TELOP_STYLE_PRESETS = {
  minimal: {
    name: 'ミニマル',
    description: '控えめな白文字',
    font_size: 24,
    font_weight: 'normal',
    text_color: '#FFFFFF',
    stroke_color: '#000000',
    stroke_width: 1,
    background_color: 'transparent',
    background_opacity: 0,
  },
  outline: {
    name: 'アウトライン',
    description: '黒縁取りの白文字',
    font_size: 28,
    font_weight: 'bold',
    text_color: '#FFFFFF',
    stroke_color: '#000000',
    stroke_width: 3,
    background_color: 'transparent',
    background_opacity: 0,
  },
  band: {
    name: 'バンド',
    description: '帯付き字幕（TV風）',
    font_size: 26,
    font_weight: 'bold',
    text_color: '#FFFFFF',
    stroke_color: 'transparent',
    stroke_width: 0,
    background_color: '#000000',
    background_opacity: 0.7,
    padding: { top: 8, right: 16, bottom: 8, left: 16 },
  },
  pop: {
    name: 'ポップ',
    description: '黄色背景（バラエティ風）',
    font_size: 30,
    font_weight: 'bold',
    text_color: '#FF0000',
    stroke_color: '#FFFFFF',
    stroke_width: 4,
    background_color: '#FFFF00',
    background_opacity: 0.9,
    padding: { top: 4, right: 12, bottom: 4, left: 12 },
  },
  cinematic: {
    name: 'シネマティック',
    description: '映画風の控えめな字幕',
    font_size: 22,
    font_weight: 'normal',
    text_color: '#FFFFFF',
    stroke_color: '#000000',
    stroke_width: 0.5,
    background_color: 'transparent',
    background_opacity: 0,
  },
};
```

---

## 4. 実装フェーズ

### Phase 1: Remotion字幕のスタイル強化（最優先）

**目標**: Remotion側の字幕スタイルを設定から制御可能にする

**実装内容**:
1. **UIに字幕スタイルプリセット選択を追加**
   - Video Build設定画面に「テロップスタイル」セレクタを追加
   - 5種プリセット（minimal, outline, band, pop, cinematic）

2. **buildProjectJson へ telop_settings を含める**
   - `build_settings.telops` に `style_preset` を追加
   - 既存の `enabled`, `position_preset`, `size_preset` は維持（後方互換）

3. **Remotion側で反映**
   - `video-build-remotion/src/components/` でスタイル適用
   - プリセットに応じたCSS/スタイル変更

4. **プレビュー確認**
   - サンドボックスでの動作確認
   - 本番デプロイ・検証

**影響範囲**:
- `src/routes/video-generation.ts` - build_settings.telops にスタイル追加
- `src/utils/video-build-helpers.ts` - buildProjectJson でスタイル伝播
- `public/static/project-editor.js` - UI追加
- `video-build-remotion/src/` - Remotionコンポーネント修正

### Phase 2: 漫画焼き込みプリセット対応

**目標**: 漫画生成時のテロップスタイルをプリセットで統一

**2-A: プリセット中心（初期）**
- 漫画生成時のデフォルトスタイルをプリセットから適用
- 既存の BUBBLE_STYLES をプリセットと連動

**2-B: telop_settings の一部を漫画レンダラへ渡す（発展）**
- font_family, font_size などを共有
- 既存画像との整合性は再生成で対応

**注意点**:
- 漫画焼き込みは画像生成時に決定されるため、後から変更には再生成が必要
- Remotion字幕との二重表示を防ぐため、`text_render_mode` の自動判定を維持

### Phase 3: チャット修正のRemotionスコープ対応

**目標**: チャット修正時のテロップ変更を Remotion 字幕に限定

**実装内容**:
1. **scope パラメータの追加**
   - `telop.set_style { scope: 'remotion' | 'comic' | 'both' }`
   - デフォルトは `remotion`（Remotion字幕のみ）

2. **normalizeIntent での scope 補完**
   - コンテキストに応じて scope を自動判定
   - `display_asset_type === 'comic'` の場合は警告表示

3. **新規アクションの追加**
   ```typescript
   interface TelopSetStyleAction {
     action: 'telop.set_style';
     style_preset: 'minimal' | 'outline' | 'band' | 'pop' | 'cinematic';
     scope?: 'remotion' | 'comic' | 'both';
   }
   ```

**影響範囲**:
- `src/routes/patches.ts` - 新規アクション追加
- `public/static/project-editor.js` - パースロジック追加

---

## 5. リスク対策

### A. 二重表示の防止
- `mode: 'both'` の場合、漫画シーン（display_asset_type=comic）では自動的に Remotion 字幕をOFF
- 警告表示: 「漫画シーンでは文字が焼き込まれているため、Remotion字幕は非表示になります」

### B. 既存動画との互換性
- 既存の `telops` キーは維持（後方互換）
- 新規キー（`style_preset`, `custom_style`）は optional
- 古いビルド設定は `style_preset: 'outline'` として扱う

### C. チャット修正の適用範囲明示
- `scope` を明示（デフォルトは `remotion`）
- 漫画焼き込みの変更は「次回漫画生成から反映」と明記

---

## 6. テストケース

### 6.1 基本機能
- [ ] プリセット変更 → Remotion字幕に反映
- [ ] 位置変更（top/center/bottom）→ 正しい位置に表示
- [ ] サイズ変更（sm/md/lg）→ 正しいサイズで表示
- [ ] シーン単位のON/OFF → 指定シーンのみ切り替わる

### 6.2 互換性
- [ ] 既存ビルド設定での動画生成が正常に動作
- [ ] telops キーがない古いビルドでも動作
- [ ] style_preset がない場合はデフォルト（outline）適用

### 6.3 二重表示防止
- [ ] comic シーンで text_render_mode=baked → Remotion字幕OFF
- [ ] comic シーンで telops.enabled=true でも焼き込みのみ表示
- [ ] 警告メッセージの表示確認

---

## 7. 関連ドキュメント

- `/docs/A案_baked_Remotion仕様.md` - 漫画焼き込みとRemotionの仕様
- `/docs/R2-A_SPEC.md` - text_render_mode の詳細仕様
- `/docs/BUBBLE_TEXTSTYLE_SPEC.md` - 吹き出しテキストスタイル

---

## 8. 変更履歴

| 日付 | 変更内容 |
|------|----------|
| 2026-02-01 | 初版作成（現状分析・SSOT設計） |
