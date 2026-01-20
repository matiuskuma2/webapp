# 依存関係マップ（SSOT更新チェックリスト）

作成日: 2026-01-19
目的: 変更のたびに必ず更新する箇所を明確化し、運用事故を防止

---

## 1. 音声生成フロー

```
┌─────────────────────────────────────────────────────────────────────┐
│                        音声生成フロー                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  [UI: voice_id 選択]                                               │
│       ↓                                                            │
│  voice-presets.json ←── 読込 ── audio-ui.js                        │
│       │                        world-character-modal.js            │
│       │                        comic-editor-v2.js                  │
│       │                        project-editor.*.js                 │
│       ↓                                                            │
│  POST /api/scenes/:id/generate-audio                               │
│       │                                                            │
│       │  body: { voice_id, text_override? }                        │
│       ↓                                                            │
│  audio-generation.ts                                               │
│       │                                                            │
│       ├─ detectProvider(voice_id)                                  │
│       │   ├─ elevenlabs: → 'el-' or 'elevenlabs:'                 │
│       │   ├─ fish:       → 'fish:' or 'fish-'                     │
│       │   └─ google:     → default                                 │
│       │                                                            │
│       ├─ INSERT audio_generations (status='generating')            │
│       │                                                            │
│       └─ waitUntil: generateAndUploadAudio()                       │
│             │                                                      │
│             ├─ ElevenLabs: generateElevenLabsTTS()                │
│             ├─ Fish:       generateFishTTS()                      │
│             └─ Google:     Google TTS API                         │
│             │                                                      │
│             └─ R2.put() → UPDATE audio_generations                 │
│                           (status='completed', r2_url=...)        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 変更時のチェックリスト

| 変更内容 | 更新が必要なファイル |
|----------|----------------------|
| 新しいTTSプロバイダ追加 | `audio-generation.ts` (detectProvider, generateAndUploadAudio), `elevenlabs.ts` or 新ファイル, `voice-presets.json`, UI各ファイル |
| voice_id フォーマット変更 | `audio-generation.ts` (detectProvider), `voice-presets.json` |
| 音声フォーマット追加 | `audio-generation.ts`, `audio.ts` (R2配信) |

---

## 2. キャラクター・音声割当フロー

```
┌─────────────────────────────────────────────────────────────────────┐
│                   キャラクター・音声割当フロー                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  [Characters タブ]                                                 │
│       │                                                            │
│       └─ world-character-ui.js                                     │
│            ↓                                                       │
│       POST /api/projects/:id/characters                            │
│            │                                                       │
│            └─ character-models.ts                                  │
│                 │                                                  │
│                 └─ INSERT/UPDATE project_character_models          │
│                      (voice_id, voice_provider, aliases_json)      │
│                                                                     │
│  [シーン側]                                                        │
│       │                                                            │
│       └─ scene-edit-modal.js / Builder UI                          │
│            ↓                                                       │
│       PATCH /api/scenes/:id/characters                             │
│            │                                                       │
│            └─ scene-characters.ts                                  │
│                 │                                                  │
│                 └─ INSERT/UPDATE scene_character_map               │
│                      (character_model_id, role)                    │
│                                                                     │
│  [音声生成時の voice_id 解決]                                       │
│       │                                                            │
│       └─ audio-generation.ts                                       │
│            │                                                       │
│            ├─ voice_id が直接指定 → そのまま使用                   │
│            └─ voice_preset_id → preset から voice_id を解決        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 変更時のチェックリスト

| 変更内容 | 更新が必要なファイル |
|----------|----------------------|
| キャラクターに新フィールド追加 | `character-models.ts`, `world-character-ui.js`, `world-character-modal.js`, マイグレーション |
| voice_id 解決ロジック変更 | `audio-generation.ts`, `character-models.ts` |
| aliases 機能追加/変更 | `character-models.ts`, マイグレーション |

---

