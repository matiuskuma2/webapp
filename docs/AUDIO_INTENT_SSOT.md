# Chat用 Audio Intent SSOT設計書

**最終更新**: 2026-01-31  
**バージョン**: 1.0  
**目的**: チャット指示を AudioEvent に正規化し、SSOT に基づいて音声操作を実行する

---

## 1. AudioEvent SSOT 定義

### 1.1 AudioEvent 型定義（SSOT）

すべての音声イベントを以下の構造で正規化する。

```typescript
interface AudioEvent {
  id: string;                    // 識別子: "scene-{sceneId}-{sourceType}-{n}"
  scene_id: number;              // 所属シーンID
  source_type: 'bgm' | 'sfx' | 'voice';
  source_id: number | null;      // 参照元ID（library or utterance）
  start_ms: number;              // シーン内相対開始位置
  end_ms: number | null;         // シーン内相対終了位置（null = 自然長）
  volume: number;                // 0.0-1.0
  fade_in_ms: number;
  fade_out_ms: number;
  priority: number;              // voice=100, sfx=50, bgm=10
  is_active: boolean;
}
```

### 1.2 識別子フォーマット（P1-B準拠）

| source_type | 識別子例 | 説明 |
|-------------|---------|------|
| bgm | `scene-123-bgm` | シーン123のBGM（シーンに1つ） |
| sfx | `scene-123-sfx-1` | シーン123のSFX#1（start_ms順） |
| sfx | `scene-123-sfx-2` | シーン123のSFX#2 |
| voice | `scene-123-voice-1` | シーン123の発話#1（utterance順） |

### 1.3 Priority ルール

高い priority の音が鳴っている区間では、低い音は自動的に音量を下げる/ミュート。

| source_type | priority | 挙動 |
|-------------|----------|------|
| voice | 100 | 最優先 |
| sfx | 50 | voice中はミュート可 |
| bgm | 10 | voice/sfx中はduck/mute |

---

## 2. Chat Intent 分類表（音声編）

### 2.1 Intent スキーマ

```typescript
interface AudioIntent {
  intent_type: AudioIntentType;
  target: AudioTarget;
  action: AudioAction;
  params: Record<string, any>;
  confidence: 'high' | 'medium' | 'low';
  ambiguous_fields?: string[];
  clarification_needed?: string;
}

type AudioIntentType = 
  | 'bgm.volume_adjust'
  | 'bgm.timing_adjust'
  | 'bgm.replace'
  | 'bgm.remove'
  | 'scene_bgm.volume_adjust'
  | 'scene_bgm.timing_adjust'
  | 'scene_bgm.add'
  | 'scene_bgm.replace'
  | 'scene_bgm.remove'
  | 'sfx.volume_adjust'
  | 'sfx.timing_adjust'
  | 'sfx.add'
  | 'sfx.replace'
  | 'sfx.remove'
  | 'sfx.duplicate'
  | 'voice.volume_adjust'
  | 'voice.timing_adjust'
  | 'duck.configure';
```

### 2.2 AudioTarget

```typescript
interface AudioTarget {
  // 対象の特定方法
  target_type: 'explicit' | 'contextual' | 'relative';
  
  // explicit: 明示的に指定
  event_id?: string;           // "scene-123-bgm"
  scene_id?: number;           // シーンID
  source_type?: 'bgm' | 'sfx' | 'voice';
  cue_no?: number;             // SFX番号（1-based）
  utterance_id?: number;       // 発話ID
  
  // contextual: 再生位置から推定
  playback_context?: PlaybackContext;
  
  // relative: 相対指定
  relative_ref?: 'current' | 'previous' | 'next' | 'this_scene' | 'all_scenes';
}
```

### 2.3 AudioAction

```typescript
interface AudioAction {
  action_type: string;
  params: {
    // volume系
    volume?: number;           // 絶対値 0.0-1.0
    volume_delta?: number;     // 相対増減 -1.0〜+1.0
    
    // timing系
    start_ms?: number;
    end_ms?: number | null;
    start_delta_ms?: number;   // 開始位置調整
    end_delta_ms?: number;     // 終了位置調整
    
    // replace系
    new_source?: {
      library_type: 'system' | 'user' | 'direct';
      library_id?: number;
      direct_url?: string;
    };
    
    // duplicate系
    target_scene_id?: number;
    target_start_ms?: number;
    
    // duck系
    duck_volume?: number;      // duck時の音量（0.0-1.0）
    duck_trigger?: 'voice' | 'sfx' | 'all';
  };
}
```

---

## 3. Intent 分類マッピング表

