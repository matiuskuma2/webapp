# キャラクター固定化 & スタイル選択 — 詳細設計書 v2.1

> 最終更新: 2026-02-15
> ステータス: 設計確定 / 実装前
> 前版: v2 を全面改訂。追加指示（voice_policy / 台本矯正 / 左ボードUI / Phase Done条件）を統合。
> 確認ポイント3件（参照画像パス・formatting注入箇所・dialogue-parser主キー）をコード調査で確定。

---

## 0. エグゼクティブサマリ

| 指標 | 値 |
|---|---|
| 新規マイグレーション | **0** |
| ALTER TABLE 文 | **0** |
| 新規 API エンドポイント | **0** |
| 変更対象ファイル | **4** (`marunage.ts`, `index.tsx`, `formatting.ts`, `types/marunage.ts`) |
| 変更不要だが恩恵を受けるファイル | **11** |
| 既存プロジェクトへの影響 | **ゼロ**（5層防御で保証） |
| v1 ボイスUI方針 | **全プロバイダー UI 表示、ナレーション選択 + キャラは自動**（A案） |

### v2 → v2.1 差分サマリ

| v2 記載済み | v2.1 で追加・改訂 |
|---|---|
| As-Is / To-Be / Diff マトリクス | 維持（変更なし） |
| ゼロインパクト5層防御 | 維持（変更なし） |
| M-1〜M-8 コード差分 | 維持 + **M-7 参照画像パスの実装方式を確定** |
| ペイロード仕様 | **voice_policy 構造体に改訂** |
| — | **追加: 台本矯正設計（v1 名前一致 / v2 AIタグ付与）** |
| — | **追加: 左ボードUI 4セクション設計** |
| — | **追加: Phase 分割 Done 条件（DB状態 + UI状態）** |
| — | **追加: 確認ポイント3件の調査結果** |
| — | **追加: 既存影響ゼロ実装ルール5条チェックリスト** |

---

## 1. 確認ポイント3件 — コード調査による確定結論

### Q1: marunage.ts の画像生成パスに参照画像を渡せるか？

**結論: YES — 同一ユーティリティで移植可能。依存は `D1Database` + `R2Bucket` のみ。**

| 項目 | Builder (image-generation.ts) | Marunage (marunage.ts) | 差分 |
|---|---|---|---|
| 参照画像取得 | `getSceneReferenceImages(db, r2, sceneId, 5)` (L917) | **未使用** | 1行追加 |
| Gemini API への渡し方 | `inline_data: { data: base64, mime_type }` (L1482-1488) | `contents: [{ parts: [{ text }] }]` (L529) | parts 配列の先頭に追加 |
| プロンプト強化（参照画像付き） | `Using the provided reference images for character consistency (${charNames}), generate: ${prompt}` (L1528) | 日本語指示 + prompt のみ (L510-512) | enhancedPrompt 構築ロジック変更 |
| 関数シグネチャ | `generateImageWithRetry(prompt, apiKey, retries, refImages, options)` | `generateSingleImage(apiKey, prompt, aspectRatio)` | 引数追加 |
| R2 参照 | `c.env.R2` (Hono context) | **`r2` 変数がスコープにない** | `env.R2` を画像生成関数に渡す必要あり |

**移植手順（具体）:**
1. `marunageStartImageGeneration()` の引数に `r2: R2Bucket` を追加（呼び出し元の advance ハンドラから `c.env.R2` を渡す）
2. 画像生成ループ内で `getSceneReferenceImages(db, r2, scene.id, 5)` を呼ぶ
3. `generateSingleImage()` の引数に `referenceImages?: Array<{base64Data, mimeType, characterName}>` を追加
4. Gemini API の `contents[0].parts` 配列の先頭に `inline_data` を追加
5. enhancedPrompt に `Using the provided reference images for character consistency (${charNames})` を追加

**リスク:** 低。Builder で 2025年から本番稼働しているロジックの移植。try-catch で graceful degradation。

### Q2: formatting.ts の "executionContext=marunage" 分岐で、キャラ情報をプロンプトに注入する場所

**結論: 2箇所。AI mode の `generateMiniScenesWithSchemaAI()` (L1625) と RILARC mode の `generateWithSchema()` (L1933)。**

