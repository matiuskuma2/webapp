# Video Build SSOT & 依存関係ドキュメント

**最終更新**: 2026-02-07  
**バージョン**: 1.3  
**目的**: 全シーンの最終動画化（Video Build）を完走するための依存関係とSSOT定義

---

## P2-3: 発話・音声・テロップ・動画の依存関係

### データフロー全体図

```
[dialogue テキスト]
    │
    ▼ (dialogue-parser.ts)
[scene_utterances] ─── SSOT: 発話テキスト・話者・順番
    │
    ├── role: 'narration' | 'dialogue'
    ├── character_key: キャラ参照（dialogueのみ）
    ├── text: 発話テキスト
    └── order_no: 順番
    │
    ▼ (audio-generation.ts / bulk-audio.ts)
[audio_generations] ─── SSOT: 音声ファイル
    │
    ├── voice解決優先順位:
    │   1. キャラのvoice_preset_id (project_character_models)
    │   2. プロジェクトのdefault_narration_voice (projects.settings_json)
    │   3. フォールバック: google/ja-JP-Neural2-B
    ├── audio_url: R2上の音声ファイルURL
    └── duration_ms: 音声の尺（ミリ秒）
    │
    ├──── [画像モード] ───────────┐
    │     テロップ: Remotion描画    │
    │     text_render_mode: 'remotion' │
    │     表示: voice.text をそのまま │
    │     タイミング: voice.start_ms  │
    │     → voice.start_ms + duration_ms │
    │                                 │
    ├──── [漫画モード] ───────────┐
    │     吹き出し: 最大3件          │
    │     text_render_mode: 'baked'   │
    │     comic_data.utterances       │
    │     ※ scene_utterances と      │
    │       comic_dataは独立          │
    │     ※ 吹き出し外の発話は       │
    │       音声のみ再生              │
    │                                 │
    ▼                                 ▼
[video-build-helpers.ts: buildProjectJson()]
    │
    ├── voices[]: 各発話の音声URL・テキスト・duration
    ├── balloons[]: 漫画の吹き出し（bakedのみ）
    ├── timing.duration_ms: シーンの合計尺
    │   計算: MAX(音声合計+500ms, duration_override_ms, 3000)
    └── assets.image/video_clip: 画像/動画アセット
    │
    ▼ (Remotion: Scene.tsx)
[最終動画レンダリング]
    ├── テロップ表示（remotionモード時）
    │   現在再生中の voice.text を字幕として表示
    │   タイミング: currentMs が voice.start_ms 〜 end_ms の範囲
    ├── 吹き出し表示（bakedモード時）
    │   bubble_image_url を合成
    ├── 音声再生
    │   各 voice の audio_url を start_ms から再生
    └── BGM
        ダッキング（音声再生時に自動減衰）
```

### 動画生成前提条件（Preflight）

| 条件 | 画像モード | 漫画モード | 備考 |
|------|-----------|-----------|------|
| 画像/漫画 | image_url 必須 | comic image_url 必須 | アクティブな画像 |
| 発話テキスト | 推奨 | 推奨 | 無くても生成可能（無音） |
| 音声生成 | 推奨 | 推奨 | 無ければ無音で尺3秒 |
| 吹き出し画像 | 不要 | baked時は必須 | bubble_r2_url |
| voice_preset_id | 推奨 | 推奨 | 無ければフォールバック |

### 音声未生成時の挙動

- **一括再生モード**: 音声が無い場合、シーン間のトランジションのみで尺3秒
- **読み終わり待ちモード**: 音声生成済みの場合、全音声の再生終了まで待機

---

## ⚡ BuildRequest v1 完全仕様（確定）

### Remotion 契約
- **Remotion は BuildRequest JSON のみを参照**
- **DB を直接読まない**
- **Scene / Comic / Audio / Style の変更は BuildRequest 生成ロジックで吸収**

### BuildRequest v1 JSON Schema

```json
{
  "version": "1.0",
  "project": {
    "id": 55,
    "title": "サンプルプロジェクト"
  },
  "output": {
    "resolution": { "width": 1080, "height": 1920 },
    "fps": 30,
    "format": "mp4"
  },
  "timeline": {
    "scenes": [
      {
        "scene_id": 537,
        "order": 1,
        "duration_ms": 4200,
        "visual": {
          "type": "comic",
          "source": { "image_url": "https://..." },
          "effect": { "type": "none", "zoom": 1.0, "pan": "center" }
        },
        "audio": {
          "voice": { "audio_url": "https://...", "speed": 1.0 }
        },
        "bubbles": [
          {
            "id": "u1",
            "text": "これはテストです",
            "type": "speech",
            "position": { "x": 0.42, "y": 0.68 },
            "timing": { "start_ms": 300, "end_ms": 2100 }
          }
        ],
        "telop": { "enabled": false }
      }
    ]
  },
  "bgm": null
}
```

