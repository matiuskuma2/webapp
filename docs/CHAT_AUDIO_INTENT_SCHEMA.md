# Chat Audio Intent Schema（音声編 Intent分類表）

**最終更新**: 2026-01-31  
**バージョン**: 1.0  
**目的**: チャット指示から音声操作Intentを正確に抽出・分類するためのSSOT

---

## 1. AudioEvent SSOT（基本データ構造）

すべての音声を「イベント」として時間帯で管理する。

```typescript
interface AudioEvent {
  id: string;                    // "scene-{sceneId}-{type}-{n}" 形式
  scene_id: number;              // 所属シーンID
  source_type: 'bgm' | 'sfx' | 'voice';
  source_id: number | null;      // library ID (system/user) or null (direct)
  start_ms: number;              // シーン内相対開始位置
  end_ms: number | null;         // null = 自然長（素材の終わりまで）
  volume: number;                // 0.0 ~ 1.0
  fade_in_ms: number;
  fade_out_ms: number;
  priority: number;              // voice=100, sfx=50, bgm=10
}
```

### Priority ルール
- **voice (100)**: 最優先。voiceが鳴っている区間は他の音を自動duck
- **sfx (50)**: 中間。BGMより優先
- **bgm (10)**: 最低優先。他の音が鳴っていないとき通常再生

---

## 2. Intent Action Types（音声操作Intent一覧）

### 2.1 BGM操作

| Action | 説明 | 必須パラメータ | オプション |
|--------|------|---------------|-----------|
| `bgm.set_volume` | BGM音量変更 | `volume: number` | `scene_idx` |
| `bgm.set_volume_delta` | BGM音量を相対変更 | `delta: number` | `scene_idx` |
| `bgm.replace` | BGMを差し替え | `library_type`, `library_id` | `scene_idx` |
| `bgm.remove` | BGMを削除 | - | `scene_idx` |
| `bgm.set_timing` | BGM区間変更 | `start_ms`, `end_ms` | `scene_idx` |
| `bgm.duck` | 特定区間でBGM音量を下げる | `when`, `duck_volume` | - |

### 2.2 Scene BGM操作（シーン固有BGM）

| Action | 説明 | 必須パラメータ | オプション |
|--------|------|---------------|-----------|
| `scene_bgm.assign` | シーンにBGM割当 | `scene_idx`, `library_type`, `library_id` | `volume`, `start_ms`, `end_ms` |
| `scene_bgm.set_volume` | シーンBGM音量変更 | `scene_idx`, `volume` | - |
| `scene_bgm.set_timing` | シーンBGM区間変更 | `scene_idx`, `start_ms`, `end_ms` | - |
| `scene_bgm.remove` | シーンBGM削除 | `scene_idx` | - |

### 2.3 SFX操作

| Action | 説明 | 必須パラメータ | オプション |
|--------|------|---------------|-----------|
| `sfx.add` | SFX追加 | `scene_idx`, `library_type`, `library_id` | `start_ms`, `volume` |
| `sfx.set_volume` | SFX音量変更 | `scene_idx`, `sfx_no` or `sfx_id`, `volume` | - |
| `sfx.set_timing` | SFXタイミング変更 | `scene_idx`, `sfx_no`, `start_ms` | `end_ms` |
| `sfx.remove` | SFX削除 | `scene_idx`, `sfx_no` or `sfx_id` | - |
| `sfx.duplicate` | SFXを複製（別タイミング） | `source_sfx_id`, `new_start_ms` | `new_scene_idx` |

### 2.4 Voice操作（将来拡張）

| Action | 説明 | 必須パラメータ | オプション |
|--------|------|---------------|-----------|
| `voice.set_volume` | 音声音量変更 | `scene_idx`, `voice_no` or `utterance_id`, `volume` | - |
| `voice.regenerate` | 音声再生成 | `scene_idx`, `voice_no` | `new_text`, `voice_style` |

### 2.5 複合操作

| Action | 説明 | 必須パラメータ | オプション |
|--------|------|---------------|-----------|
| `audio.duck_for_voice` | 特定音声区間でBGM/SFXをduck | `utterance_id` or `voice_no`, `duck_volume` | - |
| `audio.reuse` | 別シーンの音を再利用 | `source_scene_idx`, `source_type`, `target_scene_idx` | - |

