# Audio SSOT (Single Source of Truth) - 完全仕様書

> 最終更新: 2026-02-17
> 対象: MARUMUVI (webapp) 音声サブシステム全体

---

## 1. 概要

本仕様書は MARUMUVI の音声サブシステムの **唯一の真実源 (SSOT)** を定義する。
すべての音声関連コード変更は本仕様に従うこと。

### 1.1 設計原則

1. **scene_utterances が発話の SSOT** — テキスト、話者、順序はここだけが正
2. **audio_generations が音声ファイルの SSOT** — provider、status、r2_key/url はここだけが正
3. **リンクは 1:1** — `scene_utterances.audio_generation_id` → `audio_generations.id`
4. **provider は TEXT (enum lock なし)** — 新プロバイダー追加時に DB 変更不要
5. **Voice Resolution は 3段階** — utterance override > character preset > default narration voice > fallback
6. **動画ビルドは最終 audio URL を消費する** — utterance 変更時は必ずビデオリビルドが必要

---

## 2. テーブル仕様

### 2.1 scene_utterances (SSOT: 発話テキスト・順序)

**Migration**: `0022_create_scene_utterances.sql`

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | INTEGER | NO | AUTOINCREMENT | PK |
| `scene_id` | INTEGER | NO | - | FK → `scenes(id)` ON DELETE CASCADE |
| `order_no` | INTEGER | NO | - | 表示・再生順序 (1-based) |
| `role` | TEXT | NO | - | `'narration'` \| `'dialogue'` |
| `character_key` | TEXT | YES | NULL | dialogue 時のみ必須。`scene_character_map.character_key` と対応 |
| `text` | TEXT | NO | - | 発話テキスト（字幕にも使用） |
| `audio_generation_id` | INTEGER | YES | NULL | FK → `audio_generations(id)` ON DELETE SET NULL |
| `duration_ms` | INTEGER | YES | NULL | キャッシュ: リンク先 audio の尺 (ms) |
| `created_at` | DATETIME | NO | CURRENT_TIMESTAMP | - |
| `updated_at` | DATETIME | NO | CURRENT_TIMESTAMP | - |

**Indexes**:
- `UNIQUE (scene_id, order_no)` — 同一シーン内で order_no は一意
- `idx_scene_utterances_scene_id (scene_id)` — シーン検索用
- `idx_scene_utterances_audio_gen (audio_generation_id)` — 音声逆引き
- `idx_scene_utterances_role (role)` — role 統計用

**Constraints & Rules**:
- `role = 'dialogue'` の時、`character_key` は NOT NULL であるべき（アプリレベル制約）
- `role = 'narration'` の時、`character_key` は NULL であるべき
- `text` は空文字列不可（アプリレベル制約、trim 後に検証）
- `audio_generation_id` が SET NULL になった場合、`duration_ms` もリセットすべき
- `order_no` の採番: INSERT 時に `MAX(order_no) + 1` で付与
- reorder 時: 全 utterance の order_no をバッチ更新

### 2.2 audio_generations (SSOT: 音声ファイル・生成状態)

**Migration**: `0009_create_audio_generations.sql`

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | INTEGER | NO | AUTOINCREMENT | PK |
| `scene_id` | INTEGER | NO | - | FK → `scenes(id)` (実質的なスコープ) |
| `provider` | TEXT | NO | `'google'` | `'google'` \| `'elevenlabs'` \| `'fish'` \| (将来: 任意文字列) |
| `voice_id` | TEXT | YES | NULL | provider 固有の voice identifier |
| `model` | TEXT | YES | NULL | 使用モデル名 (e.g., `'eleven_multilingual_v2'`) |
| `format` | TEXT | NO | `'mp3'` | 出力形式 |
| `sample_rate` | INTEGER | NO | `24000` | サンプルレート (Google: 24000, Fish: 44100) |
| `text` | TEXT | YES | NULL | 生成時のテキスト（デバッグ用、SSOT はuttで管理） |
| `status` | TEXT | NO | `'pending'` | `'pending'` \| `'generating'` \| `'completed'` \| `'failed'` |
| `error_message` | TEXT | YES | NULL | 失敗時のエラー詳細 |
| `r2_key` | TEXT | YES | NULL | R2 オブジェクトキー |
| `r2_url` | TEXT | YES | NULL | R2 公開URL（CloudFront化の候補） |
| `is_active` | INTEGER | NO | `0` | 1 = アクティブ（レガシー: scene 単位の active 音声） |
| `created_at` | DATETIME | NO | CURRENT_TIMESTAMP | - |
| `updated_at` | DATETIME | NO | CURRENT_TIMESTAMP | - |