| 箇所 | ファイル:行 | モード | 既存 systemPrompt 末尾 | 注入方法 |
|---|---|---|---|---|
| `generateMiniScenesWithSchemaAI` | `formatting.ts:1625` | AI整理（チャンク単位） | `注意：idx、metadata は不要。シーン配列のみを返してください。` (L1662) | systemPrompt の末尾に `characterPromptSection` を連結 |
| `generateWithSchema` | `formatting.ts:1933` | RILARC（全文一括） | role の使い方リスト末尾 (L1965) | 同上 |

**注入条件（ゼロインパクト）:**
```
IF request.header('X-Execution-Context') === 'marunage'
AND body.character_hints !== undefined
AND body.character_hints.length > 0
THEN systemPrompt += characterPromptSection
ELSE NOP（空文字列追加のみ）
```

**既存 Builder フローへの影響:** ゼロ。Builder は `X-Execution-Context` を送らないか `builder` を送るため、条件が false になる。

**差し込み設計の詳細:**

```
// formatting.ts 内で body を parse する箇所（L325 付近）から character_hints を取得
const characterHints = body.character_hints as Array<{key, name, description}> | undefined

// 各 generate 関数を呼ぶ前にセクション文字列を構築
let characterSection = ''
if (characterHints?.length && preserveExecContext === 'marunage') {
  characterSection = `\n\n【登場キャラクター（固定）】\n...`
}

// generate 関数の systemPrompt に連結
const fullSystemPrompt = systemPrompt + characterSection
```

**フォーマット関数への引数追加は不要。** systemPrompt の組み立てを呼び出し側で行い、生成関数には完成した prompt を渡すだけ。

### Q3: dialogue-parser が参照するキャラ辞書の主キー

**結論: `character_name`（表示名）が主キー。`character_key` は DB 内部用。`aliases` は補助マッチ。**

| マッチング階層 | 対象カラム | 方式 | 優先度 |
|---|---|---|---|
| Pass 1a | `character_name` | 正規化後の完全一致 | 最高 |
| Pass 1b | `aliases` (JSON配列) | 正規化後の完全一致 | 高 |
| Pass 1c | `character_key` | 正規化後の完全一致 | 中 |
| Pass 2 | `character_name`, `aliases` | ひらがな/カタカナ統一 + 敬称除去 + 2文字以上の部分一致 | 低 |

**ソース根拠:** `dialogue-parser.ts:123-175` の `findCharacterKey()` 関数

**台本矯正への影響:**
- AI が生成する dialogue テキスト内のキャラ名は、**`character_name`（表示名）で出力させるべき**
- `character_key`（内部ID的な英数字キー）は AI プロンプトに含めない
- 例: AI プロンプトには「太郎（主人公。黒髪の青年）」と渡し、AI が `太郎：「こんにちは」` と出力すれば、dialogue-parser の Pass 1a で正確にマッチする

**推奨:** M-6 のキャラ注入プロンプトでは `character_name` のみ使用する。

---

## 2. POST /api/marunage/start ペイロード仕様（v2.1 確定版）

### 2-A. voice_policy 構造体

v2 では `narration_voice` + `character_voice_overrides` が分離していたが、v2.1 では `voice_policy` に統合する。

```typescript
// types/marunage.ts — v2.1 拡張

export interface VoiceSpec {
  provider: 'google' | 'elevenlabs' | 'fish'
  voice_id: string
}

export interface VoicePolicy {
  /** ボイス選択モード
   * "narration_only": ナレーション声のみ選択、キャラは user_characters.voice_preset_id を自動使用（v1 推奨）
   * "full_override":  ナレーション + キャラ別ボイスを個別指定（v2）
   */
  mode: 'narration_only' | 'full_override'
  /** ナレーション音声（narration role の scene_utterances に使用） */
  narration: VoiceSpec
  /** キャラ別ボイス上書き（character_key → VoiceSpec）
   * mode=narration_only の場合は無視される
   * mode=full_override の場合、ここに指定がないキャラは user_characters.voice_preset_id を使用
   */
  characters?: Record<string, VoiceSpec>
}

export interface MarunageStartRequest {
  title?: string
  text: string
  output_preset?: string               // 'yt_long' | 'short_vertical'
  target_scene_count?: number           // 3-10, default 5

  // v2.1: voice_policy（旧 narration_voice を統合・後方互換）
  voice_policy?: VoicePolicy
  narration_voice?: VoiceSpec           // 後方互換: voice_policy 未指定時のフォールバック

  // Phase 1: スタイル選択
  style_preset_id?: number

  // Phase 2: キャラ選択
  selected_character_ids?: number[]
}
```