### SSOT 関数（video-build-helpers.ts）

| 関数 | 責務 | SSOT |
|------|------|------|
| `selectSceneVisual()` | display_asset_type → visual 変換 | 素材選択の唯一のロジック |
| `computeSceneDurationMs()` | 尺計算 | 尺計算の唯一のロジック |
| `buildSceneBubbles()` | 吹き出しデータ生成 | v1: comic の utterances を変換 |
| `buildBuildRequestV1()` | BuildRequest v1 生成 | **唯一の出口** |
| `validateProjectAssets()` | Preflight検証 | selectSceneVisual と同じロジック |

### visual.type の決定ルール

| display_asset_type | visual.type | source | effect |
|--------------------|-------------|--------|--------|
| `image` | `image` | `image_url: active_image.r2_url` | kenburns (zoom: 1.05) |
| `comic` | `comic` | `image_url: active_comic.r2_url` | none |
| `video` | `video` | `video_url: active_video.r2_url` | none |

### duration_ms の決定ルール（v1: 推定固定）

1. **video モード**: `active_video.duration_sec × 1000`
2. **comic モード**: `SUM(utterances[].duration_ms) + 500ms`
3. **audio あり**: `active_audio.duration_ms + 500ms`
4. **dialogue から推定**: `dialogue.length × 300ms`（最低2000ms）
5. **デフォルト**: `3000ms`

### 将来拡張（v1.1+）

```json
{
  "bgm": {
    "audio_url": "https://...",
    "volume": 0.3,
    "ducking": true
  },
  "extras": [
    {
      "type": "intro",
      "duration_ms": 2000,
      "visual": { "type": "image", "source": { "image_url": "..." } }
    }
  ]
}
```

---

## 1. 用語定義

| 用語 | 定義 |
|------|------|
| **SSOT** | Single Source of Truth - 唯一の真実の情報源 |
| **Video Build** | プロジェクト全体の素材を合算してMP4動画を生成するプロセス |
| **Scene** | 動画を構成する各シーン（1〜N件） |
| **display_asset_type** | シーンの表示素材タイプ: 'image' \| 'comic' \| 'video' |
| **active_xxx** | 各素材種の「採用済み」レコード（is_active=1） |
| **Preflight** | ビルド前の素材検証チェック |
| **Remotion** | AWS Lambda上のレンダリングエンジン |

---