**Indexes**:
- `idx_audio_generations_scene (scene_id, created_at DESC)` — シーン別の最新音声取得
- `idx_audio_generations_active (scene_id, is_active)` — アクティブ音声検索
- `idx_audio_generations_status (status)` — ジョブ監視用

**Status Transitions**:
```
pending → generating → completed
                    └→ failed
```
- `completed` → 再生成不可（新 record を INSERT、古いものは is_active=0 のまま残す）
- `failed` → 再生成時は新 record を INSERT

**Provider 拡張ルール**:
- `provider` は TEXT 型で CHECK 制約なし → 新プロバイダー追加時に DB migration 不要
- provider prefix convention: `google:`, `elevenlabs:` / `el-`, `fish:` / `fish-`
- 将来: `personaplex:`, `riva:`, `openai:` など

### 2.3 projects.settings_json — デフォルトナレーション音声

**キー名 (確定)**: `default_narration_voice`

```json
{
  "default_narration_voice": {
    "provider": "google",          // 'google' | 'elevenlabs' | 'fish' | ...
    "voice_id": "ja-JP-Neural2-B"  // provider 固有の voice identifier
  },
  "output_preset": "youtube_short",
  "marunage_mode": true,
  "character_voices": {
    "char_a": { "provider": "elevenlabs", "voice_id": "el-aria" },
    "char_b": { "provider": "fish", "voice_id": "fish:nanamin" }
  },
  "telops_comic": { ... },
  "telops_remotion": { ... }
}
```

**確定根拠** (実コード参照):
- `src/routes/audio-generation.ts:177` — `settings.default_narration_voice.voice_id`
- `src/routes/audio-generation.ts:179` — `settings.default_narration_voice.provider`
- `src/routes/bulk-audio.ts:105` — `projectSettings.default_narration_voice.voice_id`
- `src/routes/marunage.ts:1249` — `settings.default_narration_voice = { provider, voice_id }`
- `src/routes/marunage.ts:1738` — `default_narration_voice: narrationVoice`
- `src/routes/marunage.ts:2098` — `sj.default_narration_voice`
- `public/static/marunage-chat.js:30` — `MC.selectedVoice = { provider: 'google', voice_id: 'ja-JP-Neural2-B' }`

### 2.4 project_character_models.voice_preset_id — キャラクター音声

**Migration**: `0001_full_schema_from_production.sql` (line 200)

| Column | Type | Description |
|--------|------|-------------|
| `voice_preset_id` | TEXT, nullable | キャラクター専用の voice ID |

**Provider 推定ルール** (prefix convention):
```
voice_preset_id starts with 'el-' or 'elevenlabs:' → provider = 'elevenlabs'
voice_preset_id starts with 'fish-' or 'fish:'     → provider = 'fish'
else                                                → provider = 'google'
```

**関連コード**:
- `src/routes/bulk-audio.ts:84-101` — `resolveVoiceForUtterance` の Priority 1
- `src/routes/audio-generation.ts:148-165` — scene 単位の voice 自動解決
- `src/routes/marunage.ts:1720-1733` — キャラ音声マップ構築

### 2.5 project_audio_jobs (SSOT: 一括音声生成ジョブ)