## 3. Video Build フロー

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Video Build フロー                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  [Preflight]                                                       │
│       │                                                            │
│       └─ GET /api/projects/:id/video-builds/preflight              │
│            │                                                       │
│            └─ video-generation.ts                                  │
│                 │                                                  │
│                 ├─ scenes テーブル (display_asset_type)            │
│                 │                                                  │
│                 ├─ 素材取得 (SSOT)                                 │
│                 │   ├─ image: image_generations (is_active=1)     │
│                 │   ├─ comic: image_generations (asset_type='comic')│
│                 │   ├─ video: video_generations (is_active=1)     │
│                 │   └─ audio: audio_generations (is_active=1)     │
│                 │                                                  │
│                 └─ toAbsoluteUrl() で全URLを絶対URL化              │
│                      ↓                                             │
│                 validateProjectAssets()                            │
│                                                                     │
│  [Build 開始]                                                      │
│       │                                                            │
│       └─ POST /api/projects/:id/video-builds                       │
│            │                                                       │
│            └─ video-generation.ts                                  │
│                 │                                                  │
│                 ├─ buildProjectJson()                              │
│                 │   └─ video-build-helpers.ts                      │
│                 │        └─ buildBuildRequestV1()                  │
│                 │                                                  │
│                 ├─ R2保存: video-builds/{id}/project.json          │
│                 │                                                  │
│                 └─ AWS Orchestrator 呼び出し                       │
│                      │                                             │
│                      └─ Remotion Lambda                            │
│                           │                                        │
│                           └─ 音声/画像URLを絶対URLで参照           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 変更時のチェックリスト

| 変更内容 | 更新が必要なファイル |
|----------|----------------------|
| 素材SSOT変更 | `video-generation.ts` (preflight, build), `video-build-helpers.ts` |
| BuildRequest スキーマ変更 | `video-build-helpers.ts`, Remotion側, `docs/VIDEO_BUILD_SSOT.md` |
| URL形式変更 | `toAbsoluteUrl()`, R2配信ルート |
| 新素材タイプ追加 | `video-generation.ts`, `video-build-helpers.ts`, preflight検証 |

---

## 4. Scene Split フロー

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Scene Split フロー                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  [UI: シーン分割ボタン]                                            │
│       │                                                            │
│       └─ project-editor.*.js                                       │
│            │                                                       │
│            └─ formatAndSplit()                                     │
│                 │                                                  │
│                 ├─ POST /api/projects/:id/parse (if needed)        │
│                 │   └─ parsing.ts                                  │
│                 │        └─ text_chunks 生成                       │
│                 │                                                  │
│                 ├─ POST /api/projects/:id/format                   │
│                 │   └─ formatting.ts                               │
│                 │        └─ processTextChunks()                    │
│                 │             └─ generateMiniScenes() (OpenAI)     │
│                 │                  └─ scenes 生成                  │
│                 │                                                  │
│                 └─ startFormatPolling()                            │
│                      │                                             │
│                      ├─ GET /api/projects/:id/format/status        │
│                      │                                             │
│                      ├─ タイムアウト: 10分 (FORMAT_TIMEOUT_MS)     │
│                      │                                             │
│                      ├─ 失敗検出: status='failed'                  │
│                      │                                             │
│                      └─ ネットワークエラー: 3回リトライ            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 変更時のチェックリスト

| 変更内容 | 更新が必要なファイル |
|----------|----------------------|
| ステータス遷移変更 | `formatting.ts`, `project-editor.*.js`, `docs/SCENE_SPLIT_SSOT.md` |
| タイムアウト値変更 | `project-editor.*.js` (FORMAT_TIMEOUT_MS) |
| エラーログ形式変更 | `formatting.ts`, `api_error_logs` テーブル |
| chunk処理ロジック変更 | `parsing.ts`, `formatting.ts` |

---

## 5. 漫画（Comic）フロー