---

## 3. Intent JSON Schema

### 3.1 基本構造

```typescript
interface AudioIntent {
  domain: 'audio';
  actions: AudioAction[];
  context: {
    scene_idx?: number;        // playbackContextから補完可能
    scene_id?: number;
    playback_time_ms?: number;
  };
  confidence: 'high' | 'medium' | 'low';
  ambiguous_fields?: string[]; // 曖昧な項目リスト
}

interface AudioAction {
  action: string;              // Action Type
  target?: string;             // 識別子 "scene-{sceneId}-bgm" など
  params: Record<string, any>; // アクション固有パラメータ
}
```

### 3.2 具体例

#### BGM音量変更（明確）
```json
{
  "domain": "audio",
  "actions": [{
    "action": "bgm.set_volume",
    "target": "project-bgm",
    "params": { "volume": 0.2 }
  }],
  "context": {},
  "confidence": "high"
}
```

#### シーンBGM音量変更（シーン指定）
```json
{
  "domain": "audio",
  "actions": [{
    "action": "scene_bgm.set_volume",
    "target": "scene-537-bgm",
    "params": { 
      "scene_idx": 3,
      "volume": 0.15 
    }
  }],
  "context": { "scene_idx": 3 },
  "confidence": "high"
}
```

#### BGMうるさい（曖昧）
```json
{
  "domain": "audio",
  "actions": [{
    "action": "bgm.set_volume_delta",
    "target": "project-bgm",
    "params": { "delta": -0.1 }
  }],
  "context": {},
  "confidence": "medium",
  "ambiguous_fields": ["delta"]
}
```

#### SFX追加
```json
{
  "domain": "audio",
  "actions": [{
    "action": "sfx.add",
    "params": {
      "scene_idx": 2,
      "library_type": "system",
      "library_id": 15,
      "start_ms": 1500,
      "volume": 0.8
    }
  }],
  "context": { "scene_idx": 2 },
  "confidence": "high"
}
```

#### 複数アクション（シーンBGM + SFX削除）
```json
{
  "domain": "audio",
  "actions": [
    {
      "action": "scene_bgm.set_volume",
      "target": "scene-537-bgm",
      "params": { "scene_idx": 3, "volume": 0.1 }
    },
    {
      "action": "sfx.remove",
      "target": "scene-537-sfx-1",
      "params": { "scene_idx": 3, "sfx_no": 1 }
    }
  ],
  "context": { "scene_idx": 3 },
  "confidence": "high"
}
```

---

## 4. ユーザー入力 → Intent 変換ルール

### 4.1 キーワード→対象マッピング

| キーワード | 対象 (target_type) | 備考 |
|-----------|-------------------|------|
| BGM, 音楽, 曲 | `bgm` | プロジェクトBGM or シーンBGM |
| このシーンのBGM, シーンの音楽 | `scene_bgm` | シーン固有BGM |
| 効果音, SFX, SE, 音 | `sfx` | シーン内効果音 |
| セリフ, 声, 音声, ナレーション | `voice` | utterance |
| テロップ | - | 音声domain外 |

### 4.2 曖昧語→パラメータ推定

| 曖昧語 | 推定 Action | 推定パラメータ | confidence |
|--------|------------|---------------|------------|
| うるさい | `*.set_volume_delta` | `delta: -0.1` | medium |
| 静かに | `*.set_volume_delta` | `delta: -0.15` | medium |
| 大きく | `*.set_volume_delta` | `delta: +0.1` | medium |
| 小さく | `*.set_volume_delta` | `delta: -0.1` | medium |
| 消して, 削除 | `*.remove` | - | high |
| ミュート | `*.set_volume` | `volume: 0` | high |
| 邪魔 | `*.set_volume_delta` or `*.remove` | - | low |
| 聞こえない | `*.set_volume_delta` | `delta: +0.15` | medium |

### 4.3 時間指定パターン

| パターン | 解釈 | 例 |
|---------|------|-----|
| `{N}秒から` | `start_ms = N * 1000` | "3秒から" → 3000 |
| `{N}秒まで` | `end_ms = N * 1000` | "5秒まで" → 5000 |
| `{N}秒〜{M}秒` | `start_ms, end_ms` | "2〜4秒" → 2000, 4000 |
| `シーン{N}` | `scene_idx = N` | "シーン3" → scene_idx: 3 |
| `この部分`, `ここ` | playbackContextから | 現在再生位置 |
| `最初`, `冒頭` | `start_ms = 0` | - |
| `最後`, `終わり` | `end_ms = null (自然長)` | - |