**Migration**: `0049_create_project_audio_jobs.sql`

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | INTEGER | NO | AUTOINCREMENT | PK |
| `project_id` | INTEGER | NO | - | FK → `projects(id)` |
| `mode` | TEXT | YES | NULL | `'missing'` \| `'pending'` \| `'all'` |
| `force_regenerate` | INTEGER | YES | 0 | 1 = 既存完了音声も再生成 |
| `narration_provider` | TEXT | YES | NULL | ジョブ指定のプロバイダー |
| `narration_voice_id` | TEXT | YES | NULL | ジョブ指定の voice ID |
| `status` | TEXT | NO | - | `'queued'` \| `'running'` \| `'completed'` \| `'failed'` \| `'canceled'` |
| `total_utterances` | INTEGER | YES | 0 | 対象 utterance 数 |
| `processed_utterances` | INTEGER | YES | 0 | 処理済み数 |
| `success_count` | INTEGER | YES | 0 | 成功数 |
| `failed_count` | INTEGER | YES | 0 | 失敗数 |
| `skipped_count` | INTEGER | YES | 0 | スキップ数 |
| `last_error` | TEXT | YES | NULL | 最後のエラー |
| `error_details_json` | TEXT | YES | NULL | 全エラー JSON |
| `locked_until` | DATETIME | YES | NULL | 排他ロック期限 |
| `started_by_user_id` | INTEGER | YES | NULL | 実行ユーザー |
| `created_at` | DATETIME | NO | CURRENT_TIMESTAMP | - |
| `started_at` | DATETIME | YES | NULL | 実行開始時刻 |
| `completed_at` | DATETIME | YES | NULL | 完了時刻 |
| `updated_at` | DATETIME | NO | CURRENT_TIMESTAMP | - |

**Idempotency Rules**:
- 同一 project_id に対して `status = 'queued' | 'running'` のジョブが存在する場合、新規作成は 409 Conflict
- `locked_until` でデッドロック防止（5分タイムアウト）

### 2.6 project_audio_tracks (SSOT: 通し BGM)

**Migration**: `0029_create_project_audio_tracks.sql`

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | INTEGER | AUTOINCREMENT | PK |
| `project_id` | INTEGER | - | FK → `projects(id)` |
| `track_type` | TEXT | `'bgm'` | 現在 'bgm' のみ |
| `r2_key` | TEXT | NULL | R2 オブジェクトキー |
| `r2_url` | TEXT | NULL | R2 公開URL |
| `duration_ms` | INTEGER | NULL | BGM の尺 |
| `volume` | REAL | `0.25` | 0.0 - 1.0 |
| `loop` | INTEGER | `1` | 0/1 |
| `fade_in_ms` | INTEGER | `800` | - |
| `fade_out_ms` | INTEGER | `800` | - |
| `ducking_enabled` | INTEGER | `0` | 将来用 |
| `ducking_volume` | REAL | `0.12` | ダッキング時音量 |
| `ducking_attack_ms` | INTEGER | `120` | - |
| `ducking_release_ms` | INTEGER | `220` | - |
| `is_active` | INTEGER | `1` | 1 = 現在の有効BGM |

**Rules**: 各プロジェクトにつき `is_active=1` は最大1つ

### 2.7 scene_audio_assignments (SSOT: シーン別 BGM/SFX)

**Migration**: `0041_create_scene_audio_assignments.sql`

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | INTEGER | AUTOINCREMENT | PK |
| `scene_id` | INTEGER | - | FK → `scenes(id)` |
| `audio_library_type` | TEXT | - | `'system'` \| `'user'` \| `'direct'` |
| `system_audio_id` | INTEGER | NULL | FK → `system_audio_library(id)` |
| `user_audio_id` | INTEGER | NULL | FK → `user_audio_library(id)` |
| `direct_r2_key` | TEXT | NULL | 直接アップロード用 |
| `direct_r2_url` | TEXT | NULL | - |
| `direct_name` | TEXT | NULL | - |
| `direct_duration_ms` | INTEGER | NULL | - |
| `audio_type` | TEXT | - | `'bgm'` \| `'sfx'` |
| `start_ms` | INTEGER | `0` | シーン内開始時刻 |
| `end_ms` | INTEGER | NULL | 終了時刻 (NULL = シーン末尾) |
| `volume_override` | REAL | NULL | - |
| `loop_override` | INTEGER | NULL | - |
| `fade_in_ms_override` | INTEGER | NULL | - |
| `fade_out_ms_override` | INTEGER | NULL | - |
| `is_active` | INTEGER | `1` | - |

**Rules**:
- 1シーンにつき BGM (`audio_type='bgm'`) は `is_active=1` が最大1つ
- SFX (`audio_type='sfx'`) は複数可、`start_ms` で再生位置を指定

---

## 3. Voice Resolution (音声解決) 仕様

### 3.1 優先順位 (SSOT: resolveVoiceForUtterance)

