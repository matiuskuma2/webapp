# データベーススキーマ仕様

## 🗄️ Cloudflare D1（SQLite）

---

## 📊 テーブル一覧

### コアテーブル
1. **projects** - プロジェクト管理
2. **transcriptions** - 文字起こし結果
3. **text_chunks** - テキスト分割チャンク
4. **scenes** - RILARCシナリオのシーン管理
5. **image_generations** - 画像生成履歴

### スタイルプリセットテーブル（0008_add_style_presets.sql）
6. **style_presets** - 画像スタイルプリセット定義
7. **project_style_settings** - プロジェクトのデフォルトスタイル設定
8. **scene_style_settings** - シーン個別のスタイル上書き設定

---

## 📋 テーブル定義

### 1. projects

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---------|-----|------|-----------|------|
| id | INTEGER | NO | PRIMARY KEY AUTOINCREMENT | プロジェクトID |
| title | TEXT | NO | - | プロジェクトタイトル |
| source_type | TEXT | NO | 'audio' | 入力タイプ（'audio' or 'text'） |
| source_text | TEXT | YES | NULL | テキスト入力内容 |
| source_updated_at | DATETIME | YES | NULL | テキスト更新日時 |
| audio_r2_key | TEXT | YES | NULL | R2ストレージキー（音声ファイル） |
| audio_filename | TEXT | YES | NULL | 元のファイル名 |
| audio_size_bytes | INTEGER | YES | NULL | ファイルサイズ（バイト） |
| audio_duration_seconds | INTEGER | YES | NULL | 音声長（秒） |
| status | TEXT | NO | 'created' | プロジェクトステータス |
| error_message | TEXT | YES | NULL | 最新エラーメッセージ |
| last_error | DATETIME | YES | NULL | 最新エラー発生日時 |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |
| updated_at | DATETIME | NO | CURRENT_TIMESTAMP | 更新日時 |

**status enum:**
- `created` - プロジェクト作成済み
- `uploaded` - 音声アップロード完了 / テキスト保存完了
- `transcribing` - 文字起こし中（音声のみ）
- `transcribed` - 文字起こし完了（音声のみ）
- `parsing` - テキスト分割中
- `parsed` - テキスト分割完了
- `formatting` - 整形・分割中
- `formatted` - 整形・分割完了
- `generating_images` - 画像生成中
- `completed` - 全工程完了
- `failed` - エラー発生

**制約:**
```sql
CHECK (status IN (
  'created', 'uploaded', 'transcribing', 'transcribed', 'parsing', 'parsed',
  'formatting', 'formatted', 'generating_images', 'completed', 'failed'
))
CHECK (source_type IN ('audio', 'text'))
```

**インデックス:**
```sql
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_created_at ON projects(created_at DESC);
```

---

### 2. transcriptions

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---------|-----|------|-----------|------|
| id | INTEGER | NO | PRIMARY KEY AUTOINCREMENT | 文字起こしID |
| project_id | INTEGER | NO | - | プロジェクトID（FK） |
| raw_text | TEXT | NO | - | 生の文字起こしテキスト |
| language | TEXT | YES | NULL | 検出された言語（例: ja, en） |
| duration_seconds | INTEGER | YES | NULL | 音声長（秒） |
| word_count | INTEGER | YES | NULL | 単語数 |
| provider | TEXT | NO | 'openai' | APIプロバイダ |
| model | TEXT | NO | 'whisper-1' | 使用モデル |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |

**制約:**
```sql
FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
```

**インデックス:**
```sql
CREATE INDEX idx_transcriptions_project_id ON transcriptions(project_id);
```

---

### 3. text_chunks

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---------|-----|------|-----------|------|
| id | INTEGER | NO | PRIMARY KEY AUTOINCREMENT | チャンクID |
| project_id | INTEGER | NO | - | プロジェクトID（FK） |
| idx | INTEGER | NO | - | チャンク番号（1から開始） |
| text | TEXT | NO | - | チャンクテキスト（500-1500文字） |
| status | TEXT | NO | 'pending' | 処理ステータス |
| scene_count | INTEGER | NO | 0 | このチャンクから生成されたシーン数 |
| error_message | TEXT | YES | NULL | エラーメッセージ |
| processed_at | DATETIME | YES | NULL | 処理完了日時 |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |
| updated_at | DATETIME | NO | CURRENT_TIMESTAMP | 更新日時 |

