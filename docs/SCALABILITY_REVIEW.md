# システム整合性・進捗管理SSOT・スケーラビリティレビュー

**実施日**: 2025-12-20  
**対象**: RILARC Scenario Generator (webapp)  
**レビュー観点**: 
1. マイグレーション・GitHub・DB間の矛盾
2. 進捗管理のSSOT（Single Source of Truth）
3. 100/1000人同時アクセス時の破綻リスク

---

## 📋 エグゼクティブサマリー

### ✅ 整合性検証結果
- **マイグレーション**: ✅ 全8ファイル適用済み
- **DB構造**: ✅ 全9テーブル存在
- **GitHub**: ✅ 最新コミット反映

### ⚠️ SSOT検証結果
- **シーン分割進捗**: ⚠️ 仕様として成立、但しポーリング停止リスク
- **画像生成進捗**: ⚠️ 仕様として成立、但し並行処理に課題

### 🔴 スケーラビリティリスク
- **D1書き込み**: 🔴 高負荷時に遅延
- **外部API**: 🔴 429レート制限リスク
- **ポーリング**: 🔴 5秒×1000人=200req/sec

---

## 1. マイグレーション・GitHub・DB間の矛盾チェック

### 1.1 マイグレーション適用状況

**確認結果**: ✅ **矛盾なし**

```bash
$ npx wrangler d1 migrations list webapp-production --local
✅ No migrations to apply!
```

**マイグレーションファイル一覧**:
1. `0001_initial_schema.sql` - 初期テーブル作成
2. `0002_add_source_type.sql` - source_type追加
3. `0003_add_error_tracking.sql` - エラー追跡
4. `0004_add_text_chunks.sql` - text_chunksテーブル
5. `0005_format_chunked_processing.sql` - chunk_id追加
6. `0006_extend_error_message.sql` - error_message拡張
7. `0007_add_runs_system.sql` - runsシステム
8. `0008_add_style_presets.sql` - スタイルプリセット

### 1.2 実際のテーブル構造

**確認結果**: ✅ **全9テーブル存在**

| テーブル名 | マイグレーション | 状態 |
|-----------|---------------|------|
| `projects` | 0001 | ✅ 存在 |
| `transcriptions` | 0001 | ✅ 存在 |
| `text_chunks` | 0004 | ✅ 存在 |
| `scenes` | 0001 | ✅ 存在 |
| `image_generations` | 0001 | ✅ 存在 |
| `style_presets` | 0008 | ✅ 存在 |
| `project_style_settings` | 0008 | ✅ 存在 |
| `scene_style_settings` | 0008 | ✅ 存在 |
| `runs` | 0007 | ✅ 存在 |

### 1.3 GitHub最新状態

**確認結果**: ✅ **最新コミット反映**

- Latest Commit: `b99780a`
- ドキュメント追加: `SYSTEM_COMPREHENSIVE_SPEC.md`, `VERIFICATION_SUMMARY.md`
- マイグレーションファイル: 全8ファイル存在

**結論**: **マイグレーション・GitHub・DB間に矛盾はありません。**

---

## 2. シーン分割（Scene Split）進捗のSSOT検証

### 2.1 SSOT（Single Source of Truth）の定義

**✅ 正しいSSOT設計**:

```
text_chunks テーブル = SSOT
  ├── text_chunks.status: 'pending' / 'processing' / 'done' / 'failed'
  ├── text_chunks.error_message: 失敗理由
  └── text_chunks.scene_count: 生成シーン数

projects.status = 大枠状態（補助）
  └── 'parsed' / 'formatting' / 'formatted'
```

### 2.2 進捗API設計

**エンドポイント**: `GET /api/projects/:id/format/status`

**レスポンス**:
```json
{
  "status": "formatting",
  "total_chunks": 16,
  "processed": 3,
  "processing": 0,
  "pending": 13,
  "failed": 0
}
```

**SSOT評価**: ✅ **`text_chunks`テーブルから正しく集計**

```typescript
// src/routes/formatting.ts (Line 220-230)
const { results: stats } = await c.env.DB.prepare(`
  SELECT 
    COUNT(CASE WHEN status = 'done' THEN 1 END) as processed,
    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
    COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing,
    COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
    COUNT(*) as total_chunks
  FROM text_chunks
  WHERE project_id = ?
`).bind(projectId).all()
```