### 4.4 相対指定パターン

| パターン | 解釈 | 例 |
|---------|------|-----|
| `{N}%` | 現在値の N% | "50%" → volume *= 0.5 |
| `半分` | 現在値の 50% | volume *= 0.5 |
| `2倍` | 現在値の 200% (max 1.0) | volume *= 2.0 |
| `もっと` | delta適用 | delta: ±0.1 |
| `少し` | delta適用（小さめ） | delta: ±0.05 |

---

## 5. Mode判定ルール（音声編）

### 5.1 Mode C（Direct Edit）条件

以下がすべて満たされる場合：
1. `target_type` が明確（bgm / scene_bgm / sfx / voice）
2. `scene_idx` が明確（明示 or playbackContext）
3. 操作が明確（volume数値 / remove / add with library_id）

**例:**
- 「BGM 20%にして」→ Mode C
- 「シーン3のSFX削除」→ Mode C
- 「このシーンのBGMを0.1に」→ Mode C（playbackContextあり）

### 5.2 Mode B（Suggestion）条件

以下のいずれか：
1. 曖昧語を含む（うるさい、邪魔、いい感じ）
2. `target_type` が曖昧（「音」だけでは bgm/sfx/voice 不明）
3. 数値が曖昧（「もっと」「少し」）
4. 複数解釈が可能

**例:**
- 「BGMうるさい」→ Mode B（delta値が曖昧）
- 「この音消して」→ Mode B（bgm/sfx/voice不明）
- 「シーン2の音量下げて」→ Mode B（どの音か不明）

### 5.3 Mode A（Conversation）条件

- 音声関連キーワードなし
- 質問のみ（「BGMって変えられる？」）
- 雑談

---

## 6. 識別子（Identifier）ルール

### 6.1 形式

| 対象 | 識別子形式 | 例 |
|------|-----------|-----|
| Project BGM | `project-bgm` | - |
| Scene BGM | `scene-{sceneId}-bgm` | `scene-537-bgm` |
| Scene SFX | `scene-{sceneId}-sfx-{n}` | `scene-537-sfx-1` |
| Voice | `scene-{sceneId}-voice-{n}` | `scene-537-voice-1` |

### 6.2 SFX連番ルール

- `n` は start_ms 昇順での連番（1始まり）
- 同一 start_ms の場合は created_at 順
- UI/Chat表示用。DBのidとは別管理

---

## 7. API マッピング

### 7.1 Intent → API エンドポイント

| Intent Action | HTTP Method | Endpoint | Body |
|---------------|-------------|----------|------|
| `bgm.set_volume` | PUT | `/api/projects/:id/settings` | `{ bgm_volume }` |
| `scene_bgm.assign` | POST | `/api/scenes/:sceneId/audio-assignments` | `{ audio_type: 'bgm', ... }` |
| `scene_bgm.set_volume` | PUT | `/api/scenes/:sceneId/audio-assignments/:id` | `{ volume_override }` |
| `scene_bgm.set_timing` | PUT | `/api/scenes/:sceneId/audio-assignments/:id` | `{ start_ms, end_ms }` |
| `scene_bgm.remove` | DELETE | `/api/scenes/:sceneId/audio-assignments/:id` | - |
| `sfx.add` | POST | `/api/scenes/:sceneId/audio-assignments` | `{ audio_type: 'sfx', ... }` |
| `sfx.set_volume` | PUT | `/api/scenes/:sceneId/audio-assignments/:id` | `{ volume_override }` |
| `sfx.set_timing` | PUT | `/api/scenes/:sceneId/audio-assignments/:id` | `{ start_ms, end_ms }` |
| `sfx.remove` | DELETE | `/api/scenes/:sceneId/audio-assignments/:id` | - |

### 7.2 scene_audio_assignments テーブル対応

