# Audio SSOT (Single Source of Truth) - 完全仕様書

> 最終更新: 2026-02-18 (production schema 完全一致版)
> 対象: MARUMUVI (webapp) 音声サブシステム全体
> 
> **本仕様の CREATE TABLE 文は production DB (0001_full_schema_from_production.sql + 後続 migration) と 1:1 で一致する。**
> migration ファイルとの差分がある場合は本仕様が誤りであり、migration が正である。

---

## 1. 概要

### 1.1 SSOT の "唯一の真実" 3つ

| SSOT | テーブル | 何が正か |
|------|---------|---------|
| **SSOT-A: 発話** | `scene_utterances` | 何を・誰が・何番目に喋るか (text, role, order_no, character_key) |
| **SSOT-B: 音声実体** | `audio_generations` | 生成結果 (provider, voice_id, status, r2_key, r2_url, duration_ms) |
| **SSOT-C: 採用リンク** | `scene_utterances.audio_generation_id` | どの音声が採用されているか |

動画ビルドは最終的に **utterances → audio_generation_id → audio_generations.r2_url** のみを参照して Remotion へ渡す (`video-build-helpers.ts`)。

### 1.2 設計原則

1. **scene_utterances が発話の SSOT** — 丸投げも Builder も「台本→音声→動画」はここに収束
2. **audio_generations が音声ファイルの SSOT** — provider, status, r2_key/url はここだけが正
3. **リンクは 1:1** — `scene_utterances.audio_generation_id` → `audio_generations.id`
4. **provider は TEXT (enum lock なし)** — CHECK 制約なし、新プロバイダー追加時に DB 変更不要
5. **Voice Resolution は 3段階** — character preset > default narration voice > fallback
6. **動画ビルドは最終 audio URL を消費する** — utterance 変更時は必ずビデオリビルドが必要

---

## 2. テーブル仕様 (production schema 完全一致)

### 2.1 scene_utterances (SSOT-A: 発話テキスト・順序)

**Migration**: `0022_create_scene_utterances.sql`
**API SSOT**: `src/routes/utterances.ts`

```sql
-- 0022_create_scene_utterances.sql (production 完全一致)
CREATE TABLE IF NOT EXISTS scene_utterances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  scene_id INTEGER NOT NULL
    REFERENCES scenes(id) ON DELETE CASCADE,
  
  order_no INTEGER NOT NULL,
  
  role TEXT NOT NULL
    CHECK (role IN ('narration', 'dialogue')),
  
  character_key TEXT NULL,
  
  text TEXT NOT NULL,
  
  audio_generation_id INTEGER NULL
    REFERENCES audio_generations(id) ON DELETE SET NULL,
  
  duration_ms INTEGER NULL,
  
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scene_utterances_scene_order 
  ON scene_utterances(scene_id, order_no);

CREATE INDEX IF NOT EXISTS idx_scene_utterances_scene 
  ON scene_utterances(scene_id);

CREATE INDEX IF NOT EXISTS idx_scene_utterances_audio_generation 
  ON scene_utterances(audio_generation_id);

CREATE INDEX IF NOT EXISTS idx_scene_utterances_role 
  ON scene_utterances(role);
```

**運用ルール**:
- `role = 'dialogue'` → `character_key` は NOT NULL であるべき (アプリ層バリデーション)
- `role = 'narration'` → `character_key` は NULL であるべき
- `text` は空文字列不可 (trim 後に検証)
- `audio_generation_id` が SET NULL になった場合 → `duration_ms` もリセットすべき
- `order_no` の採番: INSERT 時に `MAX(order_no) + 1`
- reorder 時: 全 utterance の order_no をバッチ更新

### 2.2 audio_generations (SSOT-B: 音声ファイル・生成状態)

**Origin**: `0001_full_schema_from_production.sql` (lines 332-351)
**追加 migration**: `0009_create_audio_generations.sql` (0001 に統合済み — 新環境では 0001 が正)