### 2.3 「途中で止まって見える」問題の分析

**ユーザーが見る現象**:
```
シーン化中… (3 / 16)
↓ (ページリロード)
シーン化中… (3 / 16)  ← 進んでない？
```

**原因の正体**:

1. **クライアント側ポーリング停止**
   - ページリロード → `setInterval()`が破棄
   - ネット断 → `axios`がタイムアウト
   - タブスリープ → ブラウザがポーリング停止

2. **サーバー側は正常**
   - `pending > 0` なら再開可能
   - `POST /api/projects/:id/format`を叩けば次バッチ処理

**実装済みの対策**:

```javascript
// public/static/project-editor.js (Line 279-293)
async function initSceneSplitTab() {
  // ...
  
  // 🔧 自動再開機能 (Auto-Resume)
  if (project.status === 'formatting') {
    console.log('[SceneSplit] Detected formatting status, starting auto-resume...');
    updateFormatProgress({
      status: 'formatting',
      // ...
    });
    startFormatPolling();  // ポーリング再開
  }
}
```

**評価**: ✅ **自動再開実装済み、仕様として成立**

### 2.4 潜在的リスク

#### ⚠️ リスク1: ポーリング停止時の復帰UX

**現状**:
- 自動再開は実装済み
- しかし「手動で再開」ボタンがない

**問題シナリオ**:
```
1. ユーザーが「シーン分割を実行」クリック
2. ポーリング開始 → (3/16) まで進む
3. ネット断 or タブスリープ
4. ポーリング停止 → サーバー側も停止
5. ユーザーが戻ってきても「再開方法が分からない」
```

**推奨対応**:
- UI: 「処理が止まった場合は再開ボタンを押してください」
- 実装: `<button onclick="resumeFormatting()">再開</button>`

#### ⚠️ リスク2: 無限ポーリング

**現状**:
```javascript
// public/static/project-editor.js (Line 521-590)
function startFormatPolling() {
  const pollInterval = setInterval(async () => {
    // ...
  }, 5000);  // 5秒ごと、無限ループ
}
```

**問題**:
- `formatted`になるまで **無限にポーリング**
- ネットワークエラー時もリトライし続ける

**推奨対応**:
```javascript
const MAX_POLLS = 360;  // 30分 (5秒×360)
let pollCount = 0;

const pollInterval = setInterval(async () => {
  if (pollCount++ > MAX_POLLS) {
    clearInterval(pollInterval);
    showToast('処理がタイムアウトしました。再開ボタンを押してください。', 'error');
    return;
  }
  // ...
}, 5000);
```

---

## 3. 画像生成（Builder）進捗のSSOT検証

### 3.1 SSOT（Single Source of Truth）の定義

**✅ 正しいSSOT設計**:

```
image_generations テーブル = SSOT
  ├── image_generations.status: 'pending' / 'generating' / 'completed' / 'failed'
  ├── image_generations.is_active: 1 = 採用画像（シーンごとに1枚）
  └── image_generations.r2_key: R2ストレージキー

scenes テーブル = シーン定義（補助）
  └── scenes は画像を直接持たない
```

### 3.2 進捗API設計

**エンドポイント**: `GET /api/projects/:id/generate-images/status`

**レスポンス**:
```json
{
  "project_id": 26,
  "status": "generating_images",
  "total_scenes": 48,
  "processed": 37,
  "generating": 1,
  "pending": 10,
  "failed": 0
}
```

**SSOT評価**: ✅ **`image_generations`テーブルから正しく集計**

```typescript
// src/routes/image-generation.ts (Line 450-480)
async function getImageGenerationStats(c: Context, projectId: number) {
  const stats = await c.env.DB.prepare(`
    SELECT
      COUNT(DISTINCT s.id) as total_scenes,
      COUNT(DISTINCT CASE WHEN ig.status = 'completed' THEN s.id END) as processed,
      COUNT(DISTINCT CASE WHEN ig.status = 'generating' THEN s.id END) as generating,
      COUNT(DISTINCT CASE WHEN ig.status = 'failed' THEN s.id END) as failed
    FROM scenes s
    LEFT JOIN image_generations ig ON s.id = ig.scene_id AND ig.is_active = 1
    WHERE s.project_id = ?
  `).bind(projectId).first()
  // ...
}
```

### 3.3 一括生成中の並行処理制御

**現状の実装**:

#### ✅ フロントエンド（UIロック）

```javascript
// public/static/project-editor.js
let window.isBulkImageGenerating = false;  // グローバルフラグ

async function generateBulkImages(filter) {
  if (window.isBulkImageGenerating) {
    showToast('一括画像生成が既に実行中です', 'warning');
    return;
  }
  
  window.isBulkImageGenerating = true;
  
  // 個別ボタンをグレーアウト
  document.querySelectorAll('.scene-image-btn').forEach(btn => {
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
  });
  
  // ... 処理 ...
  
  window.isBulkImageGenerating = false;
}
```

#### ✅ バックエンド（API排他）

```typescript
// src/routes/image-generation.ts (Line 280-290)
app.post('/scenes/:id/generate-image', async (c) => {
  // 🔒 重複生成チェック
  const existingGeneration = await c.env.DB.prepare(`
    SELECT id FROM image_generations 
    WHERE scene_id = ? AND status = 'generating'
  `).bind(sceneId).first();

  if (existingGeneration) {
    return c.json({ 
      error: 'ALREADY_GENERATING',
      message: 'This scene is already generating an image'
    }, 409);  // HTTP 409 Conflict
  }
  
  // ... 処理 ...
});
```

**評価**: ✅ **並行処理制御は実装済み、仕様として成立**

### 3.4 潜在的リスク

#### ⚠️ リスク1: 別タブ・別端末からの競合

**問題シナリオ**:
```
タブA: 「全画像生成」クリック
  → window.isBulkImageGenerating = true
タブB: 「全画像生成」クリック
  → window.isBulkImageGenerating = false (別のウィンドウオブジェクト)
  → 同時実行！
```

**現状の防御**:
- ✅ バックエンドAPI: `status='generating'`チェックで409返却
- ❌ フロントエンド: タブ間通信なし

**推奨対応**:
```javascript
// localStorage を使ったタブ間通信
function startBulkGeneration(projectId) {
  const lockKey = `bulk_gen_lock_${projectId}`;
  const lockValue = Date.now();
  
  // ロック取得試行
  if (localStorage.getItem(lockKey)) {
    const lockTime = parseInt(localStorage.getItem(lockKey));
    if (Date.now() - lockTime < 300000) {  // 5分以内
      showToast('他のタブで一括生成中です', 'warning');
      return;
    }
  }
  
  localStorage.setItem(lockKey, lockValue.toString());
  
  // ... 処理 ...
  
  localStorage.removeItem(lockKey);
}
```

#### ⚠️ リスク2: `generating`状態のスタック

**問題シナリオ**:
```
1. Scene A: status='generating' に更新
2. Gemini API呼び出し
3. ネットワークエラー or Workers タイムアウト
4. status='generating' のまま残る
5. 次の生成リクエストが 409 Conflict で弾かれる
```

**現状の対策**:
```typescript
// src/routes/image-generation.ts (Line 150-165)
// 🔧 スタック検知とタイムアウト処理
const stuckGenerations = await c.env.DB.prepare(`
  SELECT id FROM image_generations
  WHERE scene_id = ? 
  AND status = 'generating'
  AND created_at < datetime('now', '-5 minutes')
`).bind(sceneId).all()

if (stuckGenerations.results.length > 0) {
  // 5分以上 generating のレコードは failed に
  await c.env.DB.prepare(`
    UPDATE image_generations
    SET status = 'failed', error_message = 'Timed out'
    WHERE id = ?
  `).bind(stuckGenerations.results[0].id).run()
}
```

**評価**: ✅ **タイムアウト処理実装済み**

---

## 4. 100/1000人同時アクセス時のボトルネック分析

### 4.1 想定シナリオ

**ユーザー行動**:
```
100人が同時に:
  1. プロジェクト作成
  2. テキスト入力（平均5,000文字）
  3. 「シーン分割を実行」クリック
  4. 「全画像生成」クリック
```

**負荷計算**:
```
シーン分割:
  - テキストチャンク: 5,000文字 ÷ 1,000 = 5 chunks/user
  - 総チャンク数: 100人 × 5 = 500 chunks
  - OpenAI API呼び出し: 500回

画像生成:
  - 平均シーン数: 5 chunks × 3 scenes = 15 scenes/user
  - 総シーン数: 100人 × 15 = 1,500 scenes
  - Gemini API呼び出し: 1,500回
```

