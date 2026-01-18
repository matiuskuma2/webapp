# Phase1.7 実装状況ドキュメント

最終更新: 2026-01-18

## 概要

Phase1.7は漫画（Comic）機能のUI/UX整合性とSSOT（Single Source of Truth）設計を完成させるフェーズです。

---

## 完了済み機能

### 1. 採用切替のリアルタイム反映 ✅

**ファイル**: `public/static/project-editor.1768570000.js`

```javascript
// switchDisplayAssetType() - 部分更新でスクロール位置維持
async function switchDisplayAssetType(sceneId, newType) {
  // 1. API呼び出し
  await axios.put(`/api/scenes/${sceneId}/display-asset-type`, { display_asset_type: newType });
  
  // 2. シーンデータを再取得（部分更新用）
  const sceneRes = await axios.get(`${API_BASE}/scenes/${sceneId}?view=board`);
  
  // 3. スクロール位置を保存
  const scrollY = window.scrollY;
  
  // 4. シーンカードのみ更新
  sceneCard.outerHTML = renderBuilderSceneCard(updatedScene);
  
  // 5. スクロール位置を復元
  window.scrollTo(0, scrollY);
  
  // 6. ボタン状態を再初期化
  initializeSceneCardButtons(updatedScene, newCard);
}
```

### 2. 漫画採用中の矛盾UI排除 ✅

**ファイル**: `public/static/project-editor.1768570000.js` - `renderBuilderSceneCard()`

| 項目 | 漫画モード時の状態 |
|-----|------------------|
| 画像再生成ボタン | 非活性（グレーアウト + ツールチップ説明） |
| 動画化ボタン | 非活性（「Remotionで動画化」案内） |
| シーン編集のdialogue | 読み取り専用 + 警告メッセージ |
| 音声セクション | 発話ごとのUI（最大3発話）に切替 |

### 3. 動画サムネはAI画像固定 ✅

**理由**: 動画は元のAI画像から生成されるため、漫画採用時でもサムネイルは元画像を表示

```javascript
// renderSceneImageSection()
poster="${imageUrl || ''}"  // 常にAI画像のURLを使用
```

### 4. 漫画採用時のセリフ表示（最大3発話） ✅

**ファイル**: `public/static/project-editor.1768570000.js`

```javascript
// renderComicUtterances(scene) - 最大3発話を表示
// scene.dialogueは書き換えない（データ破壊防止）
// comic採用時は comic_data.published.utterances を表示
```

### 5. display_image SSOT ✅

**ファイル**: `src/routes/projects.ts`, `src/routes/scenes.ts`, `src/routes/runs-v2.ts`

```javascript
// APIレスポンスに display_image を追加
display_image: (() => {
  const displayType = scene.display_asset_type || 'image';
  if (displayType === 'comic' && activeComicRecord) {
    return { type: 'comic', r2_url: activeComicRecord.r2_url };
  }
  if (activeRecord) {
    return { type: 'image', r2_url: activeRecord.r2_url };
  }
  return null;
})()
```

### 6. 音声再生プレビュー ✅

**ファイル**: `public/static/project-editor.1768570000.js`

- 各発話に音声プレビュー領域（`comicUtteranceAudioPreview-{sceneId}-{idx}`）
- 生成完了時に `<audio controls>` プレーヤーを即座に表示
- 独立したポーリング（2秒間隔）で生成完了を監視

---

## API変更点

### GET /api/scenes/:id?view=board

**追加フィールド**:
- `active_video`: 動画情報（id, r2_url, status, model, duration_sec）
- `display_image`: 採用素材のSSO（type, r2_url, image_url）

### GET /api/projects/:id/scenes?view=board

**追加フィールド**:
- `display_image`: 採用素材のSSOT

### POST /api/scenes/:id/generate-audio

**追加パラメータ**:
- `voice_preset_id`: `voice_id`の代替（フロントエンド互換性）
- `text_override`: 任意のテキストを指定（漫画発話用）

---

## データベーススキーマ

### scenes テーブル

```sql
display_asset_type TEXT DEFAULT 'image'  -- 'image' | 'comic'
comic_data TEXT  -- JSON: { draft: {...}, published: {...} }
```

### image_generations テーブル

```sql
asset_type TEXT  -- 'ai' | 'comic' | NULL(legacy)
```

### audio_generations テーブル

```sql
-- 現状: scene_id単位
-- TODO: utterance_id を追加して発話単位に紐付け
```

---

## 残タスク（P1-P2）

### P1: 履歴から編集再開ボタン

画像履歴（asset_type='comic'）に以下を追加:
- 「編集再開」ボタン
- 「この漫画を採用」ボタン

### P2: 音声のutterance紐付けSSOT

```sql
-- 必要なスキーマ変更
ALTER TABLE audio_generations ADD COLUMN utterance_id TEXT;
ALTER TABLE audio_generations ADD COLUMN utterance_idx INTEGER;
```

### P2: Video Build Preflight

現状のチェック:
- `scenes.filter(s => s.active_image).length === scenes.length`

必要な拡張:
- `display_asset_type` に応じたチェック
- 漫画採用シーンは `active_comic` の存在確認
- 音声の有無チェック（任意/警告表示）

---

## 関連ファイル一覧

### バックエンド
- `src/routes/scenes.ts` - シーンAPI
- `src/routes/projects.ts` - プロジェクトAPI
- `src/routes/runs-v2.ts` - Run（バッチ処理）API
- `src/routes/comic.ts` - 漫画API
- `src/routes/audio-generation.ts` - 音声生成API
- `src/routes/downloads.ts` - エクスポートAPI

### フロントエンド
- `public/static/project-editor.1768570000.js` - メインUI
- `public/static/comic-editor-v2.js` - 漫画エディタ
- `public/static/audio-ui.js` - 音声UI
- `public/static/audio-state.js` - 音声状態管理
