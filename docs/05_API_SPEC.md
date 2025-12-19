# API仕様書

## 🌐 エンドポイント一覧

### プロジェクト管理
- `POST /api/projects` - プロジェクト作成
- `GET /api/projects` - プロジェクト一覧
- `GET /api/projects/:id` - プロジェクト詳細
- `GET /api/projects/:id/scenes` - シーン一覧

### 入力処理
- `POST /api/projects/:id/upload` - 音声アップロード
- `POST /api/projects/:id/source/text` - テキスト保存
- `POST /api/projects/:id/transcribe` - 文字起こし実行
- `POST /api/projects/:id/parse` - テキスト分割（Parse）

### シナリオ生成
- `POST /api/projects/:id/format` - 整形・シーン分割
- `GET /api/projects/:id/format/status` - フォーマット進捗取得

### 画像生成
- `POST /api/scenes/:id/generate-image` - シーン単体画像生成
- `POST /api/projects/:id/generate-images` - バッチ画像生成
- `GET /api/projects/:id/generate-images/status` - 画像生成進捗取得
- `PUT /api/scenes/:id/image-prompt` - プロンプト更新

### スタイルプリセット
- `GET /api/style-presets` - アクティブなプリセット一覧
- `GET /api/style-presets/:id` - プリセット詳細
- `POST /api/style-presets` - 新規プリセット作成
- `PUT /api/style-presets/:id` - プリセット更新
- `DELETE /api/style-presets/:id` - プリセット削除（ソフトデリート）
- `GET /api/projects/:id/style-settings` - プロジェクトのデフォルトスタイル取得
- `PUT /api/projects/:id/style-settings` - プロジェクトのデフォルトスタイル設定
- `PUT /api/scenes/:id/style` - シーン個別スタイル設定

### エクスポート
- `GET /api/projects/:id/download/images` - 画像ZIP
- `GET /api/projects/:id/download/csv` - セリフCSV
- `GET /api/projects/:id/download/all` - 全ファイルZIP

---

## 📋 API詳細

### POST /api/projects
プロジェクト作成

**Request:**
```json
{
  "title": "AIが変える未来の働き方"
}
```

**Response:** `201 Created`
```json
{
  "id": 1,
  "title": "AIが変える未来の働き方",
  "status": "created",
  "run_id": 1,
  "created_at": "2025-01-19T10:00:00Z"
}
```

---

### POST /api/projects/:id/upload
音声ファイルアップロード

**Request:**
- Content-Type: `multipart/form-data`
- Field: `audio` (File)
- Supported formats: `.mp3`, `.wav`, `.m4a`, `.ogg`, `.webm`
- Max size: 25MB

**Response:** `200 OK`
```json
{
  "id": 1,
  "title": "AIが変える未来の働き方",
  "status": "uploaded",
  "source_type": "audio",
  "audio_filename": "audio_20250119.mp3",
  "audio_size_bytes": 5242880,
  "audio_r2_key": "audio/1/audio_20250119_abc123.mp3",
  "updated_at": "2025-01-19T10:05:00Z"
}
```

---

### POST /api/projects/:id/source/text
テキスト保存

**Request:**
```json
{
  "text": "2030年、あなたの仕事の半分がAIに置き換わる。これは脅威ではなく、新しい可能性の扉だ..."
}
```

**Response:** `200 OK`
```json
{
  "id": 1,
  "title": "テスト２",
  "status": "uploaded",
  "source_type": "text",
  "source_updated_at": "2025-01-19T10:05:00Z",
  "updated_at": "2025-01-19T10:05:00Z"
}
```

---

### POST /api/projects/:id/transcribe
文字起こし実行（音声のみ）

**Response:** `200 OK`
```json
{
  "project_id": 1,
  "transcription_id": 1,
  "raw_text": "2030年、あなたの仕事の半分がAIに置き換わる...",
  "language": "ja",
  "duration_seconds": 180,
  "word_count": 250,
  "status": "transcribed"
}
```

---

### POST /api/projects/:id/parse
テキスト分割（Parse）

長文を意味単位（500-1500文字）のチャンクに分割します。

**許可されるステータス**: `uploaded`, `transcribed`