```sql
-- 0001_full_schema_from_production.sql (production 完全一致)
CREATE TABLE IF NOT EXISTS audio_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  voice_id TEXT NOT NULL,
  model TEXT,
  format TEXT NOT NULL DEFAULT 'mp3',
  sample_rate INTEGER DEFAULT 24000,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  r2_key TEXT,
  r2_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  duration_ms INTEGER,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);

-- 0001 indexes
CREATE INDEX IF NOT EXISTS idx_audio_generations_scene_id 
  ON audio_generations(scene_id);

-- 0009 indexes (0001作成後に追加された可能性あり)
CREATE INDEX IF NOT EXISTS idx_audio_generations_scene_active
  ON audio_generations(scene_id, is_active);

CREATE INDEX IF NOT EXISTS idx_audio_generations_status
  ON audio_generations(status);
```

**重要: 0001 vs 0009 の差分**:
- 0001 には `user_id` と `duration_ms` がある (production schema に後から追加された)
- 0009 にはそれらがない (0009 は 0001 より前に作られた migration)
- **production の真実は 0001** — 新環境構築時は 0001 を使う

**Status Transitions**:
```
pending → generating → completed
                    └→ failed
```
- `completed` レコードは **イミュータブル** — 再生成時は新 record を INSERT、古いものは `is_active=0`
- `failed` → 再生成時も新 record を INSERT

### 2.3 projects テーブル (settings_json 部分のみ)

**Origin**: `0001_full_schema_from_production.sql` (lines 73-96)
**追加 migration**: `0047_add_projects_settings_json.sql`

```sql
-- 0001 の projects 定義 (音声関連カラムのみ抜粋)
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  -- ... 他カラム省略 ...
  settings_json TEXT DEFAULT '{}',    -- 0047 で追加
  output_preset TEXT DEFAULT 'yt_long',  -- 0035 で追加
  split_mode TEXT DEFAULT 'raw',      -- 0045 で追加
  target_scene_count INTEGER DEFAULT 5, -- 0045 で追加
  is_deleted INTEGER NOT NULL DEFAULT 0, -- 0052 で追加
  deleted_at DATETIME,                -- 0052 で追加
  -- ... 他カラム省略 ...
);
```

**settings_json の音声関連キー (確定)**:

```json
{
  "default_narration_voice": {
    "provider": "google",
    "voice_id": "ja-JP-Neural2-B"
  },
  "character_voices": {
    "<character_key>": { "provider": "elevenlabs", "voice_id": "el-aria" }
  },
  "output_preset": "youtube_short",
  "marunage_mode": true,
  "telops_comic": { "style_preset": "outline", "size_preset": "md", "position_preset": "bottom" },
  "telops_remotion": { "enabled": true, "style_preset": "outline", ... }
}
```

**コード根拠** (キー名 `default_narration_voice` の確定):
| ファイル | 行 | 使い方 |
|---------|-----|-------|
| `src/routes/marunage.ts` | 1249 | `settings.default_narration_voice = { provider, voice_id }` (書き込み) |
| `src/routes/marunage.ts` | 1738 | `default_narration_voice: narrationVoice` (初期設定) |
| `src/routes/marunage.ts` | 2098 | `sj.default_narration_voice` (読み取り) |
| `src/routes/audio-generation.ts` | 177 | `settings.default_narration_voice.voice_id` (voice 解決) |
| `src/routes/audio-generation.ts` | 179 | `settings.default_narration_voice.provider` (voice 解決) |
| `src/routes/bulk-audio.ts` | 105 | `projectSettings.default_narration_voice.voice_id` (bulk voice 解決) |
| `public/static/marunage-chat.js` | 30 | `MC.selectedVoice = { provider: 'google', voice_id: 'ja-JP-Neural2-B' }` |

### 2.4 project_character_models (キャラクター音声設定)

**Origin**: `0001_full_schema_from_production.sql` (lines 191-208)

```sql
-- 0001_full_schema_from_production.sql (production 完全一致)
CREATE TABLE IF NOT EXISTS project_character_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  character_key TEXT NOT NULL,
  character_name TEXT NOT NULL,
  description TEXT,
  appearance_description TEXT,
  reference_image_r2_key TEXT,
  reference_image_r2_url TEXT,
  voice_preset_id TEXT,                           -- ★ キャラ声の SSOT
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  aliases_json TEXT NULL,                         -- 0011 で追加
  story_traits TEXT,                              -- 0021 で追加
  style_preset_id INTEGER REFERENCES style_presets(id),  -- 0046 で追加
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, character_key)
);
```

