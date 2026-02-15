# キャラクター固定化 & スタイル選択 — 詳細設計書 v2

> 最終更新: 2026-02-15
> ステータス: 設計完了 / 実装前
> 前提: v1 を全面改訂。コードベース精査を完了し、行番号レベルで根拠を記載。

---

## 0. エグゼクティブサマリ

**結論: DBマイグレーション不要。既存テーブル・API・ユーティリティの再利用のみで実現可能。**

| 指標 | 値 |
|---|---|
| 新規マイグレーションファイル | **0** |
| ALTER TABLE 文 | **0** |
| 新規 API エンドポイント | **0** |
| 変更対象ファイル | **3** (`marunage.ts`, `index.tsx`, `formatting.ts`) |
| 変更不要だが恩恵を受けるファイル | **11** |
| 既存プロジェクトへの影響 | **ゼロ**（後方互換） |
| v1 方針決定点 | **A案: ナレーション音声のみ＋キャラ音声は自動**（v1 推奨） |

---

## 1. As-Is: 現状のコードベース完全棚卸し

### 1-A. DB テーブル（全て migration 済み・本番稼働中）

#### 丸投げ（marunage）が現在使用しているテーブル

| テーブル | カラム（抜粋） | marunage での使い方 | ソースコード根拠 |
|---|---|---|---|
| `projects` | `id`, `title`, `status`, `settings_json`, `output_preset`, `user_id`, `source_type`, `source_text` | run 開始時に新規作成。`settings_json` に `{default_narration_voice, marunage_mode:true}` を保存 | `marunage.ts:1487-1509` |
| `marunage_runs` | `id`, `project_id`, `phase`, `config_json`, `started_by_user_id`, `audio_job_id`, `video_build_id`, ... | run の SSOT。`config_json` に全設定スナップショット保存 | `marunage.ts:1527-1530`, `types/marunage.ts:63-79` |
| `text_chunks` | `project_id`, `status` | format API がチャンク分割に使用 | `marunage.ts:1606-1613` (status polling) |
| `scenes` | `project_id`, `idx`, `dialogue`, `image_prompt`, `speech_type`, `is_hidden` | フォーマット結果のシーン。画像生成ループで参照 | `marunage.ts:677-682` |
| `image_generations` | `scene_id`, `status`, `r2_key`, `prompt`, `provider`, `model` | 画像生成結果の記録 | `marunage.ts:708-753` |
| `audio_generations` | `scene_id`, `provider`, `voice_id`, `text`, `status` | 音声生成結果。bulk-audio 経由 | `bulk-audio.ts:141-153` |
| `scene_utterances` | `scene_id`, `order_no`, `role`, `character_key`, `text`, `audio_generation_id` | シーン内発話。dialogue-parser が自動生成 | `dialogue-parser.ts:336-391` |
| `style_presets` | `id`, `name`, `prompt_prefix`, `prompt_suffix`, `negative_prompt` | 「インフォグラフィック」をハードコードで選択 | `marunage.ts:1512-1518` |
| `project_style_settings` | `project_id`, `default_style_preset_id` | 選択されたスタイルを保存 | `marunage.ts:1516-1518` |

#### 丸投げが**まだ使っていない**テーブル（スキーマは完備）

| テーブル | カラム（抜粋） | Builder での使用状況 | 丸投げ拡張での用途 |
|---|---|---|---|
| `user_characters` | `id`, `user_id`, `character_key`, `character_name`, `appearance_description`, `reference_image_r2_key`, `reference_image_r2_url`, `voice_preset_id`, `aliases_json` | CRUD 完備 (`settings.ts:534-800`) | ユーザーのキャラライブラリ → 選択元 |
| `project_character_models` | `project_id`, `character_key`, `character_name`, `appearance_description`, `reference_image_r2_key`, `reference_image_r2_url`, `voice_preset_id`, `aliases_json`, `story_traits` | CRUD + import 完備 (`character-models.ts:292-369`) | run 開始時にユーザーキャラをコピー |
| `project_character_instances` | `project_id`, `user_character_id`, `character_key`, `is_customized`, `custom_appearance`, `custom_voice_preset_id` | 紐付け管理 | キャラコピー時のリンク記録 |
| `scene_character_map` | `scene_id`, `character_key`, `is_primary`, `role` | **最大3制約チェック済み** (`scene-characters.ts:68`) | フォーマット後のシーン→キャラ割り当て |
| `scene_character_traits` | `scene_id`, `character_key`, `trait_description` | シーン固有の外観オーバーライド | v2 以降（例: 妖精→人間） |
| `world_settings` | `project_id`, `art_style`, `setting_description`, `prompt_prefix` | 世界観テキスト強化 (`world-character-helper.ts:36`) | 将来対応 |

### 1-B. 既存 API エンドポイント（全てルーティング済み）

#### キャラクター関連 API

| メソッド | パス | ファイル:行 | 機能 | 丸投げ拡張での使い方 |
|---|---|---|---|---|
| GET | `/api/settings/user/characters` | `settings.ts:534` | ユーザーキャラ一覧 | 開始画面でキャラ一覧表示 |
| POST | `/api/settings/user/characters` | `settings.ts:549` | 新規キャラ作成 | 設定画面でキャラ登録 |
| PUT | `/api/settings/user/characters/:key` | `settings.ts:710` | キャラ更新 | 設定画面で編集 |
| DELETE | `/api/settings/user/characters/:key` | `settings.ts:773` | キャラ削除 | 設定画面で削除 |
| POST | `/api/settings/user/characters/from-project` | `settings.ts:640` | プロジェクト→ライブラリ | 完了後のキャラ保存 |
| GET | `/api/projects/:id/characters` | `character-models.ts:62` | プロジェクト内キャラ一覧 | ステータス確認 |
| POST | `/api/projects/:id/characters/import` | `character-models.ts:292` | ライブラリ→プロジェクトコピー | **コピーロジック参照元** |
| GET | `/api/projects/:id/characters/library-available` | `character-models.ts:19` | 未インポートキャラ一覧 | UI フィルタリング |

#### スタイル・音声関連 API

| メソッド | パス | ファイル:行 | 機能 | 丸投げ拡張での使い方 |
|---|---|---|---|---|
| GET | `/api/style-presets` | `styles.ts:8` | アクティブなスタイル一覧 | 開始画面でスタイルカード表示 |
| GET | `/api/tts/voices` | `audio-generation.ts:942` | 全プロバイダーのボイス一覧 | 開始画面でボイス選択UI |

#### シーン・キャラ割り当て API

| メソッド | パス | ファイル:行 | 機能 | 制約 |
|---|---|---|---|---|
| GET | `/api/scenes/:id/characters` | `scene-characters.ts:17` | シーン内キャラ一覧 | — |
| POST | `/api/scenes/:id/characters` | `scene-characters.ts:50` | シーンにキャラ追加 | **最大3名制約チェック済み** |
| DELETE | `/api/scenes/:id/characters/:characterKey` | `scene-characters.ts:100+` | シーンからキャラ削除 | — |