```
Priority 1: Character Voice (dialogue のみ)
  ├─ utterance.role === 'dialogue' && utterance.character_key != null
  ├─ DB: project_character_models WHERE project_id = ? AND character_key = ?
  └─ → voice_preset_id → provider推定 (prefix convention)

Priority 2: Project Default Narration Voice
  ├─ DB: projects.settings_json → JSON.parse() → .default_narration_voice
  ├─ { provider: string, voice_id: string }
  └─ provider未設定時は voice_id の prefix から推定

Priority 3: Ultimate Fallback
  └─ { provider: 'google', voiceId: 'ja-JP-Neural2-B' }
```

### 3.2 Provider 推定ルール (prefix convention)

| Prefix | Provider |
|--------|----------|
| `elevenlabs:` / `el-` | `elevenlabs` |
| `fish:` / `fish-` | `fish` |
| それ以外 | `google` |

### 3.3 実装箇所

| File | Function | 用途 |
|------|----------|------|
| `src/routes/bulk-audio.ts:78` | `resolveVoiceForUtterance()` | 一括生成時の voice 解決 (SSOT) |
| `src/routes/audio-generation.ts:134` | inline resolution | 単一シーン生成時の voice 解決 |
| `src/routes/marunage.ts:1238-1239` | config extraction | 丸投げからの voice 取得 |

### 3.4 新プロバイダー追加時の手順

1. `src/utils/NEW_PROVIDER.ts` を作成（TTS クライアント）
2. `src/routes/audio-generation.ts` の generateTTS 関数に provider 分岐を追加
3. `src/routes/audio-generation.ts` の GET `/tts/voices` に声一覧を追加
4. prefix convention に新 prefix を追加（例: `riva:`, `openai:`）
5. `resolveVoiceForUtterance()` の prefix 判定に分岐を追加
6. DB migration **不要**（`audio_generations.provider` は TEXT 型）
7. フロントエンド: `mcLoadVoices()` に自動で反映（`/tts/voices` から動的取得）
8. 環境変数: `NEW_PROVIDER_API_KEY` を `.dev.vars` / `wrangler secret put` に追加

---

## 4. API Contracts (API 契約)

### 4.1 Utterance CRUD

#### GET /api/scenes/:sceneId/utterances
**Response**: `{ utterances: [{ id, scene_id, order_no, role, character_key, text, audio_generation_id, duration_ms, audio_status?, audio_url? }] }`

#### POST /api/scenes/:sceneId/utterances
**Body**: `{ role: 'narration'|'dialogue', character_key?: string, text: string }`
**Response**: `{ success: true, utterance: { id, ... } }`
**Side Effect**: order_no は自動採番 (`MAX(order_no) + 1`)

#### PUT /api/utterances/:utteranceId
**Body**: `{ text?: string, role?: string, character_key?: string }`
**Response**: `{ success: true, utterance: { id, ... } }`
**Side Effect**: テキスト変更時、リンクされた audio は **無効化されない**（明示的な再生成が必要）

#### DELETE /api/utterances/:utteranceId
**Response**: `{ success: true }`
**Side Effect**: `audio_generation_id` の音声レコードは孤立するが削除しない（参照整合性）

#### PUT /api/scenes/:sceneId/utterances/reorder
**Body**: `{ utterance_ids: [3, 1, 2] }` — 新しい順序
**Response**: `{ success: true }`
**Side Effect**: 全 utterance の `order_no` を 1-based で再採番

### 4.2 Audio Generation

#### POST /api/utterances/:utteranceId/generate-audio
**Body**: `{ force?: boolean, voice_id?: string, provider?: string }`
**Response**: `{ success: true, utterance_id, audio: { id, status, r2_url, duration_ms } }`
**Flow**:
1. utterance の text を取得
2. force=false かつ既存 completed audio がある場合 → skip (reuse)
3. voice 解決 (explicit > character > project_default > fallback)
4. `audio_generations` に INSERT (status='generating')
5. `scene_utterances.audio_generation_id` を UPDATE
6. TTS API 呼び出し → R2 に保存
7. status → 'completed', r2_key/r2_url 更新
8. `scene_utterances.duration_ms` にキャッシュ

#### POST /api/scenes/:sceneId/generate-audio (レガシー: シーン単位)
**Body**: `{ voice_id?, provider?, voice_preset_id? }`
**Flow**: シーンの最初の utterance text を使って音声生成 → `is_active=1` 設定