**Provider 推定ルール** (voice_preset_id → provider, prefix convention):
```
'el-'        / 'elevenlabs:' → provider = 'elevenlabs'
'fish-'      / 'fish:'       → provider = 'fish'
それ以外                      → provider = 'google'
```

### 2.5 project_audio_jobs (一括音声生成ジョブ)

**Migration**: `0049_create_project_audio_jobs.sql`

```sql
-- 0049_create_project_audio_jobs.sql (production 完全一致)
CREATE TABLE IF NOT EXISTS project_audio_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  
  mode TEXT NOT NULL CHECK (mode IN ('missing', 'pending', 'all')),
  force_regenerate INTEGER NOT NULL DEFAULT 0,
  narration_provider TEXT DEFAULT 'google',
  narration_voice_id TEXT DEFAULT 'ja-JP-Neural2-B',
  
  status TEXT NOT NULL DEFAULT 'queued' 
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'canceled')),
  
  total_utterances INTEGER NOT NULL DEFAULT 0,
  processed_utterances INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  
  last_error TEXT,
  error_details_json TEXT,
  
  locked_until DATETIME,
  
  started_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_audio_jobs_project_status 
  ON project_audio_jobs(project_id, status);

CREATE INDEX IF NOT EXISTS idx_project_audio_jobs_status_locked 
  ON project_audio_jobs(status, locked_until);
```

**Idempotency**: 同一 project_id に `status = 'queued' | 'running'` のジョブが存在 → 409 Conflict

### 2.6 project_audio_tracks (通し BGM)

**Migration**: `0029_create_project_audio_tracks.sql`

```sql
-- 0029_create_project_audio_tracks.sql (production 完全一致)
CREATE TABLE IF NOT EXISTS project_audio_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  track_type TEXT NOT NULL DEFAULT 'bgm',
  r2_key TEXT,
  r2_url TEXT,
  duration_ms INTEGER,
  volume REAL NOT NULL DEFAULT 0.25,
  loop INTEGER NOT NULL DEFAULT 1,
  fade_in_ms INTEGER NOT NULL DEFAULT 800,
  fade_out_ms INTEGER NOT NULL DEFAULT 800,
  ducking_enabled INTEGER NOT NULL DEFAULT 0,
  ducking_volume REAL NOT NULL DEFAULT 0.12,
  ducking_attack_ms INTEGER NOT NULL DEFAULT 120,
  ducking_release_ms INTEGER NOT NULL DEFAULT 220,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_audio_tracks_project 
  ON project_audio_tracks(project_id);
CREATE INDEX IF NOT EXISTS idx_project_audio_tracks_active 
  ON project_audio_tracks(project_id, is_active);
```

**Rules**: 各プロジェクトにつき `is_active=1` は最大1つ

### 2.7 scene_audio_assignments (シーン別 BGM/SFX)

**Migration**: `0041_create_scene_audio_assignments.sql`

```sql
-- 0041_create_scene_audio_assignments.sql (production 完全一致)
CREATE TABLE IF NOT EXISTS scene_audio_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  audio_library_type TEXT NOT NULL CHECK (audio_library_type IN ('system', 'user', 'direct')),
  system_audio_id INTEGER REFERENCES system_audio_library(id),
  user_audio_id INTEGER REFERENCES user_audio_library(id),
  direct_r2_key TEXT,
  direct_r2_url TEXT,
  direct_name TEXT,
  direct_duration_ms INTEGER,
  audio_type TEXT NOT NULL CHECK (audio_type IN ('bgm', 'sfx')),
  start_ms INTEGER NOT NULL DEFAULT 0,
  end_ms INTEGER,
  volume_override REAL,
  loop_override INTEGER,
  fade_in_ms_override INTEGER,
  fade_out_ms_override INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Rules**:
- 1シーン BGM (`audio_type='bgm'`) は `is_active=1` が最大1つ
- SFX (`audio_type='sfx'`) は複数可、`start_ms` で再生位置指定

---

## 3. Voice Resolution (音声解決) 仕様

### 3.1 優先順位 (SSOT: resolveVoiceForUtterance)

**実装ファイル**: `src/routes/bulk-audio.ts:78-123`

```
Priority 1: Character Voice (dialogue のみ)
  ├─ utterance.role === 'dialogue' && utterance.character_key != null
  ├─ DB: project_character_models WHERE project_id = ? AND character_key = ?
  └─ → voice_preset_id → provider推定 (prefix convention)