**Response:** `200 OK`
```json
{
  "project_id": 1,
  "total_chunks": 16,
  "status": "parsed",
  "chunks": [
    {
      "idx": 1,
      "length": 1250,
      "preview": "2030年、あなたの仕事の半分がAIに置き換わる。これは脅威ではなく、新しい可能性の扉だ..."
    },
    {
      "idx": 2,
      "length": 980,
      "preview": "AIによる業務効率化は、これまで人間が行っていた反復作業を自動化します..."
    }
  ]
}
```

---

### POST /api/projects/:id/format
整形・シーン分割

**許可されるステータス**: `parsed`, `formatting`

**動作**:
- `parsed`状態の場合: 未処理のチャンクを最大3件処理
- `formatting`状態の場合: 残りのチャンクを最大3件処理
- すべてのチャンクが`done`になったら自動的にシーンをマージし、ステータスを`formatted`に更新

**Response（処理中）:** `200 OK`
```json
{
  "project_id": 1,
  "status": "formatting",
  "batches_processed": 3,
  "batches_failed": 0,
  "total_chunks": 16,
  "processed": 9,
  "failed": 0,
  "pending": 7
}
```

**Response（完了時）:** `200 OK`
```json
{
  "project_id": 1,
  "total_scenes": 48,
  "status": "formatted",
  "message": "All chunks processed successfully, 48 scenes merged"
}
```

---

### GET /api/projects/:id/format/status
フォーマット進捗取得

**Response:** `200 OK`
```json
{
  "project_id": 1,
  "status": "formatting",
  "total_chunks": 16,
  "processed": 9,
  "failed": 0,
  "processing": 0,
  "pending": 7
}
```

---

### POST /api/scenes/:id/generate-image
画像生成

**Request (optional):**
```json
{
  "prompt": "Modern office with holographic AI interfaces..." // プロンプト上書き
}
```

**Response:** `200 OK`
```json
{
  "id": 1,
  "scene_id": 1,
  "prompt": "Japanese anime style, vibrant colors... Modern office with holographic AI interfaces... high quality, detailed, 4K resolution",
  "status": "generating",
  "provider": "gemini",
  "model": "gemini-3-pro-image-preview",
  "is_active": true
}
```

**自動再試行:**
- 429エラー時は指数バックオフで最大3回再試行
- 再試行間隔: 1秒 → 2秒 → 4秒

---

### POST /api/projects/:id/generate-images
バッチ画像生成

**動作**:
- 未生成のシーンを1件ずつ処理（`BATCH_SIZE=1`）
- 5分以上`generating`状態のレコードは自動的に`failed`に更新
- すべてのシーンが生成完了したらプロジェクトステータスを`completed`に更新

**Response（処理中）:** `200 OK`
```json
{
  "project_id": 1,
  "status": "generating_images",
  "batch_processed": 1,
  "batch_failed": 0,
  "total": 48,
  "processed": 4,
  "generating": 0,
  "pending": 44,
  "failed": 0
}
```

**Response（完了時）:** `200 OK`
```json
{
  "project_id": 1,
  "status": "completed",
  "total": 48,
  "processed": 48,
  "generating": 0,
  "pending": 0,
  "failed": 0,
  "message": "All images generated"
}
```

---

### GET /api/projects/:id/generate-images/status
画像生成進捗取得

**Response:** `200 OK`
```json
{
  "project_id": 1,
  "status": "generating_images",
  "total": 48,
  "processed": 25,
  "generating": 1,
  "pending": 22,
  "failed": 0
}
```

---

### PUT /api/scenes/:id/image-prompt
プロンプト更新

**Request:**
```json
{
  "image_prompt": "Futuristic cityscape with flying cars and neon lights at night"
}
```

**Response:** `200 OK`
```json
{
  "scene_id": 1,
  "image_prompt": "Futuristic cityscape with flying cars and neon lights at night",
  "updated_at": "2025-01-19T10:30:00Z"
}
```

---

### GET /api/style-presets
アクティブなスタイルプリセット一覧

