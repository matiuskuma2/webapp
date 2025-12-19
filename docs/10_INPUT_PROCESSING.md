# インプット処理フロー詳細

## 概要
本ドキュメントでは、音声・テキスト入力からシナリオ生成までの処理フローを詳細に解説します。

---

## 🎯 入力タイプ

### 1. 音声入力（Audio Input）
- **対応フォーマット**: MP3, WAV, M4A, OGG, WebM
- **最大サイズ**: 25MB
- **文字起こし**: OpenAI Whisper API

### 2. テキスト入力（Text Input）
- **対応フォーマット**: プレーンテキスト
- **最大サイズ**: 制限なし
- **文字起こし**: 不要（直接Parse処理へ）

---

## 📊 ステータス遷移図

### 音声入力フロー（Parse使用）
```
created (プロジェクト作成)
   ↓
uploaded (音声アップロード完了、source_type='audio')
   ↓
transcribing (文字起こし中)
   ↓
transcribed (文字起こし完了)
   ↓
parsing (テキスト分割中)
   ↓
parsed (テキスト分割完了)
   ↓
formatting (シナリオ生成中、chunk単位処理)
   ↓
formatted (シナリオ生成完了)
   ↓
generating_images (画像生成中)
   ↓
completed (全工程完了)
```

### テキスト入力フロー
```
created (プロジェクト作成)
   ↓
uploaded (テキスト保存完了、source_type='text')
   ↓
parsing (テキスト分割中)
   ↓
parsed (テキスト分割完了)
   ↓
formatting (シナリオ生成中、chunk単位処理)
   ↓
formatted (シナリオ生成完了)
   ↓
generating_images (画像生成中)
   ↓
completed (全工程完了)
```

---

## 🔄 処理フロー詳細

### Phase 1: プロジェクト作成・入力保存

#### 1-1. プロジェクト作成
```http
POST /api/projects
{
  "title": "テスト２"
}
```

**DB操作:**
```sql
INSERT INTO projects (title, status) VALUES ('テスト２', 'created');
```

**結果:** `status = 'created'`

---

#### 1-2a. 音声アップロード（音声入力の場合）
```http
POST /api/projects/1/upload
Content-Type: multipart/form-data
Field: audio (File)
```

**処理:**
1. ファイル形式バリデーション（.mp3, .wav, .m4a, .ogg, .webm）
2. ファイルサイズバリデーション（最大25MB）
3. R2にアップロード（`audio/{project_id}/{filename}_{timestamp}_{random}.ext`）
4. DB更新

**DB操作:**
```sql
UPDATE projects
SET audio_r2_key = 'audio/1/test_1737284123_abc123.mp3',
    audio_filename = 'test.mp3',
    audio_size_bytes = 5242880,
    source_type = 'audio',
    status = 'uploaded',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;
```

**結果:** `status = 'uploaded'`, `source_type = 'audio'`

---

#### 1-2b. テキスト保存（テキスト入力の場合）
```http
POST /api/projects/1/source/text
{
  "text": "2030年、あなたの仕事の半分がAIに置き換わる。これは脅威ではなく..."
}
```

**処理:**
1. テキストバリデーション（空でないこと）
2. DB更新

**DB操作:**
```sql
UPDATE projects
SET source_type = 'text',
    source_text = '2030年、あなたの仕事の半分がAIに置き換わる...',
    status = 'uploaded',
    source_updated_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;
```

**結果:** `status = 'uploaded'`, `source_type = 'text'`

---

### Phase 2: 文字起こし（音声のみ）

#### 2-1. 文字起こし実行
```http
POST /api/projects/1/transcribe
```

**処理:**
1. R2から音声ファイル取得
2. OpenAI Whisper APIで文字起こし
3. transcriptionsテーブルに保存

**ステータス遷移:**
```sql
-- 開始時
UPDATE projects SET status = 'transcribing' WHERE id = 1;

-- 完了時
INSERT INTO transcriptions (project_id, raw_text, language, duration_seconds, word_count, provider, model)
VALUES (1, '文字起こし結果...', 'ja', 180, 250, 'openai', 'whisper-1');

UPDATE projects SET status = 'transcribed' WHERE id = 1;
```

**結果:** `status = 'transcribed'`

---

### Phase 3: Parse（テキスト分割）

#### 3-1. Parse実行
```http
POST /api/projects/1/parse
```

**許可されるステータス:**
- `uploaded` (テキスト入力 または 音声入力でTranscribe未実行)
- `transcribed` (音声入力でTranscribe完了)

**処理:**
1. `source_text`または`transcriptions.raw_text`を取得
2. インテリジェント分割（意味単位、500-1500文字）
3. `text_chunks`テーブルに保存