**後方互換ルール:**
```
IF voice_policy exists:
  narration = voice_policy.narration
  character_overrides = voice_policy.characters (if mode='full_override')
ELSE IF narration_voice exists:
  narration = narration_voice  (v1 互換)
  character_overrides = {} (なし)
ELSE:
  narration = { provider: 'google', voice_id: 'ja-JP-Neural2-B' }
  character_overrides = {} (なし)
```

### 2-B. リクエスト例

```json
{
  "text": "動画にしたいテキスト...",
  "title": "丸投げ 2026/2/15",
  "output_preset": "yt_long",
  "target_scene_count": 5,

  "style_preset_id": 3,

  "selected_character_ids": [12, 15],

  "voice_policy": {
    "mode": "narration_only",
    "narration": {
      "provider": "elevenlabs",
      "voice_id": "el-aria"
    }
  }
}
```

**v2 将来版（full_override）の例:**
```json
{
  "voice_policy": {
    "mode": "full_override",
    "narration": {
      "provider": "elevenlabs",
      "voice_id": "el-aria"
    },
    "characters": {
      "taro":   { "provider": "google", "voice_id": "ja-JP-Neural2-D" },
      "hanako": { "provider": "fish", "voice_id": "fish-nanamin" }
    }
  }
}
```

### 2-C. config_json 保存先マッピング

| フィールド | 保存先 | 読み取りタイミング | 読み取り主体 |
|---|---|---|---|
| `voice_policy` | `marunage_runs.config_json` | 監査・デバッグ用 | 管理者 |
| `voice_policy.narration` | `projects.settings_json.default_narration_voice` | 音声生成時 Priority 2 | `resolveVoiceForUtterance()` |
| `voice_policy.characters[key]` | `project_character_models.voice_preset_id` (コピー時に適用) | 音声生成時 Priority 1 | `resolveVoiceForUtterance()` |
| `style_preset_id` | `project_style_settings.default_style_preset_id` | 画像生成時 | `composeStyledPrompt()` |
| `selected_character_ids` | `marunage_runs.config_json` (スナップショット) | 監査用 | 管理者 |
| — | `project_character_models` (実データ) | format 後の自動処理全般 | 各ユーティリティ |

---

## 3. 台本矯正（Script Structuring）設計

### 3-A. v1: 名前一致方式（タグ強制なし）

**ユーザーは自然文を入力するだけ。AI が構造化し、dialogue-parser がキャラ名を自動マッチング。**

```
[ユーザー入力] ← 自然文、タグなし
  "太郎は学校に着いた。「今日は天気がいいな」と太郎が言った。
   花子が振り向いて、「そうね、散歩日和だわ」と答えた。"

    ↓ formatAPI (AI mode: generateMiniScenesWithSchemaAI)
    ↓ M-6: キャラ情報注入プロンプトにより AI が構造化

[AIが生成する dialogue フィールド]
  "太郎：「今日は天気がいいな」
   花子：「そうね、散歩日和だわ」
   ナレーション：太郎は学校に着いた。"

    ↓ Phase X-2: generateUtterancesForProject()
    ↓ dialogue-parser.ts の parseDialogueToUtterances()

[scene_utterances]
  | order | role      | character_key | text                    |
  |-------|-----------|---------------|-------------------------|
  | 1     | narration | null          | 太郎は学校に着いた。     |
  | 2     | dialogue  | taro          | 今日は天気がいいな       |
  | 3     | dialogue  | hanako        | そうね、散歩日和だわ     |

    ↓ bulk-audio.ts: resolveVoiceForUtterance()

[音声生成]
  order 1: narration → Priority 2: settings_json.default_narration_voice → el-aria
  order 2: dialogue + taro → Priority 1: project_character_models.voice_preset_id → ja-JP-Neural2-D
  order 3: dialogue + hanako → Priority 1: project_character_models.voice_preset_id → fish-nanamin
```

**この方式の成立条件:**
1. M-3 で `project_character_models` にキャラデータがコピー済み
2. M-6 で AI プロンプトに `character_name`（表示名）が注入済み
3. AI が `キャラ名：「セリフ」` 形式で dialogue を出力する
4. dialogue-parser の Pass 1a（`character_name` 完全一致）でマッチする

**失敗時のフォールバック:**
- AI がキャラ名を使わなかった場合 → 全行が narration 扱い → ナレーション声で読み上げ（致命的でない）
- AI が未知のキャラ名を使った場合 → dialogue-parser が `character_key: null` で dialogue 扱い → ナレーション声フォールバック

