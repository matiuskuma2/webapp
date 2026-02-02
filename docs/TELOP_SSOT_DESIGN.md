# テロップ (Telop) SSOT 設計書

**Version**: 1.4  
**Created**: 2026-02-01  
**Updated**: 2026-02-02  
**Status**: Phase 1 完了、Phase 2-1 完了、Phase 2-2 完了、Phase 3-A 完了

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

### Phase 1: Remotion字幕のスタイル強化（✅ 完了）

**目標**: Remotion側の字幕スタイルを設定から制御可能にする

**実装完了内容** (2026-02-01):

1. **✅ UIに字幕スタイルプリセット選択を追加**
   - Video Build設定画面に「テロップスタイル」セレクタを追加済み
   - 5種プリセット（minimal, outline, band, pop, cinematic）

2. **✅ buildProjectJson へ telop_settings を含める**
   - `build_settings.telops` に `style_preset` を追加済み
   - 既存の `enabled`, `position_preset`, `size_preset` は維持（後方互換）

3. **✅ Remotion側で反映**
   - `video-build-remotion/src/components/Subtitle.tsx` でスタイル適用
   - 各プリセットに応じたフォント・色・縁取り・背景を反映
   - `Scene.tsx` で subtitleStyle prop を受け取り
   - `RilarcVideo.tsx` で build_settings.telops からスタイル読み取り

4. **✅ チャット修正アクションの追加**
   - `telop.set_style` アクションを追加（`patches.ts`）
   - scope パラメータをサポート（デフォルト: remotion）

5. **✅ 本番デプロイ完了**
   - https://webapp-c7n.pages.dev にデプロイ済み

**変更ファイル**:
- `src/index.tsx` - UIにスタイル選択セレクタ追加
- `src/routes/video-generation.ts` - build_settings.telops にスタイル追加
- `src/routes/patches.ts` - telop.set_style アクション追加
- `src/utils/video-build-helpers.ts` - buildProjectJson でスタイル伝播
- `public/static/project-editor.js` - フロントエンドで style_preset 送信
- `video-build-remotion/src/components/Subtitle.tsx` - 5プリセットスタイル実装
- `video-build-remotion/src/components/Scene.tsx` - subtitleStyle prop受取り
- `video-build-remotion/src/RilarcVideo.tsx` - テロップ設定をSceneへ伝播

### Phase 2: 漫画焼き込みプリセット対応

**目標**: 漫画生成時のテロップスタイルをプリセットで統一

#### Phase 2-1: 設定保持（✅ 完了）

**目標**: 漫画テロップ設定の保存・表示・警告を安定化（再生成は行わない）

**実装完了内容** (2026-02-01):

1. **✅ SSOT: projects.settings_json.telops_comic に保存**
   - `style_preset`: minimal | outline | band | pop | cinematic
   - `size_preset`: sm | md | lg
   - `position_preset`: bottom | center | top
   - 保存先は Project レベル（Build / Scene と分離）

2. **✅ API エンドポイント追加**
   - `PUT /api/projects/:id/comic-telop-settings` - 設定保存
   - `GET /api/projects/:id` - settings.telops_comic を返す

3. **✅ 出力設定UIに「漫画の文字（焼き込み）設定」セクション追加**
   - Remotion テロップ設定とは別セクション（ローズ色の枠）
   - 注意書き: 「この設定は次回の漫画生成から反映されます」
   - 保存ボタンで即時保存

4. **✅ チャット apply (scope=comic/both) での設定更新**
   - `telopsComicOverride` を `resolveIntentToOps` 戻り値に追加
   - `comicRegenerationRequired` に警告を追加
   - 適用時に `projects.settings_json.telops_comic` を更新

**変更ファイル**:
- `src/routes/projects.ts` - PUT /comic-telop-settings 追加、GET /:id で telops_comic 返却
- `src/routes/patches.ts` - telopsComicOverride 追加、scope=comic/both 処理
- `src/index.tsx` - 漫画の文字設定セクション追加
- `public/static/project-editor.js` - loadComicTelopSettings / saveComicTelopSettings 追加

**やらなかったこと（Phase 2-2/3 へ移行）**:
- 漫画画像の再生成による見た目の変更
- 漫画編集画面（comic-editor-v2.js）への telop preset 適用
- 既存漫画の焼き込みを後から差し替える処理

#### Phase 2-2: 再生成導線（✅ 完了）