#### POST /api/projects/:projectId/audio/bulk-generate
**Body**: `{ mode?: 'missing'|'pending'|'all', force_regenerate?: boolean }`
**Response**: `{ success: true, job_id, status: 'queued' }`
**Idempotency**: 同一 project に running/queued job がある場合 → 409 Conflict
**Flow**:
1. `project_audio_jobs` に INSERT (status='queued')
2. 対象 utterance を列挙 (mode に応じてフィルタ)
3. 各 utterance に対して `resolveVoiceForUtterance()` → `generateSingleUtteranceAudio()`
4. 進捗を `project_audio_jobs` に更新
5. 完了/失敗 → status 更新

#### GET /api/projects/:projectId/audio/bulk-status
**Response**: `{ job: { id, status, total, processed, success, failed, skipped, last_error } }`

#### POST /api/projects/:projectId/audio/bulk-cancel
**Response**: `{ success: true }`

### 4.3 TTS Voices

#### GET /api/tts/voices
**Response**:
```json
{
  "voices": [
    { "id": "google:ja-JP-Neural2-B", "provider": "google", "voice_id": "ja-JP-Neural2-B", "name": "Neural2-B", "gender": "male", "language": "ja-JP" },
    { "id": "elevenlabs:9BWtsMINq...", "provider": "elevenlabs", "voice_id": "9BWtsMINq...", "name": "Aria", "gender": "female", "description": "calm narration" },
    { "id": "fish:nanamin", "provider": "fish", "voice_id": "fish:nanamin", "name": "Nanamin", "gender": "female", "description": "anime style" }
  ],
  "configured_providers": ["google", "elevenlabs", "fish"],
  "default_voice": { "provider": "google", "voice_id": "ja-JP-Neural2-B" }
}
```

### 4.4 TTS Usage

#### GET /api/tts/usage
**Response**: `{ total_cost_usd, monthly_budget, usage_percent, warning_threshold }`
- monthly_budget: $100 USD
- warning_thresholds: 70%, 85%

---

## 5. 音声 → 動画ビルド依存関係 (Fragile Points)

### 5.1 データフロー

```
scene_utterances
  ↓ audio_generation_id
audio_generations (status='completed', r2_url NOT NULL)
  ↓ r2_url
video-generation.ts (line 1859-1863):
  voiceUrls = utterances
    .filter(u => u.audio_url && u.audio_status === 'completed')
    .map(u => u.audio_url)
  ↓
buildProjectJson() → project.json
  scenes[].voice_urls: string[]
  ↓
Remotion Lambda → 動画のオーディオトラック
```

### 5.2 Fragile Point: utterance テキスト変更

**問題**: utterance テキストを変更しても、リンクされた `audio_generation` は変わらない。
→ テキストと音声が不一致になる。

**現在の対策**: `MC._dirtyChanges` (フロントエンド) でダーティフラグを管理し、
動画リビルド前にモーダルで確認。

**推奨**: テキスト変更時に `audio_generation_id = NULL, duration_ms = NULL` にリセットし、
自動で再生成をトリガーするオプションを追加。

### 5.3 Fragile Point: presigned URL 期限切れ

**問題**: `audio_generations.r2_url` は R2 の URL（永続）なので期限切れの問題はない。
→ 音声 URL は動画ビルドの入り口で問題なし。

**注意**: `video_builds.download_url` (完成動画) は S3 presigned URL のため期限切れする。
→ commit `df9bf59` で `isPresignedUrlExpiringSoon()` ガード済み。

### 5.4 Fragile Point: video_builds と audio の結合

`buildBuildRequestV1()` (video-build-helpers.ts:1199):
```typescript
const audio = scene.active_audio?.audio_url
  ? { voice: { audio_url: scene.active_audio.audio_url, speed: 1.0 } }
  : undefined;
```
→ `active_audio` が存在しないシーンは無音。utterance が追加されても自動反映しない。

一方、video-generation.ts の preflight (line 1859) は:
```typescript
const voiceUrls = s.utterances
  .filter(u => u.audio_url && u.audio_status === 'completed')
  .map(u => u.audio_url)
```
→ utterance 単位で voice_urls を収集。preflight と buildRequest で **異なるパス** を使っている。

**リスク**: 古い buildBuildRequestV1 の `active_audio` パスと、新しい `utterances` パスの
不整合が起きる可能性がある。

---

## 6. 禁止ルール (Forbidden Rules)