### 3-B. v2（将来）: AI タグ付与方式

ユーザー入力は引き続き自然文。AI が構造化する際に明示タグを使用。

```
[AIが内部的に使うタグ]
  @narration: 太郎は学校に着いた。
  @taro: 今日は天気がいいな
  @hanako: そうね、散歩日和だわ
```

v2 のメリット:
- `キャラ名：「セリフ」` 形式に依存しない（括弧なしでもマッチ）
- dialogue-parser の精度向上（Pass 1c: character_key 完全一致でマッチ）
- 将来的にタグ上書きUI（ユーザーがタグを修正）に対応可能

**v1 では不要。** dialogue-parser の名前一致精度で十分に動作する。

---

## 4. UI 設計: 左ボード4セクション + 右チャット

### 4-A. 左ボード構成（上→下）

```
┌─ 左ボード ──────────────────────┐
│                                  │
│ ┌─ 1. Characters ──────────────┐│
│ │ [👤太郎 ✅] [👤花子 ✅]      ││
│ │ [👤博士    ] [＋登録]          ││
│ │ (GET /api/settings/user/chars) ││
│ │ 未登録時:                      ││
│ │ 「⚙設定でキャラ登録」リンク   ││
│ └───────────────────────────────┘│
│                                  │
│ ┌─ 2. Style ───────────────────┐│
│ │ [🎨Info ✅] [📊Flat] [🌊Water]││
│ │ (GET /api/style-presets)       ││
│ └───────────────────────────────┘│
│                                  │
│ ┌─ 3. Voice ───────────────────┐│
│ │ ナレーション:                  ││
│ │ ┌─────────────────────────┐  ││
│ │ │ ▼ Provider 選択          │  ││
│ │ │ ─ Google TTS ──────────  │  ││
│ │ │   Wavenet-A (女性・自然)  │  ││
│ │ │   Wavenet-C (男性・自然)  │  ││
│ │ │ ─ ElevenLabs ──────────  │  ││
│ │ │   Aria (女性・落ち着き)   │  ││
│ │ │   Adam (男性・深い)       │  ││
│ │ │ ─ Fish Audio ──────────  │  ││
│ │ │   Nanamin (女性・アニメ)  │  ││
│ │ └─────────────────────────┘  ││
│ │ (GET /api/tts/voices)          ││
│ │ ※キャラ別ボイスは自動(v1)     ││
│ └───────────────────────────────┘│
│                                  │
│ ┌─ 4. Assets (生成後) ─────────┐│
│ │ Scene 1: [🖼] [🔊] ✅         ││
│ │ Scene 2: [🖼] [🔊] ⏳         ││
│ │ Scene 3: [🖼] [⏳] ⏳         ││
│ │ (GET /:projectId/status で更新)││
│ └───────────────────────────────┘│
│                                  │
└──────────────────────────────────┘
```

### 4-B. 右チャット（メイン操作エリア）

```
┌─ 右チャット ────────────────────┐
│                                  │
│ ┌────────────────────────────┐  │
│ │ テキスト入力エリア            │  │
│ │ (100〜50,000文字)           │  │
│ │                              │  │
│ │ 台本をここに貼り付けて       │  │
│ │ ください...                  │  │
│ └────────────────────────────┘  │
│                                  │
│ ── 出力プリセット ──             │
│ (●) YouTube ロング (16:9)       │
│ ( ) ショート動画 (9:16)          │
│                                  │
│ ── シーン数 ──                   │
│ [ 5 ▼ ] シーン (3〜10)          │
│                                  │
│ ┌────────────────────────────┐  │
│ │      🚀 動画を作成する        │  │
│ └────────────────────────────┘  │
│                                  │
│ [進行中のチャットメッセージ...]   │
│ 💬 フォーマット中... (3/5 チャンク)│
│ 💬 画像生成中... (2/5 シーン)    │
│ 💬 完了しました！                │
│                                  │
└──────────────────────────────────┘
```

### 4-C. ボイス選択 UI 仕様

**GET /api/tts/voices を唯一のソースとする。** ハードコードなし。

```typescript
// フロントエンド: ボイス一覧取得
const voicesRes = await fetch('/api/tts/voices')
const voices = await voicesRes.json()
// → { google: [...], elevenlabs: [...], fish: [...] }

// <select> の optgroup で provider 別に表示
// 保存形式: voice_id のみ（provider は voice_id のプレフィックスで自動判定）
// 例: "el-aria" → provider='elevenlabs'
// 例: "ja-JP-Wavenet-A" → provider='google'
// 例: "fish-nanamin" → provider='fish'
```