**status enum:**
- `pending` - 未処理
- `processing` - 処理中
- `done` - 処理完了
- `failed` - 処理失敗

**制約:**
```sql
FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
CHECK (status IN ('pending', 'processing', 'done', 'failed'))
UNIQUE (project_id, idx)
```

**インデックス:**
```sql
CREATE INDEX idx_text_chunks_project_id ON text_chunks(project_id);
CREATE INDEX idx_text_chunks_status ON text_chunks(status);
```

---

### 4. scenes

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---------|-----|------|-----------|------|
| id | INTEGER | NO | PRIMARY KEY AUTOINCREMENT | シーンID |
| project_id | INTEGER | NO | - | プロジェクトID（FK） |
| chunk_id | INTEGER | YES | NULL | 元チャンクID（FK、テキスト入力時のみ） |
| idx | INTEGER | NO | - | シーン番号（1から開始） |
| role | TEXT | NO | - | シーン役割（enum） |
| title | TEXT | NO | - | シーンタイトル |
| dialogue | TEXT | NO | - | 読み上げセリフ |
| bullets | TEXT | NO | - | 要点（JSON配列） |
| image_prompt | TEXT | NO | - | 画像生成プロンプト |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |
| updated_at | DATETIME | NO | CURRENT_TIMESTAMP | 更新日時 |

**role enum:**
```sql
CHECK (role IN (
  'hook', 'context', 'main_point', 'evidence',
  'timeline', 'analysis', 'summary', 'cta'
))
```

**bullets フォーマット:**
```json
["要点1", "要点2", "要点3"]
```

**制約:**
```sql
FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
FOREIGN KEY (chunk_id) REFERENCES text_chunks(id) ON DELETE SET NULL
UNIQUE (project_id, idx)
```

**インデックス:**
```sql
CREATE INDEX idx_scenes_project_id ON scenes(project_id);
CREATE INDEX idx_scenes_project_idx ON scenes(project_id, idx);
CREATE INDEX idx_scenes_chunk_id ON scenes(chunk_id);
```

---

### 5. image_generations

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---------|-----|------|-----------|------|
| id | INTEGER | NO | PRIMARY KEY AUTOINCREMENT | 画像生成ID |
| scene_id | INTEGER | NO | - | シーンID（FK） |
| prompt | TEXT | NO | - | 使用したプロンプト（スタイル適用済み） |
| r2_key | TEXT | YES | NULL | R2ストレージキー |
| r2_url | TEXT | YES | NULL | 公開URL（一時） |
| status | TEXT | NO | 'pending' | 生成ステータス |
| error_message | TEXT | YES | NULL | エラーメッセージ |
| provider | TEXT | NO | 'gemini' | APIプロバイダ |
| model | TEXT | NO | 'gemini-3-pro-image-preview' | 使用モデル |
| is_active | INTEGER | NO | 1 | アクティブフラグ（0 or 1） |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |

**status enum:**
- `pending` - 生成待機中
- `generating` - 生成中
- `completed` - 生成完了
- `failed` - 生成失敗
- `policy_violation` - ポリシー違反

**制約:**
```sql
FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
CHECK (status IN ('pending', 'generating', 'completed', 'failed', 'policy_violation'))
CHECK (is_active IN (0, 1))
```

**インデックス:**
```sql
CREATE INDEX idx_image_generations_scene_id ON image_generations(scene_id);
CREATE INDEX idx_image_generations_scene_active ON image_generations(scene_id, is_active);
CREATE INDEX idx_image_generations_status ON image_generations(status);
```

---