### 6.1 DB レベル

| Rule | Reason |
|------|--------|
| ❌ `audio_generations.provider` に CHECK 制約を追加しない | 新プロバイダー追加時に migration が必要になるため |
| ❌ `scene_utterances.audio_generation_id` を CASCASDE DELETE にしない | 音声履歴が失われるため (SET NULL が正しい) |
| ❌ 同一 scene に同一 order_no の utterance を2つ以上許可しない | UNIQUE 制約で保護済み |
| ❌ `is_active` を複数 record に同時に 1 にしない (project_audio_tracks, scene_audio_assignments の BGM) | 1プロジェクト/1シーンに BGM は最大1つ |

### 6.2 アプリケーションレベル

| Rule | Reason |
|------|--------|
| ❌ 音声生成中 (status='generating') の utterance に対して DELETE/UPDATE しない | 競合状態の防止 |
| ❌ `audio_generations` の completed レコードを UPDATE しない | イミュータブル設計: 再生成時は新 record を INSERT |
| ❌ フロントエンドで直接 TTS API を呼ばない | API キーの漏洩防止 |
| ❌ `settings_json.default_narration_voice` を直接文字列にしない | 常に `{ provider, voice_id }` オブジェクト |
| ❌ 動画ビルド中に utterance テキストを変更しない | ビルド成果物との不整合防止 |
| ❌ bulk-audio job が running 中に同一プロジェクトの新 job を作成しない | 409 Conflict で保護済み |

### 6.3 ビデオビルド

| Rule | Reason |
|------|--------|
| ❌ utterance の text/audio 変更後にビデオリビルドなしで出力を確定しない | テキストと動画音声の不整合 |
| ❌ audio_generations.r2_url を直接ビデオに埋め込まない | CloudFront URL 変換が必要な場合がある |

---

## 7. テストケース

### 7.1 Voice Resolution テスト

```
TC-VR-01: dialogue + character voice → character の voice_preset_id が使われる
  Given: utterance.role='dialogue', character_key='char_a'
  And: project_character_models に char_a の voice_preset_id='el-aria' が存在
  Then: provider='elevenlabs', voiceId='el-aria', source='character'

TC-VR-02: dialogue + character voice なし → project default が使われる
  Given: utterance.role='dialogue', character_key='char_b'
  And: project_character_models に char_b の voice_preset_id=NULL
  And: settings_json.default_narration_voice = { provider: 'fish', voice_id: 'fish:nanamin' }
  Then: provider='fish', voiceId='fish:nanamin', source='project_default'

TC-VR-03: narration → project default が使われる
  Given: utterance.role='narration'
  And: settings_json.default_narration_voice = { provider: 'google', voice_id: 'ja-JP-Wavenet-A' }
  Then: provider='google', voiceId='ja-JP-Wavenet-A', source='project_default'

TC-VR-04: narration + project default なし → fallback
  Given: utterance.role='narration'
  And: settings_json = {} (default_narration_voice なし)
  Then: provider='google', voiceId='ja-JP-Neural2-B', source='fallback'

TC-VR-05: provider が明示されない voice_id の prefix 推定
  Given: voice_preset_id = 'el-adam'
  Then: provider='elevenlabs'

  Given: voice_preset_id = 'fish:nanamin'
  Then: provider='fish'

  Given: voice_preset_id = 'ja-JP-Standard-A'
  Then: provider='google'
```

### 7.2 Utterance CRUD テスト

```
TC-UT-01: POST → order_no 自動採番
  Given: scene に order_no=1, order_no=2 の utterance が存在
  When: POST /api/scenes/:sceneId/utterances { role: 'narration', text: 'テスト' }
  Then: 新 utterance の order_no = 3

TC-UT-02: DELETE → audio_generation は孤立（削除されない）
  Given: utterance id=5, audio_generation_id=10
  When: DELETE /api/utterances/5
  Then: audio_generations id=10 は残存、scene_utterances id=5 は削除

TC-UT-03: PUT text → audio は自動無効化されない
  Given: utterance id=5, audio_generation_id=10, audio.status='completed'
  When: PUT /api/utterances/5 { text: '新テキスト' }
  Then: audio_generation_id=10 はそのまま（不整合だが意図的）
  Note: ダーティフラグが UI で管理される

TC-UT-04: Reorder → order_no 再採番
  Given: utterances [id=1(order=1), id=2(order=2), id=3(order=3)]
  When: PUT /api/scenes/:sceneId/utterances/reorder { utterance_ids: [3, 1, 2] }
  Then: id=3→order_no=1, id=1→order_no=2, id=2→order_no=3
```