Priority 2: Project Default Narration Voice
  ├─ DB: projects.settings_json → .default_narration_voice
  ├─ { provider: string, voice_id: string }
  └─ provider未設定時は voice_id の prefix から推定

Priority 3: Ultimate Fallback
  └─ { provider: 'google', voiceId: 'ja-JP-Neural2-B' }
```

### 3.2 resolveVoice の実装箇所 (丸投げ + Builder 両方)

| File | Location | 用途 |
|------|----------|------|
| `src/routes/bulk-audio.ts:78` | `resolveVoiceForUtterance()` | 一括生成時の voice 解決 (**正規 SSOT**) |
| `src/routes/audio-generation.ts:134` | inline resolution | 単一シーン生成時の voice 解決 |
| `src/routes/marunage.ts:1238-1239` | config extraction | 丸投げからの voice 取得 |

**注意**: 丸投げと Builder で `resolveVoice` がそれぞれ独立実装されている。
→ **要改善**: 共通 util に統一すべき (矛盾が起きやすい点 §7.2)

### 3.3 新プロバイダー追加時の手順

1. `src/utils/NEW_PROVIDER.ts` を作成 (TTS クライアント)
2. `src/routes/audio-generation.ts` の generateTTS 関数に provider 分岐を追加
3. `src/routes/audio-generation.ts` の GET `/tts/voices` に声一覧を追加
4. prefix convention に新 prefix を追加 (e.g., `riva:`, `openai:`)
5. `resolveVoiceForUtterance()` の prefix 判定に分岐を追加
6. DB migration **不要** (`audio_generations.provider` は TEXT 型, CHECK 制約なし)
7. フロントエンド: `mcLoadVoices()` に自動反映 (`/tts/voices` から動的取得)
8. 環境変数: `NEW_PROVIDER_API_KEY` を `.dev.vars` / `wrangler secret put` に追加

---

## 4. API Contracts (API 契約 — 現行ルート完全準拠)

### 4.1 Utterance CRUD: `src/routes/utterances.ts`

| Method | Path | Description | Source |
|--------|------|-------------|--------|
| GET | `/api/scenes/:sceneId/utterances` | シーンの発話一覧 | L85 |
| POST | `/api/scenes/:sceneId/utterances` | 発話追加 (order_no 自動採番) | L209 |
| PUT | `/api/utterances/:utteranceId` | 発話テキスト/role/character_key 編集 | L342 |
| DELETE | `/api/utterances/:utteranceId` | 発話削除 (audio は孤立, 削除しない) | L491 |
| PUT | `/api/scenes/:sceneId/utterances/reorder` | 発話並べ替え | L543 |
| POST | `/api/utterances/:utteranceId/generate-audio` | 発話単位の音声生成 (P-5 で使用) | L610 |

**generate-audio の flow**:
1. utterance の text を取得
2. `force=false` かつ既存 completed audio → skip (reuse)
3. voice 解決 (explicit > character > project_default > fallback)
4. `audio_generations` に INSERT (`status='generating'`)
5. `scene_utterances.audio_generation_id` を UPDATE
6. TTS API 呼び出し → R2 に保存
7. `status` → `'completed'`, `r2_key`/`r2_url` 更新
8. `scene_utterances.duration_ms` にキャッシュ

### 4.2 Bulk Audio: `src/routes/bulk-audio.ts`

| Method | Path | Description | Source |
|--------|------|-------------|--------|
| POST | `/api/projects/:projectId/audio/bulk-generate` | 一括音声生成 | L554 |
| GET | `/api/projects/:projectId/audio/bulk-status` | ジョブ進捗 | L682 |
| POST | `/api/projects/:projectId/audio/bulk-cancel` | キャンセル | L772 |
| GET | `/api/projects/:projectId/audio/bulk-history` | 履歴 | L821 |

**bulk-generate の flow**: `resolveVoiceForUtterance()` → `generateSingleUtteranceAudio()` (utterance 単位)

### 4.3 Scene Audio (single): `src/routes/audio-generation.ts`

| Method | Path | Description | Source |
|--------|------|-------------|--------|
| POST | `/api/scenes/:id/generate-audio` | 単一シーン音声生成 | L99 |
| GET | `/api/scenes/:id/audio` | シーンの音声一覧 | L360 |
| POST | `/api/audio/:audioId/activate` | 音声アクティブ化 | L388 |
| DELETE | `/api/audio/:audioId` | 音声削除 | L442 |
| POST | `/api/tts/preview` | プレビュー | L801 |
| GET | `/api/tts/voices` | 全プロバイダーの声一覧 | L942 |
| GET | `/api/tts/usage` | TTS使用量 | L1015 |
| GET | `/api/tts/usage/check` | 使用量チェック | L1106 |
| POST | `/api/audio/fix-durations` | duration修正バッチ | L1158 |

### 4.4 TTS Providers (現在3つ)

| Provider | util file | API | 声の数 | 特徴 |
|----------|-----------|-----|--------|------|
| **Google TTS** | inline in audio-generation.ts | `texttospeech.googleapis.com/v1` | 8声 + Neural2-B | デフォルト |
| **ElevenLabs** | `src/utils/elevenlabs.ts` (274行) | `api.elevenlabs.io/v1` | 6声 | Multilingual v2 |
| **Fish Audio** | `src/utils/fish-audio.ts` (133行) | `api.fish.audio/v1/tts` | 1声 | reference_id 方式 |

---

## 5. 動画ビルド側の音声参照 (依存関係)

### 5.1 正規の参照線

```
scene_utterances
  ↓ audio_generation_id
