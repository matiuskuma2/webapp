# P2 設計パッチ — 左ボード表示改善（仕様フリーズ）

> **ステータス**: 設計フリーズ（2026-02-15）
> **前提**: Ticket A/B/C + P1 完了
> **原則**: status API 一本（SSOT）、既存影響ゼロ

---

## 変更ファイル一覧

| ファイル | 変更内容 | 影響度 |
|---------|---------|--------|
| `src/routes/marunage.ts` | status API に `character_stats` + `assets_summary` 追加 | 追加のみ（既存フィールドに触らない） |
| `src/types/marunage.ts` | 型定義に新フィールド追加 | 追加のみ |
| `src/index.tsx` | Assets セクションに `mcAssetsSummary` DOM 追加 | HTML追加のみ |
| `public/static/marunage-chat.js` | `mcUpdateBoardFromConfirmed` 拡張 + `mcUpdateAssetsSummary` 新規 | 追加のみ |

---

## 1. status API 拡張（marunage.ts）

### 1.1 confirmed.characters に登場数・voice_provider を追加

**SQL（Step 6 の既存クエリを拡張）:**

```sql
-- 既存（L2008-2013）
SELECT character_key, character_name, voice_preset_id
FROM project_character_models
WHERE project_id = ?
ORDER BY id ASC

-- 拡張版（サブクエリで登場シーン数・発話数を付与）
SELECT 
  pcm.character_key, 
  pcm.character_name, 
  pcm.voice_preset_id,
  (SELECT COUNT(DISTINCT su.scene_id)
   FROM scene_utterances su
   JOIN scenes s ON s.id = su.scene_id
   WHERE su.character_key = pcm.character_key
     AND s.project_id = pcm.project_id
     AND su.role = 'dialogue'
     AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
  ) AS appear_scenes,
  (SELECT COUNT(*)
   FROM scene_utterances su
   JOIN scenes s ON s.id = su.scene_id
   WHERE su.character_key = pcm.character_key
     AND s.project_id = pcm.project_id
     AND su.role = 'dialogue'
     AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
  ) AS utterance_count
FROM project_character_models pcm
WHERE pcm.project_id = ?
ORDER BY pcm.id ASC
```

**レスポンス（confirmed.characters の各要素）:**

```json
{
  "character_key": "taro",
  "character_name": "太郎",
  "voice_preset_id": "el-aria",
  "appear_scenes": 3,
  "utterance_count": 8,
  "voice_provider": "elevenlabs"
}
```

`voice_provider` はサーバ側で `voice_preset_id` から推定:
- `el-` or `elevenlabs:` → `"elevenlabs"`
- `fish:` or `fish-` → `"fish"`
- その他 → `"google"`

### 1.2 progress.assets_summary を追加

**既存データから算出（新規SQL不要）:**

```json
"assets_summary": {
  "scenes_total": 5,
  "images_done": 3,
  "images_state": "running",
  "audio_done": 5,
  "audio_total": 12,
  "audio_state": "done",
  "video_state": "pending",
  "video_percent": null
}
```

これは既存の `progress.images` / `progress.audio` / `progress.video` から組み立てるだけ。

---

## 2. 型定義拡張（marunage.ts types）

```typescript
// confirmed.characters 拡張
confirmed?: {
  characters: Array<{
    character_key: string
    character_name: string
    voice_preset_id: string | null
    appear_scenes: number       // ← NEW
    utterance_count: number     // ← NEW
    voice_provider: string      // ← NEW ('google' | 'elevenlabs' | 'fish')
  }>
  style: { ... }  // 変更なし
  voice: { ... }  // 変更なし
}

// progress.assets_summary 追加
progress: {
  ...existing...
  assets_summary: {             // ← NEW
    scenes_total: number
    images_done: number
    images_state: string
    audio_done: number
    audio_total: number
    audio_state: string
    video_state: string
    video_percent: number | null
  }
}
```

---

## 3. HTML 変更（index.tsx）

### 3.1 Assets セクションに assets_summary 表示エリア追加

**挿入位置**: `mcBoardIdle` の後、`mcSceneCards` の前

```html
<!-- Assets Summary (P2: populated from status API) -->
<div id="mcAssetsSummary" class="hidden mb-3">
  <div class="grid grid-cols-3 gap-2 text-center">
    <div class="bg-gray-50 rounded-lg p-2">
      <div id="mcAssetsImages" class="text-sm font-bold text-gray-800">-/-</div>
      <div class="text-[10px] text-gray-500">画像</div>
    </div>
    <div class="bg-gray-50 rounded-lg p-2">
      <div id="mcAssetsAudio" class="text-sm font-bold text-gray-800">-/-</div>
      <div class="text-[10px] text-gray-500">音声</div>
    </div>
    <div class="bg-gray-50 rounded-lg p-2">
      <div id="mcAssetsVideo" class="text-sm font-bold text-gray-800">--</div>
      <div class="text-[10px] text-gray-500">動画</div>
    </div>
  </div>
  <p id="mcAssetsHint" class="text-[10px] text-gray-400 mt-1.5 text-center">
    <i class="fas fa-info-circle mr-0.5"></i>開始後はこのボードで進捗を確認します
  </p>
</div>
```