### 1-C. ユーティリティ関数

| 関数 | ファイル:行 | 入出力 | 丸投げでの使用状況 | 拡張での変更 |
|---|---|---|---|---|
| `composeStyledPrompt(db, projectId, sceneId, basePrompt)` | `image-prompt-builder.ts:41` | DB からスタイル取得 → prefix + 強化prompt + suffix | ✅ 使用中 (`marunage.ts:727`) | **変更不要** |
| `enhancePromptWithWorldAndCharacters(prompt, world, characters)` | `world-character-helper.ts:130` | A層(外観) + B層(story_traits) + C層(scene_traits) で強化 | ✅ composeStyledPrompt 内部で呼ばれる | **変更不要** |
| `fetchWorldSettings(db, projectId)` | `world-character-helper.ts:36` | `world_settings` テーブルから取得 | ✅ 内部使用 | **変更不要** |
| `fetchSceneCharacters(db, sceneId)` | `world-character-helper.ts:60` | `scene_character_map` + `project_character_models` JOIN | ✅ 内部使用 | **変更不要** |
| `getSceneReferenceImages(db, r2, sceneId, maxImages)` | `character-reference-helper.ts:79` | R2 から参照画像を base64 で取得（最大5枚） | ❌ **未使用** | **呼び出しを追加** |
| `resolveVoiceForUtterance(db, utterance, settings)` | `bulk-audio.ts:78-123` | Priority 1: キャラ voice_preset_id → 2: default_narration → 3: fallback | ✅ 使用中 | **変更不要** |
| `autoAssignCharactersToScenes(db, projectId)` | `character-auto-assign.ts:366` | `project_character_models` のキャラ名でシーンテキストマッチング → `scene_character_map` INSERT (最大3名) | ✅ format 完了後に自動実行 | **変更不要** |
| `generateUtterancesForProject(db, projectId)` | `dialogue-parser.ts:393` | シーン dialogue を解析 → `scene_utterances` に role + character_key 付きで INSERT | ✅ format 完了後に自動実行 | **変更不要** |
| `extractAndUpdateCharacterTraits(db, projectId)` | `character-trait-extractor.ts` | シーン台詞からキャラの特徴を抽出 → `scene_character_traits` に保存 | ✅ format 完了後に自動実行 | **変更不要** |

### 1-D. ボイスカタログ（全17ボイス実装済み）

#### Google TTS（8ボイス）

| voice_id | 名前 | 性別 | 品質 |
|---|---|---|---|
| `ja-JP-Standard-A` | Standard A | female | 標準 |
| `ja-JP-Standard-B` | Standard B | female | 標準 |
| `ja-JP-Standard-C` | Standard C | male | 標準 |
| `ja-JP-Standard-D` | Standard D | male | 標準 |
| `ja-JP-Wavenet-A` | Wavenet A | female | 高品質 |
| `ja-JP-Wavenet-B` | Wavenet B | female | 高品質 |
| `ja-JP-Wavenet-C` | Wavenet C | male | 高品質 |
| `ja-JP-Wavenet-D` | Wavenet D | male | 高品質 |

#### ElevenLabs（8ボイス）

| voice_id | 名前 | 性別 | 特徴 |
|---|---|---|---|
| `el-aria` | Aria | female | 落ち着き・ナレーション向き |
| `el-sarah` | Sarah | female | 優しい・穏やか |
| `el-charlotte` | Charlotte | female | 明るい・エネルギッシュ |
| `el-lily` | Lily | female | 若い・キャラクター向き |
| `el-adam` | Adam | male | 深い・ナレーション向き |
| `el-bill` | Bill | male | 自然・聞きやすい |
| `el-brian` | Brian | male | プロフェッショナル |
| `el-george` | George | male | 落ち着き・中年男性 |

#### Fish Audio（1ボイス）

| voice_id | 名前 | 性別 | 備考 |
|---|---|---|---|
| `fish-nanamin` | Nanamin | female | API TOKEN 設定時のみ |

**voice_id プロバイダー自動判定ルール** (`bulk-audio.ts:91-98`):
```
el-xxx  or  elevenlabs:xxx  → provider='elevenlabs'
fish-xxx  or  fish:xxx      → provider='fish'
その他                       → provider='google'
```

### 1-E. 現在の marunage パイプラインフロー（コード根拠付き）

```
[ユーザー] POST /api/marunage/start (text, narration_voice, output_preset, target_scene_count)
    │
    ├─ [marunage.ts:1487] projects INSERT (status='created', source_type='text')
    ├─ [marunage.ts:1494] source_text SET, status='uploaded'
    ├─ [marunage.ts:1502] settings_json = {default_narration_voice, output_preset, marunage_mode:true}
    ├─ [marunage.ts:1512] style_presets SELECT WHERE name='インフォグラフィック' ★ハードコード
    ├─ [marunage.ts:1516] project_style_settings INSERT
    ├─ [marunage.ts:1527] marunage_runs INSERT (phase='init', config_json)
    ├─ [marunage.ts:1535] transitionPhase('init' → 'formatting')
    └─ [marunage.ts:1540] waitUntil(marunageFormatStartup)
         │
         ├─ [marunage.ts:183] POST /api/projects/:id/parse (HTTP消費)
         ├─ [marunage.ts:216] POST /api/projects/:id/format (HTTP消費, X-Execution-Context: marunage)
         │    │
         │    └─ [formatting.ts:1070] context='marunage' として処理
         │         ├─ AI mode: generateMiniScenesWithSchemaAI() でシーン生成
         │         ├─ Preserve mode: 段落→シーン直接マッピング
         │         └─ [formatting.ts:1186-1211 / 1456-1486] Phase X-2:
         │              ├─ autoAssignCharactersToScenes() ★project_character_modelsが空のため効果なし
         │              ├─ extractAndUpdateCharacterTraits()
         │              └─ generateUtterancesForProject() → scene_utterances 生成
         │
         ├─ [marunage.ts] transitionPhase('formatting' → 'awaiting_ready')
         │
    [advance: awaiting_ready → generating_images]
         │
         ├─ [marunage.ts:677-682] visible scenes 取得
         ├─ [marunage.ts:726-728] composeStyledPrompt(db, projectId, sceneId, prompt) ★テキスト強化のみ
         ├─ [marunage.ts:758] generateSingleImage(apiKey, prompt, aspectRatio) ★参照画像なし
         └─ [marunage.ts:778] R2 にアップロード → image_generations 更新
         │
    [advance: generating_images → generating_audio]
         │
         ├─ [marunage.ts:1158-1162] project.settings_json から narration_voice 読み取り
         ├─ [marunage.ts:1186] POST /api/projects/:id/audio/bulk-generate (HTTP消費)
         │    │
         │    └─ [bulk-audio.ts:78-123] resolveVoiceForUtterance:
         │         ├─ Priority 1: project_character_models.voice_preset_id ★空のため未使用
         │         ├─ Priority 2: settings_json.default_narration_voice
         │         └─ Priority 3: fallback → google/ja-JP-Neural2-B
         │
    [advance: generating_audio → ready]
```

