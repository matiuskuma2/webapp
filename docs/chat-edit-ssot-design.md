# チャット修正システム SSOT設計書（確定版）

## 概要

このドキュメントは、チャット修正システムの **Single Source of Truth (SSOT)** を定義します。
すべての実装はこの仕様に従います。

---

## STEP① Playback Context（再生文脈）

### 1.1 概念定義

**Playback Context** = 「今、ユーザーが見ているシーン」の事実情報

```typescript
interface PlaybackContext {
  scene_idx: number;          // 1-based
  scene_id: number;           // DBのscene.id
  playback_time_ms: number;   // video.currentTime * 1000

  scene_snapshot: {
    has_image: boolean;
    has_audio: boolean;
    telop_enabled: boolean;
    balloon_count: number;
    sfx_count: number;
  };
}
```

### 1.2 シーン特定アルゴリズム

```javascript
function getCurrentScene(currentTimeMs, scenes) {
  let acc = 0;
  for (let i = 0; i < scenes.length; i++) {
    const duration = scenes[i].duration_ms || 5000;
    if (currentTimeMs < acc + duration) {
      return {
        scene_idx: i + 1,
        scene_id: scenes[i].id,
        // ... snapshot
      };
    }
    acc += duration;
  }
  return scenes.length > 0 ? scenes[scenes.length - 1] : null;
}
```

### 1.3 更新タイミング

| イベント | 処理 |
|----------|------|
| `timeupdate` | syncPlaybackContext() |
| `seeked` | syncPlaybackContext() |
| `play` | syncPlaybackContext() |

### 1.4 SSOT原則

- **scene_idx は常に再生位置由来**
- **手動セレクタに頼らない**
- **ユーザー入力より事実を優先**

---

## STEP② 会話AIの3モード定義

### 2.1 モード一覧

| Mode | 名称 | 役割 | 出力 | UI |
|------|------|------|------|-----|
| **A** | Conversation | 会話 | assistant_message のみ | 会話文のみ |
| **B** | Suggestion | 提案 | assistant_message + suggestion + intent | 提案カード |
| **C** | Direct Edit | 即編集 | assistant_message + intent | dry-run直行 |

### 2.2 モード判定ルール（優先順）

```
Rule 1: actions が空 → 必ず Mode A

Rule 2: actions がある場合
  ├─ 対象が明確 AND 数値/ON-OFFが明確 → Mode C
  └─ それ以外（曖昧語含む） → Mode B
```

### 2.3 Mode C の条件（Direct Edit）

以下がすべて揃っている場合：
- `scene_idx` が確定（playbackContext or 明示指定）
- 対象が確定（balloon_no / cue_no / telop など）
- 値が確定（volume / position / size / start_ms,end_ms など）

**例:**
- 「シーン3のバブル2を3秒〜5秒表示」→ Mode C
- 「BGM 20%」→ Mode C
- 「テロップ位置を上」→ Mode C

### 2.4 Mode B の条件（Suggestion）

以下のいずれかに該当：
- 曖昧語を含む：「うるさい」「邪魔」「いい感じ」「見やすく」
- 対象が曖昧：balloon_no なし、cue_no なし
- 複数案が考えられる：「テロップ修正して」→ OFFか位置か不明

**例:**
- 「BGMうるさい」→ Mode B
- 「テロップ邪魔」→ Mode B
- 「吹き出しを声に合わせたい」→ Mode B

### 2.5 Mode A の条件（Conversation）

- actions が空配列
- 雑談、挨拶、質問

**例:**
- 「よろしくね」→ Mode A
- 「ありがとう」→ Mode A
- 「どうすればいい？」→ Mode A

### 2.6 提案の対象語ルール

**提案は根拠がある時だけ** = user_message に対象語が含まれる場合のみ

| 対象 | キーワード |
|------|-----------|
| テロップ | テロップ, 字幕, 文字, 読みにくい |
| BGM | BGM, 音楽, うるさい, 静か |
| 吹き出し | 吹き出し, バブル, セリフ, ふきだし |
| 効果音 | 効果音, SFX, 音, SE |
| 画像 | 画像, 絵, 動かして, モーション |

**原則:** 対象語が無いのに提案しない（雑談は Mode A）

---

## STEP③ 現状コードとのズレ一覧

### 3.1 主要なズレ

| No | ズレ | 原因 | 影響 |
|----|------|------|------|
| 1 | Mode判定が存在しない | 分岐ロジック未実装 | Mode B/Cの区別なし |
| 2 | 確認ボタンが出ない | intent.actions が空/不正 | UX破綻 |
| 3 | 言ってない提案が出る | 対象語チェックなし | 会話不自然 |
| 4 | 今のシーンを誰も知らない | playbackContext未実装 | 「ここ」解決不可 |
| 5 | 確認押すとエラー | intent が壊れている | 操作不可 |

### 3.2 コード箇所

| 機能 | ファイル | 関数 |
|------|----------|------|
| Mode判定（なし） | project-editor.js | sendChatEditMessage |
| AI会話 | patches.ts | geminiChatWithSuggestion |
| Intent解決 | patches.ts | resolveIntentToOps |
| Dry-run | patches.ts | executeDryRun |

---

## STEP④ Mode判定関数の設計

### 4.1 関数シグネチャ

```typescript
type ChatMode = 'A' | 'B' | 'C';

interface ModeDecisionInput {
  userMessage: string;
  intent: RilarcIntent | null;
  playbackContext: PlaybackContext | null;
}

interface ModeDecisionResult {
  mode: ChatMode;
  reason: string;
  normalizedIntent: RilarcIntent | null;
}

function decideChatMode(input: ModeDecisionInput): ModeDecisionResult;
```