**将来の provider/voice 追加時:** バックエンド API のレスポンスにボイスを追加するだけで UI に自動反映。

---

## 5. 既存影響ゼロ — 実装ルール5条（チェックリスト）

> 実装前・レビュー時に全条件を確認すること。

| # | ルール | 確認方法 | コード根拠 |
|---|---|---|---|
| **R1** | `X-Execution-Context=marunage` のときだけ追加挙動（formatting / parser / assign） | formatting.ts の条件分岐に `preserveExecContext === 'marunage'` | `formatting.ts:1070`, `marunage.ts:221` |
| **R2** | `marunage_mode=true` のときだけ `settings_json` の新キーを読む | `projects.ts:319` のフィルタで Builder 一覧から除外 | `projects.ts:319` |
| **R3** | user_characters は**参照しない**。`project_character_models` にコピーが SSOT | M-3 のコピーロジック、`character-auto-assign.ts:155`, `dialogue-parser.ts:299` | テーブル分離 |
| **R4** | 既存 API のレスポンス形は変えない（新キー追加はOK、既存キー不変） | POST /start のレスポンスに `config` フィールド追加のみ | `marunage.ts:1561-1566` |
| **R5** | Builder 側 UI と丸投げ UI は交差させない（URL もデータ導線も） | `/marunage/*` は独立ルート、`/builder/*` には触れない | ルーティング分離 |

---

## 6. Phase 分割 — Done 条件付き

### Phase 1: スタイル選択 UI + DB 保存

**変更ファイル:** `types/marunage.ts`, `marunage.ts`, `index.tsx`
**変更量:** ~80行

#### 変更内容
- M-1: `MarunageStartRequest` に `style_preset_id?: number` 追加
- M-2: `marunage.ts:1511-1518` のハードコード「インフォグラフィック」→ 動的選択（フォールバックあり）
- M-8a: `index.tsx` にスタイルカード選択 UI（`GET /api/style-presets`）

#### Done 条件

| # | 条件 | 確認方法 |
|---|---|---|
| D1-1 | `style_preset_id` 省略で POST /start → `project_style_settings` に「インフォグラフィック」のIDが入る | `SELECT * FROM project_style_settings WHERE project_id = ?` |
| D1-2 | `style_preset_id: 3` で POST /start → `project_style_settings` に `3` が入る | 同上 |
| D1-3 | 無効な `style_preset_id: 9999` → フォールバックで「インフォグラフィック」 | 同上 |
| D1-4 | UI: `/marunage` 開始画面にスタイルカードが表示される | ブラウザ確認 |
| D1-5 | 既存 Builder プロジェクトに影響なし | `GET /api/projects` のレスポンスが変わらない |
| D1-6 | `composeStyledPrompt()` が選択されたスタイルの prefix/suffix を使用する | 生成された画像の見た目確認 |

#### 依存関係
- なし（独立実装可能）

---

### Phase 2: キャラクター選択 UI + プロジェクトへのコピー

**変更ファイル:** `types/marunage.ts`, `marunage.ts`, `index.tsx`
**変更量:** ~200行

#### 変更内容
- M-1: `MarunageStartRequest` に `selected_character_ids?: number[]`, `voice_policy?: VoicePolicy` 追加
- M-3: `marunage.ts:1509+` に user_characters → project_character_models コピーロジック
- M-4: `projects.settings_json` に `character_voices` マップ追加
- M-8b: `index.tsx` にキャラカード選択 UI + ナレーション音声プルダウン

#### Done 条件

| # | 条件 | 確認方法 |
|---|---|---|
| D2-1 | `selected_character_ids` 省略で POST /start → `project_character_models` が空 | `SELECT * FROM project_character_models WHERE project_id = ?` |
| D2-2 | `selected_character_ids: [12, 15]` で POST /start → 2行が `project_character_models` にコピーされる | 同上 + `character_key`, `character_name`, `reference_image_r2_url`, `voice_preset_id` が正しいか確認 |
| D2-3 | `project_character_instances` にリンクレコードが作成される | `SELECT * FROM project_character_instances WHERE project_id = ?` |
| D2-4 | 他ユーザーの character_id 指定 → スキップされる（ownership check） | ログ確認 |
| D2-5 | `voice_policy.mode='narration_only'` → キャラの `voice_preset_id` は `user_characters` からそのままコピー | `project_character_models.voice_preset_id` 確認 |
| D2-6 | `settings_json` に `default_narration_voice` が voice_policy.narration の値で保存される | `SELECT settings_json FROM projects WHERE id = ?` |
| D2-7 | UI: キャラカードが表示され、チェックボックスで選択できる | ブラウザ確認 |
| D2-8 | UI: ボイス選択プルダウンが provider 別 optgroup で表示される | ブラウザ確認 |
| D2-9 | 既存 Builder プロジェクトに影響なし | R5 チェック |

