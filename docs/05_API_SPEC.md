# API仕様書

## 🌐 エンドポイント一覧

### Phase 1: アップロード
- `POST /api/projects` - プロジェクト作成
- `POST /api/projects/:id/upload` - 音声アップロード

### Phase 2: 文字起こし
- `POST /api/projects/:id/transcribe` - 文字起こし実行

### Phase 3: 整形・分割
- `POST /api/projects/:id/format` - 整形・シーン分割

### Phase 4: 画像生成
- `POST /api/scenes/:id/generate-image` - 画像生成
- `POST /api/projects/:id/generate-all-images` - 一括生成
- `PUT /api/scenes/:id/image-prompt` - プロンプト更新

### Phase 5: ダウンロード
- `GET /api/projects/:id/download/images` - 画像ZIP
- `GET /api/projects/:id/download/csv` - セリフCSV
- `GET /api/projects/:id/download/all` - 全ファイルZIP

### 共通
- `GET /api/projects` - プロジェクト一覧
- `GET /api/projects/:id` - プロジェクト詳細
- `GET /api/projects/:id/scenes` - シーン一覧

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
  "created_at": "2025-01-13T10:00:00Z"
}
```

---

### POST /api/projects/:id/upload
音声ファイルアップロード

**Request:**
- Content-Type: `multipart/form-data`
- Field: `audio` (File)
- Supported formats: `.mp3`, `.wav`, `.m4a`, `.ogg`
- Max size: 25MB

**Response:** `200 OK`
```json
{
  "id": 1,
  "title": "AIが変える未来の働き方",
  "status": "uploaded",
  "audio_filename": "audio_20250113.mp3",
  "audio_size_bytes": 5242880,
  "audio_r2_key": "audio/1/audio_20250113_abc123.mp3",
  "updated_at": "2025-01-13T10:05:00Z"
}
```

---

### POST /api/projects/:id/transcribe
文字起こし実行

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

### POST /api/projects/:id/format
整形・シーン分割

**Response:** `200 OK`
```json
{
  "project_id": 1,
  "total_scenes": 5,
  "status": "formatted",
  "scenes": [
    {
      "id": 1,
      "idx": 1,
      "role": "hook",
      "title": "衝撃の未来予測",
      "dialogue": "2030年、あなたの仕事の半分がAIに...",
      "bullets": ["2030年の労働市場", "AIの影響範囲"],
      "image_prompt": "Modern office with holographic AI interfaces..."
    }
  ]
}
```

---

### POST /api/scenes/:id/generate-image
画像生成

**Request:**
```json
{
  "prompt": "Modern office with..." // オプション
}
```

**Response:** `200 OK`
```json
{
  "scene_id": 1,
  "image_generation_id": 1,
  "status": "completed",
  "r2_key": "images/1/gen_1_abc123.png",
  "r2_url": "https://signed-url.r2.dev/...",
  "is_active": true
}
```

**自動再試行:**
- 429エラー時は指数バックオフで最大3回再試行
- 再試行間隔: 1秒 → 2秒 → 4秒

---

### POST /api/projects/:id/generate-all-images
一括画像生成

**Request:**
```json
{
  "mode": "all" // "all" | "pending" | "failed"
}
```

**Response:** `202 Accepted`
```json
{
  "project_id": 1,
  "total_scenes": 5,
  "target_scenes": 3,
  "mode": "pending",
  "status": "generating_images"
}
```

---

### PUT /api/scenes/:id/image-prompt
プロンプト更新

**Request:**
```json
{
  "image_prompt": "Futuristic cityscape..."
}
```

**Response:** `200 OK`
```json
{
  "scene_id": 1,
  "image_prompt": "Futuristic cityscape...",
  "updated_at": "2025-01-13T10:30:00Z"
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
└── scene_003.png
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
│   └── scene_002.png
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
| NOT_FOUND | 404 | リソースが存在しない |
| RATE_LIMIT | 429 | レート制限超過 |
| EXTERNAL_API_ERROR | 500 | 外部APIエラー |
| INTERNAL_ERROR | 500 | 内部エラー |
| POLICY_VIOLATION | 400 | ポリシー違反 |

---

最終更新: 2025-01-13