**重大なギャップ（★マーク）:**
1. スタイルが「インフォグラフィック」にハードコードされている
2. `project_character_models` が空のためキャラ自動割り当てが空振りする
3. 画像生成に参照画像（`getSceneReferenceImages()`）が渡されていない
4. 音声生成でキャラ別ボイス解決が空振り（`voice_preset_id` 未セット）

---

## 2. To-Be: 拡張後の目標状態

### 2-A. 拡張後のパイプラインフロー

```
[ユーザー] POST /api/marunage/start
    (text, narration_voice, output_preset, target_scene_count,
     ★selected_character_ids[], ★style_preset_id, ★character_voice_overrides{})
    │
    ├─ [M-1] config_json にキャラ・スタイル情報を含めて保存
    ├─ [M-2] style_preset_id 指定あり → そのスタイルを使用（なし → フォールバック「インフォグラフィック」）
    ├─ [M-3] selected_character_ids[] → user_characters からコピー → project_character_models に INSERT
    ├─ [M-3] project_character_instances にリンクレコード INSERT
    ├─ [M-4] settings_json.character_voices に voice_override マップ保存
    │        ※ override なし → user_characters.voice_preset_id をそのまま使用
    └─ waitUntil(marunageFormatStartup)
         │
         ├─ [M-5] format API body に character_hints[] を追加
         │    │
         │    └─ [formatting.ts]
         │         ├─ AI mode: GPTプロンプトにキャラ情報を注入
         │         ├─ Phase X-2: autoAssignCharactersToScenes()
         │         │   ★project_character_modelsにデータがあるため正常動作
         │         └─ generateUtterancesForProject()
         │             ★character_key がセットされた scene_utterances が生成される
         │
    [advance: awaiting_ready → generating_images]
         │
         ├─ [既存] composeStyledPrompt() ★project_style_settings に正しいスタイルがあるため動作
         ├─ [M-7] getSceneReferenceImages(db, r2, sceneId, 5)
         │   ★scene_character_map → project_character_models → R2 参照画像を取得
         └─ [M-7] generateSingleImage(apiKey, prompt, aspectRatio, ★referenceImages)
              ★Gemini API に参照画像を inlineData として送信 → キャラ固定
         │
    [advance: generating_images → generating_audio]
         │
         └─ [既存] resolveVoiceForUtterance:
              ├─ Priority 1: project_character_models.voice_preset_id ★データあり → キャラ別ボイス自動適用
              ├─ Priority 2: settings_json.default_narration_voice
              └─ Priority 3: fallback → google/ja-JP-Neural2-B
```

### 2-B. 拡張後のデータフロー図

```
user_characters (ユーザーライブラリ)
    │
    │ POST /start: selected_character_ids[]
    ▼
project_character_models (プロジェクト固有コピー)
    │
    ├─── autoAssignCharactersToScenes() ──→ scene_character_map (最大3名/シーン)
    │                                           │
    │                                           ├─── getSceneReferenceImages() ──→ Gemini API (画像生成)
    │                                           │
    │                                           └─── composeStyledPrompt() ──→ テキスト強化
    │
    ├─── generateUtterancesForProject() ──→ scene_utterances.character_key
    │                                           │
    │                                           └─── resolveVoiceForUtterance() ──→ TTS API (音声生成)
    │
    └─── voice_preset_id ──────────────────→ bulk-audio.ts (キャラ別ボイス解決)

style_presets ──→ project_style_settings ──→ composeStyledPrompt() ──→ 画像プロンプト強化
```

---

## 3. Diff マトリクス（変更対象の完全一覧）

### 3-A. 変更が必要な箇所 (合計 ~450 行追加)

| # | ファイル:行付近 | 現状 (As-Is) | 変更後 (To-Be) | 変更量 | リスク | 依存Phase |
|---|---|---|---|---|---|---|
| **M-1** | `types/marunage.ts:111-120` | `MarunageStartRequest` に text, narration_voice, output_preset, target_scene_count のみ | `+ selected_character_ids?: number[]`, `+ style_preset_id?: number`, `+ character_voice_overrides?: Record<string, {provider, voice_id}>` | ~10行 | 極低 | P1 |
| **M-2** | `marunage.ts:1512-1514` | `SELECT id FROM style_presets WHERE name = 'インフォグラフィック'` | `body.style_preset_id` があればそれを使用、なければフォールバック | ~10行 | 極低 | P1 |
| **M-3** | `marunage.ts:1509` の直後 | なし | `selected_character_ids` をループし `user_characters` → `project_character_models` にコピー + `project_character_instances` にリンク | ~50行 | 低 | P2 |
| **M-4** | `marunage.ts:1502-1505` | `settings_json = {default_narration_voice, marunage_mode:true}` | `+ character_voices: { [key]: {provider, voice_id} }` マップ追加 | ~20行 | 低 | P2 |
| **M-5** | `marunage.ts:223-226` | `body: JSON.stringify({ split_mode, target_scene_count })` | `+ character_hints: [{key, name, description}]` | ~15行 | 低 | P3 |
| **M-6** | `formatting.ts:1625` の systemPrompt 内 | キャラ情報なし | `X-Execution-Context: marunage` 時、`character_hints` があればプロンプトに注入 | ~30行 | 中 | P3 |
| **M-7** | `marunage.ts:726-758` | `composeStyledPrompt` のみ → `generateSingleImage(key, prompt, ratio)` | `+ getSceneReferenceImages(db, r2, sceneId, 5)` 追加 → `generateSingleImage(key, prompt, ratio, ★refImages)` | ~30行 | 中 | P4 |
| **M-7b** | `marunage.ts:500-580` | `generateSingleImage(apiKey, prompt, aspectRatio)` の contents に text のみ | `referenceImages?.map(img => ({inlineData: ...}))` を parts 先頭に追加 | ~15行 | 中 | P4 |
| **M-8** | `src/index.tsx` (丸投げ開始画面) | テキスト入力 + ナレーション声 + 出力プリセット | + スタイルカード選択 + キャラカード選択 + ボイス選択optgroup | ~300行 | 低（UI） | P1-2 |

**合計変更量: ~480行追加 / 0行削除（純追加のみ）**

### 3-B. 変更不要な箇所（影響ゼロ保証）

