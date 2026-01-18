# Video Build Architecture (Phase R0)

## 1. システム概要

Video Build は、複数のシーンを1本の動画に合算してレンダリングするシステムです。
AWS Lambda 上で動作する Remotion を使用して動画を生成します。

## 2. アーキテクチャ図

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Cloudflare Pages                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐           │
│  │   Frontend UI    │───▶│  Hono API Routes │───▶│    D1 Database   │           │
│  │  (project-editor)│    │ (video-generation)│    │  (video_builds)  │           │
│  └──────────────────┘    └────────┬─────────┘    └──────────────────┘           │
│                                   │                                              │
│                                   ▼                                              │
│                          ┌──────────────────┐    ┌──────────────────┐           │
│                          │  R2 Storage      │    │ video-build-     │           │
│                          │  (project.json)  │    │ helpers.ts       │           │
│                          └──────────────────┘    │ - validateAssets │           │
│                                                  │ - buildProjectJson│           │
│                                                  └──────────────────┘           │
└────────────────────────────────────┬────────────────────────────────────────────┘
                                     │
                                     │ POST /start
                                     │ GET /status/{buildId}
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         AWS API Gateway (prod)                                   │
│                https://sddd2nwesf.execute-api.ap-northeast-1.amazonaws.com/prod │
└────────────────────────────────────┬────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              AWS Lambda                                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐           │
│  │  Start Handler   │───▶│    SQS Queue     │───▶│  Worker Lambda   │           │
│  │  (入力検証)      │    │  (非同期処理)    │    │  (Remotion実行)  │           │
│  └──────────────────┘    └──────────────────┘    └────────┬─────────┘           │
│                                                           │                      │
│                                   ┌───────────────────────┘                      │
│                                   │                                              │
│                                   ▼                                              │
│                          ┌──────────────────┐    ┌──────────────────┐           │
│                          │    DynamoDB      │◀───│    S3 Bucket     │           │
│                          │ (rilarc-video-   │    │ (rilarc-remotion-│           │
│                          │  jobs)           │    │  renders-prod)   │           │
│                          └──────────────────┘    └──────────────────┘           │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 3. データフロー

### 3.1 Video Build 開始フロー

```
1. [UI] Start Video Build ボタンクリック
      │
      ▼
2. [API] POST /api/projects/:projectId/video-builds
      │
      ├─▶ 認証確認（session cookie）
      ├─▶ 二重実行チェック（activeステータスのビルドがないか）
      ├─▶ シーンデータ取得（display_asset_type + 素材情報）
      │
      ▼
3. [Helper] validateProjectAssets()
      │
      ├─▶ display_asset_type='image' → active_image.r2_url 必須
      ├─▶ display_asset_type='comic' → active_comic.r2_url 必須
      ├─▶ display_asset_type='video' → active_video (completed) 必須
      │
      ▼
4. [Helper] buildProjectJson()
      │
      ├─▶ 各シーンの asset.src を SSOT に基づいて選択
      ├─▶ duration_ms を計算（音声尺 or デフォルト）
      ├─▶ ken_burns 設定（imageのみ true）
      │
      ▼
5. [D1] video_builds レコード作成（status='validating'）
      │
      ▼
6. [R2] project.json を保存（video-builds/{buildId}/project.json）
      │
      ▼
7. [AWS] POST /start を呼び出し
      │
      ├─▶ video_build_id
      ├─▶ project_id
      ├─▶ owner_user_id / executor_user_id
      ├─▶ project_json（Remotion入力データ）
      ├─▶ build_settings
      │
      ▼
8. [D1] video_builds 更新（status='submitted', aws_job_id 等）
      │
      ▼
9. [API] レスポンス返却（build オブジェクト + preflight結果）
```

### 3.2 ステータス更新フロー

```
1. [UI] ポーリング（5秒間隔）
      │
      ▼
2. [API] POST /api/video-builds/:buildId/refresh
      │
      ├─▶ ビルドレコード取得
      │
      ▼
3. [AWS] GET /status/{aws_job_id} を呼び出し
      │
      ├─▶ render_id（オプション）
      ├─▶ output_key（オプション）
      │
      ▼
4. [AWS Response]
      │
      ├─▶ status: 'queued' | 'rendering' | 'completed' | 'failed'
      ├─▶ progress: { percent, stage, message }
      ├─▶ output: { bucket, key, presigned_url }（completed時）
      │
      ▼
5. [D1] video_builds 更新
      │
      ├─▶ status
      ├─▶ progress_percent / progress_stage / progress_message
      ├─▶ download_url（completed時）
      ├─▶ error_code / error_message（failed時）
      │
      ▼
6. [API] レスポンス返却（更新後の build オブジェクト）
```

## 4. エンドポイント仕様

### 4.1 AWS Orchestrator

**Base URL**: `https://sddd2nwesf.execute-api.ap-northeast-1.amazonaws.com/prod`

**重要**: URL正規化ルール
- `AWS_ORCH_BASE_URL` が `/prod` で終わっている場合: そのまま `/start` を追加
- `/prod` で終わっていない場合: `/prod/start` を追加
- これにより二重 `/prod/prod/start` を防止

#### POST /start

リクエスト:
```json
{
  "video_build_id": 123,
  "project_id": 456,
  "owner_user_id": 1,
  "executor_user_id": 2,
  "is_delegation": false,
  "project_json": {
    "version": "1.1",
    "project_id": 456,
    "project_title": "プロジェクト名",
    "output": {
      "aspect_ratio": "9:16",
      "fps": 30,
      "resolution": "1080p"
    },
    "global": {
      "captions": { "enabled": true, "position": "bottom" },
      "bgm": { "enabled": false },
      "motion": { "preset": "gentle-zoom", "transition": "crossfade" }
    },
    "scenes": [...],
    "total_duration_ms": 15000,
    "created_at": "2026-01-18T..."
  },
  "build_settings": {
    "captions": { "enabled": true },
    "bgm": { "enabled": false },
    "motion": { "preset": "gentle-zoom" }
  }
}
```