### 3.1 BGM操作

| ユーザー発話例 | intent_type | target | params | Mode |
|--------------|-------------|--------|--------|------|
| 「BGM音量20%」 | bgm.volume_adjust | explicit | `{ volume: 0.2 }` | C |
| 「BGMうるさい」 | bgm.volume_adjust | contextual | `{ volume_delta: -0.2 }` | B |
| 「BGM下げて」 | bgm.volume_adjust | contextual | `{ volume_delta: -0.1 }` | B |
| 「BGM消して」 | bgm.remove | explicit | - | C |
| 「BGMを別のに変えたい」 | bgm.replace | contextual | - | B |

### 3.2 Scene BGM操作

| ユーザー発話例 | intent_type | target | params | Mode |
|--------------|-------------|--------|--------|------|
| 「このシーンにBGM追加」 | scene_bgm.add | this_scene | - | B |
| 「シーン3のBGM音量50%」 | scene_bgm.volume_adjust | explicit | `{ scene_id: 3, volume: 0.5 }` | C |
| 「このシーンのBGM30秒で終わらせて」 | scene_bgm.timing_adjust | this_scene | `{ end_ms: 30000 }` | C |
| 「ここのBGM消して」 | scene_bgm.remove | this_scene | - | C |
| 「前のシーンのBGMをここでも使って」 | scene_bgm.add | this_scene | `{ source: 'previous' }` | C |

### 3.3 SFX操作

| ユーザー発話例 | intent_type | target | params | Mode |
|--------------|-------------|--------|--------|------|
| 「効果音追加して」 | sfx.add | this_scene | - | B |
| 「SFX1の音量70%」 | sfx.volume_adjust | explicit | `{ cue_no: 1, volume: 0.7 }` | C |
| 「効果音うるさい」 | sfx.volume_adjust | contextual | `{ volume_delta: -0.2 }` | B |
| 「効果音2秒後から」 | sfx.timing_adjust | contextual | `{ start_ms: 2000 }` | B |
| 「この効果音を70秒にもコピー」 | sfx.duplicate | explicit | `{ target_start_ms: 70000 }` | C |
| 「効果音消して」 | sfx.remove | contextual | - | B |

### 3.4 Voice操作

| ユーザー発話例 | intent_type | target | params | Mode |
|--------------|-------------|--------|--------|------|
| 「この声大きくして」 | voice.volume_adjust | this_scene | `{ volume_delta: +0.2 }` | B |
| 「ナレーション音量100%」 | voice.volume_adjust | all_scenes | `{ volume: 1.0 }` | C |
| 「セリフの部分、BGM下げて」 | duck.configure | contextual | `{ duck_trigger: 'voice', duck_volume: 0.2 }` | B |

### 3.5 Duck操作

| ユーザー発話例 | intent_type | target | params | Mode |
|--------------|-------------|--------|--------|------|
| 「セリフ中はBGM下げて」 | duck.configure | all_scenes | `{ duck_trigger: 'voice', duck_volume: 0.2 }` | C |
| 「効果音の時もBGM下げて」 | duck.configure | all_scenes | `{ duck_trigger: 'all', duck_volume: 0.2 }` | B |

---

## 4. 曖昧→質問テンプレート

### 4.1 対象が曖昧な場合

```json
{
  "clarification_type": "target_ambiguous",
  "question": "どの音を調整しますか？",
  "options": [
    { "label": "プロジェクト全体のBGM", "value": "project_bgm" },
    { "label": "このシーンのBGM", "value": "scene_bgm" },
    { "label": "効果音（SFX）", "value": "sfx" }
  ]
}
```

### 4.2 シーンが曖昧な場合

```json
{
  "clarification_type": "scene_ambiguous",
  "question": "どのシーンの音を調整しますか？",
  "options": [
    { "label": "今見ているシーン（シーン3）", "value": "current" },
    { "label": "全シーン", "value": "all" },
    { "label": "シーンを選択...", "value": "select" }
  ]
}
```

### 4.3 値が曖昧な場合

```json
{
  "clarification_type": "value_ambiguous",
  "question": "BGMの音量をどれくらいにしますか？",
  "current_value": 0.5,
  "suggestions": [
    { "label": "20%（小さめ）", "value": 0.2 },
    { "label": "30%（控えめ）", "value": 0.3 },
    { "label": "40%（やや控えめ）", "value": 0.4 }
  ],
  "allow_custom": true
}
```

### 4.4 操作が曖昧な場合