audio_generations (status='completed', r2_url NOT NULL)
  ↓ r2_url (絶対URL)
video-generation.ts (L1859-1863):
  voiceUrls = utterances
    .filter(u => u.audio_url && u.audio_status === 'completed')
    .map(u => u.audio_url)
  ↓
buildProjectJson() → project.json → Remotion Lambda
```

**重要**: video build は `audio_generations.is_active` を勝手に探しに行かない。
`utterance → audio_generation_id → r2_url` だけが正規の参照線。

### 5.2 二重パスの問題 (要修正候補)

`buildBuildRequestV1()` (`video-build-helpers.ts:1199`):
```typescript
// v1 パス: active_audio (レガシー, scene 単位)
const audio = scene.active_audio?.audio_url
  ? { voice: { audio_url: scene.active_audio.audio_url, speed: 1.0 } }
  : undefined;
```

`video-generation.ts` preflight (`L1859`):
```typescript
// v1.5 パス: utterances (新, utterance 単位)
const voiceUrls = s.utterances
  .filter(u => u.audio_url && u.audio_status === 'completed')
  .map(u => u.audio_url)
```

→ 2つのパスが並行して存在。統一が必要。

### 5.3 BGM の参照

```
project_audio_tracks (is_active=1)
  → buildProjectJson() → audio_global.bgm

scene_audio_assignments (is_active=1)
  → buildProjectJson() → scenes[].sfx[]
```

---

## 6. 丸投げチャット側の音声フロー

### 6.1 フロント → サーバ

```
marunage-chat.js:
  MC.selectedVoice = { provider: 'google', voice_id: 'ja-JP-Neural2-B' }
    ↓ (run 開始時に送信)
  POST /api/marunage/start { narration_voice: MC.selectedVoice }
    ↓
marunage.ts:
  narrationVoice = { provider, voice_id }
    ↓
  projects.settings_json.default_narration_voice = narrationVoice
    ↓
  bulk-audio の resolveVoice が settings_json を参照