#### 依存関係
- Phase 1 と独立して実装可能（並行可）

---

### Phase 3: フォーマット AI へのキャラ情報注入 + 台本矯正

**変更ファイル:** `marunage.ts`, `formatting.ts`
**変更量:** ~70行

#### 変更内容
- M-5: `marunageFormatStartup()` の format API 呼び出し body に `character_hints[]` 追加
- M-6: `formatting.ts` の AI プロンプト（2箇所）にキャラ情報セクション注入

#### Done 条件

| # | 条件 | 確認方法 |
|---|---|---|
| D3-1 | キャラ2名選択 + AI mode → format API body に `character_hints: [{key, name, description}, ...]` が含まれる | ログ出力確認 |
| D3-2 | GPT systemPrompt にキャラ名と説明が注入される | ログ or デバッグ出力 |
| D3-3 | AI が dialogue フィールドに `キャラ名：「セリフ」` 形式で出力する | `scenes.dialogue` の内容確認 |
| D3-4 | `autoAssignCharactersToScenes()` が正常動作し `scene_character_map` にレコードが入る | `SELECT * FROM scene_character_map WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)` |
| D3-5 | `generateUtterancesForProject()` が dialogue 行に正しい `character_key` をセットする | `SELECT * FROM scene_utterances WHERE scene_id IN (...) AND role = 'dialogue'` |
| D3-6 | Builder からの format 呼び出しにキャラプロンプトが注入されない | R1 チェック |
| D3-7 | キャラ未選択の丸投げ → 従来通り（character_hints なし） | 同上 |

#### 依存関係
- **Phase 2 必須**（`project_character_models` にデータがないと `autoAssignCharactersToScenes()` が空振り）

---

### Phase 4: 画像生成に参照画像追加（キャラ固定の核心）

**変更ファイル:** `marunage.ts`
**変更量:** ~60行

#### 変更内容
- M-7: `marunageStartImageGeneration()` に `r2: R2Bucket` 引数追加
- M-7: 画像ループ内で `getSceneReferenceImages(db, r2, sceneId, 5)` 呼び出し
- M-7b: `generateSingleImage()` に `referenceImages` 引数追加 + Gemini API の `contents[0].parts` に `inline_data` 追加
- enhancedPrompt に `Using the provided reference images for character consistency (${charNames})` 追加

#### Done 条件

| # | 条件 | 確認方法 |
|---|---|---|
| D4-1 | キャラ選択 + 参照画像あり → Gemini API に `inline_data` として画像が渡される | ログ: `[Marunage:Image] Loaded N reference images for scene X` |
| D4-2 | 生成された画像にキャラの見た目の一貫性がある | 目視確認（複数シーンで同じキャラが同じ見た目） |
| D4-3 | キャラ選択あり + 参照画像なし → テキスト強化のみで生成（graceful degradation） | ログ確認 + 画像生成が失敗しないこと |
| D4-4 | キャラ未選択 → 現行動作（参照画像なし） | 既存テストが通ること |
| D4-5 | R2 参照画像取得エラー → try-catch で続行（画像は参照なしで生成） | エラーログ確認 + 画像生成成功 |

#### 依存関係
- **Phase 3 必須**（`scene_character_map` にデータがないと `getSceneReferenceImages()` が空リストを返す）

---

### Phase 5: キャラ別ボイス（変更不要の確認）

**変更ファイル:** なし（0行）
**変更量:** 0行

#### Done 条件

| # | 条件 | 確認方法 |
|---|---|---|
| D5-1 | キャラ選択 + voice_preset_id あり → dialogue 行がキャラ固有のボイスで生成される | `SELECT ag.provider, ag.voice_id, su.character_key FROM audio_generations ag JOIN scene_utterances su ON su.audio_generation_id = ag.id WHERE su.scene_id IN (...)` |
| D5-2 | キャラ選択 + voice_preset_id なし → narration 声にフォールバック | 同上（provider/voice_id がナレーション設定と一致） |
| D5-3 | `resolveVoiceForUtterance()` のログに `source: 'character'` が表示される | ログ確認 |