| ファイル | 行数 | 変更不要の理由 | 既存動作の影響 |
|---|---|---|---|
| `src/routes/bulk-audio.ts` | 880行 | `resolveVoiceForUtterance()` が既にキャラ voice_preset_id を Priority 1 で参照。データが追加されれば自動的に動作。 | ゼロ |
| `src/routes/audio-generation.ts` | 1243行 | TTS 生成ロジックは provider + voice_id のみ依存。呼び出し側が変わるだけ。 | ゼロ |
| `src/routes/character-models.ts` | 1379行 | CRUD はそのまま。import ロジック(`L292-369`)をコピー参照するが、ファイル自体は未変更。 | ゼロ |
| `src/routes/scene-characters.ts` | 679行 | 最大3制約チェック含めそのまま動作。 | ゼロ |
| `src/routes/settings.ts` | 836行 | ユーザーキャラ CRUD はそのまま。 | ゼロ |
| `src/routes/styles.ts` | 298行 | スタイル一覧 API はそのまま。 | ゼロ |
| `src/utils/character-reference-helper.ts` | 232行 | `getSceneReferenceImages()` はそのまま。marunage.ts から呼ぶだけ。 | ゼロ |
| `src/utils/world-character-helper.ts` | 206行 | テキスト強化ロジックはそのまま。 | ゼロ |
| `src/utils/image-prompt-builder.ts` | 115行 | `composeStyledPrompt()` はそのまま。 | ゼロ |
| `src/utils/character-auto-assign.ts` | 407行 | テキストマッチングロジックはそのまま。`project_character_models` にデータが入れば自動的に動作。 | ゼロ |
| `src/utils/dialogue-parser.ts` | 500行 | utterance 生成はそのまま。`project_character_models` のキャラ名で自動マッチング。 | ゼロ |
| `src/utils/elevenlabs.ts` | 274行 | ボイス定義・TTS呼び出しはそのまま。 | ゼロ |
| `migrations/*` | 57ファイル | **一切変更なし** | ゼロ |
| `src/routes/projects.ts` | — | `settings_json.marunage_mode IS NOT 1` フィルタ (`L319`) で丸投げプロジェクトは Builder 一覧に出ない。この動作は維持。 | ゼロ |

---

## 4. ゼロインパクト保証メカニズム（5層防御）

### 層1: ペイロード後方互換性

```typescript
// types/marunage.ts — 全新規フィールドは optional
export interface MarunageStartRequest {
  title?: string
  text: string
  narration_voice?: { provider?: string; voice_id: string }
  output_preset?: string
  target_scene_count?: number
  // ★ 新規 — 全て optional
  selected_character_ids?: number[]      // 省略時: キャラなし（現行動作）
  style_preset_id?: number               // 省略時: 「インフォグラフィック」
  character_voice_overrides?: Record<string, {  // 省略時: user_characters.voice_preset_id を使用
    provider: string
    voice_id: string
  }>
}
```

**証明:** 新規フィールドが全て `undefined` の場合、`POST /start` は現行コードパスと完全に同じ動作をする。

### 層2: marunage_mode ガード

```typescript
// marunage.ts L1502-1505 (既存コード、変更なし)
const settingsJson = JSON.stringify({
  default_narration_voice: narrationVoice,
  output_preset: outputPreset,
  marunage_mode: true,   // ← この flag が true の場合のみ新設定を読む
})
```

**証明:** `marunage_mode` は丸投げプロジェクトにのみ `true` がセットされる。既存の Builder プロジェクトは `marunage_mode` が存在しないか `false` のため、新しい `character_voices` フィールドは参照されない。

### 層3: X-Execution-Context ヘッダー分離

```typescript
// marunage.ts L220-221 (既存コード、変更なし)
'X-Execution-Context': 'marunage',

// formatting.ts L1070 (既存コード、変更なし)
const preserveExecContext = c.req.header('X-Execution-Context') === 'marunage' ? 'marunage' : 'builder'
```

**証明:** format API 内のキャラヒント注入 (M-6) は `X-Execution-Context === 'marunage'` の場合のみ有効化。Builder からの format 呼び出し（ヘッダーなし or `builder`）は一切影響を受けない。

### 層4: プロジェクト隔離（新規プロジェクト＋コピー戦略）

```typescript
// marunage.ts L1487 (既存コード、変更なし)
const projectResult = await c.env.DB.prepare(`
  INSERT INTO projects (title, status, user_id, source_type)
  VALUES (?, 'created', ?, 'text')
`).bind(title, user.id).run()
```

**証明:** 丸投げは毎回新しい `projects` レコードを作成する。`user_characters` → `project_character_models` へのコピーは新プロジェクトに対してのみ行われ、他プロジェクトのキャラデータには一切触れない。

### 層5: projects 一覧からの分離

```typescript
// projects.ts L319 (既存コード、変更なし)
AND json_extract(settings_json, '$.marunage_mode') IS NOT 1
```

**証明:** 丸投げプロジェクトは Builder のプロジェクト一覧に表示されない（`marunage_mode=true` フィルタ）。逆に丸投げ一覧 (`/api/marunage/runs`) は `marunage_runs` テーブルのみ参照するため、Builder プロジェクトを返さない。

---

## 5. 変更対象の詳細設計（コード差分レベル）

### M-1: MarunageStartRequest 型拡張

**ファイル:** `src/types/marunage.ts`
**現在 (L111-120):**
```typescript
export interface MarunageStartRequest {
  title?: string
  text: string
  narration_voice?: { provider?: string; voice_id: string }
  output_preset?: string
  target_scene_count?: number
}
```

**変更後:**
```typescript
export interface MarunageStartRequest {
  title?: string
  text: string
  narration_voice?: { provider?: string; voice_id: string }
  output_preset?: string
  target_scene_count?: number
  // Phase 1: Style selection
  style_preset_id?: number
  // Phase 2: Character selection
  selected_character_ids?: number[]
  character_voice_overrides?: Record<string, {
    provider: 'google' | 'elevenlabs' | 'fish'
    voice_id: string
  }>
}
```

**config_json (MarunageConfig) も拡張:**
```typescript
export interface MarunageConfig {
  experience_tag: 'marunage_chat_v1'
  target_scene_count: number
  split_mode: 'ai' | 'preserve'
  output_preset: string
  narration_voice: MarunageNarrationVoice
  bgm_mode: 'none' | 'auto'
  // Phase 1
  style_preset_id?: number
  // Phase 2
  selected_character_ids?: number[]
  character_voice_overrides?: Record<string, {
    provider: string
    voice_id: string
  }>
}
```

### M-2: スタイル選択のハードコード除去

**ファイル:** `src/routes/marunage.ts`
**現在 (L1511-1518):**
```typescript
const defaultStyle = await c.env.DB.prepare(`
  SELECT id FROM style_presets WHERE name = 'インフォグラフィック' AND is_active = 1 LIMIT 1
`).first<{ id: number }>()
if (defaultStyle) {
  await c.env.DB.prepare(`
    INSERT INTO project_style_settings (project_id, default_style_preset_id) VALUES (?, ?)
  `).bind(projectId, defaultStyle.id).run()
}
```