### 7.3 Bulk Audio テスト

```
TC-BA-01: mode='missing' → 完了音声のある utterance はスキップ
  Given: utterance id=1 with audio.status='completed'
  And: utterance id=2 with audio_generation_id=NULL
  When: POST bulk-generate { mode: 'missing' }
  Then: id=2 のみ生成、id=1 は skipped

TC-BA-02: 409 Conflict → 既存 running job
  Given: project_audio_jobs に status='running' のレコードあり
  When: POST bulk-generate
  Then: 409 Conflict, existing_job_id 返却

TC-BA-03: force_regenerate=true → 全 utterance 再生成
  Given: utterance id=1 with audio.status='completed'
  When: POST bulk-generate { mode: 'all', force_regenerate: true }
  Then: id=1 も再生成 (新 audio_generation INSERT)
```

### 7.4 Video Build Integration テスト

```
TC-VB-01: 全 utterance に completed audio → voice_urls にすべて含まれる
  Given: scene に utterance 3件、全て audio.status='completed'
  When: preflight → voice_urls 収集
  Then: voice_urls.length === 3

TC-VB-02: 一部 utterance に audio なし → 警告だがビルド可能
  Given: scene に utterance 3件、1件のみ audio.status='completed'
  When: preflight
  Then: voice_urls.length === 1, warnings に 2件の「音声未生成」

TC-VB-03: utterance テキスト変更後 → dirtyChanges フラグ
  Given: ビルド済み video あり
  When: utterance テキストを変更
  Then: MC._dirtyChanges に記録、リビルド前モーダル表示
```

---

## 8. PersonaPlex-7B PoC 計画

### 8.1 結論: PersonaPlex-7B は Audio-to-Audio (S2S) モデル

**公式**: https://huggingface.co/nvidia/personaplex-7b-v1

PersonaPlex-7B は **TTS プロバイダーではない**。
- 入力: WAV (24kHz) + テキストプロンプト + 音声プロンプト
- 出力: WAV (24kHz) + テキスト
- 本質: リアルタイム音声対話（聞きながら同時に話す全二重モデル）

### 8.2 統合オプション分析

#### Option A: 擬似 TTS (text → 既存TTS → PersonaPlex で自然化)
```
text → Google TTS → WAV → PersonaPlex-7B → 自然な WAV
```
**評価**: ❌ 非推奨
- 2段階処理でレイテンシー 2-5倍
- コスト: TTS + GPU = 2重課金
- PersonaPlex は英語のみ → 日本語 WAV 入力の品質不明
- 「自然化」の効果が不確実

#### Option B: リアルタイムチャット/音声 UI 専用
```
PersonaPlex-7B → リアルタイム音声会話UI
既存 TTS (Google/EL/Fish) → 動画生成の音声
```
**評価**: ⚠️ 検討の余地あり（ただし英語のみ）
- 動画生成パイプラインに影響なし
- 新規機能として「AI と音声で会話」を追加する形
- MARUMUVIのコア機能（日本語動画生成）とは独立
- 英語コンテンツ対応時に再検討

### 8.3 PoC 実施計画

**目的**: PersonaPlex-7B が日本語コンテンツ生成に使えるか最低限検証

#### PoC-1: ローカル検証 (1-2日)
```bash
# 環境: NVIDIA GPU (A100/A10G) + Docker
git clone https://github.com/NVIDIA/personaplex
pip install -r requirements.txt

# Offline TTS テスト
# 1. Google TTS で日本語 WAV を生成
# 2. PersonaPlex に入力して出力 WAV を取得
# 3. 音質比較（MOS テスト）
```

**判定基準**:
- 日本語入力 WAV に対して出力が崩壊しないか
- レイテンシー (RTF: Real-Time Factor)
- 音質の主観評価 (入力より良い/同等/劣化)

#### PoC-2: AWS SageMaker テスト (3-5日, PoC-1 合格時のみ)
```python
# SageMaker Endpoint デプロイ
# FastAPI wrapper → REST API 化
# Cloudflare Workers からの呼び出しテスト
```