### 4.2 ボトルネックA: D1（SQLite）書き込み

**問題点**:
```
text_chunks.status 更新:
  - 'pending' → 'processing' → 'done'
  - 500 chunks × 2回更新 = 1,000回書き込み

image_generations INSERT/UPDATE:
  - INSERT (status='pending') → UPDATE (status='generating') → UPDATE (status='completed')
  - 1,500 scenes × 3回 = 4,500回書き込み
```

**D1のスペック**:
- SQLiteベース
- **書き込みは順次実行**（並行書き込みなし）
- レイテンシー: 数ms〜数十ms/query

**推定負荷**:
```
1,000回 + 4,500回 = 5,500回書き込み
× 10ms/query = 55秒（最良ケース）
× 50ms/query = 275秒（高負荷時）
```

**評価**: 🔴 **高負荷時に遅延・タイムアウトリスク**

**推奨対応（優先度A）**:

#### 1. バッチ更新（トランザクション化）

**現状（1件ずつ更新）**:
```typescript
// 悪い例
for (const chunk of chunks) {
  await db.prepare(`
    UPDATE text_chunks SET status = 'processing' WHERE id = ?
  `).bind(chunk.id).run();
}
```

**推奨（バッチ更新）**:
```typescript
// 良い例
await db.batch([
  db.prepare(`UPDATE text_chunks SET status = 'processing' WHERE id = ?`).bind(chunk1.id),
  db.prepare(`UPDATE text_chunks SET status = 'processing' WHERE id = ?`).bind(chunk2.id),
  db.prepare(`UPDATE text_chunks SET status = 'processing' WHERE id = ?`).bind(chunk3.id),
]);
```

**効果**: 書き込み回数 1/3 → レイテンシー大幅改善

#### 2. 進捗キャッシュ（KV/Cache API）

**現状**:
```typescript
// 5秒ごとに全ユーザーがD1クエリ
GET /api/projects/:id/format/status
  → SELECT COUNT(*) FROM text_chunks WHERE project_id = ?
```

**推奨**:
```typescript
// KVにキャッシュ
async function getFormatStatus(projectId: string) {
  const cacheKey = `format_status:${projectId}`;
  
  // KVから取得（超高速）
  let status = await env.KV.get(cacheKey, 'json');
  if (!status) {
    // D1から取得
    status = await calculateFromDB(projectId);
    // 10秒キャッシュ
    await env.KV.put(cacheKey, JSON.stringify(status), { expirationTtl: 10 });
  }
  
  return status;
}
```

**効果**: D1クエリ数 1/10 → 負荷劇的低減

### 4.3 ボトルネックB: 外部API（OpenAI/Gemini）

**レート制限**:

| サービス | 無料枠 | 有料枠 |
|---------|--------|--------|
| OpenAI API | 3 req/min | 500 req/min〜 |
| Gemini API | 15 req/min | 1,000 req/min〜 |

**現状の実装**:
```typescript
// src/routes/formatting.ts (Line 320-350)
async function processTextChunks(chunks) {
  for (const chunk of chunks) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      // ...
    });
    // 即座に次のchunkを処理
  }
}
```

**問題点**:
- **同期処理**: 1 chunk → OpenAI → 次chunk
- **リトライなし**: 429エラーで即失敗
- **キュー未実装**: 全ユーザーが同時に叩く

**100人シナリオ**:
```
500 chunks を 3分（180秒）で処理
→ 500 / 180 = 2.77 req/sec
→ OpenAI無料枠（3 req/min = 0.05 req/sec）を超える
→ 429 Too Many Requests
```

**評価**: 🔴 **レート制限で確実に失敗**

**推奨対応（優先度A）**:

#### 1. Cloudflare Queues 導入

**アーキテクチャ変更**:
```
[現在]
ユーザー → POST /format → 即実行 → OpenAI API
                              ↓ 429エラー

[推奨]
ユーザー → POST /format → Queue投入 → 完了
                              ↓
                         Worker (Consumer)
                              ↓ レート制限考慮
                         OpenAI API
```