```json
{
  "clarification_type": "action_ambiguous",
  "question": "効果音をどうしますか？",
  "options": [
    { "label": "音量を下げる", "intent": "sfx.volume_adjust", "params": { "volume_delta": -0.2 } },
    { "label": "削除する", "intent": "sfx.remove", "params": {} },
    { "label": "タイミングを変更する", "intent": "sfx.timing_adjust", "params": {} }
  ]
}
```

---

## 5. scene_audio_assignments マッピング

### 5.1 Intent → API マッピング

| intent_type | API Endpoint | Method | Body |
|-------------|--------------|--------|------|
| scene_bgm.add | `/api/scenes/:sceneId/audio-assignments` | POST | `{ audio_type: 'bgm', ... }` |
| scene_bgm.volume_adjust | `/api/scenes/:sceneId/audio-assignments/:id` | PUT | `{ volume_override: X }` |
| scene_bgm.timing_adjust | `/api/scenes/:sceneId/audio-assignments/:id` | PUT | `{ start_ms: X, end_ms: Y }` |
| scene_bgm.remove | `/api/scenes/:sceneId/audio-assignments/:id` | DELETE | - |
| scene_bgm.replace | `/api/scenes/:sceneId/audio-assignments` | POST | (既存を無効化→新規作成) |
| sfx.add | `/api/scenes/:sceneId/audio-assignments` | POST | `{ audio_type: 'sfx', ... }` |
| sfx.volume_adjust | `/api/scenes/:sceneId/audio-assignments/:id` | PUT | `{ volume_override: X }` |
| sfx.timing_adjust | `/api/scenes/:sceneId/audio-assignments/:id` | PUT | `{ start_ms: X, end_ms: Y }` |
| sfx.remove | `/api/scenes/:sceneId/audio-assignments/:id` | DELETE | - |
| sfx.duplicate | `/api/scenes/:sceneId/audio-assignments` | POST | (元イベントをコピー) |

### 5.2 Intent 解決フロー

```
1. ユーザー発話
   ↓
2. Intent 分類（AI or Regex）
   ↓
3. Target 解決（PlaybackContext 参照）
   ↓
4. 曖昧性チェック
   ├─ 曖昧あり → Mode B（確認カード表示）
   └─ 明確 → Mode C（即座に実行）
   ↓
5. API 呼び出し
   ↓
6. Remotion 反映（scene.bgm / scene.sfx 更新）
```

---

## 6. 曖昧語→数値変換表

### 6.1 音量表現

| 曖昧語 | volume_delta | 補足 |
|--------|--------------|------|
| うるさい | -0.2 | 現在値から20%減 |
| 大きい | -0.15 | 現在値から15%減 |
| 小さい | +0.1 | 現在値から10%増 |
| 聞こえない | +0.3 | 現在値から30%増 |
| ちょうどいい | 0 | 変更なし（確認のみ） |
| 下げて | -0.1 | デフォルト10%減 |
| 上げて | +0.1 | デフォルト10%増 |
| 消して | → remove | 削除アクションに変換 |
| ミュート | volume=0 | 完全消音 |

### 6.2 タイミング表現

| 曖昧語 | start_delta_ms | end_delta_ms | 補足 |
|--------|---------------|--------------|------|
| 早くして | -500 | - | 開始を500ms早める |
| 遅くして | +500 | - | 開始を500ms遅らせる |
| 長くして | - | +1000 | 終了を1秒延長 |
| 短くして | - | -1000 | 終了を1秒短縮 |
| 途中で切って | - | (要指定) | end_ms を明示指定が必要 |

---

## 7. 実装優先度

| 優先度 | Intent | 説明 |
|--------|--------|------|
| P0 | bgm.volume_adjust | 最頻出、基本操作 |
| P0 | scene_bgm.volume_adjust | シーン単位の調整 |
| P0 | sfx.volume_adjust | 効果音調整 |
| P1 | scene_bgm.add | BGM追加 |
| P1 | sfx.add | 効果音追加 |
| P1 | scene_bgm.timing_adjust | タイミング調整 |
| P2 | sfx.duplicate | 複製（再利用） |
| P2 | duck.configure | ダック設定 |
| P3 | voice.volume_adjust | 音声音量（通常変更不要） |

---

## 8. 補足：チャット指示例と解釈

### 8.1 具体例