**変更後:**
```typescript
// Style selection: use provided ID or fallback to default
let styleId: number | null = null

if (body.style_preset_id) {
  // Validate the provided style preset exists and is active
  const userStyle = await c.env.DB.prepare(`
    SELECT id FROM style_presets WHERE id = ? AND is_active = 1 LIMIT 1
  `).bind(body.style_preset_id).first<{ id: number }>()
  if (userStyle) {
    styleId = userStyle.id
  }
}

if (!styleId) {
  // Fallback: original hardcoded behavior
  const defaultStyle = await c.env.DB.prepare(`
    SELECT id FROM style_presets WHERE name = 'インフォグラフィック' AND is_active = 1 LIMIT 1
  `).first<{ id: number }>()
  styleId = defaultStyle?.id ?? null
}

if (styleId) {
  await c.env.DB.prepare(`
    INSERT INTO project_style_settings (project_id, default_style_preset_id) VALUES (?, ?)
  `).bind(projectId, styleId).run()
}
```

### M-3: キャラクターコピー処理

**ファイル:** `src/routes/marunage.ts` (L1509 の直後に挿入)
**根拠:** `character-models.ts:292-369` の import ロジックを参考に、同等のコピーを inline 実装

```typescript
// ===== Step 1.5: Copy selected characters to project (Phase 2) =====
if (body.selected_character_ids && body.selected_character_ids.length > 0) {
  for (const ucId of body.selected_character_ids) {
    // Fetch from user's library (ownership check)
    const uc = await c.env.DB.prepare(`
      SELECT * FROM user_characters WHERE id = ? AND user_id = ?
    `).bind(ucId, user.id).first()

    if (!uc) {
      console.warn(`[Marunage:Start] user_character ${ucId} not found for user ${user.id}, skipping`)
      continue
    }

    // Check duplicate (same character_key already in project)
    const existing = await c.env.DB.prepare(`
      SELECT id FROM project_character_models WHERE project_id = ? AND character_key = ?
    `).bind(projectId, uc.character_key).first()

    if (existing) {
      console.warn(`[Marunage:Start] character_key=${uc.character_key} already in project ${projectId}, skipping`)
      continue
    }

    // Determine voice_preset_id: override > original
    let voicePresetId = uc.voice_preset_id
    if (body.character_voice_overrides?.[uc.character_key]) {
      const override = body.character_voice_overrides[uc.character_key]
      // Store as provider-prefixed voice_id for resolveVoiceForUtterance() compatibility
      voicePresetId = override.voice_id  // e.g., "el-aria", "ja-JP-Wavenet-A"
    }

    // Copy to project_character_models (same schema as character-models.ts:344-358)
    const insertResult = await c.env.DB.prepare(`
      INSERT INTO project_character_models
        (project_id, character_key, character_name, description,
         appearance_description, reference_image_r2_key, reference_image_r2_url,
         voice_preset_id, aliases_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      projectId,
      uc.character_key,
      uc.character_name,
      uc.description,
      uc.appearance_description,
      uc.reference_image_r2_key,
      uc.reference_image_r2_url,
      voicePresetId,
      uc.aliases_json
    ).run()

    // Link in project_character_instances
    await c.env.DB.prepare(`
      INSERT INTO project_character_instances
        (project_id, user_character_id, character_key, is_customized)
      VALUES (?, ?, ?, ?)
    `).bind(projectId, ucId, uc.character_key, voicePresetId !== uc.voice_preset_id ? 1 : 0).run()
  }

  console.log(`[Marunage:Start] Copied ${body.selected_character_ids.length} characters to project ${projectId}`)
}
```

### M-4: settings_json のキャラ音声マップ拡張

**ファイル:** `src/routes/marunage.ts`
**現在 (L1502-1505):**
```typescript
const settingsJson = JSON.stringify({
  default_narration_voice: narrationVoice,
  output_preset: outputPreset,
  marunage_mode: true,
})
```

**変更後:**
```typescript
// Build character_voices map from project_character_models
const characterVoices: Record<string, { provider: string; voice_id: string }> = {}

if (body.selected_character_ids && body.selected_character_ids.length > 0) {
  const { results: projectChars } = await c.env.DB.prepare(`
    SELECT character_key, voice_preset_id FROM project_character_models WHERE project_id = ?
  `).bind(projectId).all()

  for (const pc of (projectChars || [])) {
    if (pc.voice_preset_id) {
      let provider = 'google'
      const vid = pc.voice_preset_id as string
      if (vid.startsWith('el-') || vid.startsWith('elevenlabs:')) provider = 'elevenlabs'
      else if (vid.startsWith('fish-') || vid.startsWith('fish:')) provider = 'fish'
      characterVoices[pc.character_key as string] = { provider, voice_id: vid }
    }
  }
}

const settingsJson = JSON.stringify({
  default_narration_voice: narrationVoice,
  output_preset: outputPreset,
  marunage_mode: true,
  // Phase 2: キャラ音声マップ（resolveVoiceForUtterance が自動参照）
  ...(Object.keys(characterVoices).length > 0 ? { character_voices: characterVoices } : {}),
})
```

### M-5: format API へのキャラヒント送信

**ファイル:** `src/routes/marunage.ts`
**現在 (L215-227):**
```typescript
const res = await fetch(formatUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Cookie': cookieHeader,
    'X-Execution-Context': 'marunage',
  },
  body: JSON.stringify({
    split_mode: config.split_mode || 'ai',
    target_scene_count: config.target_scene_count || 5,
  }),
})
```

**変更後:**
```typescript
// Build character hints from project_character_models (if any exist)
let characterHints: Array<{ key: string; name: string; description: string }> = []
if (config.selected_character_ids && config.selected_character_ids.length > 0) {
  const { results: chars } = await db.prepare(`
    SELECT character_key, character_name, description
    FROM project_character_models WHERE project_id = ?
  `).bind(projectId).all()

  characterHints = (chars || []).map(c => ({
    key: c.character_key as string,
    name: c.character_name as string,
    description: (c.description as string) || '',
  }))
}

const res = await fetch(formatUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Cookie': cookieHeader,
    'X-Execution-Context': 'marunage',
  },
  body: JSON.stringify({
    split_mode: config.split_mode || 'ai',
    target_scene_count: config.target_scene_count || 5,
    ...(characterHints.length > 0 ? { character_hints: characterHints } : {}),
  }),
})
```

### M-6: GPT プロンプトへのキャラ情報注入

**ファイル:** `src/routes/formatting.ts`
**変更箇所:** `generateMiniScenesWithSchemaAI()` (L1610) と `generateWithSchema()` (L1921) の systemPrompt 内

**条件:** `character_hints` が body に含まれ、かつ `X-Execution-Context === 'marunage'` の場合のみ

```typescript
// formatting.ts: format ハンドラ内で character_hints を受け取る
const characterHints = body.character_hints as Array<{ key: string; name: string; description: string }> | undefined

// generateMiniScenesWithSchemaAI / generateWithSchema に渡す
// systemPrompt への追記（末尾に条件付き追加）:

let characterPromptSection = ''
if (characterHints && characterHints.length > 0 && preserveExecContext === 'marunage') {
  characterPromptSection = `

【登場キャラクター（固定）】
以下のキャラクターが登場します。セリフは必ずこれらのキャラクター名を speaker として使用してください:
${characterHints.map(ch => `- ${ch.name}（${ch.description || '説明なし'}）`).join('\n')}

【セリフルール】
- ナレーション（語り手）は speech_type="narration" としてください
- キャラクターのセリフは speech_type="dialogue" とし、dialogue 内に「キャラ名：「セリフ」」形式で記載してください
- 1シーンあたり最大3名のキャラクターが登場できます
- キャラクター名は上記リストのいずれかに限定してください`
}