| Intent param | DB column | 備考 |
|--------------|-----------|------|
| `library_type` | `audio_library_type` | 'system' / 'user' / 'direct' |
| `library_id` (system) | `system_audio_id` | - |
| `library_id` (user) | `user_audio_id` | - |
| `volume` | `volume_override` | null = ライブラリデフォルト |
| `start_ms` | `start_ms` | - |
| `end_ms` | `end_ms` | null = 自然長 |
| `loop` | `loop_override` | null = ライブラリデフォルト |

---

## 8. 曖昧時の確認テンプレート

### 8.1 対象不明

```
「{入力}」について確認させてください。

どの音を調整しますか？
1. BGM（バックグラウンドミュージック）
2. 効果音（SFX）
3. セリフ・ナレーション
```

### 8.2 シーン不明

```
どのシーンの音を調整しますか？

現在のシーン: シーン{N}（{playback_time}秒付近）

1. 現在のシーン（シーン{N}）
2. プロジェクト全体
3. 別のシーンを指定
```

### 8.3 音量不明（曖昧語）

```
「{曖昧語}」とのことですが、どのくらい調整しますか？

現在の音量: {current_volume * 100}%

1. 少し下げる（-10%）→ {new_volume}%
2. 半分にする（50%）→ {half_volume}%
3. かなり下げる（-30%）→ {much_lower}%
4. ミュート（0%）
```

### 8.4 SFX特定不明

```
シーン{N}には複数の効果音があります。
どれを調整しますか？

{sfx_list.map((sfx, i) => `${i+1}. ${sfx.name}（${sfx.start_ms/1000}秒〜）`).join('\n')}
```

### 8.5 操作確認（Mode B → C 移行）

```
以下の操作を実行してよろしいですか？

対象: {target_name}（{identifier}）
操作: {action_description}
変更: {current_value} → {new_value}

[実行] [キャンセル] [調整]
```

---

## 9. 実装チェックリスト

### Phase 1: Intent Parser
- [ ] キーワード抽出（bgm/sfx/voice/シーン/音量/削除など）
- [ ] 数値抽出（パーセント、秒、シーン番号）
- [ ] 曖昧語検出
- [ ] playbackContext 統合

### Phase 2: Action Generator
- [ ] Intent → Action 変換
- [ ] 識別子生成（scene-{id}-bgm など）
- [ ] API パラメータ構築

### Phase 3: Mode Decision
- [ ] Mode A/B/C 判定ロジック
- [ ] 曖昧時の質問生成
- [ ] 確認カード表示

### Phase 4: API Execution
- [ ] dry-run 実行
- [ ] 実行結果プレビュー
- [ ] エラーハンドリング

---

## 10. scene_audio_assignments 完全マッピング表

### 10.1 DB Schema 対応

```sql
-- scene_audio_assignments テーブル構造
CREATE TABLE scene_audio_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  audio_library_type TEXT NOT NULL,  -- 'system' | 'user' | 'direct'
  system_audio_id INTEGER,           -- audio_library_type='system' の場合
  user_audio_id INTEGER,             -- audio_library_type='user' の場合
  direct_r2_key TEXT,                -- audio_library_type='direct' の場合
  direct_r2_url TEXT,
  direct_name TEXT,
  direct_duration_ms INTEGER,
  audio_type TEXT NOT NULL,          -- 'bgm' | 'sfx'
  start_ms INTEGER DEFAULT 0,
  end_ms INTEGER,                    -- NULL = 自然長
  volume_override REAL,
  loop_override INTEGER,             -- 0 | 1 | NULL
  fade_in_ms_override INTEGER,
  fade_out_ms_override INTEGER,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME,
  updated_at DATETIME
);
```

### 10.2 Intent → API → DB マッピング

#### BGM系操作

| Intent Action | API Endpoint | HTTP | DB操作 | 主要カラム |
|---------------|--------------|------|--------|-----------|
| `scene_bgm.assign` | `POST /api/scenes/:sceneId/audio-assignments` | POST | INSERT + UPDATE(旧BGM is_active=0) | `audio_type='bgm'`, `audio_library_type`, `system_audio_id`/`user_audio_id` |
| `scene_bgm.set_volume` | `PUT /api/scenes/:sceneId/audio-assignments/:id` | PUT | UPDATE | `volume_override` |
| `scene_bgm.set_timing` | `PUT /api/scenes/:sceneId/audio-assignments/:id` | PUT | UPDATE | `start_ms`, `end_ms` |
| `scene_bgm.remove` | `DELETE /api/scenes/:sceneId/audio-assignments/:id` | DELETE | DELETE (or `is_active=0`) | - |

