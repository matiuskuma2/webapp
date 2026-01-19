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

## 7. 更新履歴

| 日付 | 内容 |
|------|------|
| 2026-01-19 | 初版作成（音声・キャラクター・Video Build・Scene Split・漫画） |