| チャット指示 | 解釈 | Mode |
|-------------|------|------|
| 「BGM 20%」 | `bgm.volume_adjust { volume: 0.2 }` | C |
| 「BGMうるさい」 | `bgm.volume_adjust { volume_delta: -0.2 }` → 確認 | B |
| 「このセリフの部分だけBGM下げて」 | `duck.configure` + utterance の start_ms/end_ms で区間指定 | B |
| 「30秒の効果音を70秒にもコピー」 | `sfx.duplicate { source: scene-X-sfx-1, target_start_ms: 70000 }` | C |
| 「前のシーンの音楽をここでも使って」 | `scene_bgm.add { source: 'previous' }` | C |
| 「効果音2つ目を消して」 | `sfx.remove { cue_no: 2 }` | C |

### 8.2 確認フロー例

```
ユーザー: 「BGMうるさい」

AI: 「BGMの音量を下げますね。
     現在: 50%
     提案: 30%（20%減）
     でよろしいですか？」

ユーザー: 「もうちょっと」

AI: 「わかりました。20%まで下げますか？」

ユーザー: 「それでいい」

AI: [実行] → BGM音量を20%に設定しました。
```

---

---

## 9. P7: Audio Event 正規化レイヤー設計

### 9.1 概要

P7 は、現在の3層構造（system_audio_library, user_audio_library, scene_audio_assignments）から
統一された **AudioEvent** 形式への正規化レイヤーを提供する。

```
┌────────────────────────────────────────────────────────────────────┐
│                     Chat / UI Layer                                 │
├────────────────────────────────────────────────────────────────────┤
│  AudioIntent → AudioTarget → AudioAction                           │
└───────────────────────────┬────────────────────────────────────────┘
                            ↓
┌────────────────────────────────────────────────────────────────────┐
│              P7: AudioEvent 正規化レイヤー                          │
├────────────────────────────────────────────────────────────────────┤
│  normalizeToAudioEvents()                                          │
│  ├─ scene_audio_assignments → AudioEvent[]                         │
│  ├─ scene_utterances → AudioEvent[] (voice)                        │
│  └─ scene_audio_cues → AudioEvent[] (sfx legacy)                   │
│                                                                    │
│  resolveIntent() → API calls                                       │
│  ├─ target解決 (explicit/contextual/relative)                      │
│  ├─ 曖昧性チェック                                                  │
│  └─ DB更新 + Remotion反映                                          │
└───────────────────────────┬────────────────────────────────────────┘
                            ↓
┌────────────────────────────────────────────────────────────────────┐
│                 DB Layer (SSOT)                                     │
├────────────────────────────────────────────────────────────────────┤
│  scene_audio_assignments (BGM/SFX)                                 │
│  scene_utterances (Voice)                                           │
│  scene_audio_cues (Legacy SFX)                                      │
└───────────────────────────┬────────────────────────────────────────┘
                            ↓
┌────────────────────────────────────────────────────────────────────┐
│           Remotion Build Layer                                      │
├────────────────────────────────────────────────────────────────────┤
│  buildProjectJson() → scene.bgm, scene.sfx, scene.voices           │
└────────────────────────────────────────────────────────────────────┘
```

### 9.2 正規化関数

```typescript
// src/utils/audio-event-normalizer.ts

import type { SceneData } from './video-build-helpers';

/**
 * シーンデータから全ての AudioEvent を正規化して取得
 */
export function normalizeToAudioEvents(scene: SceneData): AudioEvent[] {
  const events: AudioEvent[] = [];
  const sceneId = scene.id;
  
  // 1. BGM (scene.bgm から)
  if (scene.bgm) {
    events.push({
      id: `scene-${sceneId}-bgm`,
      scene_id: sceneId,
      source_type: 'bgm',
      source_id: scene.bgm.id,
      start_ms: scene.bgm.start_ms ?? 0,
      end_ms: scene.bgm.end_ms ?? null,
      volume: scene.bgm.volume ?? 0.25,
      fade_in_ms: scene.bgm.fade_in_ms ?? 120,
      fade_out_ms: scene.bgm.fade_out_ms ?? 120,
      priority: 10,
      is_active: true,
    });
  }
  
  // 2. SFX (scene_audio_assignments から)
  // Note: scene.sfx は将来追加予定、現在は assignments から取得する想定
  // const sfxList = scene.sfx || [];
  // sfxList.forEach((sfx, idx) => { ... });
  
  // 3. Voice (utterances から)
  const utterances = scene.utterances || [];
  let voiceStartMs = 0;
  utterances.forEach((utterance, idx) => {
    const durationMs = utterance.duration_ms || 0;
    if (durationMs > 0 && utterance.audio_url) {
      events.push({
        id: `scene-${sceneId}-voice-${idx + 1}`,
        scene_id: sceneId,
        source_type: 'voice',
        source_id: utterance.id,
        start_ms: voiceStartMs,
        end_ms: voiceStartMs + durationMs,
        volume: 1.0, // Voice は通常100%
        fade_in_ms: 0,
        fade_out_ms: 0,
        priority: 100,
        is_active: true,
      });
      voiceStartMs += durationMs;
    }
  });
  
  return events;
}

/**
 * AudioEvent の識別子からイベントを検索
 */
export function findAudioEventById(
  events: AudioEvent[],
  eventId: string
): AudioEvent | undefined {
  return events.find(e => e.id === eventId);
}

/**
 * 時間範囲に重なる AudioEvent を取得
 */
export function findAudioEventsInRange(
  events: AudioEvent[],
  startMs: number,
  endMs: number
): AudioEvent[] {
  return events.filter(e => {
    const eventEnd = e.end_ms ?? Infinity;
    return e.start_ms < endMs && eventEnd > startMs;
  });
}
```