**インテリジェント分割ロジック:**
```typescript
function intelligentChunking(text: string): string[] {
  const MIN_CHUNK_SIZE = 500
  const MAX_CHUNK_SIZE = 1500
  const IDEAL_CHUNK_SIZE = 1000

  // 1. 段落単位で分割（\n\n）
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0)

  let chunks: string[] = []
  let currentChunk = ''

  for (const paragraph of paragraphs) {
    // 段落が大きすぎる場合は文単位でさらに分割
    if (paragraph.length > MAX_CHUNK_SIZE) {
      const sentences = splitIntoSentences(paragraph)
      // 文単位で MAX_CHUNK_SIZE 以下に分割
      ...
    } else {
      // 段落を追加
      if (currentChunk.length + paragraph.length <= MAX_CHUNK_SIZE) {
        currentChunk += (currentChunk.length > 0 ? '\n\n' : '') + paragraph
      } else {
        chunks.push(currentChunk.trim())
        currentChunk = paragraph
      }

      // IDEAL_CHUNK_SIZE を超えたら区切る
      if (currentChunk.length >= IDEAL_CHUNK_SIZE) {
        chunks.push(currentChunk.trim())
        currentChunk = ''
      }
    }
  }

  return chunks
}
```

**DB操作:**
```sql
-- ステータス更新
UPDATE projects SET status = 'parsing' WHERE id = 1;

-- チャンク保存
INSERT INTO text_chunks (project_id, idx, text, status)
VALUES 
  (1, 1, 'チャンク1のテキスト...', 'pending'),
  (1, 2, 'チャンク2のテキスト...', 'pending'),
  (1, 3, 'チャンク3のテキスト...', 'pending'),
  ...;

-- 完了
UPDATE projects SET status = 'parsed' WHERE id = 1;
```

**結果:** `status = 'parsed'`, 16個のチャンク生成（例）

---

### Phase 4: Format（シナリオ生成）

#### 4-1. Format実行（chunk単位処理）
```http
POST /api/projects/1/format
```

**許可されるステータス:**
- `parsed` (Parse完了直後)
- `formatting` (既に処理中、再呼び出しOK)

**処理フロー:**

**初回呼び出し（status='parsed'）:**
```sql
-- ステータス更新
UPDATE projects SET status = 'formatting' WHERE id = 1;

-- pending チャンクを最大3件取得
SELECT id, idx, text FROM text_chunks
WHERE project_id = 1 AND status = 'pending'
ORDER BY idx ASC
LIMIT 3;
```

**各チャンクの処理:**
1. ステータスを`processing`に更新
2. OpenAI GPT-4oでRILARCScenarioV1形式に変換
3. バリデーション
4. scenesテーブルに保存
5. チャンクステータスを`done`に更新

**単一チャンクの処理詳細:**
```sql
-- 1. 処理開始
UPDATE text_chunks SET status = 'processing' WHERE id = 101;

-- 2. OpenAI API呼び出し（GPT-4o）
-- Prompt:
-- System: "あなたはYouTube/TikTok向けのシナリオライターです。与えられたテキストをRILARCScenarioV1形式に変換してください。"
-- User: "[チャンクテキスト]"

-- 3. レスポンスバリデーション（RILARCScenarioV1スキーマ）
{
  "meta": { ... },
  "scenes": [
    {
      "idx": 1,
      "role": "hook",
      "title": "衝撃の未来予測",
      "dialogue": "2030年、あなたの仕事の半分がAIに...",
      "bullets": ["2030年の労働市場", "AIの影響範囲"],
      "image_prompt": "Modern office with holographic AI interfaces..."
    },
    ...
  ]
}

-- 4. scenesテーブルに保存
INSERT INTO scenes (project_id, chunk_id, idx, role, title, dialogue, bullets, image_prompt)
VALUES 
  (1, 101, 1, 'hook', '衝撃の未来予測', '2030年、あなたの...', '["2030年の労働市場","AIの影響範囲"]', 'Modern office with...'),
  (1, 101, 2, 'context', 'AIの現状', '現在、AIは既に...', '["現状","課題"]', 'Current AI workplace...'),
  ...;

-- 5. 完了
UPDATE text_chunks 
SET status = 'done', 
    scene_count = 3, 
    processed_at = CURRENT_TIMESTAMP 
WHERE id = 101;
```

**エラーハンドリング:**
```sql
-- API呼び出し失敗時
UPDATE text_chunks
SET status = 'failed',
    error_message = 'OpenAI API error: Rate limit exceeded',
    processed_at = CURRENT_TIMESTAMP
WHERE id = 101;
```

**レスポンス（処理中）:**
```json
{
  "project_id": 1,
  "status": "formatting",
  "batches_processed": 3,
  "batches_failed": 0,
  "total_chunks": 16,
  "processed": 3,
  "failed": 0,
  "pending": 13
}
```

---

#### 4-2. Format進捗確認
```http
GET /api/projects/1/format/status
```

**Response:**
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

#### 4-3. Format再呼び出し
```http
POST /api/projects/1/format (2回目)
POST /api/projects/1/format (3回目)
...
```

**処理:**
- `pending`チャンクが0になるまで繰り返し
- UIは`pending > 0`の間、5秒ごとにポーリングして自動再呼び出し

---

#### 4-4. 自動マージ（全チャンク完了時）

**条件:** すべてのチャンクが`done`または`failed`