// systemPrompt の末尾に characterPromptSection を追加
const finalSystemPrompt = systemPrompt + characterPromptSection
```

**安全性:** `preserveExecContext === 'marunage'` かつ `characterHints` が存在する場合のみ有効。Builder や marunage でもキャラ未選択の場合は空文字列が追加されるのみ（NOP）。

### M-7: 画像生成への参照画像追加

**ファイル:** `src/routes/marunage.ts`

**Step 1: generateSingleImage() の引数拡張 (L500 付近)**

**現在:**
```typescript
async function generateSingleImage(
  apiKey: string,
  prompt: string,
  aspectRatio: string
)
```

**変更後:**
```typescript
interface ReferenceImageForGemini {
  mimeType: string
  base64Data: string
}

async function generateSingleImage(
  apiKey: string,
  prompt: string,
  aspectRatio: string,
  referenceImages?: ReferenceImageForGemini[]  // 追加
)
```

**Step 2: Gemini API の contents 拡張 (L550 付近)**

**現在:**
```typescript
contents: [{
  parts: [
    { text: enhancedPrompt }
  ]
}]
```

**変更後:**
```typescript
contents: [{
  parts: [
    // Reference images first (if any)
    ...(referenceImages || []).map(img => ({
      inlineData: { mimeType: img.mimeType, data: img.base64Data }
    })),
    { text: enhancedPrompt }
  ]
}]
```

**Step 3: 画像生成ループでの参照画像取得 (L726 付近)**

**現在 (L726-758):**
```typescript
let prompt = scene.image_prompt as string || ''
try {
  prompt = await composeStyledPrompt(db, projectId, scene.id as number, prompt)
} catch (e) { ... }
// ...
const imageResult = await generateSingleImage(keyResult.apiKey, prompt, aspectRatio as any)
```

**変更後:**
```typescript
let prompt = scene.image_prompt as string || ''
try {
  prompt = await composeStyledPrompt(db, projectId, scene.id as number, prompt)
} catch (e) { ... }

// ★ Phase 4: Fetch reference images for character consistency
let referenceImages: ReferenceImageForGemini[] = []
try {
  const { getSceneReferenceImages } = await import('../utils/character-reference-helper')
  const refs = await getSceneReferenceImages(db, r2, scene.id as number, 5)
  referenceImages = refs.map(r => ({
    mimeType: r.mimeType,
    base64Data: r.base64Data,
  }))
  if (referenceImages.length > 0) {
    console.log(`[Marunage:Image] Loaded ${referenceImages.length} reference images for scene ${scene.id}`)
  }
} catch (e) {
  console.warn(`[Marunage:Image] Reference image loading failed for scene ${scene.id}:`, e)
  // Continue without reference images (graceful degradation)
}

const imageResult = await generateSingleImage(keyResult.apiKey, prompt, aspectRatio as any, referenceImages)
```

---

## 6. 依存関係マトリクス

```
Phase 1 (スタイル選択) ←── 依存なし
    │
    ▼
Phase 2 (キャラ選択 + コピー) ←── 依存なし（Phase 1 と並行可能）
    │
    ▼
Phase 3 (フォーマットAI キャラ注入) ←── Phase 2 必須
    │                                     （project_character_models にデータがないと意味がない）
    │
    ▼
Phase 4 (画像生成 参照画像) ←── Phase 3 必須
    │                           （scene_character_map にデータがないと参照画像を取得できない）
    │
    ▼
Phase 5 (キャラ別ボイス) ←── Phase 2 完了で自動動作（コード変更不要）
```

**最小 MVP (Phase 1 のみ):**
- スタイル選択 UI + `POST /start` の 10行変更
- 即効効果: 画像のスタイルが変わる
- リスク: 極低

**推奨 MVP (Phase 1 + 2):**
- スタイル + キャラ選択 UI + コピーロジック
- 効果: スタイル選択 + キャラ別ボイス（Phase 5 が自動動作）
- リスク: 低

**フル実装 (Phase 1-4):**
- 全機能: スタイル + キャラ + AI注入 + 画像参照
- 効果: キャラ固定化の完全実現
- リスク: 中（Phase 3 の GPT 出力変動）

---

## 7. POST /api/marunage/start ペイロード仕様

### 7-A. リクエスト（後方互換）

```json
{
  "text": "動画にしたいテキスト...",                // 必須 (100-50000文字)
  "title": "動画タイトル",                          // 任意 (デフォルト: 丸投げ YYYY/MM/DD)
  "output_preset": "yt_long",                       // 任意 (yt_long | short_vertical)
  "target_scene_count": 5,                          // 任意 (3-10, デフォルト5)
  "narration_voice": {                              // 任意
    "provider": "google",                           //   デフォルト: google
    "voice_id": "ja-JP-Neural2-B"                   //   デフォルト: ja-JP-Neural2-B
  },

  // ★ Phase 1: スタイル選択 (任意)
  "style_preset_id": 3,                             // style_presets.id (省略時: 「インフォグラフィック」)

  // ★ Phase 2: キャラ選択 (任意)
  "selected_character_ids": [5, 8, 12],             // user_characters.id の配列 (省略時: キャラなし)

  // ★ Phase 2: キャラ別ボイス上書き (任意)
  "character_voice_overrides": {                    // character_key → voice 設定
    "taro": {
      "provider": "elevenlabs",
      "voice_id": "el-adam"
    },
    "hanako": {
      "provider": "google",
      "voice_id": "ja-JP-Wavenet-A"
    }
  }
}
```

### 7-B. レスポンス（変更なし）

```json
{
  "run_id": 42,
  "project_id": 123,
  "phase": "formatting",
  "config": {
    "experience_tag": "marunage_chat_v1",
    "target_scene_count": 5,
    "split_mode": "ai",
    "output_preset": "yt_long",
    "narration_voice": { "provider": "google", "voice_id": "ja-JP-Neural2-B" },
    "bgm_mode": "none",
    "style_preset_id": 3,
    "selected_character_ids": [5, 8, 12],
    "character_voice_overrides": {
      "taro": { "provider": "elevenlabs", "voice_id": "el-adam" }
    }
  }
}
```

### 7-C. config_json 保存先

| フィールド | 保存先 | 読み取りタイミング |
|---|---|---|
| `style_preset_id` | `marunage_runs.config_json` + `project_style_settings` | 画像生成時（`composeStyledPrompt` 経由） |
| `selected_character_ids` | `marunage_runs.config_json` (スナップショット) | 監査ログ用。実データは `project_character_models` |
| `character_voice_overrides` | `marunage_runs.config_json` + `project_character_models.voice_preset_id` | 音声生成時（`resolveVoiceForUtterance` 経由） |
| `narration_voice` | `marunage_runs.config_json` + `projects.settings_json.default_narration_voice` | 音声生成時（Priority 2 フォールバック） |

---

## 8. v1 方針決定: ボイス選択 UI

### 選択肢

| 案 | 内容 | UI 複雑度 | 効果 | 推奨 |
|---|---|---|---|---|
| **A案: ナレーション音声のみ** | 開始画面にナレーション声プルダウン1つ。キャラは `user_characters.voice_preset_id` を自動使用。 | 低 | 十分（キャラ登録時にボイスを設定済みであれば完全動作） | ★ v1 推奨 |
| **B案: キャラ別ボイス上書きUI** | ナレーション声 + 各キャラにボイスプルダウン表示。`character_voice_overrides` を送信。 | 中 | 柔軟（プロジェクトごとにキャラの声を変えられる） | v2 検討 |

### 推奨: A案（v1）

**理由:**
1. `resolveVoiceForUtterance()` は `project_character_models.voice_preset_id` を最優先で参照する（`bulk-audio.ts:84-101`）
2. キャラ登録時（`/settings`）にボイスを設定しておけば、丸投げ開始時に何もしなくても正しいボイスが使われる
3. UI が最小限で済み、Phase 2 の実装コストが下がる
4. `character_voice_overrides` の仕組みは M-3 のコピー時に組み込み済みなので、v2 で UI だけ追加すればよい

**A案での動作フロー:**
```
1. ユーザーが /settings でキャラ登録（voice_preset_id = "el-adam"）
2. 丸投げ開始画面でキャラ選択（checkbox）
3. POST /start → M-3: user_characters → project_character_models コピー
   → voice_preset_id = "el-adam" がコピーされる