レスポンス（成功）:
```json
{
  "success": true,
  "aws_job_id": "job-abc123",
  "remotion": {
    "render_id": "render-xyz789",
    "site_name": "rilarc-remotion-site"
  },
  "output": {
    "bucket": "rilarc-remotion-renders-prod-202601",
    "key": "video-builds/owner-1/video-build-123.mp4"
  }
}
```

#### GET /status/{buildId}

クエリパラメータ:
- `render_id`: Remotion render ID（オプション）
- `output_key`: S3 output key（オプション）

レスポンス:
```json
{
  "success": true,
  "status": "rendering",
  "progress": {
    "percent": 45,
    "stage": "Encoding",
    "message": "フレームをエンコード中..."
  }
}
```

レスポンス（完了時）:
```json
{
  "success": true,
  "status": "completed",
  "progress": { "percent": 100, "stage": "Complete" },
  "output": {
    "bucket": "rilarc-remotion-renders-prod-202601",
    "key": "video-builds/owner-1/video-build-123.mp4",
    "presigned_url": "https://...",
    "size_bytes": 12345678,
    "duration_ms": 15000
  },
  "render_metadata": {
    "render_id": "render-xyz789",
    "started_at": "2026-01-18T10:00:00Z",
    "completed_at": "2026-01-18T10:05:00Z",
    "duration_sec": 300
  }
}
```

### 4.2 Cloudflare API

| Endpoint | Method | 説明 |
|----------|--------|------|
| `/api/video-builds/usage` | GET | 利用状況（daily/concurrent制限） |
| `/api/projects/:id/video-builds/preflight` | GET | Preflight検証 |
| `/api/projects/:id/video-builds` | GET | ビルド一覧 |
| `/api/projects/:id/video-builds` | POST | ビルド開始 |
| `/api/video-builds/:id` | GET | ビルド詳細 |
| `/api/video-builds/:id/refresh` | POST | ステータス更新 |

## 5. データベーススキーマ

### video_builds テーブル

```sql
CREATE TABLE video_builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- Relations
  project_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  executor_user_id INTEGER NOT NULL,
  is_delegation INTEGER DEFAULT 0,
  
  -- Status
  status TEXT NOT NULL DEFAULT 'queued',
  progress_percent REAL DEFAULT 0,
  progress_stage TEXT,
  progress_message TEXT,
  
  -- Settings
  settings_json TEXT NOT NULL,
  project_json_version TEXT DEFAULT '1.1',
  project_json_r2_key TEXT,
  project_json_hash TEXT,
  
  -- AWS
  aws_job_id TEXT,
  remotion_site_name TEXT,
  remotion_render_id TEXT,
  s3_bucket TEXT,
  s3_output_key TEXT,
  
  -- Metrics
  total_scenes INTEGER,
  total_duration_ms INTEGER,
  render_started_at DATETIME,
  render_completed_at DATETIME,
  render_duration_sec INTEGER,
  
  -- Error
  error_code TEXT,
  error_message TEXT,
  
  -- Output
  download_url TEXT,
  
  -- Timestamps
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 6. SSOT（Single Source of Truth）

### 6.1 素材選択のSSOT

| display_asset_type | 必須素材 | Ken Burns |
|--------------------|----------|-----------|
| `image` | `active_image.r2_url` | ✅ 有効 |
| `comic` | `active_comic.r2_url` | ❌ 無効 |
| `video` | `active_video.r2_url` (completed) | ❌ 無効 |

### 6.2 Duration計算のSSOT

| モード | 計算方法 |
|--------|----------|
| `video` | `active_video.duration_sec * 1000` |
| `comic` | `utterances.reduce((sum, u) => sum + u.duration_ms, 0) + PADDING` |
| `image` | `active_audio.duration_ms + PADDING` または `DEFAULT (3000ms)` |

### 6.3 project.json のSSOT

- **編集のSSOT**: ビルド開始時に生成した `project.json` がレンダリングの唯一の入力
- **ハッシュ**: `project_json_hash` で一意性を保証
- **R2保存**: `video-builds/{buildId}/project.json` に保存して復旧可能に

## 7. エラーコード

| Code | 説明 | 対処 |
|------|------|------|
| `UNAUTHORIZED` | 認証切れ | 再ログイン |
| `BUILD_IN_PROGRESS` | 二重実行 | 既存ビルド完了待ち |
| `NO_SCENES` | シーンなし | シーン追加 |
| `PREFLIGHT_FAILED` | 素材不足 | 欠落素材を生成 |
| `AWS_NOT_CONFIGURED` | AWS設定なし | 管理者に連絡 |
| `AWS_START_FAILED` | AWS開始失敗 | リトライ |
| `RENDER_FAILED` | レンダリング失敗 | エラー詳細確認 |

## 8. 今後の拡張

### Phase R1: Preflight 強化
- 音声警告を必須化（オプション）
- 3シーン以上の強制チェック

### Phase R2: Edit Spec
- edit_spec JSON の標準化
- リビジョン管理（edit_spec_version/hash）

### Phase R3: 再レンダリング
- 前回のproject.jsonからの差分検出
- インクリメンタルレンダリング

---

**最終更新**: 2026-01-18
**ドキュメントバージョン**: 1.0
