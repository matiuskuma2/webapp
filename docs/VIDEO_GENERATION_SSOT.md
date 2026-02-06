# 動画生成 SSOT（Single Source of Truth）仕様書

## バージョン
- **Version**: 1.0
- **最終更新**: 2026-02-06
- **ステータス**: 実装完了

---

## 1. SSOT 原則

### 1.1 video_generations テーブルがSSOT
- `video_generations.prompt` が動画生成時のプロンプトを保持
- `video_generations.is_active = 1` が現在のアクティブ動画
- scenes テーブルには prompt を持たせない

### 1.2 保存と生成の分離
| 操作 | API | 結果 |
|------|-----|------|
| プロンプト保存 | `PUT /api/video-generations/:id/prompt` | DB更新のみ、生成しない |
| 再生成 | `POST /api/scenes/:sceneId/video-regenerate` | 新レコード作成 → Veo呼び出し |

---

## 2. データモデル

### 2.1 video_generations テーブル
```sql
CREATE TABLE video_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  provider TEXT DEFAULT 'google_veo',
  model TEXT,                    -- 'veo-2.0-generate-001' | 'veo-3.0-generate-001'
  status TEXT DEFAULT 'pending', -- 'pending' | 'generating' | 'completed' | 'failed'
  duration_sec INTEGER DEFAULT 5,
  prompt TEXT,                   -- ★ SSOT: 生成時のプロンプト
  source_image_r2_key TEXT NOT NULL,
  r2_key TEXT,
  r2_url TEXT,                   -- 完成した動画の公開URL
  error_message TEXT,
  is_active INTEGER DEFAULT 0,   -- ★ SSOT: アクティブ動画フラグ
  job_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### 2.2 インデックス
- `idx_video_generations_scene_active`: (scene_id, is_active)
- `idx_video_generations_scene_status`: (scene_id, status)
- `idx_video_generations_status`: (status)

---

## 3. API 仕様

### 3.1 プロンプト保存（生成なし）
```
PUT /api/video-generations/:id/prompt
```

**Request Body:**
```json
{
  "prompt": "新しいプロンプト文字列"
}
```

**Response:**
```json
{
  "success": true,
  "video_generation": {
    "id": 123,
    "scene_id": 456,
    "prompt": "新しいプロンプト文字列",
    "status": "completed"
  },
  "message": "プロンプトを更新しました（再生成は別途実行してください）"
}
```

**SSOT 保証:**
- `status`, `r2_url`, `is_active` は変更しない
- プロンプトのみ更新

---

### 3.2 動画再生成（新レコード作成）
```
POST /api/scenes/:sceneId/video-regenerate
```

**Request Body:**
```json
{
  "prompt": "オプション: 上書きプロンプト",
  "model": "オプション: veo-2.0-generate-001 | veo-3.0-generate-001",
  "duration_sec": 5
}
```

**プロンプト優先順位:**
1. `body.prompt` （リクエストで指定）
2. `currentActive.prompt` （現在のactive動画のプロンプト）
3. `scene.dialogue` （シーンのセリフ）

**フロー:**
```
1. 新 video_generations INSERT (is_active=0, status='generating')
2. Veo API 呼び出し
3. 成功時:
   - 新レコード is_active=1, status='completed'
   - 旧 active は is_active=0
4. 失敗時:
   - 新レコード status='failed'
   - active 切替なし（事故防止）