```
┌─────────────────────────────────────────────────────────────────────┐
│                         漫画フロー                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  [漫画エディタ]                                                    │
│       │                                                            │
│       └─ comic-editor-v2.js                                        │
│            │                                                       │
│            ├─ 吹き出し操作 (CRUD)                                  │
│            │   └─ POST/PUT/DELETE /api/scenes/:id/comic/bubbles    │
│            │        └─ comic.ts                                    │
│            │                                                       │
│            └─ 採用切替                                             │
│                └─ PATCH /api/scenes/:id                            │
│                     └─ scenes.ts (display_asset_type)              │
│                                                                     │
│  [comic_data スキーマ (SSOT)]                                      │
│       │                                                            │
│       └─ scenes.comic_data (JSON)                                  │
│            │                                                       │
│            ├─ draft: { utterances: [...], bubbles: [...] }         │
│            │                                                       │
│            └─ published: { ... }                                   │
│                                                                     │
│  [吹き出しスタイル (Phase 3 予定)]                                 │
│       │                                                            │
│       └─ bubble.textStyle: { writingMode, fontFamily, ... }        │
│       └─ bubble.timing: { show_from_ms, show_until_ms, mode }      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 変更時のチェックリスト

| 変更内容 | 更新が必要なファイル |
|----------|----------------------|
| comic_data スキーマ変更 | `comic.ts`, `comic-editor-v2.js`, `video-build-helpers.ts` |
| 吹き出しタイプ追加 | `comic.ts`, `comic-editor-v2.js` |
| textStyle/timing 追加 | `comic.ts`, `comic-editor-v2.js`, `video-build-helpers.ts`, `docs/BUBBLE_TEXTSTYLE_SPEC.md` |
| 採用切替ロジック変更 | `scenes.ts`, `video-generation.ts` (preflight) |

---

## 6. ファイル参照マトリクス

### フロントエンド → バックエンド

| フロントエンド | 呼び出すAPI | バックエンド |
|---------------|-------------|--------------|
| `project-editor.*.js` | `/api/projects/:id/format` | `formatting.ts` |
| `project-editor.*.js` | `/api/projects/:id/parse` | `parsing.ts` |
| `audio-ui.js` | `/api/scenes/:id/generate-audio` | `audio-generation.ts` |
| `world-character-ui.js` | `/api/projects/:id/characters` | `character-models.ts` |
| `comic-editor-v2.js` | `/api/scenes/:id/comic/*` | `comic.ts` |

### バックエンド → 外部サービス

| バックエンド | 外部サービス | 環境変数 |
|--------------|--------------|----------|
| `audio-generation.ts` | Google TTS | `GOOGLE_TTS_API_KEY` or `GEMINI_API_KEY` |
| `audio-generation.ts` | Fish Audio | `FISH_AUDIO_API_TOKEN` |
| `audio-generation.ts` | ElevenLabs | `ELEVENLABS_API_KEY` |
| `formatting.ts` | OpenAI | `OPENAI_API_KEY` |
| `video-generation.ts` | AWS Orchestrator | `AWS_*` |

---

## 7. 運用事故防止ルール（SSOT）

### 7.1 project-editor.js の更新ルール

**現状（案A適用済み）:**
- ファイル名: `public/static/project-editor.js` （固定）
- 参照: `<script src="/static/project-editor.js?v=YYYYMMDDHHMM"></script>`
- キャッシュバスター: クエリパラメータで管理

**更新手順:**
1. `public/static/project-editor.js` を編集
2. `src/index.tsx` の `?v=` パラメータを現在日時に更新
3. **両方のファイルが変更されていることを確認してからコミット**

### 7.2 currentProject の参照ルール

**SSOT:** `window.currentProject` が唯一の正

```javascript
// ✅ 正しい更新方法
updateCurrentProject(newProject);

// ❌ 避けるべき方法（片方だけ更新）
currentProject = newProject;  // letで宣言された変数のみ更新
```

**実装位置:** `project-editor.js:1-18`

### 7.3 Scene Split の監視ルール

**SSOT:** `currentFormatRunId` で監視対象を識別

```javascript
// Format開始時にrun_idを保存
currentFormatRunId = response.data.run_id;

// ポーリング時にmismatchをチェック
if (data.run_id !== currentFormatRunId) {
  // 別のrunが開始された → 即座に停止
  clearInterval(formatPollingInterval);
}
```

**停止条件:**
- `status in ['formatted', 'failed', 'canceled']`
- `run_id mismatch`
- `10分タイムアウト`
- `ネットワークエラー3回連続`

**実装位置:** `project-editor.js:830-833, 1073-1090`

### 7.4 キャラクター特徴の優先順位

**SSOT:** `world-character-helper.ts:141`

```
C（シーン固有） > B（物語共通） > A（キャラ登録）

1. scene_override      (最高) ← シーン別オーバーライド（変身など）
2. story_traits        (高)   ← 物語から抽出された特徴
3. appearance_description (低) ← 手動設定の外見説明
```

**参照画像は常に併用:** 優先度に関わらず `reference_image_r2_url` は必ず送信

### 7.5 画像生成の参照画像ルール

**SSOT:** `character-reference-helper.ts`

```
最大枚数: 5枚（Gemini API制限）
優先順位: is_primary=1 → created_at順
```

**取得関数:** `getSceneReferenceImages(db, r2, sceneId)`

**使用箇所（全経路統一済み）:**
- 単体生成: `image-generation.ts:377-388`
- 旧バッチ生成: `image-generation.ts:98-140` ✅ 2026-01-20 統一完了
- 一括生成: `image-generation.ts:648-659`

**将来拡張（変身シーン対応）:**
変身シーンで参照画像が邪魔になる場合の逃げ道として、以下の拡張を想定：

```sql
-- scene_character_traits への追加カラム（未実装）
ALTER TABLE scene_character_traits ADD COLUMN reference_image_mode TEXT DEFAULT 'inherit';
-- 値: 'inherit' (デフォルト), 'disable' (参照画像無効化), 'override' (別画像を使用)
ALTER TABLE scene_character_traits ADD COLUMN override_reference_image_r2_url TEXT DEFAULT NULL;
```

現時点では仕様として明記のみ。実装は「妖精→人間」のような変身でキャラが維持されすぎる問題が発生した際に対応。

### 7.6 voice_presets coming_soon フィルタ

**対象ファイル:**
- `audio-ui.js:91-94` ✅ フィルタ適用済み
- `world-character-modal.js:348-350` ✅ フィルタ適用済み
- `project-editor.js` → ハードコードのため対象外

**フィルタ方法:**
```javascript
const presets = (data.voice_presets || []).filter(p => p.status !== 'coming_soon');
```

---

## 8. 運用ゲート検証チェックリスト

### Gate 1: 特徴3層（A/B/C）が効いているか

**テストシナリオ:**
1. キャラ登録(A): レン＝人間（appearance_description: "人間の青年"）
2. 物語(B): シーン1の台詞に「レンは妖精だった」→ story_traits 設定
3. シーン(C): シーン2だけ「レンは人間に変身、羽が消える」を scene_character_traits に設定

**期待結果:**
- シーン1生成画像: 妖精レン（BがAを上書き）
- シーン2生成画像: 人間レン・羽なし（CがBを上書き）
- シーン3生成画像: 妖精レン（Bに戻る）

**検証状態:** [ ] 未検証 / [ ] OK / [ ] NG

---

### Gate 2: 画像生成経路差分の事故がないか

**テストシナリオ:**
同じシーンに対して以下の3経路で生成し、キャラが飛ばないことを確認

| 経路 | エンドポイント | 検証状態 |
|------|---------------|----------|
| 単体生成 | `POST /scenes/:id/generate-image` | [ ] OK / [ ] NG |
| 旧バッチ生成 | `POST /projects/:id/generate-images` | [ ] OK / [ ] NG |
| 一括生成 | `POST /projects/:id/generate-all-images` | [ ] OK / [ ] NG |

**SSOT統一状況（2026-01-20 確認）:**
- 全3経路で `enhancePromptWithWorldAndCharacters` 使用: ✅
- 全3経路で `getSceneReferenceImages` 使用: ✅

---

### Gate 3: 参照画像の上限・優先順位が守られているか

**テストシナリオ:**
- 6人以上キャラ割当 → 参照画像は最大5枚で落ちないこと
- 優先順位: is_primary=1 が先、次に created_at 順

**検証状態:** [ ] 未検証 / [ ] OK / [ ] NG

---

## 9. 更新履歴

| 日付 | 内容 |
|------|------|
| 2026-01-19 | 初版作成（音声・キャラクター・Video Build・Scene Split・漫画） |
| 2026-01-20 | 運用事故防止ルール追加（SSOT 7項目） |
| 2026-01-20 | 旧バッチ生成にSSOT関数統一、運用ゲート検証チェックリスト追加 |