### 3.2 ロックバッジの tooltip 更新

全4セクションの `title` を変更:
```
処理中は変更できません  →  生成中のため変更できません（再生成はv2）
```

---

## 4. JS 変更（marunage-chat.js）

### 4.1 mcUpdateBoardFromConfirmed 拡張

キャラチップに `登場 N/M` + voice ラベルを表示:

```javascript
// Characters (from server SSOT) — P2: include appear_scenes + voice label
charConfirmed.innerHTML = confirmed.characters.map(ch => {
  const scenesTotal = data?.progress?.format?.scene_count || 0;
  const appear = ch.appear_scenes || 0;
  const voiceLabel = ch.voice_provider === 'elevenlabs' ? '🎤EL'
    : ch.voice_provider === 'fish' ? '🎤Fish' : '🔊Google';
  return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium">'
    + '<i class="fas fa-user text-[10px]"></i>' + escapeHtml(ch.character_name)
    + '<span class="text-[9px] text-gray-400 ml-0.5">'
    + (scenesTotal > 0 ? appear + '/' + scenesTotal : '')
    + ' ' + voiceLabel
    + '</span>'
    + '</span>';
}).join('');
```

### 4.2 mcUpdateAssetsSummary 新関数

```javascript
function mcUpdateAssetsSummary(progress) {
  const el = document.getElementById('mcAssetsSummary');
  if (!el || !progress) return;
  
  const summary = progress.assets_summary;
  if (!summary) return;
  
  el.classList.remove('hidden');
  
  // Images: "3/5" + color
  const imgEl = document.getElementById('mcAssetsImages');
  imgEl.textContent = summary.images_done + '/' + summary.scenes_total;
  imgEl.className = 'text-sm font-bold ' + stateColor(summary.images_state);
  
  // Audio: "12/12" + color
  const audEl = document.getElementById('mcAssetsAudio');
  audEl.textContent = summary.audio_done + '/' + summary.audio_total;
  audEl.className = 'text-sm font-bold ' + stateColor(summary.audio_state);
  
  // Video: state label
  const vidEl = document.getElementById('mcAssetsVideo');
  if (summary.video_state === 'done') vidEl.textContent = '完了';
  else if (summary.video_state === 'running') vidEl.textContent = (summary.video_percent || 0) + '%';
  else if (summary.video_state === 'failed') vidEl.textContent = '失敗';
  else if (summary.video_state === 'off') vidEl.textContent = 'OFF';
  else vidEl.textContent = '待機中';
  vidEl.className = 'text-sm font-bold ' + stateColor(summary.video_state);
}

function stateColor(state) {
  if (state === 'done') return 'text-green-600';
  if (state === 'running') return 'text-blue-600';
  if (state === 'failed') return 'text-red-600';
  return 'text-gray-600';
}
```

### 4.3 mcUpdateFromStatus にフック追加

```javascript
function mcUpdateFromStatus(data) {
  // ... existing code ...
  
  // P2: Update assets summary
  mcUpdateAssetsSummary(data.progress);
  
  // ... rest of existing code ...
}
```

### 4.4 mcStartNew で assets_summary をリセット

```javascript
function mcStartNew() {
  // ... existing code ...
  
  // P2: Hide assets summary
  const assetsSummary = document.getElementById('mcAssetsSummary');
  if (assetsSummary) assetsSummary.classList.add('hidden');
}
```

---

## 5. 実装行数見積もり

| ファイル | 追加行 | 削除行 |
|---------|--------|--------|
| `src/routes/marunage.ts` | ~30 | ~5（既存クエリ置換） |
| `src/types/marunage.ts` | ~12 | 0 |
| `src/index.tsx` | ~20 | ~4（tooltip text） |
| `public/static/marunage-chat.js` | ~45 | ~5（チップHTML置換） |
| **合計** | **~107** | **~14** |

---

## 6. ゼロインパクト確認

- [ ] 新テーブル: **0**
- [ ] ALTER TABLE: **0**
- [ ] 新APIエンドポイント: **0**（既存 status API の応答拡張のみ）
- [ ] 既存フィールド削除: **0**（全て追加のみ）
- [ ] Builder UI への影響: **ゼロ**
- [ ] フロントの既存DOM変更: **0**（新id追加のみ）