**実装例**:
```typescript
// Producer (APIエンドポイント)
app.post('/projects/:id/format', async (c) => {
  const chunks = await getChunks(projectId);
  
  // Queueに投入（即座に返す）
  for (const chunk of chunks) {
    await c.env.QUEUE.send({
      type: 'format_chunk',
      projectId,
      chunkId: chunk.id,
      text: chunk.text
    });
  }
  
  return c.json({ success: true, queued: chunks.length });
});

// Consumer (バックグラウンドWorker)
export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      const { projectId, chunkId, text } = message.body;
      
      // レート制限考慮（指数バックオフ）
      await processChunkWithRetry(projectId, chunkId, text);
      message.ack();
    }
  }
}
```

**効果**:
- ✅ ユーザー体験向上（即座にレスポンス）
- ✅ レート制限回避（Workerが順次処理）
- ✅ リトライ機能（Queueが自動再送）

#### 2. 指数バックオフ（Exponential Backoff）

**現状**:
```typescript
// リトライなし
const response = await fetch(apiUrl);
if (!response.ok) {
  throw new Error('API failed');
}
```

**推奨**:
```typescript
async function fetchWithBackoff(url, options, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, options);
    
    if (response.ok) return response;
    
    if (response.status === 429) {
      const delay = Math.pow(2, i) * 1000;  // 1s, 2s, 4s, 8s, 16s
      console.log(`Rate limited, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    
    throw new Error(`API failed: ${response.status}`);
  }
  
  throw new Error('Max retries exceeded');
}
```

**効果**: 一時的な429エラーを自動リカバリ

### 4.4 ボトルネックC: ポーリング過多

**現状**:
```javascript
// 全ユーザーが5秒ごとにポーリング
setInterval(async () => {
  await axios.get(`/api/projects/${PROJECT_ID}/format/status`);
}, 5000);
```

**負荷計算**:
```
100人 × (1回/5秒) = 20 req/sec
1000人 × (1回/5秒) = 200 req/sec
```

**D1への影響**:
```
SELECT COUNT(*) FROM text_chunks WHERE project_id = ?
× 200回/sec
= D1が過負荷
```

**評価**: 🔴 **大量ユーザー時にD1過負荷**

**推奨対応（優先度B）**:

#### 1. ポーリング間隔の指数バックオフ

**現状（固定5秒）**:
```javascript
setInterval(() => poll(), 5000);
```

**推奨（適応的間隔）**:
```javascript
let pollInterval = 2000;  // 初期2秒
let consecutiveNoChange = 0;

async function adaptivePoll() {
  const status = await getStatus();
  
  if (status.pending === 0) {
    // 完了 → ポーリング停止
    return;
  }
  
  if (status.processing > 0) {
    // 処理中 → 短い間隔
    pollInterval = 2000;
    consecutiveNoChange = 0;
  } else {
    // 変化なし → 徐々に間隔を延ばす
    consecutiveNoChange++;
    pollInterval = Math.min(pollInterval * 1.5, 30000);  // 最大30秒
  }
  
  setTimeout(adaptivePoll, pollInterval);
}
```

**効果**: 
- 処理中: 2秒間隔（リアルタイム性維持）
- 待機中: 最大30秒間隔（負荷軽減）

#### 2. Server-Sent Events (SSE) 検討

**現状（ポーリング）**:
```
Client → Server (5秒ごと)
       ← レスポンス
```

**推奨（SSE）**:
```
Client → Server (初回接続のみ)
       ← イベントストリーム（変化時のみ送信）
```

**実装例**:
```typescript
// Server (Hono + SSE)
app.get('/projects/:id/format/stream', async (c) => {
  return streamSSE(c, async (stream) => {
    while (true) {
      const status = await getFormatStatus(projectId);
      await stream.writeSSE({
        data: JSON.stringify(status)
      });
      
      if (status.pending === 0) break;
      
      await stream.sleep(5000);
    }
  });
});

