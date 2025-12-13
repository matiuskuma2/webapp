# データベーススキーマ仕様

## 🗄️ Cloudflare D1（SQLite）

---

## 📊 テーブル一覧

### 1. projects
プロジェクト管理テーブル

### 2. transcriptions
文字起こし結果テーブル

### 3. scenes
RILARCシナリオのシーン管理テーブル

### 4. image_generations
画像生成履歴テーブル

---

## 📋 テーブル定義

### 1. projects

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---------|-----|------|-----------|------|
| id | INTEGER | NO | PRIMARY KEY AUTOINCREMENT | プロジェクトID |
| title | TEXT | NO | - | プロジェクトタイトル |
| audio_r2_key | TEXT | YES | NULL | R2ストレージキー（音声ファイル） |
| audio_filename | TEXT | YES | NULL | 元のファイル名 |
| audio_size_bytes | INTEGER | YES | NULL | ファイルサイズ（バイト） |
| audio_duration_seconds | INTEGER | YES | NULL | 音声長（秒） |
| status | TEXT | NO | 'created' | プロジェクトステータス |
| created_at | DATETIME | NO | CURRENT_TIMESTAMP | 作成日時 |
| updated_at | DATETIME | NO | CURRENT_TIMESTAMP | 更新日時 |

**status enum:**
- `created` - プロジェクト作成済み
- `uploaded` - 音声アップロード完了
- `transcribing` - 文字起こし中
- `transcribed` - 文字起こし完了
- `formatting` - 整形・分割中
- `formatted` - 整形・分割完了
- `generating_images` - 画像生成中
- `completed` - 全工程完了
- `failed` - エラー発生

**制約:**
```sql
CHECK (status IN (
  'created', 'uploaded', 'transcribing', 'transcribed',
  'formatting', 'formatted', 'generating_images', 'completed', 'failed'
))
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

### 3. scenes

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---------|-----|------|-----------|------|
| id | INTEGER | NO | PRIMARY KEY AUTOINCREMENT | シーンID |
| project_id | INTEGER | NO | - | プロジェクトID（FK） |
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
UNIQUE (project_id, idx)
```

**インデックス:**
```sql
CREATE INDEX idx_scenes_project_id ON scenes(project_id);
CREATE INDEX idx_scenes_project_idx ON scenes(project_id, idx);
```

---

### 4. image_generations

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---------|-----|------|-----------|------|
| id | INTEGER | NO | PRIMARY KEY AUTOINCREMENT | 画像生成ID |
| scene_id | INTEGER | NO | - | シーンID（FK） |
| prompt | TEXT | NO | - | 使用したプロンプト |
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

## 🔄 リレーション図

```
projects (1) ──< (N) transcriptions
    │
    └──< (N) scenes (1) ──< (N) image_generations
```

---

## 📝 マイグレーションファイル

### migrations/0001_initial_schema.sql

```sql
-- projects table
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  audio_r2_key TEXT,
  audio_filename TEXT,
  audio_size_bytes INTEGER,
  audio_duration_seconds INTEGER,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'uploaded', 'transcribing', 'transcribed',
    'formatting', 'formatted', 'generating_images', 'completed', 'failed'
  )),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_created_at ON projects(created_at DESC);

-- transcriptions table
CREATE TABLE IF NOT EXISTS transcriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  language TEXT,
  duration_seconds INTEGER,
  word_count INTEGER,
  provider TEXT NOT NULL DEFAULT 'openai',
  model TEXT NOT NULL DEFAULT 'whisper-1',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_transcriptions_project_id ON transcriptions(project_id);

-- scenes table
CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'hook', 'context', 'main_point', 'evidence',
    'timeline', 'analysis', 'summary', 'cta'
  )),
  title TEXT NOT NULL,
  dialogue TEXT NOT NULL,
  bullets TEXT NOT NULL,
  image_prompt TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, idx)
);

CREATE INDEX idx_scenes_project_id ON scenes(project_id);
CREATE INDEX idx_scenes_project_idx ON scenes(project_id, idx);

-- image_generations table
CREATE TABLE IF NOT EXISTS image_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  r2_key TEXT,
  r2_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'generating', 'completed', 'failed', 'policy_violation'
  )),
  error_message TEXT,
  provider TEXT NOT NULL DEFAULT 'gemini',
  model TEXT NOT NULL DEFAULT 'gemini-3-pro-image-preview',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);

CREATE INDEX idx_image_generations_scene_id ON image_generations(scene_id);
CREATE INDEX idx_image_generations_scene_active ON image_generations(scene_id, is_active);
CREATE INDEX idx_image_generations_status ON image_generations(status);
```

---

## 🔍 主要クエリ例

### プロジェクト一覧取得
```sql
SELECT id, title, status, created_at, updated_at
FROM projects
ORDER BY created_at DESC;
```

### プロジェクト詳細（シーン含む）
```sql
SELECT 
  p.*,
  t.raw_text,
  COUNT(DISTINCT s.id) as scene_count,
  COUNT(DISTINCT CASE WHEN ig.status = 'completed' THEN ig.id END) as completed_images
FROM projects p
LEFT JOIN transcriptions t ON p.id = t.project_id
LEFT JOIN scenes s ON p.id = s.project_id
LEFT JOIN image_generations ig ON s.id = ig.scene_id AND ig.is_active = 1
WHERE p.id = ?
GROUP BY p.id;
```

### シーン一覧（画像含む）
```sql
SELECT 
  s.*,
  ig.r2_url as active_image_url,
  ig.status as image_status,
  ig.error_message
FROM scenes s
LEFT JOIN image_generations ig ON s.id = ig.scene_id AND ig.is_active = 1
WHERE s.project_id = ?
ORDER BY s.idx ASC;
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

最終更新: 2025-01-13