4. 音声生成時 → resolveVoiceForUtterance()
   → Priority 1: project_character_models.voice_preset_id = "el-adam" → ElevenLabs Adam
5. ナレーション → Priority 2: settings_json.default_narration_voice
```

---

## 9. UI 設計概要（M-8）

### 9-A. 丸投げ開始画面のレイアウト

```
┌─────────────────────────────────────────────┐
│  丸投げで動画を作る                           │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │ テキスト入力エリア                      │   │
│  │ (100〜50,000文字)                     │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  ── スタイル選択 ─────────────────────       │
│  ┌────┐  ┌────┐  ┌────┐  ┌────┐           │
│  │ 🎨  │  │ 📊  │  │ 🌊  │  │ 🎭  │           │
│  │Info │  │Flat│  │Water│  │Anime│          │
│  │✅   │  │    │  │    │  │    │           │
│  └────┘  └────┘  └────┘  └────┘           │
│  (GET /api/style-presets)                    │
│                                              │
│  ── キャラクター選択 (任意) ─────────         │
│  ┌────┐  ┌────┐  ┌────┐  ┌────┐           │
│  │ 👤  │  │ 👤  │  │ 👤  │  │ ＋  │           │
│  │太郎 │  │花子│  │博士│  │追加│           │
│  │✅   │  │✅  │  │    │  │    │           │
│  └────┘  └────┘  └────┘  └────┘           │
│  (GET /api/settings/user/characters)         │
│  未登録の場合: 「設定画面でキャラクターを       │
│  登録してください」リンク表示                  │
│                                              │
│  ── ナレーション音声 ──────────────          │
│  ┌─────────────────────────────────┐       │
│  │ ▼ Google TTS                     │       │
│  │   ja-JP-Wavenet-A (女性・自然)    │       │
│  │ ▼ ElevenLabs                     │       │
│  │   Aria (女性・落ち着き)            │       │
│  └─────────────────────────────────┘       │
│  (GET /api/tts/voices)                       │
│                                              │
│  ── 出力プリセット ────────────────          │
│  (●) YouTube ロング (16:9)                   │
│  ( ) ショート動画 (9:16)                      │
│                                              │
│  ┌───────────────────────────────────┐      │
│  │         🚀 動画を作成する            │      │
│  └───────────────────────────────────┘      │
│                                              │
└─────────────────────────────────────────────┘
```

### 9-B. API 呼び出しフロー（フロントエンド）

```javascript
// 1. ページロード時に並列取得
const [stylesRes, charsRes, voicesRes] = await Promise.all([
  fetch('/api/style-presets'),
  fetch('/api/settings/user/characters'),
  fetch('/api/tts/voices'),
])
const styles = await stylesRes.json()     // style_presets[]
const chars = await charsRes.json()       // user_characters[]
const voices = await voicesRes.json()     // { google: [], elevenlabs: [], fish: [] }