## 2. 依存関係フロー（SSOT図）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Video Build パイプライン                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  GATE 1: Scene データ準備                                            │   │
│  │  ────────────────────────────────────────────────────────────────── │   │
│  │  SSOT: scenes テーブル                                              │   │
│  │  - display_asset_type (image | comic | video)                       │   │
│  │  - dialogue (セリフテキスト)                                         │   │
│  │  - comic_data (JSON: utterances[] for 漫画モード)                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                               ↓                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  GATE 2: 素材準備（表示素材）                                         │   │
│  │  ────────────────────────────────────────────────────────────────── │   │
│  │  SSOT: display_asset_type に応じた素材ソース                         │   │
│  │                                                                     │   │
│  │  if display_asset_type == 'image':                                  │   │
│  │    → image_generations (is_active=1, asset_type='ai' OR NULL)       │   │
│  │    → 必須: r2_url                                                   │   │
│  │                                                                     │   │
│  │  if display_asset_type == 'comic':                                  │   │
│  │    → image_generations (is_active=1, asset_type='comic')            │   │
│  │    → 必須: r2_url                                                   │   │
│  │                                                                     │   │
│  │  if display_asset_type == 'video':                                  │   │
│  │    → video_generations (is_active=1, status='completed')            │   │
│  │    → 必須: r2_url                                                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                               ↓                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  GATE 3: 素材準備（音声）[オプション]                                  │   │
│  │  ────────────────────────────────────────────────────────────────── │   │
│  │  SSOT: 音声ソース                                                    │   │
│  │                                                                     │   │
│  │  if display_asset_type == 'comic':                                  │   │
│  │    → scenes.comic_data.utterances[].audio_url                       │   │
│  │    → 各発話の duration_ms                                           │   │
│  │                                                                     │   │
│  │  else (image | video):                                              │   │
│  │    → audio_generations (is_active=1, status='completed')            │   │
│  │    → r2_url, duration_ms                                            │   │
│  │                                                                     │   │
│  │  ※ 音声がない場合はデフォルト 3000ms                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                               ↓                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  GATE 4: Preflight検証                                              │   │
│  │  ────────────────────────────────────────────────────────────────── │   │
│  │  API: GET /api/projects/:id/video-builds/preflight                  │   │
│  │  実装: video-build-helpers.ts → validateProjectAssets()             │   │
│  │                                                                     │   │
│  │  検証内容:                                                           │   │
│  │  - 全シーンに display_asset_type に応じた素材があるか                 │   │
│  │  - image: active_image.r2_url が存在                                │   │
│  │  - comic: active_comic.r2_url が存在                                │   │
│  │  - video: active_video.status=completed && r2_url が存在            │   │
│  │                                                                     │   │
│  │  結果: is_ready (true/false), missing[], warnings[]                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                               ↓                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  GATE 5: project.json 生成                                          │   │
│  │  ────────────────────────────────────────────────────────────────── │   │
│  │  API: POST /api/projects/:id/video-builds                           │   │
│  │  実装: video-build-helpers.ts → buildProjectJson()                  │   │
│  │                                                                     │   │
│  │  SSOT 参照:                                                          │   │
│  │  - asset.src = display_asset_type に基づく r2_url                   │   │
│  │  - audio.src = 音声URL                                              │   │
│  │  - duration_ms = 音声尺 + 500ms パディング                          │   │
│  │  - ken_burns = asset.type=='image' のときのみ有効                   │   │
│  │  - utterances = comic モード時のみ                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                               ↓                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  GATE 6: AWS Orchestrator 送信                                      │   │
│  │  ────────────────────────────────────────────────────────────────── │   │
│  │  クライアント: aws-video-build-client.ts                            │   │
│  │  エンドポイント: POST /video/build/start (SigV4 署名)               │   │
│  │                                                                     │   │
│  │  リクエスト:                                                         │   │
│  │  - video_build_id                                                   │   │
│  │  - project_id                                                       │   │
│  │  - owner_user_id / executor_user_id                                 │   │
│  │  - project_json (GATE 5 の結果)                                     │   │
│  │  - build_settings (captions, bgm, motion)                           │   │
│  │                                                                     │   │
│  │  レスポンス:                                                         │   │
│  │  - aws_job_id                                                       │   │
│  │  - remotion.render_id / site_name                                   │   │
│  │  - output.bucket / key                                              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                               ↓                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  GATE 7: ポーリング & 完了                                           │   │
│  │  ────────────────────────────────────────────────────────────────── │   │
│  │  API: POST /api/video-builds/:id/refresh                            │   │
│  │  エンドポイント: GET /video/build/status/{buildId}                  │   │
│  │                                                                     │   │
│  │  ステータス遷移:                                                     │   │
│  │  queued → validating → submitted → rendering → uploading → completed│   │
│  │           ↓              ↓           ↓                              │   │
│  │        failed         failed      failed                            │   │
│  │                                                                     │   │
│  │  完了時:                                                             │   │
│  │  - download_url (presigned S3 URL, 24時間有効)                      │   │
│  │  - render_completed_at                                              │   │
│  │  - s3_output_size_bytes                                             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. SSOT 定義（明文化）

### 3.1 SSOT①: シーンの「表示に使う素材」

| display_asset_type | SSOT テーブル | 条件 | 取得カラム |
|--------------------|---------------|------|------------|
| `image` | image_generations | is_active=1 AND (asset_type='ai' OR asset_type IS NULL) | r2_key, r2_url |
| `comic` | image_generations | is_active=1 AND asset_type='comic' | id, r2_key, r2_url |
| `video` | video_generations | is_active=1 AND status='completed' AND r2_url IS NOT NULL | id, status, r2_url, model, duration_sec |

### 3.2 SSOT②: シーンの「音声」

| display_asset_type | SSOT ソース | 条件 | 取得フィールド |
|--------------------|-------------|------|----------------|
| `comic` | scenes.comic_data.utterances[] | - | audio_url, duration_ms (per utterance) |
| `image` / `video` | audio_generations | is_active=1 AND status='completed' | audio_url, duration_ms |

### 3.3 SSOT③: シーン尺（duration_ms）

| display_asset_type | 計算ロジック |
|--------------------|--------------|
| `video` | active_video.duration_sec × 1000 |
| `comic` | SUM(utterances[].duration_ms) + 500ms |
| `image` | active_audio.duration_ms + 500ms（音声なし: 3000ms デフォルト） |

### 3.4 SSOT④: project.json の asset.src

