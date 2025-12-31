# 🎯 音声生成（TTS）機能の最小実装仕様書

**作成日**: 2024-12-26  
**対象**: RILARC Scenario Generator - webapp  
**スコープ**: 音声生成（TTS）機能の追加（既存機能に影響なし）  
**バージョン**: 2.0（Cloudflare環境対応版）

---

## 📋 目次

1. [概要](#概要)
2. [技術選定と安全要件](#技術選定と安全要件)
3. [DB設計](#db設計)
4. [API設計](#api設計)
5. [UI/UX設計](#uiux設計)
6. [Export統合](#export統合)
7. [実装順序](#実装順序)
8. [技術的負債の整理](#技術的負債の整理)

---

## 概要

### 🎯 **目標**

シーンごとに `dialogue`（セリフ）から音声を生成し、履歴管理・採用・Exportを可能にする。

### ✅ **原則**

1. **既存テーブルは変更しない**（破壊的変更なし）
2. **新規テーブルのみ追加**（マイグレーションは追加SQLで完結）
3. **既存APIは変更しない**（新規エンドポイントのみ追加）
4. **画像生成と同じパターンを踏襲**（状態管理・UI・進捗表示）
5. **Cloudflare Workers/Pages環境で安全に動作**

### 📦 **スコープ**

- ✅ シーン単位の音声生成
- ✅ 音声履歴の管理（生成・一覧・採用・削除）
- ✅ 音声プレビュー（`<audio controls>`）
- ✅ 擬似進捗表示（0% → 100%）
- ✅ 524タイムアウト対策（ポーリング復帰）
- ✅ Exportへの統合（`audio/scene_{idx}.mp3`）
- ⏭️ 一括音声生成（後続フェーズ）

---

## 技術選定と安全要件

### 🔧 **修正① Google TTS - REST API を使用**

**❌ NG: `@google-cloud/text-to-speech` SDK**
- 理由:
  - Cloudflare Workers環境で依存が重い
  - 認証方式が複雑（サービスアカウントJSON等）
  - バンドルサイズが肥大化
  - エラーハンドリングが不透明

**✅ OK: Google Cloud Text-to-Speech REST API**

```typescript
// Google TTS REST API
const TTS_API_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

async function generateSpeech(text: string, voiceId: string, apiKey: string) {
  const response = await fetch(TTS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
    },
    body: JSON.stringify({
      input: { text },
      voice: {
        languageCode: 'ja-JP',
        name: voiceId,
      },
      audioConfig: {
        audioEncoding: 'MP3',
        sampleRateHertz: 24000,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`TTS API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.audioContent; // Base64 encoded MP3
}
```

**環境変数:**
```bash
GOOGLE_TTS_API_KEY=your_api_key_here
```

**メリット:**
- ✅ 依存ゼロ（fetch APIのみ）
- ✅ バンドルサイズ影響なし
- ✅ エラーが明確
- ✅ Cloudflare Workers/Pagesで安全

---

### 🔧 **修正② 524タイムアウト対策**

**問題:**
- 音声生成は短時間が多いが、長文では30秒以上かかる可能性
- 同期APIで待つと、UI固まる＋524エラー

**解決策:**

1. **基本は同期実行でOK**（音声は短時間）
2. **ただし、524やネットワークエラーでも "生成は続いている" 可能性**
3. **フロントエンドはポーリングで完了検知**

**実装パターン:**

```typescript
// バックエンド
audioGeneration.post('/scenes/:id/generate-audio', async (c) => {
  try {
    // 1) generating レコード作成（即座に返す）
    const audioGen = await createAudioGeneration(sceneId, voiceId, dialogue);
    
    // 2) 非同期処理開始（await しない）
    generateAndUploadAudio(audioGen.id, dialogue, voiceId, c.env)
      .catch(err => {
        console.error('Audio generation failed:', err);
        updateAudioStatus(audioGen.id, 'failed', err.message);
      });
    
    // 3) 即座に generating を返す
    return c.json({
      audio_generation: {
        id: audioGen.id,
        status: 'generating',
        ...
      }
    });
    
  } catch (error) {
    // ...
  }
});

// フロントエンド
async function generateAudio(sceneId) {
  try {
    // 1) API呼び出し（即座に generating が返る）
    const response = await axios.post(
      `${API_BASE}/scenes/${sceneId}/generate-audio`,
      { voice_id: voiceId }
    );
    
    const audioGen = response.data.audio_generation;
    
    // 2) 擬似進捗開始
    setAudioButtonState(sceneId, 'generating', 0);
    startAudioGenerationWatch(sceneId);
    
    // 3) ポーリング（completed になるまで）
    await pollAudioStatus(sceneId, audioGen.id);
    
    // 4) 完了
    stopAudioGenerationWatch(sceneId);
    setAudioButtonState(sceneId, 'completed', 100);
    updateAudioPreview(sceneId);
    
  } catch (error) {
    // 524やネットワークエラーでも「生成は続いている」
    // UIは generating のまま、ポーリングで完了検知
    if (error.code === 'ECONNABORTED' || error.response?.status === 524) {
      console.warn('Network timeout, but generation may continue');
      // ポーリング継続
    } else {
      setAudioButtonState(sceneId, 'failed', 0);
    }
  }
}
```

---

### 🔧 **修正③ Trigger削除（updated_at はアプリ側管理）**

**理由:**
- SQLite Triggerは動くが、デバッグしづらい
- D1環境でどこで更新されたか追いづらい
- `updated_at` はアプリ側で明示的に管理する方が安全

**実装:**

```typescript
// ❌ Trigger不要
// CREATE TRIGGER update_audio_generations_timestamp ...

// ✅ UPDATE時に明示的に更新
await c.env.DB.prepare(`
  UPDATE audio_generations 
  SET status = ?, r2_url = ?, updated_at = CURRENT_TIMESTAMP 
  WHERE id = ?
`).bind(status, r2Url, audioId).run();
```

---

### ⚠️ **安全要件（画像生成で学んだルール）**

#### **1) completed の定義を固定**

```typescript
// ✅ completed なら r2_url は必須
async function completeAudioGeneration(audioId: number, r2Url: string) {
  // Update to completed
  await db.prepare(`
    UPDATE audio_generations 
    SET status = 'completed', r2_url = ?, updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `).bind(r2Url, audioId).run();
  
  // 検証: r2_url が空なら failed に戻す
  const audio = await db.prepare(`
    SELECT id, r2_url FROM audio_generations WHERE id = ?
  `).bind(audioId).first();
  
  if (!audio.r2_url) {
    console.error(`[Audio] No r2_url for audio ${audioId}, reverting to failed`);
    await db.prepare(`
      UPDATE audio_generations 
      SET status = 'failed', error_message = 'R2 upload failed', updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).bind(audioId).run();
  }
}
```

#### **2) 競合防止（音声も必須）**

```typescript
// 同一シーンで generating があれば 409
audioGeneration.post('/scenes/:id/generate-audio', async (c) => {
  // Check for existing generating audio
  const existing = await c.env.DB.prepare(`
    SELECT id FROM audio_generations 
    WHERE scene_id = ? AND status = 'generating'
  `).bind(sceneId).first();
  
  if (existing) {
    return c.json({
      error: {
        code: 'AUDIO_GENERATING',
        message: 'Audio generation already in progress for this scene'
      }
    }, 409);
  }
  
  // Proceed with generation
  // ...
});
```

**UI側:**
```javascript
async function generateAudio(sceneId) {
  // 生成中のチェック
  if (window.audioGeneratingWatch && window.audioGeneratingWatch[sceneId]) {
    showToast('音声生成中です', 'warning');
    return;
  }
  
  // Proceed
  // ...
}
```

#### **3) active は最大1件をアプリで担保**

```typescript
// activate は (1) 既存activeを0 → (2) 対象を1
audioGeneration.post('/audio/:audioId/activate', async (c) => {
  const audioId = parseInt(c.req.param('audioId'));
  
  // Get scene_id
  const audio = await c.env.DB.prepare(`
    SELECT scene_id FROM audio_generations WHERE id = ?
  `).bind(audioId).first();
  
  if (!audio) {
    return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  }
  
  // Step 1: Deactivate all for this scene
  await c.env.DB.prepare(`
    UPDATE audio_generations 
    SET is_active = 0, updated_at = CURRENT_TIMESTAMP 
    WHERE scene_id = ?
  `).bind(audio.scene_id).run();
  
  // Step 2: Activate target
  await c.env.DB.prepare(`
    UPDATE audio_generations 
    SET is_active = 1, updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `).bind(audioId).run();
  
  // Verify
  const activeCount = await c.env.DB.prepare(`
    SELECT COUNT(*) as count FROM audio_generations 
    WHERE scene_id = ? AND is_active = 1
  `).bind(audio.scene_id).first();
  
  if (activeCount.count !== 1) {
    console.error(`[Audio] Active count mismatch for scene ${audio.scene_id}`);
  }
  
  return c.json({ success: true });
});
```

---

## DB設計

### 🗄️ **新規テーブル: `audio_generations`**

**マイグレーションファイル**: `migrations/0009_create_audio_generations.sql`

```sql
-- Audio generations table
CREATE TABLE IF NOT EXISTS audio_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  
  -- TTS provider settings
  provider TEXT NOT NULL DEFAULT 'google',  -- 'google' | 'elevenlabs' | 'minimax'
  voice_id TEXT NOT NULL,                   -- 例: 'ja-JP-Standard-A'
  model TEXT,                               -- 例: 'ja-JP-Neural2-B'
  
  -- Audio specs
  format TEXT NOT NULL DEFAULT 'mp3',       -- 'mp3' | 'wav'
  sample_rate INTEGER DEFAULT 24000,        -- Hz
  
  -- Generation input/output
  text TEXT NOT NULL,                       -- 生成元セリフ（dialogue）
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'generating' | 'completed' | 'failed'
  error_message TEXT,                       -- エラー詳細
  
  -- R2 storage
  r2_key TEXT,                              -- R2のキー: audio/{project_id}/scene_{idx}/{generation_id}_{timestamp}.mp3
  r2_url TEXT,                              -- 公開URL
  
  -- Metadata
  is_active INTEGER NOT NULL DEFAULT 0,    -- 1 = 採用中, 0 = 履歴
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_audio_generations_scene_id 
  ON audio_generations(scene_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audio_generations_scene_active 
  ON audio_generations(scene_id, is_active);

CREATE INDEX IF NOT EXISTS idx_audio_generations_status 
  ON audio_generations(status);

-- ❌ Trigger削除（updated_at はアプリ側で管理）
```

---

### 📝 **音声プリセット管理（最小実装）**

**ファイル**: `public/static/voice-presets.json`

```json
{
  "presets": [
    {
      "id": "ja-standard-a",
      "name": "日本語 女性A（標準）",
      "provider": "google",
      "voice_id": "ja-JP-Standard-A",
      "language": "ja-JP",
      "gender": "female",
      "description": "標準的な女性の声",
      "is_active": true
    },
    {
      "id": "ja-standard-b",
      "name": "日本語 男性B（標準）",
      "provider": "google",
      "voice_id": "ja-JP-Standard-B",
      "language": "ja-JP",
      "gender": "male",
      "description": "標準的な男性の声",
      "is_active": true
    },
    {
      "id": "ja-neural2-b",
      "name": "日本語 男性B（Neural2）",
      "provider": "google",
      "voice_id": "ja-JP-Neural2-B",
      "language": "ja-JP",
      "gender": "male",
      "description": "自然な男性の声（高品質）",
      "is_active": true
    },
    {
      "id": "ja-neural2-c",
      "name": "日本語 女性C（Neural2）",
      "provider": "google",
      "voice_id": "ja-JP-Neural2-C",
      "language": "ja-JP",
      "gender": "female",
      "description": "自然な女性の声（高品質）",
      "is_active": true
    }
  ],
  "default_preset_id": "ja-standard-a"
}
```

---

## API設計

### 🔌 **新規エンドポイント**

#### **1) シーン単位の音声生成**

**POST `/api/scenes/:id/generate-audio`**

```typescript
// Request
{
  voice_id: string;        // 例: "ja-JP-Standard-A"
  provider?: string;       // デフォルト: "google"
  format?: string;         // デフォルト: "mp3"
  sample_rate?: number;    // デフォルト: 24000
}

// Response (Success) - 即座に generating を返す
{
  audio_generation: {
    id: number;
    scene_id: number;
    provider: string;
    voice_id: string;
    text: string;           // scenes.dialogue
    status: "generating";   // 常に generating
    r2_url: null;           // まだ null
    is_active: false;
    created_at: string;
  }
}

// Response (Error)
{
  error: {
    code: "INVALID_SCENE" | "NO_DIALOGUE" | "AUDIO_GENERATING";
    message: string;
  }
}
```

#### **2) シーンの音声履歴取得**

**GET `/api/scenes/:id/audio`**

```typescript
// Response
{
  audio_generations: [
    {
      id: number;
      scene_id: number;
      provider: string;
      voice_id: string;
      text: string;
      status: string;
      error_message: string | null;
      r2_url: string | null;
      is_active: boolean;
      created_at: string;
      updated_at: string;
    }
  ],
  active_audio: {
    // is_active = 1 のレコード（最大1件）
  } | null
}
```

#### **3) 音声の採用切り替え**

**POST `/api/audio/:audioId/activate`**

```typescript
// Request
{} // Body不要

// Response
{
  success: true;
  active_audio: {
    id: number;
    scene_id: number;
    r2_url: string;
    is_active: true;
  }
}
```

#### **4) 音声の削除**

**DELETE `/api/audio/:audioId`**

```typescript
// Response
{
  success: true;
}

// Error
{
  error: {
    code: "ACTIVE_AUDIO_DELETE" | "NOT_FOUND";
    message: string;
  }
}
```

---

## UI/UX設計

### 🎨 **Builderカードへの増築**

#### **増築後の構造:**
```
┌─────────────────────────────────┐
│ Scene Header (index, role)      │
├─────────────────────────────────┤
│ Dialogue (left column)          │
│ Media Area (right column)       │
│   ┌───────────────────────────┐ │
│   │ Image Section             │ │
│   │   - Image                 │ │
│   │   - primaryBtn-{id}       │ │
│   │   - historyBtn-{id}       │ │
│   └───────────────────────────┘ │
│   ┌───────────────────────────┐ │
│   │ Audio Section (NEW)       │ │
│   │   - Voice Preset Selector │ │
│   │   - audioPreview-{id}     │ │
│   │   - audioPrimaryBtn-{id}  │ │
│   │   - audioHistoryBtn-{id}  │ │
│   └───────────────────────────┘ │
└─────────────────────────────────┘
```

### 🔧 **Audio Section の実装（固定DOM）**

```html
<!-- Audio Section -->
<div class="mt-4 border-t pt-4">
  <h4 class="text-sm font-semibold text-gray-700 mb-2">
    <i class="fas fa-volume-up mr-2"></i>音声
  </h4>
  
  <!-- Voice Preset Selector -->
  <div class="mb-2">
    <select 
      id="voicePreset-${scene.id}" 
      class="w-full px-3 py-2 border rounded-lg text-sm"
    >
      <option value="">音声タイプを選択</option>
      <!-- 動的に voice-presets.json から生成 -->
    </select>
  </div>
  
  <!-- Audio Preview (固定DOM) -->
  <div id="audioPreview-${scene.id}" class="mb-2">
    <!-- 未生成時 -->
    <div class="bg-gray-100 rounded-lg p-4 text-center text-gray-500 text-sm">
      <i class="fas fa-microphone-slash text-2xl mb-2"></i>
      <p>音声未生成</p>
    </div>
  </div>
  
  <!-- Action Buttons (固定DOM) -->
  <div class="flex gap-2">
    <button 
      id="audioPrimaryBtn-${scene.id}" 
      onclick="generateAudio(${scene.id})"
      class="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold"
    >
      <i class="fas fa-magic mr-2"></i>音声生成
    </button>
    
    <button 
      id="audioHistoryBtn-${scene.id}" 
      onclick="viewAudioHistory(${scene.id})"
      class="px-4 py-2 rounded-lg font-semibold bg-gray-600 text-white hover:bg-gray-700 transition-colors"
    >
      <i class="fas fa-history"></i>
    </button>
  </div>
</div>
```

### 🎯 **状態管理関数（画像と同じパターン）**

```javascript
/**
 * Set audio button state (IDLE/RUNNING/DONE/FAILED)
 * @param {number} sceneId 
 * @param {string} state - 'idle' | 'generating' | 'completed' | 'failed'
 * @param {number} percent - Progress percentage (0-100)
 */
function setAudioButtonState(sceneId, state, percent = 0) {
  const btn = document.getElementById(`audioPrimaryBtn-${sceneId}`);
  if (!btn) {
    console.warn(`[Audio] Button not found for scene ${sceneId}`);
    return;
  }
  
  // Remove all state classes
  btn.classList.remove(
    'bg-blue-600', 'hover:bg-blue-700',    // IDLE
    'bg-yellow-500', 'hover:bg-yellow-600', // RUNNING
    'bg-green-600', 'hover:bg-green-700',   // DONE
    'bg-red-600', 'hover:bg-red-700',       // FAILED
    'cursor-not-allowed'
  );
  
  switch (state) {
    case 'idle':
      btn.className = 'flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold';
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-magic mr-2"></i>音声生成';
      btn.onclick = () => generateAudio(sceneId);
      break;
      
    case 'generating':
      btn.className = 'flex-1 px-4 py-2 bg-yellow-500 text-white rounded-lg cursor-not-allowed transition-colors font-semibold';
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>生成中... ${percent}%`;
      btn.onclick = null;
      console.log(`[Audio Progress] Scene ${sceneId}: ${percent}%`);
      break;
      
    case 'completed':
      btn.className = 'flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold';
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-redo mr-2"></i>再生成';
      btn.onclick = () => generateAudio(sceneId);
      break;
      
    case 'failed':
      btn.className = 'flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-semibold';
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-redo mr-2"></i>再生成';
      btn.onclick = () => generateAudio(sceneId);
      break;
  }
}

// Expose to window
window.setAudioButtonState = setAudioButtonState;
```

---

## Export統合

### 📦 **既存ZIPを壊さず追加**

#### **ディレクトリ構造:**

```
all.zip
├── images/
│   ├── scene_1.png
│   ├── scene_2.png
│   └── ...
├── audio/              ← 新規追加
│   ├── scene_1.mp3
│   ├── scene_2.mp3
│   └── ...
├── dialogue.csv        ← 既存（変更なし）
└── dialogue_with_audio.csv  ← 新規追加（オプション）
```

---

## 実装順序

### 📅 **Phase 0: 設計の固定（完了）**

- ✅ SDKではなくREST API
- ✅ completed定義（r2_url必須）
- ✅ generating競合（409）
- ✅ ボタン固定DOM方式
- ✅ 524タイムアウト対策

### 📅 **Phase 1: DB & マイグレーション**

1. ✅ マイグレーションファイル作成
2. ✅ ローカルDB適用
3. ✅ 本番DB適用

### 📅 **Phase 2: バックエンドAPI**

1. ✅ 新規ファイル作成
2. ✅ エンドポイント実装
3. ✅ Google TTS REST API統合
4. ✅ 安全要件実装

### 📅 **Phase 3: フロントエンド**

1. ✅ Voice Presets JSON
2. ✅ UI実装
3. ✅ 状態管理
4. ✅ 生成フロー
5. ✅ 履歴モーダル

### 📅 **Phase 4: Export統合**

1. ✅ Export API更新
2. ✅ ZIP生成

---

## 技術的負債の整理

### 🔧 **最小限の共通化**

1. **status定数**: `src/constants.ts`
2. **エラーレスポンス**: `src/utils/error-response.ts`
3. **R2 URL生成**: `src/utils/r2-helper.ts`

---

**最終更新**: 2024年12月26日  
**作成者**: Claude (Anthropic) & モギモギ