**Response:** `200 OK`
```json
{
  "style_presets": [
    {
      "id": 1,
      "name": "日本アニメ風",
      "description": "YouTube向けの明るく親しみやすいアニメスタイル",
      "prompt_prefix": "Japanese anime style, vibrant colors, clear outlines, cel-shaded, ",
      "prompt_suffix": ", saturated colors, clean composition, bright lighting, anime aesthetic",
      "negative_prompt": "realistic, photographic, dark, muddy colors, blurry, low quality",
      "is_active": 1
    },
    {
      "id": 4,
      "name": "日本ジブリアニメ風",
      "description": "ジブリ作品のような温かみのあるアニメスタイル",
      "prompt_prefix": "Studio Ghibli anime style, warm colors, detailed backgrounds, ",
      "prompt_suffix": ", hand-drawn aesthetic, whimsical atmosphere, high quality",
      "negative_prompt": "realistic, dark, harsh, cold colors",
      "is_active": 1
    }
  ]
}
```

---

### GET /api/style-presets/:id
スタイルプリセット詳細

**Response:** `200 OK`
```json
{
  "id": 1,
  "name": "日本アニメ風",
  "description": "YouTube向けの明るく親しみやすいアニメスタイル",
  "prompt_prefix": "Japanese anime style, vibrant colors, clear outlines, cel-shaded, ",
  "prompt_suffix": ", saturated colors, clean composition, bright lighting, anime aesthetic",
  "negative_prompt": "realistic, photographic, dark, muddy colors, blurry, low quality",
  "is_active": 1
}
```

---

### POST /api/style-presets
新規スタイルプリセット作成

**Request:**
```json
{
  "name": "リアル写真風",
  "description": "写実的な写真スタイル",
  "prompt_prefix": "Photorealistic, professional photography, ",
  "prompt_suffix": ", high resolution, natural lighting, 8K quality",
  "negative_prompt": "cartoon, anime, illustration, painting, drawing"
}
```

**Response:** `201 Created`
```json
{
  "id": 7,
  "name": "リアル写真風",
  "description": "写実的な写真スタイル",
  "prompt_prefix": "Photorealistic, professional photography, ",
  "prompt_suffix": ", high resolution, natural lighting, 8K quality",
  "negative_prompt": "cartoon, anime, illustration, painting, drawing",
  "is_active": 1
}
```

---

### PUT /api/style-presets/:id
スタイルプリセット更新

**Request:**
```json
{
  "name": "日本ジブリアニメ風（更新版）",
  "description": "ジブリ作品のような温かみのあるアニメスタイル",
  "prompt_prefix": "Studio Ghibli anime style, warm colors, detailed backgrounds, ",
  "prompt_suffix": ", hand-drawn aesthetic, whimsical atmosphere, high quality",
  "negative_prompt": "realistic, dark, harsh, cold colors",
  "is_active": 1
}
```

**Response:** `200 OK`
```json
{
  "id": 4,
  "name": "日本ジブリアニメ風（更新版）",
  "description": "ジブリ作品のような温かみのあるアニメスタイル",
  "prompt_prefix": "Studio Ghibli anime style, warm colors, detailed backgrounds, ",
  "prompt_suffix": ", hand-drawn aesthetic, whimsical atmosphere, high quality",
  "negative_prompt": "realistic, dark, harsh, cold colors",
  "is_active": 1
}
```

---

### DELETE /api/style-presets/:id
スタイルプリセット削除（ソフトデリート）

**Response:** `200 OK`
```json
{
  "success": true,
  "message": "Style preset deleted successfully"
}
```

**Note**: 物理削除ではなく、`is_active=0`に更新されます。

---

### GET /api/projects/:id/style-settings
プロジェクトのデフォルトスタイル取得

**Response:** `200 OK`
```json
{
  "default_style_preset_id": 4,
  "default_preset_name": "日本ジブリアニメ風",
  "available_presets": [
    {
      "id": 1,
      "name": "日本アニメ風",
      "description": "YouTube向けの明るく親しみやすいアニメスタイル"
    },
    {
      "id": 4,
      "name": "日本ジブリアニメ風",
      "description": "ジブリ作品のような温かみのあるアニメスタイル"
    }
  ]
}
```

---

### PUT /api/projects/:id/style-settings
プロジェクトのデフォルトスタイル設定

**Request:**
```json
{
  "default_style_preset_id": 4
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "default_style_preset_id": 4
}
```

**Note**: `null`を指定するとデフォルトスタイルを解除できます。

---

### PUT /api/scenes/:id/style
シーン個別スタイル設定