**目標**: 漫画の再生成ボタンで telops_comic を適用（既存は保持、新規生成のみ）

**実装完了内容** (2026-02-02):

1. **✅ API: POST /api/scenes/:sceneId/comic/regenerate**
   - telops_comic を読み込み、pending_regeneration として保存
   - 連打防止（30秒クールダウン、audit_logs ベース）
   - 監査ログ `comic.regenerate.requested` を記録
   - 既存漫画は保持（新規生成のみ）

2. **✅ UI: 2段階確認モーダル**
   - 漫画編集画面（comic-editor-v2.js）に「再生成」ボタン追加
   - Step 1: 確認（既存は残る旨を明示）
   - Step 2: 適用される設定を表示（style/size/position）
   - 連打防止（ボタン disabled + サーバ 409）

3. **✅ 状態表示**
   - 「🟠 文字設定更新済み」バッジ（pending_regeneration 検知）
   - 再生成リクエスト後にバッジ更新

**変更ファイル**:
- `src/routes/comic.ts` - POST /comic/regenerate エンドポイント追加
- `public/static/comic-editor-v2.js` - 再生成モーダル、ボタン、状態バッジ追加

**やらなかったこと（Phase 2-3 へ移行）**:
- 既存漫画の自動差し替え（activate 自動化）
- 漫画編集画面の描画エンジン側でプリセット自動適用（焼き込み処理統合）
- 全シーン一括再生成

#### Phase 2-3: 描画ロジック統合（未実装）

- comic-editor-v2.js でプリセットを参照して描画
- font_family, font_size などの共有

**注意点**:
- 漫画焼き込みは画像生成時に決定されるため、後から変更には再生成が必要
- Remotion字幕との二重表示を防ぐため、`text_render_mode` の自動判定を維持

### Phase 3-A: チャット修正のRemotionスコープ対応（✅ 完了）

**目標**: チャット修正時のテロップ変更を Remotion 字幕に限定

**実装完了内容** (2026-02-01):

1. **✅ scope パラメータの追加**
   - `telop.set_style { scope: 'remotion' | 'comic' | 'both' }`
   - `telop.set_position { scope?: ... }`
   - `telop.set_size { scope?: ... }`
   - デフォルトは `remotion`（Remotion字幕のみ、即時プレビュー可能）

2. **✅ resolveIntentToOps での scope 判定**
   - scope 未指定 → `remotion` として処理
   - scope が `comic` / `both` → `comicRegenerationRequired` に追加
   - 警告メッセージを warnings に含める
   - `requires_confirmation: true` を返す

3. **✅ LLM プロンプトの更新**
   - 「字幕」「テロップ」→ scope: remotion（デフォルト、省略可）
   - 「漫画の吹き出し」「焼き込み」→ scope: comic
   - 「両方」「全部」→ scope: both

4. **✅ データ構造**
   ```typescript
   type TelopScope = 'remotion' | 'comic' | 'both';
   
   interface ComicRegenerationRequired {
     scope: 'comic' | 'both';
     action: string;
     message: string;
     affected_scenes?: number[];
   }
   ```

**変更ファイル**:
- `src/routes/patches.ts` - scope 判定、警告生成、LLMプロンプト更新

**残タスク**:
- UI: 提案カードに「適用先：Remotion字幕 / 漫画焼き込み（再生成必要）」表示

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
- [x] プリセット変更 → Remotion字幕に反映（Phase 1 完了）
- [x] 位置変更（top/center/bottom）→ 正しい位置に表示
- [x] サイズ変更（sm/md/lg）→ 正しいサイズで表示
- [x] シーン単位のON/OFF → 指定シーンのみ切り替わる
- [x] telop.set_style チャットアクション追加

### 6.2 互換性
- [x] 既存ビルド設定での動画生成が正常に動作
- [x] telops キーがない古いビルドでも動作
- [x] style_preset がない場合はデフォルト（outline）適用

### 6.3 二重表示防止
- [x] comic シーンで text_render_mode=baked → Remotion字幕OFF
- [x] comic シーンで telops.enabled=true でも焼き込みのみ表示
- [ ] 警告メッセージの表示確認（Phase 2 予定）

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
| 2026-02-01 | Phase 1 実装完了（Remotion字幕スタイル5プリセット、UI、チャットアクション） |
| 2026-02-01 | Phase 3-A 実装完了（チャット telop scope SSOT固定、LLMプロンプト更新） |
