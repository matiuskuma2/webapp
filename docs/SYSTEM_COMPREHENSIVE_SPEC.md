# RILARC Scenario Generator - 完全統合技術仕様書

**最終更新**: 2025-12-20  
**対象システム**: webapp (RILARC Scenario Generator)  
**作成目的**: 全体の依存関係、DB設計、API設計を包括的に確認し、矛盾点・エラー・古い記述を洗い出す

---

## 📋 目次

1. [システム概要](#1-システム概要)
2. [技術スタック](#2-技術スタック)
3. [データベース設計](#3-データベース設計)
4. [API設計](#4-api設計)
5. [フロントエンド-バックエンド連携](#5-フロントエンド-バックエンド連携)
6. [依存関係マップ](#6-依存関係マップ)
7. [検出された問題点](#7-検出された問題点)
8. [推奨事項](#8-推奨事項)

---

## 1. システム概要

### 1.1 プロジェクト名
**RILARC Scenario Generator**

### 1.2 目的
音声またはテキストから、YouTube動画用のシナリオ（シーン分割 + 画像生成）を自動生成する

### 1.3 主要機能
1. **Input Phase**: 音声アップロード/録音/テキスト入力
2. **Transcription Phase**: 音声→テキスト変換（OpenAI Whisper API）
3. **Parse Phase**: 長文テキストをチャンク分割（500-1500文字）
4. **Format Phase**: チャンクからRILARC形式シーンを生成（OpenAI GPT-4o）
5. **Image Generation Phase**: シーンごとに画像生成（Google Gemini API）
6. **Export Phase**: 画像ZIP、CSV、全素材パックのダウンロード

### 1.4 デプロイ環境
- **Platform**: Cloudflare Pages/Workers
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2 (S3互換)
- **Runtime**: Edge Runtime (No Node.js APIs)

---

## 2. 技術スタック

### 2.1 バックエンド

| 項目 | 技術 | バージョン | 用途 |
|------|------|-----------|------|
| **Framework** | Hono | ^4.11.0 | 軽量Webフレームワーク |
| **Runtime** | Cloudflare Workers | - | Edge Computing |
| **Database** | Cloudflare D1 | - | SQLiteベース分散DB |
| **Storage** | Cloudflare R2 | - | オブジェクトストレージ |
| **Build Tool** | Vite | ^6.3.5 | バンドル・ビルド |
| **API** | OpenAI API | - | 文字起こし・シーン生成 |
| **API** | Google Gemini API | - | 画像生成 |

### 2.2 フロントエンド

| 項目 | 技術 | 備考 |
|------|------|------|
| **Framework** | Vanilla JS | フレームワークレス |
| **HTTP Client** | Axios | CDN版 (1.6.0) |
| **CSS Framework** | TailwindCSS | CDN版 |
| **Icons** | Font Awesome | CDN版 (6.4.0) |
| **UI Components** | カスタムコンポーネント | 自作 |

### 2.3 開発環境

```json
{
  "name": "webapp",
  "type": "module",
  "dependencies": {
    "hono": "^4.11.0",
    "jszip": "^3.10.1"
  },
  "devDependencies": {
    "@hono/vite-build": "^1.2.0",
    "@hono/vite-dev-server": "^0.18.2",
    "autoprefixer": "^10.4.22",
    "postcss": "^8.5.6",
    "tailwindcss": "^3.4.19",
    "vite": "^6.3.5",
    "wrangler": "^4.4.0"
  }
}
```

### 2.4 Cloudflare設定

**wrangler.jsonc**:
```jsonc
{
  "name": "webapp",
  "compatibility_date": "2024-01-01",
  "pages_build_output_dir": "./dist",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [{
    "binding": "DB",
    "database_name": "webapp-production",
    "database_id": "51860cd3-bfa8-4eab-8a11-aa230adee686"
  }],
  "r2_buckets": [{
    "binding": "R2",
    "bucket_name": "webapp-bucket"
  }]
}
```

---

## 3. データベース設計

### 3.1 テーブル一覧

| テーブル名 | 用途 | 主要カラム |
|-----------|------|-----------|
| `projects` | プロジェクトメタデータ | id, title, status, source_type |
| `transcriptions` | 音声文字起こし結果 | id, project_id, raw_text |
| `text_chunks` | パース済みテキストチャンク | id, project_id, idx, text, status |
| `scenes` | 生成済みシーン | id, project_id, idx, role, dialogue, image_prompt |
| `image_generations` | 画像生成履歴 | id, scene_id, prompt, r2_key, status |
| `style_presets` | スタイルプリセット | id, name, prompt_prefix, prompt_suffix |
| `project_style_settings` | プロジェクトスタイル設定 | id, project_id, default_style_preset_id |
| `scene_style_settings` | シーンスタイル設定 | id, scene_id, style_preset_id |
| `runs` | Run管理（Phase B） | id, project_id, run_no, state |

### 3.2 テーブル詳細

#### 3.2.1 `projects`

**役割**: プロジェクトの基本情報とステータス管理

| カラム名 | 型 | NULL | Default | 説明 |
|---------|-----|------|---------|------|
| id | INTEGER | NO | AUTO_INCREMENT | Primary Key |
| title | TEXT | NO | - | プロジェクトタイトル |
| audio_r2_key | TEXT | YES | NULL | R2に保存された音声ファイルキー |
| audio_filename | TEXT | YES | NULL | オリジナル音声ファイル名 |
| audio_size_bytes | INTEGER | YES | NULL | 音声ファイルサイズ |
| audio_duration_seconds | INTEGER | YES | NULL | 音声の長さ（秒） |
| source_type | TEXT | YES | NULL | 'audio' or 'text' |
| source_text | TEXT | YES | NULL | テキスト入力の場合の元テキスト |
| status | TEXT | NO | 'created' | ステータス（後述） |
| error_message | TEXT | YES | NULL | エラーメッセージ |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |
| updated_at | DATETIME | NO | CURRENT_TIMESTAMP | 更新日時 |

**ステータス遷移**:
```
created → uploaded → transcribing → transcribed → parsing → parsed → 
formatting → formatted → generating_images → completed
```

**外部キー制約**: なし（ルートテーブル）

#### 3.2.2 `transcriptions`

**役割**: 音声からの文字起こし結果

| カラム名 | 型 | NULL | Default | 説明 |
|---------|-----|------|---------|------|
| id | INTEGER | NO | AUTO_INCREMENT | Primary Key |
| project_id | INTEGER | NO | - | 外部キー → projects.id |
| raw_text | TEXT | NO | - | 文字起こし結果テキスト |
| language | TEXT | YES | NULL | 検出された言語コード |
| duration_seconds | INTEGER | YES | NULL | 音声の長さ |
| word_count | INTEGER | YES | NULL | 単語数 |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |

**外部キー制約**:
```sql
FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
```

**インデックス**:
```sql
CREATE INDEX idx_transcriptions_project ON transcriptions(project_id)
```

#### 3.2.3 `text_chunks`

**役割**: パース済みテキストチャンク（500-1500文字単位）

| カラム名 | 型 | NULL | Default | 説明 |
|---------|-----|------|---------|------|
| id | INTEGER | NO | AUTO_INCREMENT | Primary Key |
| project_id | INTEGER | NO | - | 外部キー → projects.id |
| idx | INTEGER | NO | - | チャンクのインデックス（0始まり） |
| text | TEXT | NO | - | チャンクテキスト |
| status | TEXT | NO | 'pending' | 処理ステータス |
| error_message | TEXT | YES | NULL | エラーメッセージ |
| scene_count | INTEGER | YES | NULL | このチャンクから生成されたシーン数 |
| processed_at | DATETIME | YES | NULL | 処理完了日時 |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |
| updated_at | DATETIME | NO | CURRENT_TIMESTAMP | 更新日時 |
| validation_errors | TEXT | YES | NULL | バリデーションエラー（JSON） |
| run_id | INTEGER | YES | NULL | 外部キー → runs.id |

**ステータス**: `'pending'`, `'processing'`, `'done'`, `'failed'`

**外部キー制約**:
```sql
FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL
```

**インデックス**:
```sql
CREATE INDEX idx_text_chunks_project ON text_chunks(project_id)
CREATE INDEX idx_text_chunks_status ON text_chunks(project_id, status)
CREATE INDEX idx_text_chunks_run ON text_chunks(run_id)
```

#### 3.2.4 `scenes`

**役割**: 生成済みRILARCシーン

| カラム名 | 型 | NULL | Default | 説明 |
|---------|-----|------|---------|------|
| id | INTEGER | NO | AUTO_INCREMENT | Primary Key |
| project_id | INTEGER | NO | - | 外部キー → projects.id |
| idx | INTEGER | NO | - | シーンインデックス（1始まり） |
| role | TEXT | NO | - | シーン役割（hook/main_point/evidence/...） |
| title | TEXT | NO | - | シーンタイトル |
| dialogue | TEXT | NO | - | セリフ/ナレーション |
| bullets | TEXT | NO | - | 要点（JSON配列） |
| image_prompt | TEXT | NO | - | 画像生成プロンプト |
| style_preset_id | INTEGER | YES | NULL | 外部キー → style_presets.id |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |
| updated_at | DATETIME | NO | CURRENT_TIMESTAMP | 更新日時 |
| run_id | INTEGER | YES | NULL | 外部キー → runs.id |

**外部キー制約**:
```sql
FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
FOREIGN KEY (style_preset_id) REFERENCES style_presets(id) ON DELETE SET NULL
FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL
```

**インデックス**:
```sql
CREATE INDEX idx_scenes_project ON scenes(project_id)
CREATE UNIQUE INDEX idx_scenes_project_idx ON scenes(project_id, idx)
CREATE INDEX idx_scenes_run ON scenes(run_id)
```

**シーン役割（role）**:
- `hook`: 冒頭フック
- `main_point`: メインポイント
- `evidence`: 証拠・根拠
- `example`: 具体例
- `summary`: まとめ
- `cta`: Call to Action

#### 3.2.5 `image_generations`

**役割**: 画像生成履歴（シーンごとに複数の世代を保持）

| カラム名 | 型 | NULL | Default | 説明 |
|---------|-----|------|---------|------|
| id | INTEGER | NO | AUTO_INCREMENT | Primary Key |
| scene_id | INTEGER | NO | - | 外部キー → scenes.id |
| prompt | TEXT | NO | - | 実際に使用されたプロンプト |
| r2_key | TEXT | YES | NULL | R2ストレージキー |
| r2_url | TEXT | YES | NULL | R2 URL（廃止予定、r2_keyから生成） |
| status | TEXT | NO | 'pending' | ステータス |
| error_message | TEXT | YES | NULL | エラーメッセージ |
| provider | TEXT | YES | NULL | プロバイダー（例: gemini） |
| model | TEXT | YES | NULL | モデル名 |
| is_active | INTEGER | NO | 0 | アクティブフラグ（0 or 1） |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |

**ステータス**: `'pending'`, `'generating'`, `'completed'`, `'failed'`, `'policy_violation'`

**外部キー制約**:
```sql
FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
```

**インデックス**:
```sql
CREATE INDEX idx_image_generations_scene ON image_generations(scene_id)
CREATE INDEX idx_image_generations_active ON image_generations(scene_id, is_active)
CREATE INDEX idx_image_generations_status ON image_generations(scene_id, status)
```

**重要**: シーンごとに`is_active = 1`は1件のみ

#### 3.2.6 `style_presets`

**役割**: 画像生成スタイルプリセット

| カラム名 | 型 | NULL | Default | 説明 |
|---------|-----|------|---------|------|
| id | INTEGER | NO | AUTO_INCREMENT | Primary Key |
| name | TEXT | NO | - | スタイル名 |
| description | TEXT | YES | NULL | 説明 |
| prompt_prefix | TEXT | YES | NULL | プロンプト接頭辞 |
| prompt_suffix | TEXT | YES | NULL | プロンプト接尾辞 |
| negative_prompt | TEXT | YES | NULL | ネガティブプロンプト |
| is_active | INTEGER | NO | 1 | 有効フラグ（0 or 1） |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |
| updated_at | DATETIME | NO | CURRENT_TIMESTAMP | 更新日時 |

**外部キー制約**: なし

**インデックス**:
```sql
CREATE INDEX idx_style_presets_active ON style_presets(is_active)
```

#### 3.2.7 `project_style_settings`

**役割**: プロジェクト全体のデフォルトスタイル設定

| カラム名 | 型 | NULL | Default | 説明 |
|---------|-----|------|---------|------|
| id | INTEGER | NO | AUTO_INCREMENT | Primary Key |
| project_id | INTEGER | NO | - | 外部キー → projects.id |
| default_style_preset_id | INTEGER | YES | NULL | 外部キー → style_presets.id |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |
| updated_at | DATETIME | NO | CURRENT_TIMESTAMP | 更新日時 |

**外部キー制約**:
```sql
FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
FOREIGN KEY (default_style_preset_id) REFERENCES style_presets(id) ON DELETE SET NULL
CREATE UNIQUE INDEX idx_project_style_unique ON project_style_settings(project_id)
```

#### 3.2.8 `scene_style_settings`

**役割**: シーンごとの個別スタイル設定（プロジェクトデフォルトをオーバーライド）

| カラム名 | 型 | NULL | Default | 説明 |
|---------|-----|------|---------|------|
| id | INTEGER | NO | AUTO_INCREMENT | Primary Key |
| scene_id | INTEGER | NO | - | 外部キー → scenes.id |
| style_preset_id | INTEGER | YES | NULL | 外部キー → style_presets.id |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |
| updated_at | DATETIME | NO | CURRENT_TIMESTAMP | 更新日時 |

**外部キー制約**:
```sql
FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
FOREIGN KEY (style_preset_id) REFERENCES style_presets(id) ON DELETE SET NULL
CREATE UNIQUE INDEX idx_scene_style_unique ON scene_style_settings(scene_id)
```

**重要**: シーンごとに1件のみ（UNIQUE制約）

**使用方法**:
- `scenes`テーブルには`style_preset_id`カラムは**存在しない**
- スタイル設定は`scene_style_settings`テーブルで管理
- APIでは`LEFT JOIN scene_style_settings`で取得
- NULL の場合はプロジェクトデフォルトスタイルを使用

#### 3.2.9 `runs`

**役割**: Run管理（Phase B - 複数バージョン管理）

| カラム名 | 型 | NULL | Default | 説明 |
|---------|-----|------|---------|------|
| id | INTEGER | NO | AUTO_INCREMENT | Primary Key |
| project_id | INTEGER | NO | - | 外部キー → projects.id |
| run_no | INTEGER | NO | - | Run番号（1始まり） |
| state | TEXT | NO | 'draft' | 状態 |
| source_type | TEXT | YES | NULL | 'audio' or 'text' |
| source_text | TEXT | YES | NULL | テキストソース |
| audio_r2_key | TEXT | YES | NULL | 音声R2キー |
| audio_filename | TEXT | YES | NULL | 音声ファイル名 |
| audio_size_bytes | INTEGER | YES | NULL | 音声サイズ |
| audio_duration_seconds | INTEGER | YES | NULL | 音声時間 |
| transcription_text | TEXT | YES | NULL | 文字起こし結果 |
| status | TEXT | NO | 'created' | 処理ステータス |
| error_message | TEXT | YES | NULL | エラーメッセージ |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |
| updated_at | DATETIME | NO | CURRENT_TIMESTAMP | 更新日時 |

**外部キー制約**:
```sql
FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
CREATE UNIQUE INDEX idx_runs_project_no ON runs(project_id, run_no)
```

---

## 3.3 データベース設計上の問題点

### ✅ 解決済み: `scene_style_settings`テーブルの正常動作

**状況**: 
- `scene_style_settings`テーブルは正しく作成されている
- `scenes`テーブルには`style_preset_id`カラムは**存在しない**
- APIでは`LEFT JOIN scene_style_settings`で正しく取得している

**結論**: 問題なし。設計通りに動作している。

### ⚠️ 問題2: `r2_url`カラムの冗長性

**状況**:
- `image_generations.r2_url`は`r2_key`から動的に生成可能
- データベースに保存する必要性が低い

**推奨対応**:
1. `r2_url`カラムを廃止
2. APIレスポンスで`r2_key`から動的に`image_url`を生成

### ⚠️ 問題3: NULL制約の不統一

**状況**:
- 一部のテーブルでNULL制約が緩い
- 例: `projects.source_type`はNULL許可だが、実際は'audio'か'text'であるべき

**推奨対応**:
1. 必須カラムにはNOT NULL制約を追加
2. CHECK制約で値の範囲を制限（D1でサポートされている場合）

---

## 4. API設計

### 4.1 APIエンドポイント一覧

| カテゴリ | メソッド | パス | 説明 |
|---------|---------|------|------|
| **Projects** | GET | `/api/projects` | プロジェクト一覧取得 |
| | GET | `/api/projects/:id` | プロジェクト詳細取得 |
| | POST | `/api/projects` | 新規プロジェクト作成 |
| | PUT | `/api/projects/:id` | プロジェクト更新 |
| | DELETE | `/api/projects/:id` | プロジェクト削除 |
| **Transcription** | POST | `/api/projects/:id/upload` | 音声アップロード |
| | POST | `/api/projects/:id/transcribe` | 文字起こし実行 |
| | GET | `/api/projects/:id/transcription` | 文字起こし結果取得 |
| **Parsing** | POST | `/api/projects/:id/parse` | テキストパース実行 |
| | GET | `/api/projects/:id/text_chunks` | テキストチャンク一覧 |
| **Formatting** | POST | `/api/projects/:id/format` | シーン分割実行 |
| | GET | `/api/projects/:id/format/status` | シーン分割進捗取得 |
| | POST | `/api/projects/:id/merge` | シーンマージ実行 |
| **Scenes** | GET | `/api/projects/:id/scenes` | シーン一覧取得 |
| | GET | `/api/scenes/:id` | シーン詳細取得 |
| | PUT | `/api/scenes/:id` | シーン更新 |
| | DELETE | `/api/scenes/:id` | シーン削除 |
| | POST | `/api/projects/:id/scenes/reorder` | シーン並び替え |
| **Image Generation** | POST | `/api/scenes/:id/generate-image` | 単一シーン画像生成 |
| | POST | `/api/projects/:id/generate-images` | バッチ画像生成 |
| | GET | `/api/projects/:id/generate-images/status` | 画像生成進捗取得 |
| | GET | `/api/scenes/:id/images` | シーン画像履歴取得 |
| | PUT | `/api/images/:id/activate` | 画像をアクティブ化 |
| **Images** | GET | `/images/:projectId/scene_:sceneIdx/:imageId_:timestamp.png` | R2画像アクセス |
| **Styles** | GET | `/api/style-presets` | スタイルプリセット一覧 |
| | GET | `/api/style-presets/:id` | スタイルプリセット詳細 |
| | POST | `/api/style-presets` | スタイルプリセット作成 |
| | PUT | `/api/style-presets/:id` | スタイルプリセット更新 |
| | DELETE | `/api/style-presets/:id` | スタイルプリセット削除 |
| | GET | `/api/projects/:id/style-settings` | プロジェクトスタイル取得 |
| | PUT | `/api/projects/:id/style-settings` | プロジェクトスタイル設定 |
| | PUT | `/api/scenes/:id/style` | シーンスタイル設定 |
| | DELETE | `/api/scenes/:id/style` | シーンスタイルクリア |
| **Downloads** | GET | `/api/projects/:id/download/images` | 画像ZIP |
| | GET | `/api/projects/:id/download/csv` | シナリオCSV |
| | GET | `/api/projects/:id/download/all` | 全素材ZIP |
| **Runs** | GET | `/api/projects/:projectId/runs` | Run一覧取得 |
| | POST | `/api/projects/:projectId/runs` | Run作成 |
| | GET | `/api/runs/:runId` | Run詳細取得 |
| | DELETE | `/api/runs/:runId` | Run削除 |
| | POST | `/api/runs/:runId/parse` | Run Parse実行 |
| | POST | `/api/runs/:runId/format` | Run Format実行 |
| | POST | `/api/runs/:runId/generate-images` | Run画像生成 |
| | GET | `/api/runs/:runId/scenes` | Runシーン一覧 |

### 4.2 主要APIの詳細仕様

#### 4.2.1 プロジェクト作成

**エンドポイント**: `POST /api/projects`

**リクエスト**:
```json
{
  "title": "テストプロジェクト"
}
```

**レスポンス**:
```json
{
  "id": 26,
  "title": "テストプロジェクト",
  "status": "created",
  "source_type": null,
  "created_at": "2025-12-19T08:59:41.000Z"
}
```

#### 4.2.2 音声アップロード

**エンドポイント**: `POST /api/projects/:id/upload`

**リクエスト**: `multipart/form-data`
- `audio`: 音声ファイル（最大25MB）

**レスポンス**:
```json
{
  "success": true,
  "project_id": 26,
  "r2_key": "audio/26/original_1766153981234.wav",
  "filename": "recording.wav",
  "size_bytes": 1234567,
  "duration_seconds": 120
}
```

#### 4.2.3 シーン分割実行

**エンドポイント**: `POST /api/projects/:id/format`

**リクエスト**: なし

**レスポンス**:
```json
{
  "success": true,
  "batch_processed": 3,
  "batch_failed": 0,
  "total_chunks": 16,
  "processed": 3,
  "pending": 13,
  "failed": 0,
  "processing": 0
}
```

#### 4.2.4 シーン分割進捗取得

**エンドポイント**: `GET /api/projects/:id/format/status`

**レスポンス**:
```json
{
  "status": "formatting",
  "total_chunks": 16,
  "processed": 6,
  "failed": 0,
  "processing": 0,
  "pending": 10
}
```

#### 4.2.5 シーン一覧取得

**エンドポイント**: `GET /api/projects/:id/scenes?view={edit|board}`

**クエリパラメータ**:
- `view=edit`: 軽量版（画像情報なし）
- `view=board`: Builder用（最小画像情報のみ）

**レスポンス（view=board）**:
```json
{
  "project_id": 26,
  "total_scenes": 48,
  "scenes": [
    {
      "id": 166,
      "idx": 1,
      "role": "hook",
      "title": "事業概要",
      "dialogue": "関節整体サロン...",
      "bullets": ["高付加価値", "高満足度"],
      "image_prompt": "Modern wellness spa...",
      "style_preset_id": 9,
      "active_image": {
        "image_url": "/images/26/scene_1/117_1766154019961.png"
      },
      "latest_image": {
        "status": "completed",
        "error_message": null
      }
    }
  ]
}
```

#### 4.2.6 単一シーン画像生成

**エンドポイント**: `POST /api/scenes/:id/generate-image`

**リクエスト**: なし

**レスポンス**:
```json
{
  "success": true,
  "scene_id": 166,
  "image_id": 117,
  "r2_key": "images/26/scene_1/117_1766154019961.png",
  "status": "completed"
}
```

#### 4.2.7 バッチ画像生成

**エンドポイント**: `POST /api/projects/:id/generate-images`

**リクエスト**:
```json
{
  "filter": "all" | "pending" | "failed"
}
```

**レスポンス**:
```json
{
  "success": true,
  "successCount": 5,
  "failedCount": 0,
  "skippedCount": 0,
  "totalProcessed": 5
}
```

#### 4.2.8 画像生成進捗取得

**エンドポイント**: `GET /api/projects/:id/generate-images/status`

**レスポンス**:
```json
{
  "project_id": 26,
  "status": "generating_images",
  "total_scenes": 48,
  "processed": 37,
  "failed": 0,
  "generating": 1,
  "pending": 10
}
```

---

## 4.3 API設計上の問題点

### ⚠️ 問題1: `r2_url`の返却方法の不統一

**状況**:
- 一部のAPIは`r2_url`を返す
- 一部のAPIは`r2_key`を返す
- フロントエンドで`image_url`として使用

**推奨対応**:
1. 全APIで`r2_key`のみを返す
2. フロントエンドで`/images/${r2_key}`として構築
3. または、全APIで`image_url`として返す（統一）

### ⚠️ 問題2: エラーレスポンスフォーマットの不統一

**状況**:
- 一部のAPIは`{ error: "...", message: "..." }`
- 一部のAPIは`{ success: false, error: "..." }`

**推奨対応**:
1. 統一フォーマットを定義
```json
{
  "success": false,
  "error": "ERROR_CODE",
  "message": "Human-readable error message",
  "details": {}
}
```

### ⚠️ 問題3: Concurrent処理の競合

**状況**:
- バッチ画像生成中に個別画像生成が可能（修正済み）
- 同一シーンで複数の画像生成が同時実行される可能性

**対応済み**:
- フロントエンド: `window.isBulkImageGenerating`フラグで制御
- バックエンド: HTTP 409 Conflictで重複生成を拒否

---

## 5. フロントエンド-バックエンド連携

### 5.1 主要JavaScriptファイル

| ファイル | 役割 | 行数 |
|---------|------|------|
| `/static/app.js` | トップページ（プロジェクト一覧） | ~500行 |
| `/static/project-editor.js` | プロジェクトエディタ（全タブ） | ~2500行 |

### 5.2 主要グローバル変数

**project-editor.js**:
```javascript
const PROJECT_ID = <dynamic>;  // HTMLから注入
const API_BASE = '';           // 相対パス
let isProcessing = false;      // グローバル処理中フラグ
let sceneProcessing = {};      // シーンごとの処理中フラグ
let window.isBulkImageGenerating = false;  // バッチ画像生成中フラグ
let window.builderProjectDefaultStyle = null;  // プロジェクトデフォルトスタイル
let ALL_STYLE_PRESETS = [];    // 全スタイルプリセット
```

### 5.3 API呼び出しパターン

#### パターン1: 単純なGET
```javascript
async function loadProject() {
  const response = await axios.get(`${API_BASE}/api/projects/${PROJECT_ID}`);
  const project = response.data;
  // ...
}
```

#### パターン2: POSTでデータ送信
```javascript
async function createProject() {
  const response = await axios.post(`${API_BASE}/api/projects`, {
    title: document.getElementById('projectTitle').value
  });
  // ...
}
```

#### パターン3: ファイルアップロード
```javascript
async function uploadAudio() {
  const formData = new FormData();
  formData.append('audio', audioFile);
  
  const response = await axios.post(
    `${API_BASE}/api/projects/${PROJECT_ID}/upload`,
    formData,
    {
      headers: { 'Content-Type': 'multipart/form-data' }
    }
  );
  // ...
}
```

#### パターン4: ポーリング
```javascript
async function startFormatPolling() {
  const pollInterval = setInterval(async () => {
    const response = await axios.get(
      `${API_BASE}/api/projects/${PROJECT_ID}/format/status`
    );
    
    if (response.data.status === 'formatted') {
      clearInterval(pollInterval);
      onFormatComplete();
    }
  }, 5000);  // 5秒ごと
}
```

### 5.4 フロントエンド-バックエンド連携上の問題点

### ⚠️ 問題1: APIレスポンスのフィールド名不一致

**状況**:
- バックエンド: `r2_key`を返す
- フロントエンド: `image_url`として期待

**例**（project-editor.js Line 1248）:
```javascript
const imageUrl = activeImage ? activeImage.image_url : null;
```

**バックエンド（projects.ts Line 403）**:
```typescript
active_image: activeRecord ? { image_url: `/${activeRecord.r2_key}` } : null,
```

**状況確認**: バックエンドは`image_url`として返している → **問題なし**

### ⚠️ 問題2: キャッシュ問題

**状況**:
- ブラウザキャッシュでAPIレスポンスが古い
- UIが更新されない

**対応済み**（project-editor.js Line 1097）:
```javascript
const response = await axios.get(
  `${API_BASE}/api/projects/${PROJECT_ID}/scenes?view=board&_t=${Date.now()}`
);
```

### ⚠️ 問題3: グローバル変数の名前空間汚染

**状況**:
- `isProcessing`, `sceneProcessing`などがグローバルスコープ
- 複数タブで同時実行すると衝突の可能性

**推奨対応**:
```javascript
const AppState = {
  isProcessing: false,
  sceneProcessing: {},
  isBulkImageGenerating: false,
  // ...
};
```

---

## 6. 依存関係マップ

### 6.1 データフロー図

```
[User Input (Audio/Text)]
    ↓
[POST /api/projects] → projects.created
    ↓
[POST /api/projects/:id/upload] → projects.uploaded + R2
    ↓
[POST /api/projects/:id/transcribe] → transcriptions + projects.transcribed
    ↓
[POST /api/projects/:id/parse] → text_chunks + projects.parsed
    ↓
[POST /api/projects/:id/format] → scenes + projects.formatting
    (ポーリング: GET /api/projects/:id/format/status)
    ↓
[Auto Merge] → scenes (idx正規化) + projects.formatted
    ↓
[POST /api/projects/:id/generate-images] → image_generations + projects.generating_images
    (ポーリング: GET /api/projects/:id/generate-images/status)
    ↓
projects.completed
    ↓
[GET /api/projects/:id/download/*] → ZIP/CSV
```

### 6.2 テーブル依存関係

```
projects (root)
  ├── transcriptions (1:1)
  ├── text_chunks (1:N)
  ├── scenes (1:N)
  │   ├── image_generations (1:N)
  │   └── style_preset_id → style_presets
  ├── project_style_settings (1:1)
  │   └── default_style_preset_id → style_presets
  └── runs (1:N)
      ├── text_chunks.run_id
      └── scenes.run_id

style_presets (standalone)
```

### 6.3 モジュール依存関係

**バックエンド**:
```
src/index.tsx (main)
  ├── routes/projects.ts
  ├── routes/transcriptions.ts
  ├── routes/parsing.ts
  ├── routes/formatting.ts
  ├── routes/image-generation.ts
  ├── routes/scenes.ts
  ├── routes/images.ts
  ├── routes/downloads.ts
  ├── routes/styles.ts
  ├── routes/runs.ts
  └── routes/runs-v2.ts
```

**フロントエンド**:
```
public/static/app.js (トップページ)
public/static/project-editor.js (エディタ)
```

---

## 7. 検出された問題点

### 7.1 データベース設計

| ID | 問題 | 重要度 | 対応状況 |
|----|------|--------|---------|
| DB-1 | `scene_style_settings`テーブルの存在確認 | 中 | ✅ 解決済み |
| DB-2 | `r2_url`カラムの冗長性 | 低 | 未対応 |
| DB-3 | NULL制約の不統一 | 中 | 未対応 |
| DB-4 | CHECK制約の欠如（status値など） | 低 | 未対応 |

### 7.2 API設計

| ID | 問題 | 重要度 | 対応状況 |
|----|------|--------|---------|
| API-1 | `r2_url`の返却方法の不統一 | 低 | 部分対応 |
| API-2 | エラーレスポンスフォーマットの不統一 | 中 | 未対応 |
| API-3 | Concurrent処理の競合 | 高 | ✅ 対応済み |
| API-4 | ポーリングの自動再開欠如 | 高 | ✅ 対応済み |

### 7.3 フロントエンド

| ID | 問題 | 重要度 | 対応状況 |
|----|------|--------|---------|
| FE-1 | グローバル変数の名前空間汚染 | 中 | 未対応 |
| FE-2 | キャッシュ問題 | 高 | ✅ 対応済み |
| FE-3 | エラーハンドリングの不統一 | 中 | 未対応 |

### 7.4 ドキュメント

| ID | 問題 | 重要度 | 対応状況 |
|----|------|--------|---------|
| DOC-1 | DB設計書が古い | 中 | 本ドキュメントで対応 |
| DOC-2 | API仕様書が古い | 中 | 本ドキュメントで対応 |
| DOC-3 | フロントエンド仕様書が存在しない | 低 | 未対応 |

---

## 8. 推奨事項

### 8.1 即座に対応すべき項目（高優先度）

#### 1. Concurrent処理の完全保護 ✅ 完了
- [x] バッチ処理中の個別ボタン無効化
- [x] API側での重複生成チェック

#### 2. ポーリングの自動再開 ✅ 完了
- [x] ページリロード時の自動再開
- [x] 進捗状況の永続化

### 8.2 短期的に対応すべき項目（中優先度）

#### 1. エラーレスポンスの統一
**推奨フォーマット**:
```json
{
  "success": false,
  "error": "ERROR_CODE",
  "message": "Human-readable message",
  "details": {}
}
```

#### 2. NULL制約の整理
**対応方法**:
1. 必須カラムにNOT NULL制約追加
2. マイグレーションファイル作成

### 8.3 長期的に対応すべき項目（低優先度）

#### 1. `r2_url`カラムの廃止
**対応方法**:
1. マイグレーションで`r2_url`カラムを削除
2. API側で`r2_key`から動的に`image_url`を生成

#### 2. グローバル変数の名前空間化
**対応方法**:
```javascript
const AppState = {
  // ...
};
Object.freeze(AppState);
```

#### 3. CHECK制約の追加
**対応方法**:
```sql
ALTER TABLE projects ADD CONSTRAINT chk_status 
  CHECK (status IN ('created', 'uploaded', 'transcribing', ...));
```

---

## 9. 補足資料

### 9.1 マイグレーションファイル一覧

1. `0001_initial_schema.sql` - 初期テーブル作成
2. `0002_add_source_type.sql` - source_type追加
3. `0003_add_error_tracking.sql` - エラー追跡
4. `0004_add_text_chunks.sql` - text_chunksテーブル
5. `0005_format_chunked_processing.sql` - チャンク処理
6. `0006_extend_error_message.sql` - error_message拡張
7. `0007_add_runs_system.sql` - runs機能
8. `0008_add_style_presets.sql` - スタイルプリセット

### 9.2 関連ドキュメント

- `docs/04_DB_SCHEMA.md` - DB設計書（本ドキュメントで更新）
- `docs/05_API_SPEC.md` - API仕様書（本ドキュメントで更新）
- `docs/10_INPUT_PROCESSING.md` - 入力処理フロー
- `docs/11_PROGRESS_AND_RECOVERY_REVIEW.md` - 進捗管理とリカバリー

---

## 10. 検証チェックリスト

### 10.1 データベース検証

- [x] 全テーブルが存在するか確認
- [x] 外部キー制約が正しく設定されているか確認
- [x] インデックスが適切に設定されているか確認
- [x] `scene_style_settings`テーブルの存在確認 ✅

### 10.2 API検証

- [ ] 全エンドポイントが正常に動作するか確認
- [ ] エラーレスポンスが統一されているか確認
- [ ] 並行処理が正しく制御されているか確認

### 10.3 フロントエンド検証

- [ ] 全タブが正常に動作するか確認
- [ ] API呼び出しが正しいか確認
- [ ] エラーハンドリングが適切か確認

---

**最終更新**: 2025-12-20  
**レビュアー**: AI Assistant  
**承認**: （承認者名）