**Request:**
```json
{
  "style_preset_id": 2
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "scene_id": 110,
  "style_preset_id": 2
}
```

**Note**: 
- `null`を指定するとシーン個別スタイルを解除し、プロジェクトデフォルトに戻ります。
- 画像生成時の優先順位: `scene_style_settings > project_style_settings > none`

---

### GET /api/projects/:id/scenes
シーン一覧取得

**Query Parameters:**
- `view=edit`: 軽量版（画像情報なし）
- `view=board`: Builder用（最小画像情報）
- デフォルト: 完全版（後方互換）

**Response (view=board):** `200 OK`
```json
{
  "project_id": 23,
  "total_scenes": 48,
  "scenes": [
    {
      "id": 110,
      "idx": 1,
      "role": "hook",
      "title": "衝撃の未来予測",
      "dialogue": "2030年、あなたの仕事の半分がAIに...",
      "bullets": ["2030年の労働市場", "AIの影響範囲"],
      "image_prompt": "Modern office with holographic AI interfaces...",
      "style_preset_id": 4,
      "active_image": {
        "image_url": "/images/23/scene_1/59_1765990138338.png"
      },
      "latest_image": {
        "status": "completed",
        "error_message": null
      }
    }
  ]
}
```

---

### GET /api/projects/:id/download/images
画像ZIP

**Response:** `200 OK`
- Content-Type: `application/zip`
- Content-Disposition: `attachment; filename="project_1_images.zip"`

**ZIP構造:**
```
project_1_images.zip
├── scene_001.png
├── scene_002.png
└── scene_048.png
```

---

### GET /api/projects/:id/download/csv
セリフCSV

**Response:** `200 OK`
- Content-Type: `text/csv; charset=utf-8`

**CSV形式:**
```csv
idx,role,title,dialogue,bullets
1,hook,衝撃の未来予測,"2030年、あなたの...","要点1|要点2"
2,context,AIの現状,"現在、AIは既に...","現状|課題"
```

---

### GET /api/projects/:id/download/all
全ファイルZIP

**Response:** `200 OK`
- Content-Type: `application/zip`

**ZIP構造:**
```
project_1_all.zip
├── images/
│   ├── scene_001.png
│   ├── scene_002.png
│   └── scene_048.png
└── dialogue.csv
```

---

## 🔐 エラーレスポンス形式

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Title is required",
    "details": {
      "field": "title"
    }
  }
}
```

### エラーコード
| コード | HTTPステータス | 説明 |
|-------|--------------|------|
| VALIDATION_ERROR | 400 | バリデーションエラー |
| INVALID_STATUS | 400 | 不正なプロジェクトステータス |
| NOT_FOUND | 404 | リソースが存在しない |
| RATE_LIMIT | 429 | レート制限超過 |
| EXTERNAL_API_ERROR | 500 | 外部APIエラー |
| INTERNAL_ERROR | 500 | 内部エラー |
| POLICY_VIOLATION | 400 | ポリシー違反 |

---

## 🔄 ワークフロー例

### テキスト入力の完全フロー
```
1. POST /api/projects (title="AIの未来")
2. POST /api/projects/1/source/text (text="長文...")
3. POST /api/projects/1/parse (status: uploaded → parsed)
4. POST /api/projects/1/format (chunk単位処理、複数回呼び出し)
5. GET /api/projects/1/format/status (進捗確認)
6. POST /api/projects/1/format (すべてのchunkが完了するまで繰り返し)
   → status: formatted
7. PUT /api/projects/1/style-settings (default_style_preset_id=4)
8. POST /api/projects/1/generate-images (バッチ生成開始)
9. GET /api/projects/1/generate-images/status (進捗確認)
10. POST /api/projects/1/generate-images (pending > 0 なら繰り返し)
    → status: completed
11. GET /api/projects/1/download/all
```

### 音声入力の完全フロー
```
1. POST /api/projects (title="AIの未来")
2. POST /api/projects/1/upload (audio file)
3. POST /api/projects/1/transcribe (status: uploaded → transcribed)
4. POST /api/projects/1/parse (status: transcribed → parsed)
5. POST /api/projects/1/format (chunk単位処理、以降はテキストと同じ)
...
```

---

最終更新: 2025-01-19
