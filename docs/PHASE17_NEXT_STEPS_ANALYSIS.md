# Phase1.7 次ステップ分析ドキュメント

最終更新: 2026-01-18

---

## 現状調査結果

### 1. audio_generations テーブル（現状）

```sql
-- migrations/0009_create_audio_generations.sql
CREATE TABLE audio_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,      -- シーン単位（発話単位ではない）
  provider TEXT NOT NULL DEFAULT 'google',
  voice_id TEXT NOT NULL,
  model TEXT,
  format TEXT NOT NULL DEFAULT 'mp3',
  sample_rate INTEGER DEFAULT 24000,
  text TEXT NOT NULL,             -- 生成時のテキスト
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  r2_key TEXT,
  r2_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);
```

**問題点**: 
- `scene_id` 単位でしか紐付けられない
- 漫画の発話（utterance）単位で追跡できない
- 同一シーンで複数発話の音声を生成すると混線する

### 2. video_builds テーブル（現状）

```sql
-- migrations/0013_create_video_builds.sql
CREATE TABLE video_builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  executor_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  settings_json TEXT NOT NULL,          -- { include_captions, include_bgm, include_motion, resolution, aspect_ratio }
  project_json_version TEXT NOT NULL DEFAULT '1.1',
  project_json_r2_key TEXT,
  aws_job_id TEXT,
  s3_output_key TEXT,
  download_url TEXT,
  ...
);
```

**現状のsettings_json**:
```json
{
  "include_captions": true,
  "include_bgm": true,
  "include_motion": false,
  "resolution": "1080p",
  "aspect_ratio": "9:16"
}
```

### 3. Video Build UI Preflight（現状）

**ファイル**: `public/static/project-editor.1768570000.js` - `updateVideoBuildRequirements()`

```javascript
// 現状のチェック
const scenesWithImages = scenes.filter(s => s.active_image).length;
const allScenesHaveImages = hasScenes && scenesWithImages === scenes.length;
```

**問題点**:
- `display_asset_type` を見ていない
- 漫画採用シーンは `active_comic` をチェックすべき
- 音声の有無をチェックしていない

### 4. Remotion連携（現状）

**ファイル**: `src/routes/video-generation.ts`

```javascript
// POST /api/projects/:projectId/video-builds
// TODO: Trigger AWS Lambda for actual video build
// This would normally call AWS to start the rendering process
```

**現状**:
- video_builds レコードは作成される
- 実際のAWS Lambda呼び出しは未実装（TODOコメント）
- 進捗ポーリングの仕組みはUI側に実装済み

---

## 必要な変更（計画）

### Task 1: 履歴から編集再開ボタン（P1）

#### 変更箇所

1. **UI**: `public/static/project-editor.1768570000.js`
   - `viewImageHistory()` 関数を修正
   - asset_type='comic' のアイテムに「編集再開」「この漫画を採用」ボタン追加

2. **API**: 既存で対応可能
   - 編集再開: `openComicEditor(sceneId)` を呼ぶ
   - 採用切替: `PUT /api/scenes/:id/display-asset-type`

#### 影響範囲
- UIのみ（API変更なし）
- 既存機能への影響なし

#### 検証方法
```
1. シーンの画像履歴を開く
2. asset_type='comic' のアイテムに「編集再開」「採用」ボタンが表示される
3. 編集再開ボタン → 漫画エディタが開く
4. 採用ボタン → display_asset_type='comic' に切り替わる
```

---

### Task 2: 音声のutterance紐付けSSOT（P2）

#### 変更箇所

1. **マイグレーション**: 新規
```sql
-- migrations/0018_add_utterance_id_to_audio.sql
ALTER TABLE audio_generations ADD COLUMN utterance_id TEXT;
ALTER TABLE audio_generations ADD COLUMN utterance_idx INTEGER;
CREATE INDEX idx_audio_generations_utterance 
  ON audio_generations(scene_id, utterance_id);
```

2. **API**: `src/routes/audio-generation.ts`
```javascript
// POST /api/scenes/:id/generate-audio
// 追加パラメータ: utterance_id, utterance_idx
const utteranceId = body.utterance_id as string | undefined;
const utteranceIdx = body.utterance_idx as number | undefined;

// INSERT時に保存
INSERT INTO audio_generations (
  scene_id, provider, voice_id, ..., utterance_id, utterance_idx
) VALUES (?, ?, ?, ..., ?, ?)
```

3. **API**: `src/routes/audio.ts` (新規エンドポイント)
```javascript
// GET /api/scenes/:id/audio/utterances
// utterance_idごとに最新の音声を返す
```

4. **UI**: `public/static/project-editor.1768570000.js`
```javascript
// generateComicUtteranceVoice() を修正
await axios.post(`${API_BASE}/scenes/${sceneId}/generate-audio`, {
  voice_preset_id: voicePresetId,
  text_override: text,
  utterance_id: utterance.id,    // 追加
  utterance_idx: idx             // 追加
});

// 再生プレビューは utterance_id でフィルタした音声を表示
```

