# 画像生成ボタンと進捗表示の完全修正ドキュメント

## 📋 目次

1. [問題の概要](#問題の概要)
2. [根本原因の分析](#根本原因の分析)
3. [解決策の実装](#解決策の実装)
4. [技術的な詳細](#技術的な詳細)
5. [トラブルシューティング](#トラブルシューティング)
6. [今後のメンテナンス](#今後のメンテナンス)

---

## 問題の概要

### 🔴 発生していた問題

1. **再生成ボタンが消える**
   - ユーザーが「再生成」ボタンをクリックすると、ボタンが消えて操作不能になる
   - 画像生成中にボタンが見えなくなり、UXが悪い

2. **進捗バー（0%～100%）が表示されない**
   - 「生成中... 0%」が表示されるはずが、表示されない
   - または0%のまま止まり、進捗が更新されない

3. **完了後にボタンが戻らない**
   - 画像生成完了後、ボタンが再表示されない
   - ページをリロードしないと次の操作ができない

### 🎯 期待される動作

1. ✅ ボタンをクリック → 黄色になり「生成中... 0%」と表示
2. ✅ 1秒ごとに進捗が更新: 1% → 3% → 5% → ... → 100%
3. ✅ ボタンは常に表示され続ける（消えない）
4. ✅ 完了後、自動で画像が更新され、ボタンが緑の「再生成」に戻る
5. ✅ ページリロード不要

---

## 根本原因の分析

### 🔍 原因1: 複数のボタンIDによる混乱

**問題のコード:**
```javascript
// 初回生成時
<button id="generateBtn-${sceneId}" onclick="generateSceneImage(${sceneId})">
  画像生成
</button>

// 再生成時
<button id="regenerateBtn-${sceneId}" onclick="regenerateSceneImage(${sceneId})">
  再生成
</button>
```

**何が問題か:**
- シーンの状態によってボタンIDが変わる
- `updateGeneratingButtonUI()` が正しいボタンを見つけられない
- `getElementById()` でボタンが見つからず、進捗更新が失敗

---

### 🔍 原因2: innerHTML による丸ごと置換

**問題のコード:**
```javascript
// updateSingleSceneCard() 内
actionBtnContainer.innerHTML = `
  <button id="regenerateBtn-${sceneId}" ...>
    再生成中...
  </button>
`;
```

**何が問題か:**
- `innerHTML` で置換すると、既存のDOMが削除される
- 進捗更新中に `updateSingleSceneCard()` が呼ばれると、ボタンが消える
- 新しいボタンが作られても、IDが変わってしまう

---

### 🔍 原因3: 同期APIと進捗表示の不一致

**問題の構造:**
```javascript
// API は同期的に完了を返す
const response = await axios.post(`/api/scenes/${sceneId}/generate-image`);
// response.data.status === 'completed' ← すぐに完了

// しかしフロントは「ポーリングで進捗を確認」する設計
pollSceneImageGeneration(sceneId); // ← 意味がない
```

**何が問題か:**
- APIが30-60秒待って `status: 'completed'` を返す（同期的）
- フロントは非同期ポーリングを想定していたため、進捗が表示されない
- ユーザーは「何も起きていない」と感じる

---

### 🔍 原因4: ブラウザキャッシュ

**問題:**
```javascript
// src/index.tsx
<script src="/static/project-editor.js?v=${Date.now()}"></script>
```

**何が問題か:**
- `Date.now()` はビルド時に評価される（毎回同じ値）
- Cloudflare Pages が静的ファイルを積極的にキャッシュ
- 修正後も古いJavaScriptファイルが読み込まれ続ける

---

## 解決策の実装

### ✅ 解決策1: ボタンIDの統一

**修正後のコード:**
```javascript
// すべての状態で同じID
<button id="primaryBtn-${sceneId}" class="flex-1 ...">
  <!-- 状態によって内容が変わる -->
</button>

<button id="historyBtn-${sceneId}" onclick="viewImageHistory(${sceneId})">
  履歴
</button>
```

**メリット:**
- シーンごとに1つのボタンIDで管理
- `document.getElementById('primaryBtn-306')` が必ず見つかる
- 状態遷移時もボタンが消えない

---

### ✅ 解決策2: 状態駆動の一元管理

**新規関数: `setPrimaryButtonState()`**

```javascript
/**
 * Set primary button state (IDLE/RUNNING/DONE/FAILED)
 * @param {number} sceneId 
 * @param {string} state - 'idle' | 'generating' | 'completed' | 'failed'
 * @param {number} percent - Progress percentage (for generating state)
 */
function setPrimaryButtonState(sceneId, state, percent = 0) {
  const primaryBtn = document.getElementById(`primaryBtn-${sceneId}`);
  if (!primaryBtn) {
    console.warn(`[setPrimaryButtonState] primaryBtn not found for scene ${sceneId}`);
    return;
  }

  // Remove all state classes
  primaryBtn.classList.remove(
    'bg-blue-600', 'hover:bg-blue-700',     // IDLE
    'bg-yellow-500', 'opacity-75',           // RUNNING
    'bg-green-600', 'hover:bg-green-700',   // DONE
    'bg-red-600', 'hover:bg-red-700',       // FAILED
    'cursor-not-allowed'
  );

  switch (state.toLowerCase()) {
    case 'idle':
      // Blue button: "画像生成"
      primaryBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
      primaryBtn.disabled = false;
      primaryBtn.onclick = () => generateSceneImage(sceneId);
      primaryBtn.innerHTML = `<i class="fas fa-magic mr-2"></i>画像生成`;
      break;

    case 'generating':
    case 'running':
      // Yellow button: "生成中... XX%" (disabled)
      primaryBtn.classList.add('bg-yellow-500', 'opacity-75', 'cursor-not-allowed');
      primaryBtn.disabled = true;
      primaryBtn.onclick = null;
      primaryBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>生成中... ${percent}%`;
      console.log(`[Progress] Scene ${sceneId}: ${percent}%`);
      break;

    case 'completed':
    case 'done':
      // Green button: "再生成"
      primaryBtn.classList.add('bg-green-600', 'hover:bg-green-700');
      primaryBtn.disabled = false;
      primaryBtn.onclick = () => regenerateSceneImage(sceneId);
      primaryBtn.innerHTML = `<i class="fas fa-redo mr-2"></i>再生成`;
      break;

    case 'failed':
      // Red button: "再生成" (after failure)
      primaryBtn.classList.add('bg-red-600', 'hover:bg-red-700');
      primaryBtn.disabled = false;
      primaryBtn.onclick = () => regenerateSceneImage(sceneId);
      primaryBtn.innerHTML = `<i class="fas fa-redo mr-2"></i>再生成`;
      break;

    default:
      console.error(`[setPrimaryButtonState] Invalid state: ${state}`);
  }
}

// ✅ Expose to window for debugging
window.setPrimaryButtonState = setPrimaryButtonState;
```

**メリット:**
- 状態ごとに色・テキスト・onclick を自動設定
- 1つの関数ですべてのボタン更新を管理
- デバッグが容易（コンソールから手動で状態変更可能）

---

### ✅ 解決策3: 擬似進捗タイマー

**同期APIに対応した進捗表示:**

```javascript
async function generateSceneImage(sceneId) {
  // ... 初期処理 ...

  // ✅ Start fake progress timer BEFORE API call
  startGenerationWatch(sceneId);
  updateGeneratingButtonUI(sceneId, 0); // Show 0% immediately
  
  let fakePercent = 0;
  const fakeStart = Date.now();
  const fakeTimer = setInterval(() => {
    const elapsed = (Date.now() - fakeStart) / 1000;
    if (elapsed < 45) {
      fakePercent = Math.round((elapsed / 45) * 80); // 0-45s → 0-80%
    } else if (elapsed < 90) {
      fakePercent = 80 + Math.round(((elapsed - 45) / 45) * 15); // 45-90s → 80-95%
    } else {
      fakePercent = 95; // 90s+ → stuck at 95%
    }
    updateGeneratingButtonUI(sceneId, fakePercent);
  }, 1000);

  try {
    // API呼び出し（同期的に完了を返す）
    const response = await axios.post(`${API_BASE}/scenes/${sceneId}/generate-image`);
    
    // ✅ Stop timer and show 100%
    clearInterval(fakeTimer);
    updateGeneratingButtonUI(sceneId, 100);
    
    if (response.data.status === 'completed') {
      console.log(`✅ Image generation completed immediately for scene ${sceneId}`);
      showToast('画像生成が完了しました', 'success');
      
      // Small delay to show 100% before updating card
      setTimeout(async () => {
        stopGenerationWatch(sceneId);
        window.sceneProcessing[sceneId] = false;
        
        // Update card immediately (no polling needed)
        await updateSingleSceneCard(sceneId);
        await checkAndUpdateProjectStatus();
      }, 500);
      return;
    }
    
    // If status is 'generating' or 'pending', start polling
    startGenerationWatch(sceneId);
    updateGeneratingButtonUI(sceneId, 0);
    pollSceneImageGeneration(sceneId);
    
  } catch (error) {
    clearInterval(fakeTimer); // ✅ タイマーを停止
    
    if (error.response?.status === 524) {
      // 524 Timeout: サーバーは処理中、ポーリングを継続
      console.warn(`[524 Timeout] Scene ${sceneId} - Server processing continues`);
      showToast('生成に時間がかかっています（処理は継続中）', 'info');
      
      // タイマーは継続（95%で維持）
      // ポーリングを開始して完了を待つ
      startGenerationWatch(sceneId);
      pollSceneImageGeneration(sceneId);
      return;
    }
    
    // 真のエラー
    console.error('Generate image error:', error);
    // ... エラー処理 ...
  }
}
```

**進捗の計算ロジック:**
- **0-45秒**: 0% → 80%（線形増加）
- **45-90秒**: 80% → 95%（緩やかに増加）
- **90秒以上**: 95%で固定（タイムアウト待ち）
- **完了時**: 100%を0.5秒表示 → 画像更新

**メリット:**
- ユーザーに「処理中」であることを視覚的に伝える
- API待ち時間中も進捗を表示
- 完了時にスムーズに100%へ遷移

---

### ✅ 解決策4: キャッシュバスティング

**ファイル名にタイムスタンプハッシュを追加:**

```bash
# ファイル名を変更
HASH=$(date +%s)
mv public/static/project-editor.js public/static/project-editor.${HASH}.js
# 例: project-editor.1766716731.js
```

**src/index.tsx を更新:**
```typescript
// 修正前
<script src="/static/project-editor.js?v=${Date.now()}"></script>

// 修正後
<script src="/static/project-editor.1766716731.js"></script>
```

**メリット:**
- ファイル名が変わるため、キャッシュが強制的にクリアされる
- Cloudflare Pages でも確実に新しいファイルが配信される

---

### ✅ 解決策5: updateSingleSceneCard() の堅牢化

**タイマー実行中はボタンを上書きしない:**

```javascript
async function updateSingleSceneCard(sceneId) {
  // ... シーン情報取得 ...
  
  const actionBtnContainer = sceneCard.querySelector('.scene-action-buttons');
  if (actionBtnContainer) {
    const hasImage = latestImage && imageStatus === 'completed';
    const isGenerating = imageStatus === 'generating';
    const isFailed = imageStatus === 'failed';
    
    if (isGenerating || isProcessing) {
      // 生成中 - ✅ タイマー実行中は上書きしない
      const timerRunning = window.generatingSceneWatch?.[sceneId];
      const existingBtn = document.getElementById(`primaryBtn-${sceneId}`);
      
      if (!existingBtn || !timerRunning) {
        // ボタンが存在しない、またはタイマーが動いていない場合のみ作成
        if (!existingBtn) {
          actionBtnContainer.innerHTML = `
            <button id="primaryBtn-${sceneId}" class="flex-1 px-4 py-2 bg-gray-300 text-white rounded-lg font-semibold touch-manipulation">
              <i class="fas fa-spinner fa-spin mr-2"></i>読み込み中...
            </button>
            <button id="historyBtn-${sceneId}" onclick="viewImageHistory(${sceneId})" class="px-4 py-2 bg-gray-300 text-white rounded-lg font-semibold touch-manipulation">
              <i class="fas fa-history mr-2"></i>履歴
            </button>
          `;
        }
        setPrimaryButtonState(sceneId, 'generating', 0);
      } else {
        console.log(`[UpdateScene] Keeping existing button for scene ${sceneId} (timer running)`);
      }
    } else {
      // 完了 or 失敗 or 未生成
      const existingBtn = document.getElementById(`primaryBtn-${sceneId}`);
      if (!existingBtn) {
        actionBtnContainer.innerHTML = `
          <button id="primaryBtn-${sceneId}" class="flex-1 px-4 py-2 bg-gray-300 text-white rounded-lg font-semibold touch-manipulation">
            <i class="fas fa-spinner fa-spin mr-2"></i>読み込み中...
          </button>
          <button id="historyBtn-${sceneId}" onclick="viewImageHistory(${sceneId})" class="px-4 py-2 bg-gray-300 text-white rounded-lg font-semibold touch-manipulation">
            <i class="fas fa-history mr-2"></i>履歴
          </button>
        `;
      }
      
      if (isFailed) {
        setPrimaryButtonState(sceneId, 'failed', 0);
      } else if (hasImage) {
        setPrimaryButtonState(sceneId, 'completed', 0);
      } else {
        setPrimaryButtonState(sceneId, 'idle', 0);
      }
      
      // 履歴ボタンを更新
      const historyBtn = document.getElementById(`historyBtn-${sceneId}`);
      if (historyBtn) {
        historyBtn.disabled = !activeImage;
        historyBtn.className = `px-4 py-2 rounded-lg font-semibold touch-manipulation ${
          activeImage ? 'bg-gray-600 text-white hover:bg-gray-700 transition-colors' : 'bg-gray-400 text-gray-200 cursor-not-allowed'
        }`;
        historyBtn.innerHTML = '<i class="fas fa-history mr-2"></i>履歴';
      }
    }
  }
}
```

**メリット:**
- 進捗表示中にボタンが上書きされない
- タイマーが動いていない時だけボタンを再生成
- 既存のボタンを最大限保持

---

## 技術的な詳細

### 🏗️ アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                     フロントエンド (Browser)                  │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ユーザークリック「再生成」                                    │
│         ↓                                                     │
│  generateSceneImage(sceneId)                                 │
│         ↓                                                     │
│  startGenerationWatch(sceneId) ← タイマー開始                 │
│  setPrimaryButtonState(sceneId, 'generating', 0) ← 0%表示    │
│         ↓                                                     │
│  fakeTimer (1秒ごと) → updateGeneratingButtonUI() ← 進捗更新  │
│         ↓                                                     │
│  axios.post(/api/scenes/${sceneId}/generate-image)           │
│         ↓                                                     │
│  [30-60秒待機] ← API処理中                                    │
│         ↓                                                     │
│  response.data.status === 'completed'                        │
│         ↓                                                     │
│  clearInterval(fakeTimer) ← タイマー停止                      │
│  setPrimaryButtonState(sceneId, 'generating', 100) ← 100%表示│
│         ↓                                                     │
│  setTimeout(500ms) ← 0.5秒待機                                │
│         ↓                                                     │
│  updateSingleSceneCard(sceneId) ← 画像更新                    │
│         ↓                                                     │
│  setPrimaryButtonState(sceneId, 'completed', 0) ← 再生成ボタン│
│                                                               │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                   バックエンド (Cloudflare Workers)           │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  POST /api/scenes/${sceneId}/generate-image                  │
│         ↓                                                     │
│  シーン情報取得 (D1 Database)                                 │
│         ↓                                                     │
│  競合チェック（既に generating があれば 409）                  │
│         ↓                                                     │
│  スタイル設定取得（シーン個別 > プロジェクトデフォルト）         │
│         ↓                                                     │
│  最終プロンプト生成（スタイル適用）                            │
│         ↓                                                     │
│  image_generations レコード作成 (status: 'pending')          │
│         ↓                                                     │
│  Gemini API 呼び出し（3回リトライ、30-60秒待機）               │
│         ↓                                                     │
│  画像を R2 に保存（r2Key, r2Url 生成）                        │
│         ↓                                                     │
│  既存のアクティブ画像を無効化                                  │
│         ↓                                                     │
│  新しい画像をアクティブ化 (status: 'completed')               │
│         ↓                                                     │
│  レスポンス返却: { scene_id, image_generation_id,            │
│                    status: 'completed', r2_key, r2_url }     │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

### 📦 データモデル

#### image_generations テーブル

```sql
CREATE TABLE image_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  status TEXT NOT NULL,  -- 'pending' | 'generating' | 'completed' | 'failed'
  image_url TEXT,
  r2_key TEXT,
  r2_url TEXT,
  is_active INTEGER DEFAULT 0,  -- 0 or 1 (boolean)
  error_message TEXT,
  provider TEXT DEFAULT 'gemini',
  model TEXT DEFAULT 'gemini-3-pro-image-preview',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);

CREATE INDEX idx_image_generations_scene_id ON image_generations(scene_id);
CREATE INDEX idx_image_generations_is_active ON image_generations(is_active);
```

#### 状態遷移

```
pending → generating → completed
                    ↓
                  failed
```

---

### 🔄 状態管理

#### フロントエンド補助状態

```javascript
// UIロック（ボタン連打防止）
window.sceneProcessing = {
  306: true,  // シーン306は処理中
  307: false  // シーン307は待機中
};

// 擬似進捗タイマー
window.generatingSceneWatch = {
  306: {
    startedAt: 1766716731000,  // タイムスタンプ
    attempts: 5,               // ポーリング試行回数
    timerId: 123               // setInterval のID
  }
};

// 一括生成フラグ
window.isBulkImageGenerating = false;
```

#### SSOT（真実の情報源）

```javascript
// データベースの image_generations.status が唯一の真実
// フロントは補助的に window.sceneProcessing を使用するが、
// 最終的にはサーバーの状態が正しい
```

---

### 🎨 UI状態と色

| 状態 | ボタン色 | テキスト | クリック可能 | onclick |
|------|---------|---------|-------------|---------|
| **idle** | 青 (bg-blue-600) | 「画像生成」 | ✅ Yes | `generateSceneImage(sceneId)` |
| **generating** | 黄 (bg-yellow-500) | 「生成中... X%」 | ❌ No | `null` |
| **completed** | 緑 (bg-green-600) | 「再生成」 | ✅ Yes | `regenerateSceneImage(sceneId)` |
| **failed** | 赤 (bg-red-600) | 「再生成」 | ✅ Yes | `regenerateSceneImage(sceneId)` |

---

## トラブルシューティング

### 🐛 問題: ボタンが消える

**診断コマンド:**
```javascript
const sceneId = 306;
({
  primaryBtn: !!document.getElementById(`primaryBtn-${sceneId}`),
  historyBtn: !!document.getElementById(`historyBtn-${sceneId}`),
  regenerateBtn: !!document.getElementById(`regenerateBtn-${sceneId}`), // 古いID
  actionHTML: document.querySelector(`#builder-scene-${sceneId} .scene-action-buttons`)?.innerHTML?.slice(0, 200)
})
```

**原因1: 古いコードが読み込まれている**
- `regenerateBtn: true` → 古いコード
- 解決策: キャッシュをクリアしてリロード（Ctrl+Shift+R）

**原因2: updateSingleSceneCard() が上書きしている**
- `actionHTML` に `primaryBtn-306` が含まれていない
- 解決策: `window.generatingSceneWatch[sceneId]` が設定されているか確認

---

### 🐛 問題: 進捗が0%で止まる

**診断コマンド:**
```javascript
const sceneId = 306;
({
  timerExists: !!window.generatingSceneWatch?.[sceneId],
  timerData: window.generatingSceneWatch?.[sceneId],
  setPrimaryFn: typeof window.setPrimaryButtonState
})
```

**原因1: タイマーが開始されていない**
- `timerExists: false`
- 解決策: `startGenerationWatch(sceneId)` が呼ばれているか確認

**原因2: setPrimaryButtonState が存在しない**
- `setPrimaryFn: 'undefined'`
- 解決策: 新しいスクリプトファイルが読み込まれているか確認

---

### 🐛 問題: 進捗が表示されるが、ボタンが消える

**診断コマンド:**
```javascript
const sceneId = 306;
// クリック直後に実行
setTimeout(() => {
  console.log('After 5s:', {
    btnExists: !!document.getElementById(`primaryBtn-${sceneId}`),
    btnText: document.getElementById(`primaryBtn-${sceneId}`)?.innerText
  });
}, 5000);
```

**原因: updateSingleSceneCard() が実行されている**
- 5秒後に `btnExists: false`
- 解決策: タイマー実行中のチェックロジックを確認

```javascript
// updateSingleSceneCard() 内
const timerRunning = window.generatingSceneWatch?.[sceneId];
if (!existingBtn || !timerRunning) {
  // ボタンを再生成（タイマー実行中はスキップされるべき）
}
```

---

### 🐛 問題: 524 タイムアウトエラー

**エラーメッセージ:**
```
API error 524 (HTTP Status 524, code UNKNOWN)
```

**原因:**
- Gemini API の処理時間が100秒を超えている
- Cloudflare Workers の制限（100秒）を超過

**解決策:**
```javascript
// generateSceneImage() の catch ブロック
if (error.response?.status === 524) {
  // タイマーは継続（95%で維持）
  // ポーリングを開始して完了を待つ
  startGenerationWatch(sceneId);
  pollSceneImageGeneration(sceneId);
  return;
}
```

**ユーザーへの通知:**
- ❌ 「画像生成に失敗しました」（誤解を招く）
- ✅ 「生成に時間がかかっています（処理は継続中）」（正確）

---

### 🐛 問題: 古いファイルがキャッシュされている

**診断コマンド:**
```javascript
[...document.scripts].find(s => s.src.includes("project-editor"))?.src
```

**期待結果:**
```javascript
"https://xxx.webapp-c7n.pages.dev/static/project-editor.1766716731.js"
// ハッシュ（1766716731）が含まれている
```

**実際の結果（問題がある場合）:**
```javascript
"https://xxx.webapp-c7n.pages.dev/static/project-editor.js"
// ハッシュがない（古いファイル）
```

**解決策:**
1. ハードリロード（Ctrl+Shift+R または Cmd+Shift+R）
2. シークレットウィンドウで開く
3. ブラウザのキャッシュをクリア

---

### 🐛 問題: DB に generating レコードが残っている

**症状:**
- シーンが「生成中」のまま止まる
- 再生成ボタンが押せない
- リロードしても変わらない

**診断:**
```bash
# D1 Database を確認
npx wrangler d1 execute webapp-production --remote \
  --command="SELECT id, scene_id, status, r2_key, created_at FROM image_generations WHERE status = 'generating'"
```

**解決策:**
```bash
# generating レコードを failed に変更
npx wrangler d1 execute webapp-production --remote \
  --command="UPDATE image_generations SET status = 'failed', error_message = 'Timeout or stuck in generating state' WHERE status = 'generating' AND r2_key IS NULL"
```

---

## 今後のメンテナンス

### 📝 新しいファイルを追加する場合

**キャッシュバスティングのためのファイル名変更:**

```bash
# 1. 新しいタイムスタンプでファイル名を変更
cd /home/user/webapp
HASH=$(date +%s)
mv public/static/project-editor.{OLD_HASH}.js public/static/project-editor.${HASH}.js

# 2. src/index.tsx の参照を更新
# Line 970 付近:
<script src="/static/project-editor.${HASH}.js"></script>

# 3. ビルド & デプロイ
npm run build
npx wrangler pages deploy dist --project-name webapp
```

---

### 🎨 新しい状態を追加する場合

**例: "processing" 状態を追加**

```javascript
// setPrimaryButtonState() に追加
case 'processing':
  // Purple button: "処理中..."
  primaryBtn.classList.add('bg-purple-600', 'hover:bg-purple-700');
  primaryBtn.disabled = true;
  primaryBtn.onclick = null;
  primaryBtn.innerHTML = `<i class="fas fa-cog fa-spin mr-2"></i>処理中...`;
  break;
```

**使用例:**
```javascript
setPrimaryButtonState(sceneId, 'processing', 0);
```

---

### ⚡ 進捗速度を変更する場合

**現在の設定:**
- 0-45秒: 0% → 80%
- 45-90秒: 80% → 95%
- 90秒以上: 95% で固定

**変更例（より速い進捗）:**
```javascript
// generateSceneImage() 内の fakeTimer
if (elapsed < 30) {
  fakePercent = Math.round((elapsed / 30) * 70); // 0-30s → 0-70%
} else if (elapsed < 60) {
  fakePercent = 70 + Math.round(((elapsed - 30) / 30) * 20); // 30-60s → 70-90%
} else {
  fakePercent = 90; // 60s+ → 90%
}
```

---

### 🔧 バックエンドを非同期化する場合

**現在の問題:**
- POST /api/scenes/:id/generate-image が同期的（30-60秒待機）
- フロントは擬似進捗を表示

**理想的な実装:**

```javascript
// バックエンド: 即座に返す
POST /api/scenes/:id/generate-image
→ { scene_id: 306, image_generation_id: 239, status: 'generating' }

// フロント: 真の進捗をポーリング
GET /api/scenes/306/images/239
→ { id: 239, status: 'generating', progress: 45 }  // 0-100
```

**メリット:**
- 真の進捗を表示できる
- タイムアウトエラーが発生しない
- ユーザーはページを離れても処理が続く

---

### 🧪 テストケース

**テストケース1: 高速生成（<100秒）**
```javascript
// 期待される動作:
// 1. クリック → 黄色「生成中... 0%」
// 2. 1秒ごとに進捗更新（1%, 3%, 5%, ...）
// 3. 30秒後に完了 → 100% 表示 → 画像更新
// 4. ボタンが緑の「再生成」に戻る
```

**テストケース2: 遅い生成（>100秒、524タイムアウト）**
```javascript
// 期待される動作:
// 1. クリック → 黄色「生成中... 0%」
// 2. 進捗更新（最大95%まで）
// 3. 100秒後に524エラー
// 4. タイマーは95%で継続
// 5. ポーリング開始 → サーバーで完了を待つ
// 6. 完了後、画像更新 → ボタンが緑に戻る
```

**テストケース3: エラー（400/500）**
```javascript
// 期待される動作:
// 1. クリック → 黄色「生成中... 0%」
// 2. 進捗更新
// 3. エラー発生 → タイマー停止
// 4. エラートースト表示
// 5. ボタンが赤の「再生成」に変わる
// 6. 再度クリック可能
```

**テストケース4: ページリロード中に生成完了**
```javascript
// 期待される動作:
// 1. 生成中にページをリロード
// 2. initBuilderTab() が実行される
// 3. autoResumeGeneratingScenes() が generating シーンを検出
// 4. ポーリングを再開
// 5. 完了後、自動で画像更新
```

---

### 📊 パフォーマンス最適化

**現在の実装:**
- `updateGeneratingButtonUI()` が1秒ごとに呼ばれる
- DOM操作が頻繁に発生

**最適化案1: requestAnimationFrame を使用**
```javascript
// 現在
setInterval(() => {
  updateGeneratingButtonUI(sceneId, percent);
}, 1000);

// 最適化後
function animateProgress(sceneId, startPercent, endPercent, duration) {
  const startTime = Date.now();
  
  function update() {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const currentPercent = startPercent + (endPercent - startPercent) * progress;
    
    updateGeneratingButtonUI(sceneId, Math.round(currentPercent));
    
    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }
  
  requestAnimationFrame(update);
}
```

**最適化案2: Virtual DOM を使用**
- React や Vue.js への移行
- 差分更新による DOM 操作の削減

---

### 🔒 セキュリティ考慮事項

**XSS 対策:**
```javascript
// 悪意のあるプロンプトを防ぐ
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 使用例
const prompt = document.getElementById(`builderPrompt-${sceneId}`)?.value.trim();
// ... API に送信前にバリデーション
```

**CSRF 対策:**
- Hono の CSRF ミドルウェアを使用
- SameSite Cookie の設定

**Rate Limiting:**
- 連続クリックの防止（`window.sceneProcessing`）
- API レベルでのレート制限

---

## 一括生成での進捗表示

### 📦 一括生成の仕様

**要求仕様:**
- 一括生成時も、各シーンで独立した擬似進捗を表示
- 個別生成と同じ UX（0% → 100%）
- ボタンは消えない
- 完了したシーンから順次「再生成」に戻る

### 🔧 実装方針

**アプローチA: 擬似進捗（採用）**

- 5秒ごとのポーリング時に全シーン状態を取得
- `status === 'generating'` のシーンで擬似進捗開始
- `status === 'completed'` のシーンで擬似進捗停止
- 既存の `startGenerationWatch()` / `stopGenerationWatch()` を再利用

**実装コード:**
```javascript
// 一括生成のポーリングループ内
while (pollCount < maxPolls) {
  // ステータス取得
  const statusRes = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/generate-images/status`);
  const { processed, pending, failed, generating, status } = statusRes.data;
  
  // 🎯 各シーンの状態を取得して擬似進捗を開始/停止
  try {
    const scenesRes = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes?view=board`);
    const scenes = scenesRes.data.scenes || [];
    
    scenes.forEach(scene => {
      const latestImage = scene.latest_image;
      const imageStatus = latestImage?.status || 'pending';
      
      if (imageStatus === 'generating') {
        // 擬似進捗開始（既に動いている場合は何もしない）
        if (!window.generatingSceneWatch || !window.generatingSceneWatch[scene.id]) {
          console.log(`🚀 [BULK] Starting fake progress for scene ${scene.id}`);
          startGenerationWatch(scene.id);
        }
      } else if (imageStatus === 'completed') {
        // 擬似進捗停止 & 完了状態へ
        if (window.generatingSceneWatch && window.generatingSceneWatch[scene.id]) {
          console.log(`✅ [BULK] Scene ${scene.id} completed, stopping fake progress`);
          stopGenerationWatch(scene.id);
          setPrimaryButtonState(scene.id, 'completed', 0);
        }
      }
    });
  } catch (sceneError) {
    console.warn('[BULK] Failed to fetch scenes for progress update:', sceneError);
  }
  
  // 5秒待機
  await new Promise(resolve => setTimeout(resolve, 5000));
  pollCount++;
}
```

### ✅ 期待される動作

**一括生成開始時:**
1. 全シーンのボタンが「一括処理中」で無効化
2. バックエンドが順次生成開始

**生成中:**
1. シーンAが `generating` になる → 擬似進捗開始（黄色、0%）
2. 1秒ごとに進捗更新: 1% → 3% → 5% → ... → 95%
3. シーンAが `completed` になる → 擬似進捗停止、100%表示、緑の「再生成」へ
4. シーンB、C、... も同様に独立して進捗表示

**完了時:**
- すべてのシーンが緑の「再生成」ボタンになる
- トーストで「画像生成完了！ (N件)」を表示

### 🎯 重要ポイント

1. **各シーン独立**
   - 各シーンは独立したタイマーで進捗表示
   - あるシーンが完了しても、他のシーンには影響しない

2. **ポーリング頻度**
   - 5秒ごとに全シーン状態を確認
   - ポーリング中は擬似進捗が動作し続ける

3. **状態一貫性**
   - `startGenerationWatch()` / `stopGenerationWatch()` を使用
   - 個別生成と一括生成で同じロジック

4. **エラーハンドリング**
   - シーン取得失敗時も、全体のポーリングは継続
   - 個別シーンのエラーは独立して処理

### 🚫 採用しなかったアプローチ

**アプローチB: リアルタイム進捗（高度）**
- バックエンドに `/api/projects/:id/generate-images/progress` を追加
- 各シーンの実際の進捗（0-100）を返す
- **不採用理由**: バックエンド変更が必要、擬似進捗で十分

### 🔍 テスト手順

**一括生成のテスト:**
```javascript
// 1) 一括生成を開始
document.getElementById('generateAllImagesBtn').click();

// 2) 数秒後、各シーンの進捗を確認
Object.keys(window.generatingSceneWatch || {});  // 生成中のシーンID一覧

// 3) 特定シーンの進捗を確認
const sceneId = 306;
document.getElementById(`primaryBtn-${sceneId}`)?.innerText;  // "生成中... X%"

// 4) コンソールログを確認
// 期待:
// 🚀 [BULK] Starting fake progress for scene 306
// [Progress] Scene 306: 0%
// [Progress] Scene 306: 1%
// ...
// ✅ [BULK] Scene 306 completed, stopping fake progress
```

### 📝 今後の改善候補

1. **全体進捗バー**
   - 「3/10 シーン完了」のような全体進捗を表示
   - トップバーに進捗バーを追加

2. **優先度制御**
   - 失敗したシーンを優先的に再生成
   - ユーザーが順序を指定できる

3. **リアルタイム進捗**
   - バックエンドからの実際の進捗を表示
   - WebSocket や Server-Sent Events を使用

---

## まとめ

### ✅ 達成したこと

1. **ボタンが消えない** → `primaryBtn-${sceneId}` を固定DOM化
2. **進捗表示が動作（個別 & 一括）** → 擬似進捗タイマーを実装
3. **完了後の自動復帰** → `setPrimaryButtonState()` で状態管理
4. **キャッシュ問題を解決** → ファイル名にハッシュを追加
5. **堅牢なエラーハンドリング** → 524タイムアウトに対応
6. **一括生成対応** → 各シーンで独立した擬似進捗表示

### 🎯 核心的な学び

1. **状態駆動設計の重要性**
   - UI の状態を明確に定義する（IDLE/RUNNING/DONE/FAILED）
   - 1つの関数ですべての状態遷移を管理する

2. **DOM の永続化**
   - `innerHTML` での丸ごと置換を避ける
   - 固定IDのボタンを作り、内容だけを更新する

3. **同期APIと進捗表示の両立**
   - 擬似進捗で UX を改善できる
   - ユーザーに「処理中」を視覚的に伝える

4. **キャッシュの恐怖**
   - 静的ファイルのキャッシュは予想以上に強力
   - ファイル名にハッシュを含めるのが確実

5. **デバッグの重要性**
   - コンソールログを適切に配置する
   - 問題を段階的に切り分ける

---

## 参考リンク

- **GitHub リポジトリ**: https://github.com/matiuskuma2/webapp
- **最新デプロイ**: https://0ad5bf2a.webapp-c7n.pages.dev/projects/30
- **Cloudflare Pages ドキュメント**: https://developers.cloudflare.com/pages/
- **Hono ドキュメント**: https://hono.dev/
- **Gemini API ドキュメント**: https://ai.google.dev/gemini-api

---

## 変更履歴

| 日付 | バージョン | 変更内容 | コミット |
|------|----------|---------|---------|
| 2024-12-26 | 1.0.0 | 初版作成 | 04e2c3e |

---

**最終更新**: 2024年12月26日  
**作成者**: Claude (Anthropic) & モギモギ  
**ライセンス**: MIT