**処理:**
```sql
-- 1. 全scenesを取得（idx順、chunk_id順）
SELECT * FROM scenes 
WHERE project_id = 1 
ORDER BY chunk_id ASC, idx ASC;

-- 2. idxを振り直し（1から連番）
UPDATE scenes SET idx = 1 WHERE id = 501;
UPDATE scenes SET idx = 2 WHERE id = 502;
...

-- 3. プロジェクトステータスを 'formatted' に更新
UPDATE projects 
SET status = 'formatted', 
    updated_at = CURRENT_TIMESTAMP 
WHERE id = 1;
```

**レスポンス（完了時）:**
```json
{
  "project_id": 1,
  "total_scenes": 48,
  "status": "formatted",
  "message": "All chunks processed successfully, 48 scenes merged"
}
```

---

## 🚨 エラーパターンと対処

### 1. INVALID_STATUS エラー

**エラー例:**
```json
{
  "error": {
    "code": "INVALID_STATUS",
    "message": "Cannot format project with status: uploaded"
  }
}
```

**原因:** Parse APIがスキップされている

**対処:** 
```http
POST /api/projects/1/parse (まずParseを実行)
POST /api/projects/1/format (その後Format)
```

---

### 2. Parse APIでのステータスエラー

**エラー例:**
```json
{
  "error": {
    "code": "INVALID_STATUS",
    "message": "Cannot parse project with status: created"
  }
}
```

**原因:** 音声アップロードまたはテキスト保存が未完了

**対処:**
```http
POST /api/projects/1/source/text (テキスト保存)
POST /api/projects/1/parse (その後Parse)
```

---

### 3. チャンク処理の部分失敗

**状況:** 16チャンク中3件が失敗

**DB状態:**
```sql
SELECT status, COUNT(*) FROM text_chunks WHERE project_id = 1 GROUP BY status;
-- done: 13
-- failed: 3
```

**対処:**
```http
POST /api/text_chunks/105/retry (失敗したチャンクをリトライ)
POST /api/projects/1/format (Format再実行)
```

---

### 4. OpenAI APIレート制限

**エラーメッセージ:** `Rate limit exceeded`

**対処:**
1. 自動リトライ（指数バックオフ: 1s → 2s → 4s）
2. それでも失敗する場合は`failed`として記録
3. ユーザーは手動で`/retry`を実行可能

---

## 📊 処理時間の目安

### 音声入力（10分音声）
- **Transcribe**: 約30秒
- **Parse**: 約2秒
- **Format**: 約3-5分（16チャンク、各チャンク10-15秒）
- **合計**: 約4-6分

### テキスト入力（16,000文字）
- **Parse**: 約2秒
- **Format**: 約3-5分（16チャンク）
- **合計**: 約3-5分

---

## 🔍 デバッグ方法

### 1. プロジェクトステータス確認
```http
GET /api/projects/1
```

### 2. チャンク進捗確認
```http
GET /api/projects/1/format/status
```

### 3. シーン一覧確認
```http
GET /api/projects/1/scenes?view=edit
```

### 4. 失敗したチャンクの確認
```sql
SELECT id, idx, status, error_message 
FROM text_chunks 
WHERE project_id = 1 AND status = 'failed';
```

### 5. ログ確認（サーバーサイド）
- Cloudflare Pages Functions のログを確認
- `console.error` で出力されたエラーメッセージ

---

## ✅ ベストプラクティス

### 1. UIでの自動ポーリング実装
```javascript
async function formatAndSplit() {
  // 1. Parse実行（status='uploaded'の場合）
  if (project.status === 'uploaded') {
    await axios.post(`/api/projects/${PROJECT_ID}/parse`)
  }

  // 2. Format実行（ポーリングループ）
  let pollCount = 0
  const maxPolls = 60 // 最大5分（5秒 x 60回）

  while (pollCount < maxPolls) {
    // ステータス確認
    const statusRes = await axios.get(`/api/projects/${PROJECT_ID}/format/status`)
    const { processed, pending, failed, status } = statusRes.data

    // 完了判定
    if (pending === 0) {
      console.log('Format completed!', { processed, failed })
      break
    }

    // 次のバッチ実行
    if (pending > 0) {
      await axios.post(`/api/projects/${PROJECT_ID}/format`)
    }

    // 5秒待機
    await new Promise(resolve => setTimeout(resolve, 5000))
    pollCount++
  }
}
```

### 2. エラー処理の実装
```javascript
try {
  await axios.post(`/api/projects/${PROJECT_ID}/format`)
} catch (error) {
  if (error.response?.data?.error?.code === 'INVALID_STATUS') {
    // Parse APIを先に実行
    await axios.post(`/api/projects/${PROJECT_ID}/parse`)
    // Format再実行
    await axios.post(`/api/projects/${PROJECT_ID}/format`)
  }
}
```

### 3. source_typeの確実な設定
```typescript
// 音声アップロード時
await db.prepare(`
  UPDATE projects
  SET source_type = 'audio', -- 必須
      status = 'uploaded',
      ...
  WHERE id = ?
`).bind(projectId).run()

// テキスト保存時
await db.prepare(`
  UPDATE projects
  SET source_type = 'text', -- 必須
      status = 'uploaded',
      ...
  WHERE id = ?
`).bind(projectId).run()
```

---

最終更新: 2025-01-19