#### SFX系操作

| Intent Action | API Endpoint | HTTP | DB操作 | 主要カラム |
|---------------|--------------|------|--------|-----------|
| `sfx.add` | `POST /api/scenes/:sceneId/audio-assignments` | POST | INSERT | `audio_type='sfx'`, `start_ms` |
| `sfx.set_volume` | `PUT /api/scenes/:sceneId/audio-assignments/:id` | PUT | UPDATE | `volume_override` |
| `sfx.set_timing` | `PUT /api/scenes/:sceneId/audio-assignments/:id` | PUT | UPDATE | `start_ms`, `end_ms` |
| `sfx.remove` | `DELETE /api/scenes/:sceneId/audio-assignments/:id` | DELETE | DELETE | - |
| `sfx.duplicate` | `POST /api/scenes/:sceneId/audio-assignments` | POST | INSERT (コピー) | 同じ `audio_library_type`/ID, 新しい `start_ms` |

### 10.3 Intent params → API Body → DB columns

```typescript
// Intent Action params
interface SceneBgmAssignParams {
  scene_idx: number;           // → sceneId (URLパラメータ)
  library_type: 'system' | 'user' | 'direct';  // → audio_library_type
  library_id: number;          // → system_audio_id or user_audio_id
  volume?: number;             // → volume_override
  start_ms?: number;           // → start_ms
  end_ms?: number;             // → end_ms
  loop?: boolean;              // → loop_override (0/1)
  fade_in_ms?: number;         // → fade_in_ms_override
  fade_out_ms?: number;        // → fade_out_ms_override
}

// API Request Body (POST /api/scenes/:sceneId/audio-assignments)
interface CreateAssignmentBody {
  audio_library_type: 'system' | 'user' | 'direct';
  audio_type: 'bgm' | 'sfx';
  system_audio_id?: number;
  user_audio_id?: number;
  direct_r2_url?: string;
  direct_name?: string;
  direct_duration_ms?: number;
  start_ms?: number;           // default: 0
  end_ms?: number;             // default: null (自然長)
  volume_override?: number;    // default: null (ライブラリ設定)
  loop_override?: boolean;     // default: null
  fade_in_ms_override?: number;
  fade_out_ms_override?: number;
}

// API Request Body (PUT /api/scenes/:sceneId/audio-assignments/:id)
interface UpdateAssignmentBody {
  start_ms?: number;
  end_ms?: number | null;
  volume_override?: number | null;
  loop_override?: boolean | null;
  fade_in_ms_override?: number | null;
  fade_out_ms_override?: number | null;
  is_active?: boolean;
}
```

### 10.4 識別子 → DB ID 逆引き

```typescript
// 識別子形式: "scene-{sceneId}-bgm" or "scene-{sceneId}-sfx-{n}"

function resolveIdentifierToDbId(
  identifier: string,
  assignments: SceneAudioAssignment[]
): number | null {
  const bgmMatch = identifier.match(/^scene-(\d+)-bgm$/);
  if (bgmMatch) {
    const sceneId = parseInt(bgmMatch[1], 10);
    const bgm = assignments.find(
      a => a.scene_id === sceneId && a.audio_type === 'bgm' && a.is_active
    );
    return bgm?.id ?? null;
  }

  const sfxMatch = identifier.match(/^scene-(\d+)-sfx-(\d+)$/);
  if (sfxMatch) {
    const sceneId = parseInt(sfxMatch[1], 10);
    const sfxNo = parseInt(sfxMatch[2], 10);
    // start_ms 昇順でソートして n 番目を取得
    const sfxList = assignments
      .filter(a => a.scene_id === sceneId && a.audio_type === 'sfx' && a.is_active)
      .sort((a, b) => a.start_ms - b.start_ms);
    return sfxList[sfxNo - 1]?.id ?? null;
  }

  return null;
}
```

### 10.5 ライブラリ参照の解決