#### 依存関係
- **Phase 2 完了で自動動作**（`project_character_models.voice_preset_id` がセットされていれば、`resolveVoiceForUtterance()` の Priority 1 が発火する）

---

## 7. 全体依存関係グラフ

```
Phase 1 (スタイル) ─────────────── 独立
                                     │
Phase 2 (キャラ選択+コピー) ──── 独立 │
    │                                │
    ├──→ Phase 5 (ボイス) ← 自動動作 │
    │                                │
    ▼                                │
Phase 3 (AI注入+台本矯正) ←─── Phase 2 必須
    │
    ▼
Phase 4 (参照画像) ←────────── Phase 3 必須
```

**推奨実装順序:**
1. Phase 1 + Phase 2（並行可、合計 ~280行）
2. Phase 3（~70行）
3. Phase 4（~60行）
4. Phase 5（0行、確認のみ）

**最小 MVP:** Phase 1 のみ（~80行）→ スタイル変更が即効
**推奨 MVP:** Phase 1 + 2（~280行）→ スタイル + キャラボイス自動動作
**フル実装:** Phase 1-4（~410行）→ キャラ固定化完全実現

---

## 8. Diff マトリクス（v2.1 確定版）

### 変更が必要な箇所

| # | ファイル:行付近 | As-Is | To-Be | 変更量 | Phase |
|---|---|---|---|---|---|
| **M-1** | `types/marunage.ts:111-120` | MarunageStartRequest に 5 フィールド | + `style_preset_id`, `selected_character_ids`, `voice_policy` | ~20行 | P1-2 |
| **M-2** | `marunage.ts:1511-1518` | `WHERE name = 'インフォグラフィック'` ハードコード | `body.style_preset_id` 優先 + フォールバック | ~15行 | P1 |
| **M-3** | `marunage.ts:1509+` (新規) | なし | user_characters → project_character_models コピー + instances リンク + voice_override 適用 | ~60行 | P2 |
| **M-4** | `marunage.ts:1502-1505` | `settings_json = {narration, preset, mode}` | + `character_voices` マップ構築 + voice_policy 対応 | ~25行 | P2 |
| **M-5** | `marunage.ts:223-226` | `body: { split_mode, target_scene_count }` | + `character_hints[]` | ~20行 | P3 |
| **M-6** | `formatting.ts:1625, 1933` | systemPrompt にキャラ情報なし | marunage 時のみキャラセクション追加 | ~30行 | P3 |
| **M-7** | `marunage.ts:500-580, 726-760` | `generateSingleImage(key, prompt, ratio)` / 参照画像なし | + `r2` 引数追加、`getSceneReferenceImages()` 呼び出し、`inline_data` 追加 | ~60行 | P4 |
| **M-8** | `index.tsx` (丸投げ開始画面) | テキスト + プリセット + ナレーション声 | + 左ボード4セクション（Characters, Style, Voice, Assets） | ~300行 | P1-2 |

### 変更不要な箇所

| ファイル | 行数 | 理由 |
|---|---|---|
| `bulk-audio.ts` | 880 | `resolveVoiceForUtterance()` が自動でキャラ voice_preset_id を使用 |
| `audio-generation.ts` | 1243 | TTS 生成ロジック不変 |
| `character-models.ts` | 1379 | CRUD / import ロジック不変 |
| `scene-characters.ts` | 679 | 最大3制約チェック不変 |
| `settings.ts` | 836 | ユーザーキャラ CRUD 不変 |
| `styles.ts` | 298 | スタイル一覧 API 不変 |
| `character-reference-helper.ts` | 232 | `getSceneReferenceImages()` 不変 |
| `character-auto-assign.ts` | 407 | テキストマッチングロジック不変 |
| `dialogue-parser.ts` | 500 | パース + キャラマッチングロジック不変 |
| `world-character-helper.ts` | 206 | テキスト強化ロジック不変 |
| `image-prompt-builder.ts` | 115 | `composeStyledPrompt()` 不変 |
| `elevenlabs.ts` | 274 | ボイス定義 + TTS 呼び出し不変 |
| `migrations/*` | 57ファイル | 一切変更なし |

---

## 9. ゼロインパクト保証（v2 から継承、5層防御）