#### 影響範囲
- DBスキーマ変更（既存データには影響なし、NULLable）
- 音声生成API（後方互換性あり）
- 漫画音声UI

#### 検証方法
```
1. 漫画の発話1, 発話2, 発話3 それぞれで音声生成
2. 各発話の再生バーに正しい音声が表示される
3. 発話1を再生成しても、発話2, 発話3の音声は変わらない
4. audio_generations テーブルに utterance_id が保存されている
```

---

### Task 3: Video Build Preflight拡張（P2）

#### 変更箇所

1. **UI**: `public/static/project-editor.1768570000.js`
```javascript
function updateVideoBuildRequirements() {
  // 変更前
  const scenesWithImages = scenes.filter(s => s.active_image).length;
  
  // 変更後
  const scenesReady = scenes.filter(s => {
    const displayType = s.display_asset_type || 'image';
    if (displayType === 'comic') {
      return s.active_comic?.r2_url;  // 漫画採用は active_comic をチェック
    }
    return s.active_image?.r2_url;    // 画像採用は active_image をチェック
  }).length;
  
  // 音声チェック（警告表示、必須ではない）
  const scenesWithAudio = scenes.filter(s => s.active_audio).length;
  if (scenesWithAudio < scenes.length) {
    html += '<div class="text-amber-600">音声なしのシーンがあります（' + scenesWithAudio + '/' + scenes.length + '）</div>';
  }
}
```

2. **API**: `src/routes/projects.ts`
```javascript
// GET /api/projects/:id/scenes?view=board
// active_audio を追加
const activeAudio = await c.env.DB.prepare(`
  SELECT id, r2_url, status FROM audio_generations
  WHERE scene_id = ? AND is_active = 1 AND status = 'completed'
  LIMIT 1
`).bind(scene.id).first();

// レスポンスに追加
active_audio: activeAudio || null
```

#### 影響範囲
- UIのPreflightチェックロジック
- projects API（active_audio追加）

#### 検証方法
```
1. 漫画採用シーンを含むプロジェクトでVideo Buildタブを開く
2. 「◯シーン準備完了」が display_asset_type に応じた正しい数を表示
3. 音声なしシーンがある場合に警告表示
4. すべてのシーンが準備完了の場合のみ「動画生成開始」が押せる
```

---

## Remotion連携の現状詳細

### 実装済み

1. **video_builds テーブル**
   - ジョブ管理、ステータス追跡、AWS連携フィールド

2. **API エンドポイント**
   - `POST /api/projects/:id/video-builds` - ビルド作成
   - `GET /api/projects/:id/video-builds` - ビルド一覧
   - `GET /api/video-builds/:id` - ビルド詳細
   - `POST /api/video-builds/:id/refresh` - ステータス更新
   - `GET /api/video-builds/usage` - 使用量確認

3. **UI**
   - Video Build タブ
   - 設定フォーム（字幕、BGM、モーション、解像度、アスペクト比）
   - Preflightチェック（現状: 画像のみ）
   - 進捗表示、履歴一覧

### 未実装（TODO）

1. **AWS Lambda 呼び出し**
   - `POST /api/projects/:id/video-builds` で `// TODO: Trigger AWS Lambda` コメント

2. **Remotion project.json 生成**
   - `settings_json` は保存されるが、実際の project.json 生成は未実装

3. **display_asset_type 連携**
   - 現状: active_image のみチェック
   - 必要: display_asset_type に応じた素材選択

---

## 実装順序の推奨

```
1. Task 1: 履歴から編集再開ボタン（工数: 小、リスク: 低）
   → UIのみの変更、すぐにテスト可能

2. Task 3: Video Build Preflight拡張（工数: 中、リスク: 低）
   → display_asset_type 対応は早めに入れるべき
   → 漫画採用シーンが動画化対象に含まれる前に必要

3. Task 2: 音声のutterance紐付け（工数: 大、リスク: 中）
   → DBスキーマ変更を含む
   → マイグレーションのテストが必要
   → 後方互換性を保つ設計
```

---

## セキュリティに関する注意

### GitHubリポジトリのセキュリティ

1. **機密情報の除外（.gitignore）**
   - `.dev.vars` - ローカル環境変数
   - `.wrangler/` - ローカルDB状態
   - `node_modules/`

2. **APIキーの管理**
   - 本番: Cloudflare Secrets（`wrangler secret put`）
   - 開発: `.dev.vars`（gitignore対象）

3. **リポジトリアクセス**
   - プライベートリポジトリを推奨
   - コラボレーター管理を適切に

4. **ブランチ保護（推奨）**
   ```
   Settings > Branches > Add rule
   - main ブランチを保護
   - Require pull request reviews
   - Require status checks
   ```