```

### 6.2 mcLoadVoices()

`public/static/marunage-chat.js:4632` — `/api/tts/voices` を fetch し、Google / ElevenLabs / Fish のタブで一覧表示。

---

## 7. 矛盾が起きやすい点 (要注意・次の改善候補)

### 7.1 utterance text 更新時の音声不一致

**現状**: text 更新後に `generate-audio(force)` を呼ぶ運用で解決。
**事故要因**: text だけ変えて音声を再生成しないとズレる。
**対策案**: PUT `utterance.text` の時点で `audio_generation_id=null` にするオプション (フラグ運用)。
**フロント側**: `MC._dirtyChanges` でダーティフラグ管理 → リビルド前モーダルで確認。

### 7.2 丸投げ/Builder で resolveVoice がズレる可能性

**現状**: `bulk-audio.ts:78` と `audio-generation.ts:134` に同一ロジックが独立実装。
**対策**: `resolveVoiceForUtterance` を共通 util (`src/utils/voice-resolution.ts`) に切り出す。

### 7.3 buildBuildRequestV1 と preflight の voice パス不整合

**現状**: §5.2 の通り `active_audio` パス (v1) と `utterances` パス (v1.5) が並行。
**対策**: v1 パスを deprecate し、全て utterances パスに統一。

---

## 8. 禁止ルール (Forbidden Rules)

### 8.1 DB レベル

| Rule | Reason |
|------|--------|
| ❌ `audio_generations.provider` に CHECK 制約を追加しない | 新プロバイダー追加時に migration 不要を維持 |
| ❌ `scene_utterances.audio_generation_id` を CASCADE DELETE にしない | 音声履歴保持のため (SET NULL が正) |
| ❌ 同一 scene に同一 order_no の utterance を2つ許可しない | UNIQUE 制約で保護済み |
| ❌ `is_active` を複数 record に同時に 1 にしない (BGM 系) | 1プロジェクト/1シーンに BGM は最大1つ |

### 8.2 アプリケーションレベル

| Rule | Reason |
|------|--------|
| ❌ 音声生成中 (`status='generating'`) の utterance に DELETE/UPDATE しない | 競合防止 |
| ❌ `audio_generations` の completed レコードを UPDATE しない | イミュータブル設計 |
| ❌ フロントで直接 TTS API を呼ばない | API キー漏洩防止 |
| ❌ `settings_json.default_narration_voice` を文字列にしない | 常に `{ provider, voice_id }` オブジェクト |
| ❌ 動画ビルド中に utterance テキストを変更しない | ビルド成果物との不整合防止 |
| ❌ bulk-audio job running 中に同一プロジェクトの新 job 作成しない | 409 で保護済み |

---

## 9. テストケース

### 9.1 Voice Resolution

```
TC-VR-01: dialogue + character voice → character の voice_preset_id が使われる
  Given: role='dialogue', character_key='char_a',
         project_character_models.voice_preset_id='el-aria'
  Then: provider='elevenlabs', voiceId='el-aria', source='character'

TC-VR-02: dialogue + character voice なし → project default
  Given: role='dialogue', character_key='char_b',
         voice_preset_id=NULL,
         settings_json.default_narration_voice = { provider:'fish', voice_id:'fish:nanamin' }
  Then: provider='fish', voiceId='fish:nanamin', source='project_default'

TC-VR-03: narration → project default
  Given: role='narration',
         default_narration_voice = { provider:'google', voice_id:'ja-JP-Wavenet-A' }
  Then: provider='google', voiceId='ja-JP-Wavenet-A', source='project_default'

TC-VR-04: narration + project default なし → fallback
  Given: role='narration', settings_json = {}
  Then: provider='google', voiceId='ja-JP-Neural2-B', source='fallback'

TC-VR-05: prefix 推定
  'el-adam'         → elevenlabs
  'elevenlabs:xxx'  → elevenlabs
  'fish:nanamin'    → fish
  'fish-custom'     → fish
  'ja-JP-Standard-A' → google