```typescript
// Intent の library_type/library_id から API body を構築
function buildApiBodyFromIntent(
  action: AudioAction
): CreateAssignmentBody {
  const { library_type, library_id, ...params } = action.params;

  const body: CreateAssignmentBody = {
    audio_library_type: library_type,
    audio_type: action.action.startsWith('scene_bgm') ? 'bgm' : 'sfx',
  };

  // ライブラリ参照
  if (library_type === 'system') {
    body.system_audio_id = library_id;
  } else if (library_type === 'user') {
    body.user_audio_id = library_id;
  } else if (library_type === 'direct') {
    body.direct_r2_url = params.direct_r2_url;
    body.direct_name = params.direct_name;
    body.direct_duration_ms = params.direct_duration_ms;
  }

  // タイミング
  if (params.start_ms !== undefined) body.start_ms = params.start_ms;
  if (params.end_ms !== undefined) body.end_ms = params.end_ms;

  // オーバーライド
  if (params.volume !== undefined) body.volume_override = params.volume;
  if (params.loop !== undefined) body.loop_override = params.loop;
  if (params.fade_in_ms !== undefined) body.fade_in_ms_override = params.fade_in_ms;
  if (params.fade_out_ms !== undefined) body.fade_out_ms_override = params.fade_out_ms;

  return body;
}
```

### 10.6 BGM 1件制約の処理

```typescript
// BGM追加時は既存のactive BGMを無効化
// APIサーバー側で自動処理されるが、Intent側でも認識

async function executeSceneBgmAssign(
  sceneId: number,
  body: CreateAssignmentBody
): Promise<AssignmentResult> {
  // API内部で以下が実行される:
  // 1. UPDATE scene_audio_assignments 
  //    SET is_active = 0 
  //    WHERE scene_id = ? AND audio_type = 'bgm' AND is_active = 1
  // 2. INSERT INTO scene_audio_assignments (...) VALUES (...)

  const response = await fetch(
    `/api/scenes/${sceneId}/audio-assignments`,
    { method: 'POST', body: JSON.stringify(body) }
  );
  return response.json();
}
```

### 10.7 Remotion 連携（buildProjectJson）

```typescript
// Video Build 時の scene_audio_assignments → Remotion ProjectScene 変換

interface RemotionSceneBgm {
  url: string;
  name?: string;
  volume: number;
  loop: boolean;
  start_ms: number;
  end_ms: number | null;
  fade_in_ms: number;
  fade_out_ms: number;
}

interface RemotionSceneSfx {
  id: string;
  url: string;
  name?: string;
  volume: number;
  start_ms: number;
  end_ms: number | null;
  fade_in_ms: number;
  fade_out_ms: number;
}

function convertAssignmentToRemotionBgm(
  assignment: SceneAudioAssignment,
  libraryInfo: LibraryInfo
): RemotionSceneBgm {
  return {
    url: libraryInfo.r2_url,
    name: libraryInfo.name,
    volume: assignment.volume_override ?? libraryInfo.default_volume ?? 0.25,
    loop: false, // SSOT: loop禁止
    start_ms: assignment.start_ms,
    end_ms: assignment.end_ms,
    fade_in_ms: assignment.fade_in_ms_override ?? libraryInfo.default_fade_in_ms ?? 120,
    fade_out_ms: assignment.fade_out_ms_override ?? libraryInfo.default_fade_out_ms ?? 120,
  };
}
```

---

## 11. 曖昧解消フロー詳細

### 11.1 フローチャート

```
ユーザー入力
    │
    ▼
┌────────────────────────────────────┐
│ 1. キーワード抽出                    │
│   - 対象語: BGM/SFX/効果音/セリフ    │
│   - 操作語: 消して/下げて/上げて     │
│   - 数値: 20%, 3秒, シーン2          │
└────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────┐
│ 2. 対象特定                         │
│   対象語あり?                        │
│   ├─ YES → target_type 確定         │
│   └─ NO  → 質問「どの音ですか？」    │
└────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────┐
│ 3. シーン特定                        │
│   シーン指定あり?                    │
│   ├─ YES → scene_idx 確定            │
│   ├─ playbackContext あり → 補完     │
│   └─ NO → 質問「どのシーン？」       │
└────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────┐
│ 4. 操作特定                         │
│   操作語から action 推定             │
│   ├─ 明確 → action 確定              │
│   └─ 曖昧 → 質問「どう変更？」       │
└────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────┐
│ 5. パラメータ特定                    │
│   数値/相対語から params 推定        │
│   ├─ 明確 → params 確定              │
│   └─ 曖昧 → 提案「-10%でいい？」     │
└────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────┐
│ 6. Mode 判定                        │
│   ├─ 全て明確 → Mode C (Direct)      │
│   ├─ 一部曖昧 → Mode B (Suggestion)  │
│   └─ 操作なし → Mode A (Conversation)│
└────────────────────────────────────┘
```

