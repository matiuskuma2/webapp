# Chat Audio Intent Schema (音声編 Intent 分類表)

**作成日**: 2026-01-31  
**バージョン**: 1.0  
**目的**: チャットによる音声編集指示を正確に解釈し、AudioEvent SSOTへマッピングするためのIntent分類

---

## 1. AudioEvent SSOT 定義

すべての音声イベントは以下の構造で正規化される:

```typescript
interface AudioEvent {
  id: string;                           // 識別子: scene-{sceneId}-{type}-{n}
  scene_id: number;                     // シーンID
  source_type: 'bgm' | 'sfx' | 'voice'; // 音源タイプ
  source_id: number | null;             // ライブラリID (system/user) or null (direct)
  start_ms: number;                     // 開始位置（シーン内相対ms）
  end_ms: number | null;                // 終了位置（null = 自然長）
  volume: number;                       // 音量 (0.0 - 1.0)
  fade_in_ms: number;                   // フェードイン (ms)
  fade_out_ms: number;                  // フェードアウト (ms)
  priority: number;                     // 優先度 (voice=100, sfx=50, bgm=10)
}
```

### 1.1 識別子命名規則 (P1-B準拠)

| タイプ | 識別子フォーマット | 例 |
|--------|-------------------|-----|
| BGM | `scene-{sceneId}-bgm` | `scene-123-bgm` |
| SFX | `scene-{sceneId}-sfx-{n}` | `scene-123-sfx-1`, `scene-123-sfx-2` |
| Voice | `scene-{sceneId}-voice-{n}` | `scene-123-voice-1` |

※ SFXの `{n}` は start_ms 昇順の連番

---

## 2. Intent 分類表（音声編）

### 2.1 BGM 操作

| Intent | action | 必須パラメータ | オプショナル | 例文 |
|--------|--------|---------------|-------------|------|
| BGM音量調整 | `bgm.set_volume` | `volume` | `scene_idx` | 「BGM下げて」「BGM 20%」 |
| BGM音量相対調整 | `bgm.adjust_volume` | `delta` | `scene_idx` | 「BGMもう少し小さく」 |
| BGMミュート | `bgm.mute` | - | `scene_idx` | 「BGM消して」「BGMオフ」 |
| BGMアンミュート | `bgm.unmute` | - | `scene_idx` | 「BGM戻して」「BGMオン」 |
| BGM差し替え | `bgm.replace` | `audio_id`, `library_type` | `scene_idx` | 「このBGMを〇〇に変えて」 |
| BGM削除 | `bgm.remove` | - | `scene_idx` | 「BGM削除して」 |
| BGM区間指定 | `bgm.set_timing` | `start_ms`, `end_ms` | `scene_idx` | 「BGMを3秒から鳴らして」 |
| BGMフェード設定 | `bgm.set_fade` | `fade_in_ms`, `fade_out_ms` | `scene_idx` | 「BGMをフェードインして」 |

### 2.2 Scene BGM 操作（シーン固有BGM）

| Intent | action | 必須パラメータ | オプショナル | 例文 |
|--------|--------|---------------|-------------|------|
| SceneBGM追加 | `scene_bgm.add` | `audio_id`, `library_type` | `start_ms`, `end_ms`, `volume` | 「このシーンにBGM追加」 |
| SceneBGM音量調整 | `scene_bgm.set_volume` | `scene_idx`, `volume` | - | 「シーン3のBGMを50%に」 |
| SceneBGM削除 | `scene_bgm.remove` | `scene_idx` | - | 「このシーンのBGM消して」 |
| SceneBGMタイミング | `scene_bgm.set_timing` | `scene_idx`, `start_ms` | `end_ms` | 「BGMを2秒後から」 |

### 2.3 SFX 操作

| Intent | action | 必須パラメータ | オプショナル | 例文 |
|--------|--------|---------------|-------------|------|
| SFX追加 | `sfx.add` | `scene_idx`, `audio_id`, `library_type` | `start_ms`, `volume` | 「効果音追加して」 |
| SFX音量調整 | `sfx.set_volume` | `scene_idx`, `sfx_no`, `volume` | - | 「効果音1の音量を上げて」 |
| SFX削除 | `sfx.remove` | `scene_idx`, `sfx_no` | - | 「この効果音消して」 |
| SFXタイミング変更 | `sfx.set_timing` | `scene_idx`, `sfx_no`, `start_ms` | `end_ms` | 「効果音を5秒に移動」 |
| SFX複製 | `sfx.duplicate` | `scene_idx`, `sfx_no`, `new_start_ms` | `new_scene_idx` | 「この効果音を70秒にも」 |
| SFX全削除 | `sfx.remove_all` | `scene_idx` | - | 「効果音全部消して」 |

### 2.4 Voice（セリフ）操作