```

### 9.2 Utterance CRUD

```
TC-UT-01: POST → order_no 自動採番 (MAX + 1)
TC-UT-02: DELETE → audio_generation は孤立 (削除されない)
TC-UT-03: PUT text → audio は自動無効化されない (意図的仕様)
TC-UT-04: Reorder → order_no 1-based 再採番
```

### 9.3 Bulk Audio

```
TC-BA-01: mode='missing' → completed 音声ある utterance はスキップ
TC-BA-02: 既存 running job → 409 Conflict
TC-BA-03: force_regenerate=true → 全 utterance 再生成 (新 audio INSERT)
```

---

## 10. PersonaPlex-7B 統合判定

### 10.1 事実

PersonaPlex-7B は **Audio-to-Audio (S2S) モデル** であり、TTS ではない。
(ref: https://huggingface.co/nvidia/personaplex-7b-v1/tree/main)

- 入力: WAV (24kHz) + テキストプロンプト + 音声プロンプト
- 出力: WAV (24kHz) + テキスト
- 訓練データ: Fisher English (<10,000h) — **英語のみ**

### 10.2 統合オプション

| Option | 方式 | 推奨 | 理由 |
|--------|------|------|------|
| **A** | 擬似TTS: text → 既存TTS → PersonaPlex で自然化 | ❌ | 2段階処理、コスト2倍、英語のみ |
| **B** | リアルタイムチャット/音声UI専用 | ⚠️ | コア機能に影響なし、英語対応時に再検討 |

### 10.3 PoC 計画 (やるなら)

**PoC-1**: ローカル GPU (A100) で text → (Google TTS → WAV) → PersonaPlex → WAV の品質検証
**判定基準**: 日本語入力で出力が崩壊しないか、RTF、主観音質

---

## 付録A: 環境変数 (音声関連)

```
GOOGLE_TTS_API_KEY        — Google TTS API キー (GEMINI_API_KEY でも可)
ELEVENLABS_API_KEY        — ElevenLabs API キー
FISH_AUDIO_API_TOKEN      — Fish Audio API トークン
ELEVENLABS_DEFAULT_MODEL  — デフォルトモデル (eleven_multilingual_v2)
```

## 付録B: ファイル構成 (音声関連)

```
src/routes/audio-generation.ts  — 単一音声生成 + voices一覧 + usage
src/routes/bulk-audio.ts        — 一括音声生成 + resolveVoiceForUtterance (SSOT)
src/routes/utterances.ts        — 発話CRUD + generate-audio
src/routes/marunage.ts          — 丸投げチャット (narration_voice → settings_json)
src/utils/fish-audio.ts         — Fish Audio TTS クライアント
src/utils/elevenlabs.ts         — ElevenLabs TTS クライアント
src/utils/video-build-helpers.ts — buildBuildRequestV1 / buildProjectJson
src/routes/video-generation.ts  — preflight voice_urls 収集
public/static/marunage-chat.js  — フロントエンド (mcLoadVoices, mcSelectVoice 等)
```

## 付録C: Migration 一覧 (音声関連)

| # | File | 内容 | 対象テーブル |
|---|------|------|------------|
| 0001 | full_schema_from_production | 本番DB全体 (audio_generations 含む) | audio_generations + 全テーブル |
| 0009 | create_audio_generations | TTS音声 (0001 に統合済み、新環境では不要) | audio_generations |
| 0018 | create_tts_usage_logs | TTS使用量追跡 | tts_usage_logs |
| 0022 | create_scene_utterances | 発話SSOT (R1.5) | scene_utterances |
| 0029 | create_project_audio_tracks | 通しBGM | project_audio_tracks |
| 0039 | create_system_audio_library | システムBGM/SFXライブラリ | system_audio_library |
| 0040 | create_user_audio_library | ユーザーBGM/SFXライブラリ | user_audio_library |
| 0041 | create_scene_audio_assignments | シーン別BGM/SFX割当 | scene_audio_assignments |
| 0047 | add_projects_settings_json | settings_json カラム追加 | projects |
| 0048 | add_bgm_timeline_columns | BGMタイムラインカラム | (BGM拡張) |
| 0049 | create_project_audio_jobs | 一括音声生成ジョブ | project_audio_jobs |