```

**Response (成功):**
```json
{
  "success": true,
  "video_generation": {
    "id": 789,
    "scene_id": 456,
    "prompt": "使用されたプロンプト",
    "model": "veo-2.0-generate-001",
    "status": "generating",
    "job_id": "abc123"
  },
  "message": "動画生成を開始しました（完了後に自動でアクティブになります）"
}
```

---

## 4. is_active 切替ルール

### 4.1 切替発生タイミング
| タイミング | 処理 |
|------------|------|
| 動画生成完了時 | 新レコード `is_active=1`, 旧レコード `is_active=0` |
| 手動アクティベート | `POST /api/videos/:id/activate` |

### 4.2 切替しないケース
| 状況 | 理由 |
|------|------|
| 生成失敗時 | 旧アクティブを維持（事故防止） |
| プロンプト保存時 | 保存と生成は分離 |

---

## 5. preflight 検証

### 5.1 VISUAL_VIDEO_MISSING エラー
`display_asset_type='video'` のシーンで以下の場合、preflight は赤エラー:
- `active_video` が存在しない
- `active_video.status !== 'completed'`
- `active_video.r2_url` が null/空

### 5.2 エラー表示
```json
{
  "code": "VISUAL_VIDEO_MISSING",
  "severity": "error",
  "message": "動画が設定されていません（display_asset_type=video）",
  "action_hint": "シーンに動画を生成・選択するか、display_asset_typeを変更してください"
}
```

### 5.3 サイレントフォールバック禁止
- `display_asset_type='video'` で動画がない場合、静止画にフォールバックしない
- ユーザーに明示的な修正を要求

---

## 6. UI 設計（Builder）

### 6.1 動画タブの構成
```
┌─────────────────────────────────────────┐
│ 動画タブ                                 │
├─────────────────────────────────────────┤
│ プロンプト:                              │
│ ┌─────────────────────────────────────┐ │
│ │ [現在のactive_video.prompt]          │ │
│ │                                      │ │
│ └─────────────────────────────────────┘ │
│                                          │
│ [保存] [このプロンプトで再生成]            │
│                                          │
│ ステータス: completed ✅                  │
│ モデル: veo-2.0-generate-001             │
│ 生成日時: 2026-02-06 10:30               │
└─────────────────────────────────────────┘
```

### 6.2 ボタン動作
| ボタン | API | 動作 |
|--------|-----|------|
| 保存 | `PUT /api/video-generations/:id/prompt` | プロンプトのみ更新 |
| 再生成 | `POST /api/scenes/:sceneId/video-regenerate` | 新動画生成、成功時active切替 |

### 6.3 状態表示
- `generating`: スピナー + 「生成中...」
- `completed`: チェックマーク + プレビュー
- `failed`: エラーマーク + エラーメッセージ

---

## 7. 課金・監査

### 7.1 api_usage_logs
再生成時に以下を記録:
```json
{
  "api_type": "video_generation",
  "provider": "google_veo",
  "model": "veo-2.0-generate-001",
  "metadata_json": {
    "scene_id": 456,
    "video_generation_id": 789,
    "prompt_length": 150,
    "duration_sec": 5,
    "is_regeneration": true
  }
}
```

### 7.2 audit_logs
- 誰が（user_id）
- いつ（created_at）
- 何を（entity_type='video_generation', entity_id）
- どうした（action='prompt_update' | 'regenerate'）

---

## 8. 運用チェックリスト

### 8.1 SSOT 整合性確認
```sql
-- completed だが r2_url が null のケース（理想: 0件）
SELECT id, scene_id, status, r2_url
FROM video_generations
WHERE status = 'completed' AND (r2_url IS NULL OR r2_url = '')
LIMIT 50;

-- 同一シーンに複数の active があるケース（理想: 0件）
SELECT scene_id, COUNT(*) as active_count
FROM video_generations
WHERE is_active = 1
GROUP BY scene_id
HAVING active_count > 1;
```

### 8.2 stuck ジョブ検知
```sql
-- 15分以上 generating のままのジョブ
SELECT id, scene_id, status, created_at
FROM video_generations
WHERE status = 'generating'
  AND created_at < datetime('now', '-15 minutes')
ORDER BY created_at ASC
LIMIT 50;
```

---

## 9. 関連ドキュメント
- [MOTION_PRESET_SPEC.md](./MOTION_PRESET_SPEC.md) - カメラワーク仕様
- [AUDIO_BULK_SSOT_SPEC.md](./AUDIO_BULK_SSOT_SPEC.md) - 音声一括生成SSOT
- [AUDIO_STATE_TRANSITIONS.md](./AUDIO_STATE_TRANSITIONS.md) - 音声状態遷移図