### 6. style_presets

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---------|-----|------|-----------|------|
| id | INTEGER | NO | PRIMARY KEY AUTOINCREMENT | スタイルプリセットID |
| name | TEXT | NO | - | スタイル名（例: 日本アニメ風） |
| description | TEXT | YES | NULL | スタイル説明 |
| prompt_prefix | TEXT | YES | NULL | プロンプト接頭辞 |
| prompt_suffix | TEXT | YES | NULL | プロンプト接尾辞 |
| negative_prompt | TEXT | YES | NULL | ネガティブプロンプト |
| is_active | INTEGER | NO | 1 | アクティブフラグ（0 or 1） |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |
| updated_at | DATETIME | NO | CURRENT_TIMESTAMP | 更新日時 |

**プロンプト合成ロジック:**
```
final_prompt = prompt_prefix + scene.image_prompt + prompt_suffix
```

**制約:**
```sql
CHECK (is_active IN (0, 1))
```

**インデックス:**
```sql
CREATE INDEX idx_style_presets_active ON style_presets(is_active);
```

**デフォルトプリセット:**
1. **日本アニメ風** - YouTube向けの明るく親しみやすいアニメスタイル
2. **インフォマーシャル風** - 情報を明確に伝える図解スタイル
3. **シネマ調** - 高級感のある映画的なスタイル

---

### 7. project_style_settings

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---------|-----|------|-----------|------|
| id | INTEGER | NO | PRIMARY KEY AUTOINCREMENT | 設定ID |
| project_id | INTEGER | NO | - | プロジェクトID（FK） |
| default_style_preset_id | INTEGER | YES | NULL | デフォルトスタイルプリセットID（FK） |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |
| updated_at | DATETIME | NO | CURRENT_TIMESTAMP | 更新日時 |

**制約:**
```sql
FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
FOREIGN KEY (default_style_preset_id) REFERENCES style_presets(id) ON DELETE SET NULL
UNIQUE (project_id)
```

**インデックス:**
```sql
CREATE INDEX idx_project_style_settings_project ON project_style_settings(project_id);
```

---

### 8. scene_style_settings

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---------|-----|------|-----------|------|
| id | INTEGER | NO | PRIMARY KEY AUTOINCREMENT | 設定ID |
| scene_id | INTEGER | NO | - | シーンID（FK） |
| style_preset_id | INTEGER | YES | NULL | スタイルプリセットID（FK） |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |
| updated_at | DATETIME | NO | CURRENT_TIMESTAMP | 更新日時 |

**制約:**
```sql
FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
FOREIGN KEY (style_preset_id) REFERENCES style_presets(id) ON DELETE SET NULL
UNIQUE (scene_id)
```

**インデックス:**
```sql
CREATE INDEX idx_scene_style_settings_scene ON scene_style_settings(scene_id);
```

---

## 🔄 リレーション図

```
projects (1) ──< (N) transcriptions
    │
    ├──< (N) text_chunks (1) ──< (N) scenes (1) ──< (N) image_generations
    │                                   │
    ├──< (1) project_style_settings    └──< (1) scene_style_settings
    │              │                               │
    │              └────> style_presets <─────────┘
    │
    └──< (N) scenes (without chunk_id for audio projects)
```

### スタイル優先順位ロジック
```
最終プロンプト = composeStyledPrompt(project_id, scene_id, base_prompt)

優先順位:
1. scene_style_settings.style_preset_id （シーン個別）
2. project_style_settings.default_style_preset_id （プロジェクトデフォルト）
3. base_prompt のみ（スタイルなし、後方互換）
```

---

## 📝 マイグレーションファイル一覧

| ファイル名 | 説明 |
|-----------|------|
| 0001_initial_schema.sql | 基本4テーブル（projects, transcriptions, scenes, image_generations） |
| 0002_add_source_type.sql | テキスト入力対応（source_type, source_text, source_updated_at） |
| 0003_add_error_tracking.sql | エラー追跡（error_message, last_error） |
| 0004_add_text_chunks.sql | テキスト分割（text_chunks テーブル） |
| 0005_format_chunked_processing.sql | チャンク単位処理対応（chunk_id 追加） |
| 0006_extend_error_message.sql | エラーメッセージ拡張 |
| 0007_add_runs_system.sql | Run管理システム（runs テーブル） |
| 0008_add_style_presets.sql | スタイルプリセット（3テーブル + デフォルトプリセット） |