| Intent | action | 必須パラメータ | オプショナル | 例文 |
|--------|--------|---------------|-------------|------|
| Voice音量調整 | `voice.set_volume` | `scene_idx`, `voice_no`, `volume` | - | 「このセリフの音量上げて」 |
| Voice区間でBGM Duck | `voice.duck_bgm` | `scene_idx`, `voice_no` | `duck_volume` | 「セリフの部分、BGM下げて」 |
| Voice再生成 | `voice.regenerate` | `scene_idx`, `voice_no` | `voice_id`, `speed` | 「このセリフ読み直して」 |

### 2.5 複合操作

| Intent | action | 必須パラメータ | オプショナル | 例文 |
|--------|--------|---------------|-------------|------|
| 全音声ミュート | `audio.mute_all` | - | `scene_idx` | 「音全部消して」 |
| 音量一括調整 | `audio.adjust_all` | `delta` | `scene_idx` | 「全体的に音量下げて」 |
| BGM再利用 | `bgm.reuse` | `source_scene_idx`, `target_scene_idx` | - | 「前のシーンのBGMを使って」 |

---

## 3. Intent JSON Schema

```typescript
interface AudioIntent {
  action: string;           // 上記のaction名
  confidence: number;       // 0.0-1.0 (AIの確信度)
  parameters: {
    // 対象指定
    scene_idx?: number;     // 1-based シーン番号
    sfx_no?: number;        // 1-based SFX番号 (start_ms順)
    voice_no?: number;      // 1-based Voice番号
    
    // 音量
    volume?: number;        // 絶対値 (0.0-1.0)
    delta?: number;         // 相対値 (-0.5 ~ +0.5)
    duck_volume?: number;   // Duck時の音量 (default: 0.1)
    
    // タイミング
    start_ms?: number;      // 開始位置 (ms)
    end_ms?: number | null; // 終了位置 (ms, null=自然長)
    
    // フェード
    fade_in_ms?: number;    // フェードイン (ms)
    fade_out_ms?: number;   // フェードアウト (ms)
    
    // ライブラリ参照
    audio_id?: number;      // system/user audio library ID
    library_type?: 'system' | 'user' | 'direct';
    
    // 複製・再利用
    new_start_ms?: number;  // 複製先の開始位置
    new_scene_idx?: number; // 複製先のシーン
    source_scene_idx?: number; // 再利用元シーン
    target_scene_idx?: number; // 再利用先シーン
  };
  ambiguous?: {
    reason: string;         // 曖昧な理由
    candidates: string[];   // 候補となる解釈
    question: string;       // ユーザーへの確認質問
  };
}
```

---

## 4. scene_audio_assignments へのマッピング表

### 4.1 BGM操作 → API マッピング

| action | HTTP Method | Endpoint | Body |
|--------|-------------|----------|------|
| `bgm.set_volume` | PUT | `/api/scenes/:sceneId/audio-assignments/:id` | `{ volume_override: number }` |
| `bgm.mute` | PUT | `/api/scenes/:sceneId/audio-assignments/:id` | `{ volume_override: 0 }` |
| `bgm.unmute` | PUT | `/api/scenes/:sceneId/audio-assignments/:id` | `{ volume_override: null }` |
| `bgm.replace` | POST | `/api/scenes/:sceneId/audio-assignments` | `{ audio_library_type, system_audio_id/user_audio_id, audio_type: 'bgm' }` |
| `bgm.remove` | DELETE | `/api/scenes/:sceneId/audio-assignments/:id` | - |
| `bgm.set_timing` | PUT | `/api/scenes/:sceneId/audio-assignments/:id` | `{ start_ms, end_ms }` |
| `bgm.set_fade` | PUT | `/api/scenes/:sceneId/audio-assignments/:id` | `{ fade_in_ms_override, fade_out_ms_override }` |

### 4.2 SFX操作 → API マッピング

| action | HTTP Method | Endpoint | Body |
|--------|-------------|----------|------|
| `sfx.add` | POST | `/api/scenes/:sceneId/audio-assignments` | `{ audio_library_type, audio_type: 'sfx', start_ms, volume_override }` |
| `sfx.set_volume` | PUT | `/api/scenes/:sceneId/audio-assignments/:id` | `{ volume_override: number }` |
| `sfx.remove` | DELETE | `/api/scenes/:sceneId/audio-assignments/:id` | - |
| `sfx.set_timing` | PUT | `/api/scenes/:sceneId/audio-assignments/:id` | `{ start_ms, end_ms }` |
| `sfx.duplicate` | POST | `/api/scenes/:sceneId/audio-assignments` | (元SFXをコピーして新規作成) |

### 4.3 scene_audio_cues との関係

既存の `scene_audio_cues` テーブル（SFX直接アップロード用）と `scene_audio_assignments` の使い分け:

| テーブル | 用途 | ライブラリ参照 |
|----------|------|---------------|
| `scene_audio_assignments` | ライブラリから選択したBGM/SFX | system/user/direct |
| `scene_audio_cues` | シーンに直接アップロードしたSFX | なし（R2直接） |

**推奨**: 今後は `scene_audio_assignments` に統一し、`scene_audio_cues` は廃止予定。

---

## 5. 曖昧→質問テンプレート（確認パターン）

### 5.1 対象が不明確