### 9.3 Intent 解決フロー

```typescript
// src/utils/audio-intent-resolver.ts

interface ResolveResult {
  success: boolean;
  mode: 'A' | 'B' | 'C';
  actions?: ApiAction[];
  clarification?: ClarificationRequest;
  message?: string;
}

/**
 * AudioIntent を解決して API アクションに変換
 */
export async function resolveAudioIntent(
  intent: AudioIntent,
  context: {
    playbackContext?: PlaybackContext;
    scenes: SceneData[];
  }
): Promise<ResolveResult> {
  const { target, action, params } = intent;
  
  // 1. Target 解決
  const resolvedTarget = await resolveTarget(target, context);
  if (!resolvedTarget.resolved) {
    return {
      success: false,
      mode: 'B',
      clarification: resolvedTarget.clarification,
    };
  }
  
  // 2. 曖昧性チェック
  const ambiguityCheck = checkAmbiguity(intent, resolvedTarget);
  if (ambiguityCheck.needsClarification) {
    return {
      success: false,
      mode: 'B',
      clarification: ambiguityCheck.clarification,
    };
  }
  
  // 3. API アクション生成
  const actions = generateApiActions(intent, resolvedTarget);
  
  return {
    success: true,
    mode: 'C',
    actions,
    message: generateConfirmationMessage(intent, resolvedTarget),
  };
}

/**
 * Target を解決
 */
function resolveTarget(
  target: AudioTarget,
  context: { playbackContext?: PlaybackContext; scenes: SceneData[] }
): { resolved: boolean; sceneId?: number; eventId?: string; clarification?: ClarificationRequest } {
  
  // explicit: 明示的に指定されている場合
  if (target.target_type === 'explicit' && target.scene_id) {
    return { resolved: true, sceneId: target.scene_id, eventId: target.event_id };
  }
  
  // contextual: 再生位置から推定
  if (target.target_type === 'contextual' && context.playbackContext) {
    return {
      resolved: true,
      sceneId: context.playbackContext.scene_id,
    };
  }
  
  // relative: 相対指定
  if (target.target_type === 'relative') {
    if (target.relative_ref === 'this_scene' && context.playbackContext) {
      return { resolved: true, sceneId: context.playbackContext.scene_id };
    }
    if (target.relative_ref === 'all_scenes') {
      return { resolved: true }; // 全シーン対象
    }
    // previous/next は playbackContext から計算
  }
  
  // 解決できない場合
  return {
    resolved: false,
    clarification: {
      clarification_type: 'scene_ambiguous',
      question: 'どのシーンの音を調整しますか？',
      options: [
        { label: '今見ているシーン', value: 'current' },
        { label: '全シーン', value: 'all' },
      ],
    },
  };
}
```

### 9.4 実装ファイル構成（予定）

```
src/utils/
├── audio-event-normalizer.ts   # P7: AudioEvent 正規化
├── audio-intent-resolver.ts    # P7: Intent 解決
├── audio-intent-parser.ts      # Intent 分類（AI/Regex）
└── video-build-helpers.ts      # 既存（buildProjectJson 等）
```

### 9.5 移行計画

| Phase | 内容 | 期間 |
|-------|------|------|
| Phase 1 | AudioEvent 型定義・正規化関数 | 1日 |
| Phase 2 | Intent 解決フロー基盤 | 2日 |
| Phase 3 | Regex パーサー（P0 Intent） | 1日 |
| Phase 4 | AI パーサー統合 | 2日 |
| Phase 5 | E2E テスト | 1日 |

---

## 更新履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|----------|
| 2026-01-31 | 1.0 | 初版作成（P7準備） |
| 2026-01-31 | 1.1 | P7 正規化レイヤー設計追加 |