### 11.2 質問生成ルール

```typescript
interface ClarificationQuestion {
  type: 'target' | 'scene' | 'action' | 'params';
  message: string;
  options: ClarificationOption[];
}

interface ClarificationOption {
  label: string;
  value: any;
  description?: string;
}

function generateClarificationQuestion(
  ambiguousField: string,
  context: IntentContext
): ClarificationQuestion {
  switch (ambiguousField) {
    case 'target_type':
      return {
        type: 'target',
        message: 'どの音を調整しますか？',
        options: [
          { label: 'BGM', value: 'bgm', description: 'バックグラウンドミュージック' },
          { label: '効果音', value: 'sfx', description: 'シーン内の効果音' },
          { label: 'セリフ', value: 'voice', description: 'キャラクターの音声' },
        ],
      };

    case 'scene_idx':
      return {
        type: 'scene',
        message: 'どのシーンを調整しますか？',
        options: [
          { 
            label: `現在のシーン（シーン${context.playbackContext?.scene_idx}）`, 
            value: context.playbackContext?.scene_idx 
          },
          { label: 'プロジェクト全体', value: 'all' },
          { label: '別のシーンを指定', value: 'specify' },
        ],
      };

    case 'volume':
      const current = context.currentVolume ?? 0.5;
      return {
        type: 'params',
        message: `音量をどのくらいにしますか？（現在: ${Math.round(current * 100)}%）`,
        options: [
          { label: '少し下げる', value: Math.max(0, current - 0.1), description: `-10% → ${Math.round((current - 0.1) * 100)}%` },
          { label: '半分', value: current * 0.5, description: `50% → ${Math.round(current * 50)}%` },
          { label: 'かなり下げる', value: Math.max(0, current - 0.3), description: `-30% → ${Math.round((current - 0.3) * 100)}%` },
          { label: 'ミュート', value: 0, description: '0%' },
        ],
      };

    case 'sfx_no':
      const sfxList = context.sceneSfxList ?? [];
      return {
        type: 'target',
        message: 'どの効果音を調整しますか？',
        options: sfxList.map((sfx, i) => ({
          label: `${sfx.name}`,
          value: i + 1,
          description: `${sfx.start_ms / 1000}秒〜`,
        })),
      };

    default:
      return {
        type: 'action',
        message: 'どのような操作を行いますか？',
        options: [
          { label: '音量を変更', value: 'set_volume' },
          { label: 'タイミングを変更', value: 'set_timing' },
          { label: '削除', value: 'remove' },
        ],
      };
  }
}
```

### 11.3 確認メッセージ生成

```typescript
function generateConfirmationMessage(
  intent: AudioIntent,
  resolvedParams: ResolvedParams
): string {
  const action = intent.actions[0];
  const target = resolvedParams.targetName;
  
  switch (action.action) {
    case 'scene_bgm.set_volume':
    case 'bgm.set_volume':
      return `「${target}」の音量を ${Math.round(action.params.volume * 100)}% に変更します。よろしいですか？`;
    
    case 'scene_bgm.remove':
    case 'sfx.remove':
      return `「${target}」を削除します。よろしいですか？`;
    
    case 'sfx.set_timing':
      return `「${target}」のタイミングを ${action.params.start_ms / 1000}秒〜${action.params.end_ms ? action.params.end_ms / 1000 + '秒' : 'シーン終了まで'} に変更します。よろしいですか？`;
    
    case 'scene_bgm.assign':
    case 'sfx.add':
      return `シーン${action.params.scene_idx}に「${resolvedParams.libraryName}」を追加します。よろしいですか？`;
    
    default:
      return `以下の操作を実行します:\n${JSON.stringify(action, null, 2)}\n\nよろしいですか？`;
  }
}
```

---

## 変更履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|----------|
| 2026-01-31 | 1.0 | 初版作成 |
| 2026-01-31 | 1.1 | scene_audio_assignments マッピング表追加、曖昧解消フロー詳細追加 |