```json
{
  "ambiguous": {
    "reason": "target_unclear",
    "candidates": ["scene-123-bgm", "project-bgm"],
    "question": "「BGM」はこのシーンのBGMですか？それともプロジェクト全体のBGMですか？"
  }
}
```

### 5.2 数値が曖昧

```json
{
  "ambiguous": {
    "reason": "value_unclear",
    "candidates": ["0.5", "0.3", "0.2"],
    "question": "「小さく」はどのくらいですか？\n1. 少し小さく (50%)\n2. かなり小さく (30%)\n3. ほぼ聞こえない (20%)"
  }
}
```

### 5.3 タイミングが曖昧

```json
{
  "ambiguous": {
    "reason": "timing_unclear",
    "candidates": ["0ms", "1000ms", "scene_start"],
    "question": "「最初から」は具体的にいつからですか？\n現在のシーンは 0ms〜5000ms です。"
  }
}
```

### 5.4 複数候補がある

```json
{
  "ambiguous": {
    "reason": "multiple_matches",
    "candidates": ["scene-123-sfx-1", "scene-123-sfx-2"],
    "question": "このシーンには2つの効果音があります:\n1. scene-123-sfx-1 (0ms〜): 「ドアの音」\n2. scene-123-sfx-2 (3000ms〜): 「足音」\nどちらの効果音ですか？"
  }
}
```

### 5.5 シーン指定がない

```json
{
  "ambiguous": {
    "reason": "scene_not_specified",
    "candidates": [],
    "question": "どのシーンのBGMを調整しますか？現在表示中のシーン3でよいですか？"
  }
}
```

---

## 6. 曖昧語→数値変換テーブル

### 6.1 音量表現

| 曖昧語 | 変換先 volume | delta |
|--------|--------------|-------|
| 「上げて」「大きく」 | - | +0.1 |
| 「下げて」「小さく」 | - | -0.1 |
| 「もっと上げて」 | - | +0.2 |
| 「もっと下げて」 | - | -0.2 |
| 「うるさい」 | - | -0.15 |
| 「聞こえない」 | - | +0.2 |
| 「ミュート」「消して」 | 0.0 | - |
| 「最大」「MAX」 | 1.0 | - |
| 「半分」「50%」 | 0.5 | - |
| 「ちょっと」「少し」 | - | ±0.05 |

### 6.2 タイミング表現

| 曖昧語 | 変換先 |
|--------|--------|
| 「最初から」「冒頭から」 | start_ms: 0 |
| 「最後まで」「終わりまで」 | end_ms: null |
| 「〇秒から」 | start_ms: ○ * 1000 |
| 「〇秒まで」 | end_ms: ○ * 1000 |
| 「セリフの後」 | start_ms: voice.end_ms |
| 「セリフの前」 | end_ms: voice.start_ms |
| 「セリフの間」 | start_ms: voice.start_ms, end_ms: voice.end_ms |

### 6.3 フェード表現

| 曖昧語 | 変換先 |
|--------|--------|
| 「フェードイン」 | fade_in_ms: 500 |
| 「フェードアウト」 | fade_out_ms: 500 |
| 「ゆっくりフェード」 | fade_*_ms: 1000 |
| 「すぐに」「急に」 | fade_*_ms: 0 |

---

## 7. Mode判定との統合

### 7.1 Mode C（Direct Edit）条件

以下がすべて満たされる場合、確認なしで即実行:

```typescript
function canDirectEdit(intent: AudioIntent): boolean {
  // 1. scene_idx が確定
  const hasSceneIdx = intent.parameters.scene_idx != null;
  
  // 2. 対象が確定（BGMなら不要、SFXならsfx_no必須）
  const hasTarget = intent.action.startsWith('bgm.') || 
                    intent.parameters.sfx_no != null ||
                    intent.parameters.voice_no != null;
  
  // 3. 値が確定
  const hasValue = intent.parameters.volume != null ||
                   intent.parameters.start_ms != null ||
                   intent.action.includes('remove') ||
                   intent.action.includes('mute');
  
  // 4. 曖昧さがない
  const notAmbiguous = !intent.ambiguous;
  
  return hasSceneIdx && hasTarget && hasValue && notAmbiguous;
}
```

### 7.2 Mode B（Suggestion）条件

- 曖昧語を含む
- 対象が複数ありえる
- 数値が未指定

→ 提案カードを表示し、ユーザー確認を求める

### 7.3 Mode A（Conversation）

- actions が空
- 音声関連のキーワードなし
- 質問や雑談

---

## 8. 実装チェックリスト

- [ ] AudioIntent TypeScript型定義
- [ ] intent パーサー（regex + AI）
- [ ] scene_audio_assignments API呼び出しラッパー
- [ ] 曖昧語→数値変換ユーティリティ
- [ ] Mode判定関数の音声Intent対応
- [ ] 確認テンプレートのUI実装
- [ ] Remotion側との整合性確認

---

## 更新履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|----------|
| 2026-01-31 | 1.0 | 初版作成 |