```typescript
// video-build-helpers.ts: buildProjectJson()
switch (displayType) {
  case 'comic':
    assetSrc = scene.active_comic?.r2_url || '';
    break;
  case 'video':
    assetSrc = scene.active_video?.r2_url || '';
    break;
  default: // 'image'
    assetSrc = scene.active_image?.r2_url || '';
    break;
}
```

---

## 4. DB テーブル関連

### 4.1 video_builds テーブル

```sql
CREATE TABLE video_builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  executor_user_id INTEGER NOT NULL,
  
  status TEXT NOT NULL DEFAULT 'queued',
  -- 'queued' | 'validating' | 'submitted' | 'rendering' | 'uploading' 
  -- | 'completed' | 'failed' | 'cancelled' | 'retry_wait'
  
  progress_percent REAL DEFAULT 0,
  progress_stage TEXT,
  progress_message TEXT,
  
  settings_json TEXT NOT NULL,        -- ビルド設定
  project_json_version TEXT,           -- '1.1'
  project_json_r2_key TEXT,            -- R2に保存したproject.json
  project_json_hash TEXT,              -- SHA-256 ハッシュ
  
  aws_job_id TEXT,
  remotion_render_id TEXT,
  remotion_site_name TEXT,
  
  s3_bucket TEXT,
  s3_output_key TEXT,
  s3_output_size_bytes INTEGER,
  
  total_scenes INTEGER,
  total_duration_ms INTEGER,
  render_started_at DATETIME,
  render_completed_at DATETIME,
  
  error_code TEXT,
  error_message TEXT,
  error_details_json TEXT,
  
  download_url TEXT,                   -- presigned URL (24時間有効)
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

### 4.2 関連テーブル

| テーブル | 役割 | Video Build との関係 |
|----------|------|---------------------|
| scenes | シーン基本情報 | display_asset_type, dialogue, comic_data |
| image_generations | AI画像・漫画画像 | active_image, active_comic の SSOT |
| video_generations | I2V動画 | active_video の SSOT |
| audio_generations | 音声 | active_audio の SSOT |

---

## 5. API エンドポイント

### 5.1 Video Build APIs

| メソッド | エンドポイント | 用途 |
|----------|----------------|------|
| GET | /api/video-builds/usage | 利用状況（月間/同時） |
| GET | /api/projects/:id/video-builds/preflight | Preflight検証 |
| GET | /api/projects/:id/video-builds | ビルド一覧 |
| POST | /api/projects/:id/video-builds | ビルド開始 |
| GET | /api/video-builds/:id | ビルド詳細 |
| POST | /api/video-builds/:id/refresh | ステータス更新 |

### 5.2 AWS Orchestrator APIs (内部)

| メソッド | エンドポイント | 用途 |
|----------|----------------|------|
| POST | /video/build/start | Remotion ビルド開始 |
| GET | /video/build/status/{buildId} | ステータス取得 |

---

## 6. 変更が入った場合の反映ルール

### 6.1 Scene側変更 → Video Build への影響

| 変更内容 | 影響 | 対応 |
|----------|------|------|
| display_asset_type 変更 | asset.src の参照先が変わる | Preflight で検知 |
| 画像の採用変更 | active_image が変わる | Preflight で検知 |
| 漫画の採用変更 | active_comic が変わる | Preflight で検知 |
| 動画の採用変更 | active_video が変わる | Preflight で検知 |
| 音声の採用変更 | audio.src, duration_ms が変わる | 警告表示 |
| dialogue 変更 | 字幕テキストが変わる | 自動反映 |
| comic_data.utterances 変更 | 漫画モードの音声が変わる | 自動反映 |

### 6.2 ルール: Scene側改修凍結時の対処

1. **Scene契約（SSOT）変更が必要な場合**:
   - 本ドキュメントの SSOT 定義を更新
   - video-build-helpers.ts の validateProjectAssets() を更新
   - video-build-helpers.ts の buildProjectJson() を更新
   - フロントエンドの updateVideoBuildRequirements() を更新

2. **Build側の取り込み変更が必要な場合**:
   - video-generation.ts の preflight / create エンドポイント更新
   - aws-video-build-client.ts の型定義更新
   - AWS Orchestrator (Lambda) の対応更新

---

## 7. 現在の問題点・TODO

### 7.1 確認済みの問題

- [x] ~~フロントエンドで `active_audio` がシーンデータに含まれていない~~ → **修正済み (2026-01-19)**
  - video-generation.ts の preflight / create エンドポイントで audio_generations テーブルから取得するように修正
  - duration_ms はテキスト長から推定（日本語約300ms/文字、最低2秒）
- [ ] 漫画モードの `comic_data.utterances[].audio_url` の反映確認
- [ ] AWS Orchestrator のエラーハンドリング強化
- [ ] presigned URL 期限切れ時の再取得フロー確認

### 7.2 テスト項目

1. **Preflight テスト**
   - [ ] image モードで画像なし → missing 検出
   - [ ] comic モードで漫画なし → missing 検出
   - [ ] video モードで動画なし → missing 検出
   - [ ] video モードで generating 中 → missing（生成中メッセージ）
   - [ ] 音声なし → warnings 表示

2. **Build テスト**
   - [ ] image モード × 音声あり → 正常完了
   - [ ] comic モード × utterances 音声あり → 正常完了
   - [ ] video モード × 動画完了 → 正常完了
   - [ ] 混合モード（シーンごとに異なる display_asset_type） → 正常完了

---

## 8. 変更反映運用ルール

### 8.1 Scene側改修凍結のルール

**原則**: Scene側の細かい改修は凍結し、Video Build 完走に集中する。

**例外**: 以下の場合のみ改修を許可：
1. **Video Build のブロッカー**: Preflight で検出される致命的な問題
2. **SSOT違反**: 既存の SSOT 定義に反する実装の修正
3. **ユーザー操作不能**: UI 操作が不可能な状態

### 8.2 変更ラベリングルール

Scene 側の変更が必要な場合は、以下のラベルを付与：

| ラベル | 意味 | 例 |
|--------|------|-----|
| `[SSOT-CHANGE]` | SSOT 定義の変更 | display_asset_type に新しい値を追加 |
| `[BUILD-INTAKE]` | Build側で取り込む変更 | 音声URL形式の変更 |
| `[SCENE-BUGFIX]` | Scene 側のバグ修正 | 採用フラグの不整合修正 |

### 8.3 変更時のチェックリスト

**Scene 側変更時**:
- [ ] VIDEO_BUILD_SSOT.md の該当箇所を更新
- [ ] validateProjectAssets() への影響を確認
- [ ] buildProjectJson() への影響を確認
- [ ] フロントエンド updateVideoBuildRequirements() への影響を確認

**Build 側変更時**:
- [ ] AWS Orchestrator の型定義との整合性を確認
- [ ] project.json のバージョン番号を検討
- [ ] エラーハンドリングの追加

### 8.4 テスト実行チェックリスト

変更後は以下を確認：

```bash
# 1. Preflight API テスト
curl -s "https://webapp-c7n.pages.dev/api/projects/55/video-builds/preflight" | jq