---

## 🔍 主要クエリ例

### プロジェクト一覧取得
```sql
SELECT id, title, status, source_type, created_at, updated_at
FROM projects
ORDER BY created_at DESC;
```

### プロジェクト詳細（シーン含む）
```sql
SELECT 
  p.*,
  t.raw_text,
  COUNT(DISTINCT s.id) as scene_count,
  COUNT(DISTINCT CASE WHEN ig.status = 'completed' THEN ig.id END) as completed_images,
  pss.default_style_preset_id,
  sp.name as default_style_name
FROM projects p
LEFT JOIN transcriptions t ON p.id = t.project_id
LEFT JOIN scenes s ON p.id = s.project_id
LEFT JOIN image_generations ig ON s.id = ig.scene_id AND ig.is_active = 1
LEFT JOIN project_style_settings pss ON p.id = pss.project_id
LEFT JOIN style_presets sp ON pss.default_style_preset_id = sp.id
WHERE p.id = ?
GROUP BY p.id;
```

### シーン一覧（画像 + スタイル含む）
```sql
SELECT 
  s.*,
  ig.r2_url as active_image_url,
  ig.status as image_status,
  ig.error_message,
  sss.style_preset_id as scene_style_id,
  sp.name as scene_style_name
FROM scenes s
LEFT JOIN image_generations ig ON s.id = ig.scene_id AND ig.is_active = 1
LEFT JOIN scene_style_settings sss ON s.id = sss.scene_id
LEFT JOIN style_presets sp ON sss.style_preset_id = sp.id
WHERE s.project_id = ?
ORDER BY s.idx ASC;
```

### スタイル適用済みプロンプト生成（疑似コード）
```typescript
async function composeStyledPrompt(
  db: D1Database,
  projectId: number,
  sceneId: number,
  basePrompt: string
): Promise<string> {
  // 1. シーン個別スタイル確認
  const sceneStyle = await db.prepare(`
    SELECT style_preset_id FROM scene_style_settings WHERE scene_id = ?
  `).bind(sceneId).first()

  let stylePresetId = sceneStyle?.style_preset_id

  // 2. なければプロジェクトデフォルト
  if (!stylePresetId) {
    const projectStyle = await db.prepare(`
      SELECT default_style_preset_id FROM project_style_settings WHERE project_id = ?
    `).bind(projectId).first()

    stylePresetId = projectStyle?.default_style_preset_id
  }

  // 3. スタイルなし
  if (!stylePresetId) {
    return basePrompt
  }

  // 4. プリセット取得
  const preset = await db.prepare(`
    SELECT prompt_prefix, prompt_suffix FROM style_presets WHERE id = ? AND is_active = 1
  `).bind(stylePresetId).first()

  if (!preset) {
    return basePrompt
  }

  // 5. 合成
  return `${preset.prompt_prefix || ''} ${basePrompt} ${preset.prompt_suffix || ''}`.trim()
}
```

### アクティブ画像の切り替え
```sql
-- 既存のアクティブを無効化
UPDATE image_generations
SET is_active = 0
WHERE scene_id = ? AND is_active = 1;

-- 新しい画像をアクティブ化
UPDATE image_generations
SET is_active = 1
WHERE id = ?;
```

---

## 🚨 重要な制約とルール

### 1. ステータス遷移の正しいフロー
#### 音声入力（Parse使用）
```
created → uploaded → transcribing → transcribed → parsing → parsed 
  → formatting → formatted → generating_images → completed
```

#### テキスト入力
```
created → uploaded → parsing → parsed → formatting → formatted 
  → generating_images → completed
```

### 2. source_type の設定必須
- **音声アップロード時**: `source_type='audio'` を必ず設定
- **テキスト保存時**: `source_type='text'` を必ず設定

### 3. 画像生成時のスタイル優先順位
```
scene_style_settings > project_style_settings > none
```

### 4. 外部キー削除時の挙動
- **CASCADE**: 親削除時に子も削除（projects → scenes → image_generations）
- **SET NULL**: 親削除時に子の外部キーをNULLに（style_presets削除時）

---

最終更新: 2025-01-19