**判定基準**:
- E2E レイテンシー < 5秒 (Workers → SageMaker → R2)
- コスト: 1音声あたり < $0.01
- エラーレート < 1%

### 8.4 代替 TTS 推奨 (PersonaPlex 不要の場合)

| 優先度 | Provider | 日本語 | コスト | 特徴 |
|--------|----------|--------|--------|------|
| 1 | Fish Audio Speech 1.6 | ○ 良好 | ~$15/月 | 既に統合済み、reference_id でカスタム声可 |
| 2 | ElevenLabs Multilingual v2 | ○ 対応 | $22-99/月 | 高品質、ボイスクローン可 |
| 3 | NVIDIA Riva (NIM API) | ○ 対応 | 従量制 | クラウドAPI、GPU不要 |
| 4 | OpenAI TTS (gpt-4o-mini-tts) | ○ 対応 | 従量制 | 感情表現豊か、多言語 |

---

## 9. 矛盾点・リスクまとめ (presigned URL 修正: commit 85ccd6a, df9bf59)

### 9.1 修正内容の検証

| 修正 | ファイル | 検証結果 |
|------|---------|----------|
| `isPresignedUrlExpiringSoon()` utility | `aws-video-client.ts` | ✅ URL パースで X-Amz-Date + X-Amz-Expires から残り時間を推定。10分以内で true |
| marunage.ts status API | `marunage.ts` | ✅ completed + s3_output_key あり + URL期限切れ → fresh URL 生成 |
| video-generation.ts GET /video-builds/:buildId | `video-generation.ts` | ✅ 同上ロジック |
| Frontend: video src 更新条件 | `marunage-chat.js` | ✅ URL 文字列比較で変更時のみ src 更新 |
| Frontend: 403 error recovery | `marunage-chat.js` | ✅ video onerror で fresh URL 再取得 |

### 9.2 残存リスク

| Risk | Severity | Mitigation |
|------|----------|------------|
| URL パース失敗 (非標準形式) | 低 | try/catch でフォールバック → 常に再生成 |
| D1 UPDATE (download_url) のレースコンディション | 低 | fire-and-forget UPDATE、最悪でも次回リクエストで再生成 |
| isPresignedUrlExpiringSoon の 10分閾値が短すぎる | 低 | 変更容易 (定数化済み) |
| フロント polling 間隔が長い場合に期限切れ | 中 | onerror ハンドラで 403 時に自動リカバリ |

---

## 付録A: 実コードとの対応表

| Spec の項目 | 実コードの場所 |
|-------------|---------------|
| `settings_json.default_narration_voice` | `audio-generation.ts:177`, `bulk-audio.ts:105`, `marunage.ts:1249` |
| `resolveVoiceForUtterance()` | `bulk-audio.ts:78-123` |
| `generateSingleUtteranceAudio()` | `bulk-audio.ts:129-163` |
| Voice prefix detection | `bulk-audio.ts:94-98`, `audio-generation.ts:158-164` |
| buildProjectJson voice_urls | `video-generation.ts:1859-1863` |
| buildBuildRequestV1 audio | `video-build-helpers.ts:1199-1201` |
| Utterance CRUD | `utterances.ts:85-650` |
| Bulk generate | `bulk-audio.ts:554-680` |
| TTS voices list | `audio-generation.ts:942-1014` |

## 付録B: settings_json 完全キーマップ

```json
{
  "default_narration_voice": {
    "provider": "google|elevenlabs|fish|...",
    "voice_id": "ja-JP-Neural2-B|el-aria|fish:nanamin|..."
  },
  "output_preset": "youtube_short|youtube_long|tiktok|instagram_reel",
  "marunage_mode": true,
  "character_voices": {
    "<character_key>": { "provider": "...", "voice_id": "..." }
  },
  "telops_comic": {
    "style_preset": "outline|minimal|band|pop|cinematic",
    "size_preset": "sm|md|lg",
    "position_preset": "bottom|center|top"
  },
  "telops_remotion": {
    "enabled": true,
    "style_preset": "outline|minimal|band|pop|cinematic",
    "size_preset": "sm|md|lg",
    "position_preset": "bottom|center|top",
    "custom_style": { ... },
    "typography": { ... },
    "updated_at": "2026-02-17T..."
  }
}
```