# 2. シーンデータ確認（display_asset_type）
curl -s "https://webapp-c7n.pages.dev/api/projects/55/scenes?view=board" | jq '.[0] | {display_asset_type, active_image, active_comic, active_video, active_audio}'

# 3. フロントエンド Video Build タブ
# - https://webapp-c7n.pages.dev/projects/55 の「動画」タブを確認
# - 要件チェックに問題がないこと
# - 「動画生成を開始」ボタンがクリック可能なこと
```

---

## 9. ファイル一覧

| ファイル | 役割 |
|----------|------|
| `/src/routes/video-generation.ts` | Video Build API エンドポイント |
| `/src/utils/video-build-helpers.ts` | validateProjectAssets(), buildProjectJson() |
| `/src/utils/aws-video-build-client.ts` | AWS Orchestrator クライアント |
| `/public/static/project-editor.*.js` | フロントエンド Video Build UI |
| `/migrations/0013_create_video_builds.sql` | DB スキーマ |

---

## 10. 動作確認コマンド集

### Preflight 確認
```bash
# プロジェクト55の素材チェック
curl -s "https://webapp-c7n.pages.dev/api/projects/55/video-builds/preflight" | jq
```

### シーンデータ確認
```bash
# シーン一覧（display_asset_type付き）
curl -s "https://webapp-c7n.pages.dev/api/projects/55/scenes?view=board" | jq '.scenes | map({id, display_asset_type})'

# 特定シーンの音声確認
curl -s "https://webapp-c7n.pages.dev/api/scenes/537/audio" | jq '.active_audio'
```

### ビルド一覧
```bash
curl -s "https://webapp-c7n.pages.dev/api/projects/55/video-builds" | jq '.builds'
```

### 利用状況
```bash
curl -s "https://webapp-c7n.pages.dev/api/video-builds/usage" | jq
```

---

## 更新履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|----------|
| 2026-01-19 | 1.0 | 初版作成 |
| 2026-01-19 | 1.1 | active_audio 取得修正、変更反映運用ルール追加 |
| 2026-01-19 | 1.2 | BuildRequest v1 完全仕様追加、SSOT関数一覧追加 |