// 2. 送信時
const payload = {
  text: textArea.value,
  style_preset_id: selectedStyleId,           // number or undefined
  selected_character_ids: selectedCharIds,     // number[] or undefined
  narration_voice: {
    provider: selectedVoiceProvider,
    voice_id: selectedVoiceId,
  },
  output_preset: selectedPreset,
  target_scene_count: 5,
}
const res = await fetch('/api/marunage/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})
```

---

## 10. テスト計画（Phase ごと）

### Phase 1 テスト

| # | テストケース | 期待結果 | 確認方法 |
|---|---|---|---|
| T1-1 | `style_preset_id` 省略で POST /start | 従来通り「インフォグラフィック」が適用される | `project_style_settings` レコード確認 |
| T1-2 | `style_preset_id: 3` で POST /start | style_presets.id=3 が適用される | `project_style_settings` + 画像の見た目確認 |
| T1-3 | 無効な `style_preset_id: 9999` | フォールバックで「インフォグラフィック」 | `project_style_settings` 確認 |
| T1-4 | 既存の Builder プロジェクトを作成 | スタイル選択の影響なし | Builder UI で確認 |

### Phase 2 テスト

| # | テストケース | 期待結果 | 確認方法 |
|---|---|---|---|
| T2-1 | `selected_character_ids` 省略で POST /start | キャラなし（現行動作） | `project_character_models` が空 |
| T2-2 | `selected_character_ids: [5, 8]` で POST /start | 2 キャラが project_character_models にコピー | DB 直接確認 |
| T2-3 | 他ユーザーの character_id を指定 | スキップされる（ownership check） | ログ確認 |
| T2-4 | 重複 character_key | 2番目以降がスキップ | ログ確認 |
| T2-5 | voice_override ありで POST /start | override された voice_preset_id がコピーされる | `project_character_models.voice_preset_id` 確認 |
| T2-6 | voice_override なしで POST /start | user_characters の voice_preset_id がコピーされる | 同上 |

### Phase 3 テスト

| # | テストケース | 期待結果 | 確認方法 |
|---|---|---|---|
| T3-1 | キャラ2名選択 + AI mode | GPT プロンプトにキャラ名が含まれ、dialogue に character_key がセット | scene_utterances 確認 |
| T3-2 | キャラ未選択 + AI mode | 従来通り（キャラプロンプトなし） | systemPrompt にキャラセクションなし |
| T3-3 | Builder から format API 呼び出し | キャラプロンプト未注入（X-Execution-Context !== 'marunage'） | ログ確認 |
| T3-4 | autoAssignCharactersToScenes() | project_character_models のキャラ名でシーンマッチング → 最大3名 | scene_character_map 確認 |

### Phase 4 テスト

| # | テストケース | 期待結果 | 確認方法 |
|---|---|---|---|
| T4-1 | キャラ＋参照画像ありで画像生成 | Gemini API に inlineData として画像が渡される | ログ + 画像の見た目確認 |
| T4-2 | キャラあり・参照画像なしで画像生成 | テキスト強化のみ（graceful degradation） | ログ + 画像確認 |
| T4-3 | キャラなしで画像生成 | 現行動作（参照画像なし） | 画像確認 |
| T4-4 | 参照画像取得でR2エラー | 参照画像なしで続行（try-catch） | ログ確認 |

---

## 11. 既存自動処理チェーン（Phase X-2）の動作確認

**現在のフォーマット完了後の自動処理 (`formatting.ts:1186-1211` / `1456-1486`):**

```
フォーマット完了（status = 'formatted'）
    │
    └─ waitUntil (非同期、レスポンスをブロックしない)
         │
         ├─ 1. autoAssignCharactersToScenes(db, projectId)
         │      project_character_models からキャラパターン構築
         │      → scenes.dialogue + bullets + image_prompt でテキストマッチング
         │      → scene_character_map に INSERT (最大3名/シーン)
         │      ★ 現在: project_character_models が空のため 0 件
         │      ★ 拡張後: M-3 でコピー済みのため正常動作
         │
         ├─ 2. extractAndUpdateCharacterTraits(db, projectId)
         │      シーン台詞からキャラ特徴を抽出
         │      → scene_character_traits に保存
         │
         └─ 3. generateUtterancesForProject(db, projectId)
                scenes.dialogue を解析
                → 「キャラ名：「セリフ」」形式を検出
                → scene_utterances に role + character_key 付きで INSERT
                → project_character_models のキャラ名 + aliases で fuzzy マッチング
                ★ 現在: キャラマッチングは空振り → 全て narration 扱い
                ★ 拡張後: M-3 + M-6 により dialogue 行にキャラが正しく割り当てられる
```

**重要な発見:** これらの自動処理は**既に format 完了時に毎回実行されている**。M-3 で `project_character_models` にデータを入れるだけで、Phase X-2 の全自動処理が正しく動作し始める。追加コードは不要。

---

## 12. リスク評価と軽減策

| リスク | 発生確率 | 影響度 | 軽減策 |
|---|---|---|---|
| GPT がキャラ名を正しく使わない (M-6) | 中 | 中 | バリデーション + フォールバック（キャラ未指定のセリフは narration 扱い） |
| 参照画像が大きすぎて Gemini タイムアウト (M-7) | 低 | 中 | `getSceneReferenceImages` の maxImages=5 制限 + 45秒タイムアウト既存 |
| R2 から参照画像取得失敗 (M-7) | 低 | 低 | try-catch で graceful degradation（参照画像なしで続行） |
| user_characters にボイス未設定 (M-3) | 中 | 低 | フォールバック: resolveVoiceForUtterance Priority 2-3 で処理 |
| config_json が大きくなる | 低 | 極低 | TEXT型カラム、実用上問題なし |
| 既存 Builder プロジェクトへの影響 | — | — | **ゼロ（5層防御で保証）** |

---

## 13. 確定仕様一覧

| 項目 | 決定 | 根拠 |
|---|---|---|
| DB マイグレーション | **なし** | 全テーブル・カラム既存 |
| 既存 API の破壊的変更 | **なし** | 新規フィールドは全て optional |
| シーン内キャラ上限 | **最大3名/シーン** | `character-auto-assign.ts:288` + `scene-characters.ts:68` |
| ナレーション行数 | **無制限** | scene_utterances に制限なし |
| dialogue 行数 | **無制限**（speaker は3名以内） | 同上 |
| キャラ選択タイミング | **丸投げ開始前に固定** | run 進行中の変更不可 |
| スタイル選択タイミング | **丸投げ開始前に固定** | 同上 |
| ボイス選択肢 | **全17ボイス** (Google 8 + ElevenLabs 8 + Fish 1) | `GET /api/tts/voices` |
| v1 ボイス UI | **A案: ナレーションのみ** | キャラ音声は user_characters から自動 |
| キャラ途中追加 | **v1 非対応** | config_json で凍結 |
| 画像参照の graceful degradation | **参照画像取得失敗時はテキストのみで続行** | try-catch |

---

## 14. 将来拡張（v2以降）

| 項目 | 優先度 | 前提条件 |
|---|---|---|
| B案: キャラ別ボイス上書き UI | 中 | M-3 のコード基盤で対応済み。UI のみ追加 |
| キャラ登録画像アップロード UI | 中 | R2 アップロード API 既存 |
| scene_character_traits (C層) | 低 | テーブル・ユーティリティ既存 |
| シーン単位キャラ入れ替え UI | 低 | scene_character_map CRUD 既存 |
| world_settings 活用 | 低 | テーブル・ユーティリティ既存 |
| ボイスプレビュー（試聴） | 中 | TTS API 経由で短文生成 |
| カスタムボイスクローニング | 低 | ElevenLabs Voice Clone API |
| フォルダ整理 (`/marunage/folders`) | 低 | 別チケット |

---

## 15. 変更差分サマリ（実装チェックリスト）

```
Phase 1 (スタイル選択):
  [ ] M-1: types/marunage.ts — MarunageStartRequest に style_preset_id 追加
  [ ] M-2: marunage.ts:1511-1518 — ハードコード「インフォグラフィック」→ 動的選択
  [ ] M-8a: index.tsx — スタイルカード選択 UI

Phase 2 (キャラ選択):
  [ ] M-1: types/marunage.ts — selected_character_ids, character_voice_overrides 追加
  [ ] M-3: marunage.ts:1509+ — user_characters → project_character_models コピー
  [ ] M-4: marunage.ts:1502-1505 — settings_json に character_voices 追加
  [ ] M-8b: index.tsx — キャラカード選択 UI + ナレーション音声プルダウン

Phase 3 (フォーマットAI):
  [ ] M-5: marunage.ts:215-226 — format API body に character_hints 追加
  [ ] M-6: formatting.ts:1625 — GPT systemPrompt にキャラ情報注入
  [ ] autoAssignCharactersToScenes() — 変更不要（自動動作）
  [ ] generateUtterancesForProject() — 変更不要（自動動作）

Phase 4 (画像参照):
  [ ] M-7: marunage.ts:500 — generateSingleImage() に referenceImages 引数追加
  [ ] M-7b: marunage.ts:550 — Gemini contents に inlineData 追加
  [ ] M-7c: marunage.ts:726 — 画像生成ループで getSceneReferenceImages() 呼び出し

Phase 5 (キャラ別ボイス):
  [ ] 変更不要 — resolveVoiceForUtterance() が自動的に動作
```