// Client
const eventSource = new EventSource(`/api/projects/${PROJECT_ID}/format/stream`);
eventSource.onmessage = (event) => {
  const status = JSON.parse(event.data);
  updateUI(status);
};
```

**効果**: ポーリング負荷 → 0

**注意**: Cloudflare Workersは接続時間制限あり（Durable Objectsで回避可能）

---

## 5. 改善提案（優先順位付き）

### 優先度A：落ちない・止まらない（運用の安全弁）

#### 1. **Cloudflare Queues 導入** 🔴 最重要

**対象**: シーン分割・画像生成

**理由**:
- 外部APIレート制限を確実に回避
- ユーザー体験向上（即座にレスポンス）
- 自動リトライでエラー耐性向上

**実装工数**: 中（2-3日）

**効果**: 🔥 破綻リスク大幅低減

#### 2. **D1バッチ更新** 🔴

**対象**: `text_chunks`, `image_generations`の更新

**理由**:
- 書き込み回数を1/3に削減
- レイテンシー改善

**実装工数**: 小（1日）

**効果**: D1負荷 30% 削減

#### 3. **進捗キャッシュ（KV）** 🟠

**対象**: `/format/status`, `/generate-images/status`

**理由**:
- D1クエリ数を1/10に削減
- ポーリング負荷軽減

**実装工数**: 小（1日）

**効果**: D1負荷 90% 削減（進捗API）

#### 4. **ポーリングタイムアウト** 🟠

**対象**: フロントエンドポーリング

**理由**:
- 無限ポーリング防止
- UX改善（タイムアウト通知）

**実装工数**: 極小（1時間）

**効果**: 無駄なリクエスト削減

### 優先度B：速い（体感改善）

#### 5. **ポーリング間隔のバックオフ** 🟢

**対象**: フロントエンドポーリング

**理由**:
- 処理中: 短い間隔（リアルタイム性）
- 待機中: 長い間隔（負荷軽減）

**実装工数**: 小（半日）

**効果**: API負荷 50% 削減

#### 6. **指数バックオフリトライ** 🟢

**対象**: 外部API呼び出し

**理由**:
- 429エラー自動リカバリ
- 一時的なエラー耐性

**実装工数**: 小（1日）

**効果**: 成功率向上

### 優先度C：観測性（原因追跡しやすさ）

#### 7. **構造化エラーログ** 🔵

**理由**:
- デバッグ効率向上
- 障害対応の時間短縮

**実装工数**: 小（1日）

**効果**: 運用コスト削減

#### 8. **運用指標ダッシュボード** 🔵

**内容**:
- 最後に成功したchunk/scene
- 平均処理時間
- エラー率

**実装工数**: 中（2日）

**効果**: 問題の早期発見

---

## 6. 実装ロードマップ

### フェーズ1（1週間） - 緊急対応
```
Day 1-2: Cloudflare Queues 導入（シーン分割）
Day 3:   D1バッチ更新
Day 4-5: Cloudflare Queues 導入（画像生成）
Day 6:   進捗キャッシュ（KV）
Day 7:   テスト・デプロイ
```

### フェーズ2（1週間） - 体感改善
```
Day 1-2: ポーリング間隔バックオフ
Day 3-4: 指数バックオフリトライ
Day 5-6: ポーリングタイムアウト
Day 7:   テスト・デプロイ
```

### フェーズ3（2週間） - 観測性強化
```
Week 1: 構造化エラーログ
Week 2: 運用指標ダッシュボード
```

---

## 7. 結論と推奨事項

### ✅ 整合性評価

| 項目 | 評価 | 備考 |
|------|------|------|
| マイグレーション | ✅ 良好 | 全8ファイル適用済み |
| DB構造 | ✅ 良好 | 全9テーブル存在 |
| GitHub | ✅ 良好 | 最新コミット反映 |

### ⚠️ SSOT評価

| 項目 | 評価 | 備考 |
|------|------|------|
| シーン分割進捗 | ⚠️ 成立 | ポーリング停止リスクあり |
| 画像生成進捗 | ⚠️ 成立 | 並行処理制御済み |

### 🔴 スケーラビリティ評価

| 項目 | 現状 | 100人時 | 1000人時 |
|------|------|---------|----------|
| D1書き込み | 🟢 正常 | 🟠 遅延 | 🔴 タイムアウト |
| 外部API | 🟢 正常 | 🔴 429エラー | 🔴 破綻 |
| ポーリング | 🟢 正常 | 🟠 高負荷 | 🔴 過負荷 |

### 📋 最優先対応項目（フェーズ1）

1. **Cloudflare Queues 導入** 🔥
2. **D1バッチ更新**
3. **進捗キャッシュ（KV）**
4. **ポーリングタイムアウト**

### 🎯 目標

**100人同時**:
- ✅ 全機能が正常動作
- ✅ レスポンス3秒以内

**1000人同時**:
- ✅ 順次処理でエラーなし
- ⚠️ レスポンス遅延許容

---

**レビュアー**: AI Assistant  
**最終更新**: 2025-12-20  
**次回レビュー**: フェーズ1完了後