### 4.2 判定ロジック（疑似コード）

```javascript
function decideChatMode({ userMessage, intent, playbackContext }) {
  // Rule 1: actions が空 → Mode A
  if (!intent || !intent.actions || intent.actions.length === 0) {
    return {
      mode: 'A',
      reason: 'No actions in intent',
      normalizedIntent: null
    };
  }

  // Rule 2: actions がある → Mode B or C を判定
  const actions = intent.actions;
  
  // 全アクションが「明確」かチェック
  const allActionsExplicit = actions.every(action => {
    return isActionExplicit(action, playbackContext);
  });

  if (allActionsExplicit) {
    // Mode C: Direct Edit
    return {
      mode: 'C',
      reason: 'All actions are explicit',
      normalizedIntent: normalizeIntent(intent, playbackContext)
    };
  } else {
    // Mode B: Suggestion
    return {
      mode: 'B',
      reason: 'Actions contain ambiguous elements',
      normalizedIntent: normalizeIntent(intent, playbackContext)
    };
  }
}

function isActionExplicit(action, playbackContext) {
  // scene_idx が明示 or playbackContext から取得可能
  const hasSceneIdx = action.scene_idx != null || playbackContext?.scene_idx != null;
  
  // アクション種別ごとの明確性チェック
  switch (action.action) {
    case 'bgm.set_volume':
      return typeof action.volume === 'number';
    case 'bgm.set_loop':
      return typeof action.loop === 'boolean';
    case 'telop.set_enabled':
      return typeof action.enabled === 'boolean';
    case 'telop.set_enabled_scene':
      return hasSceneIdx && typeof action.enabled === 'boolean';
    case 'telop.set_position':
      return ['top', 'center', 'bottom'].includes(action.position_preset);
    case 'telop.set_size':
      return ['sm', 'md', 'lg'].includes(action.size_preset);
    case 'balloon.set_policy':
      return hasSceneIdx && action.balloon_no != null && action.policy != null;
    case 'balloon.adjust_window':
      return hasSceneIdx && action.balloon_no != null;
    case 'sfx.set_volume':
      return hasSceneIdx && action.cue_no != null && typeof action.volume === 'number';
    case 'sfx.remove':
      return hasSceneIdx && action.cue_no != null;
    default:
      return false;
  }
}

function normalizeIntent(intent, playbackContext) {
  // scene_idx が未指定のアクションに playbackContext.scene_idx を補完
  const normalizedActions = intent.actions.map(action => {
    if (action.scene_idx == null && playbackContext?.scene_idx != null) {
      // シーン単位のアクションに scene_idx を補完
      if (SCENE_LEVEL_ACTIONS.includes(action.action)) {
        return { ...action, scene_idx: playbackContext.scene_idx };
      }
    }
    return action;
  });

  return {
    ...intent,
    actions: normalizedActions
  };
}

const SCENE_LEVEL_ACTIONS = [
  'telop.set_enabled_scene',
  'balloon.adjust_window',
  'balloon.adjust_position',
  'balloon.set_policy',
  'sfx.set_volume',
  'sfx.set_timing',
  'sfx.remove',
  'sfx.add_from_library'
];
```

### 4.3 UI側の分岐

```javascript
async function sendChatEditMessage() {
  const message = input.value.trim();
  const playbackContext = window.chatEditState?.playbackContext;

  // Step 1: Intent を取得（regex or AI）
  let intent = null;
  const parsed = parseMessageToIntent(message);
  if (parsed.ok && parsed.intent?.actions?.length > 0) {
    intent = parsed.intent;
  } else if (window.chatEditState?.useAiParse) {
    const aiResult = await callChatAPI(message, playbackContext);
    if (aiResult.suggestion?.intent) {
      intent = aiResult.suggestion.intent;
    }
    // 会話メッセージは常に表示
    showAssistantMessage(aiResult.assistant_message);
  }

  // Step 2: Mode 判定
  const decision = decideChatMode({ userMessage: message, intent, playbackContext });

  // Step 3: Mode に応じた処理
  switch (decision.mode) {
    case 'A':
      // 会話のみ（提案カード出さない）
      break;

    case 'B':
      // 提案カード表示
      showSuggestionCard(decision.normalizedIntent, aiResult?.suggestion?.summary);
      break;

    case 'C':
      // 直接 dry-run へ
      await processDryRunWithIntent(decision.normalizedIntent, message);
      break;
  }
}
```

---

## STEP⑤ 実装順序（確定）

| 順番 | タスク | 優先度 | 工数 |
|------|--------|--------|------|
| 1 | `decideChatMode` 関数実装 | 🔴高 | 2h |
| 2 | `syncPlaybackContext` 実装（動画連携） | 🔴高 | 3h |
| 3 | `sendChatEditMessage` の分岐改修 | 🔴高 | 2h |
| 4 | AI プロンプトに current_scene 追加 | 🟠中 | 2h |
| 5 | エラーメッセージのユーザーフレンドリー化 | 🟠中 | 1h |
| 6 | 新アクション追加（motion, image） | 🟡低 | 6h |

---

## 変更履歴

| 日付 | 変更内容 |
|------|----------|
| 2026-01-29 | 初版作成（STEP①〜④確定） |
| 2026-01-29 | STEP⑤-1〜5 実装完了 |