| 層 | メカニズム | コード根拠 |
|---|---|---|
| 1. ペイロード後方互換 | 新規フィールドは全て `optional` (`?`)。未指定時は既存デフォルト。 | `types/marunage.ts` |
| 2. marunage_mode ガード | `settings_json.marunage_mode === true` のときだけ新設定を読む | `marunage.ts:1505` |
| 3. X-Execution-Context 分離 | `'marunage'` ヘッダーのときだけ formatting にキャラ注入 | `marunage.ts:221`, `formatting.ts:1070` |
| 4. プロジェクト隔離 | 毎回新規 project 作成。user_characters はコピー（参照でない） | `marunage.ts:1487` |
| 5. 一覧フィルタ | `json_extract(settings_json,'$.marunage_mode') IS NOT 1` で Builder 一覧から除外 | `projects.ts:319` |

---

## 10. 確定仕様一覧

| 項目 | 決定 |
|---|---|
| DB マイグレーション | **なし** |
| 既存 API 破壊的変更 | **なし** |
| シーン内キャラ上限 | **最大3名/シーン** |
| ナレーション行数 | **無制限** |
| dialogue speaker 数 | **無制限**（ただし scene_character_map は最大3） |
| 台本タグ（v1） | **不要**（AI が構造化、dialogue-parser が名前一致） |
| キャラ選択タイミング | **丸投げ開始前に固定** |
| スタイル選択タイミング | **丸投げ開始前に固定** |
| ボイス UI | **全プロバイダー表示**（GET /api/tts/voices が唯一のソース） |
| v1 ボイスモード | **A案: narration_only**（キャラは user_characters.voice_preset_id 自動） |
| voice_policy 構造体 | **mode: narration_only / full_override** |
| キャラデータの持ち方 | **コピー方式**（user_characters → project_character_models） |
| 参照画像の graceful degradation | **取得失敗時はテキストのみで続行** |
| 左ボード | **4セクション**（Characters, Style, Voice, Assets） |

---

## 11. 将来拡張（v2以降）

| 項目 | 優先度 | 前提 |
|---|---|---|
| `voice_policy.mode='full_override'` UI | 中 | バックエンドは Phase 2 で対応済み |
| AI タグ付与方式（`@taro:` 形式） | 低 | dialogue-parser の拡張 |
| キャラ登録画像アップロード UI 改善 | 中 | R2 アップロード API 既存 |
| scene_character_traits (C層: 例外状態) | 低 | テーブル・ユーティリティ既存 |
| シーン単位キャラ入れ替え UI | 低 | scene_character_map CRUD 既存 |
| ボイスプレビュー（試聴） | 中 | TTS API 経由で短文生成 |
| フォルダ整理 (`/marunage/folders`) | 低 | 別チケット |

---

## 12. 実装チェックリスト

```
Phase 1 (スタイル選択) — ~80行:
  [ ] M-1: types/marunage.ts — style_preset_id 追加
  [ ] M-2: marunage.ts:1511 — ハードコード→動的選択+フォールバック
  [ ] M-8a: index.tsx — スタイルカード UI
  [ ] Done: D1-1〜D1-6 全て PASS

Phase 2 (キャラ選択) — ~200行:
  [ ] M-1: types/marunage.ts — selected_character_ids, voice_policy 追加
  [ ] M-3: marunage.ts:1509+ — コピーロジック + instances リンク
  [ ] M-4: marunage.ts:1502 — settings_json 拡張 + voice_policy 対応
  [ ] M-8b: index.tsx — キャラカード UI + ボイスプルダウン
  [ ] Done: D2-1〜D2-9 全て PASS

Phase 3 (AI キャラ注入) — ~70行:
  [ ] M-5: marunage.ts:223 — character_hints 追加
  [ ] M-6: formatting.ts:1625,1933 — GPT プロンプト注入
  [ ] Done: D3-1〜D3-7 全て PASS

Phase 4 (参照画像) — ~60行:
  [ ] M-7: marunage.ts — r2 引数追加 + getSceneReferenceImages 呼び出し
  [ ] M-7b: marunage.ts — generateSingleImage 拡張 + inline_data
  [ ] Done: D4-1〜D4-5 全て PASS

Phase 5 (ボイス確認) — 0行:
  [ ] Done: D5-1〜D5-3 全て PASS

横断チェック:
  [ ] R1〜R5 全て PASS（既存影響ゼロ）
  [ ] 既存 Builder UI でプロジェクト作成→画像生成→音声生成が正常動作
  [ ] 既存丸投げ（キャラ・スタイル未指定）が正常動作
```
