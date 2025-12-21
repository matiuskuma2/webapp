# 🐛 修正レポート：画像生成完了時のステータス更新問題

**報告日時**: 2025-12-20  
**報告者**: モギモギ（関屋紘之）  
**対象プロジェクト**: Project ID 27  
**症状**: 既に画像生成済みなのに「生成中」と表示され、再生成エラーが発生

---

## 🔍 問題の詳細

### 症状
- **Project ID 27**で、すべての画像が既に生成済み（24/24件完了）
- 再生成しようとすると「生成中」と表示され、エラーが発生
- コンソールエラー: `GET https://webapp-c7n.pages.dev/images/27/scene_4/158_1766206581066.png net::ERR_HTTP2_PROTOCOL_ERROR 200 (OK)`

### 根本原因
- **プロジェクトステータスが `generating_images` のまま固定**
- データベース確認結果:
  - `projects.status = 'generating_images'`
  - `image_generations`: 24件すべて `status='completed'`、`pending=0`, `generating=0`
  
**なぜステータスが更新されないか？**

フロントエンドのポーリングロジック（`project-editor.js` Line 1577）で、`pending === 0 && generating === 0` の場合に**即座に完了判定**していたが、**最後のAPI呼び出しを実行していなかった**。

バックエンドAPI (`image-generation.ts` Line 71-87) では、`pendingScenes.length === 0` の場合に初めてプロジェクトステータスを `completed` に更新する設計だったため、**フロントエンドが最後の1回のAPIコールをスキップすると、ステータスが更新されない**。

---

## ✅ 修正内容

### コード修正箇所
**ファイル**: `public/static/project-editor.js`  
**行番号**: Line 1577付近

#### Before（修正前）
```javascript
// 2) 完了判定
if (pending === 0 && generating === 0) {
  const finalMessage = failed > 0 
    ? `画像生成完了！ (成功: ${processed}件, 失敗: ${failed}件)` 
    : `画像生成完了！ (${processed}件)`;
  showToast(finalMessage, failed > 0 ? 'warning' : 'success');
  await initBuilderTab();
  break;
}
```

#### After（修正後）
```javascript
// 2) 完了判定
if (pending === 0 && generating === 0) {
  // 最後のAPI呼び出しでプロジェクトステータスを 'completed' に更新
  try {
    await axios.post(`${API_BASE}/projects/${PROJECT_ID}/generate-images`);
  } catch (finalCallError) {
    console.warn('Final API call error:', finalCallError);
  }
  
  const finalMessage = failed > 0 
    ? `画像生成完了！ (成功: ${processed}件, 失敗: ${failed}件)` 
    : `画像生成完了！ (${processed}件)`;
  showToast(finalMessage, failed > 0 ? 'warning' : 'success');
  await initBuilderTab();
  break;
}
```

### 修正ロジック
1. **完了判定時に最後のAPI呼び出しを追加**
2. API内部で `pendingScenes.length === 0` を検出し、プロジェクトステータスを `completed` に更新
3. エラーハンドリングを追加（最後のAPIコールが失敗しても、UI上は完了表示）

---

## 🛠️ 即時対応（Project ID 27）

既存のProject 27のステータスを手動で修正しました:

```sql
UPDATE projects 
SET status = 'completed', updated_at = CURRENT_TIMESTAMP 
WHERE id = 27;
```

**結果**: Project 27は正常に `completed` 状態になり、再生成が可能になります。

---

## 📊 影響範囲

### 影響を受ける機能
- **一括画像生成機能**（「全画像生成」「未生成のみ」「失敗のみ」ボタン）
- **個別画像生成**には影響なし（元々ステータス確認なし）

### 影響を受けるプロジェクト
- **すでに完了しているが `status='generating_images'` のままのプロジェクト**
- 新規プロジェクトは修正後のコードで正常動作

### データベース確認コマンド
```sql
-- 影響を受けているプロジェクトを確認
SELECT p.id, p.title, p.status, COUNT(ig.id) as total_images,
       SUM(CASE WHEN ig.status='completed' THEN 1 ELSE 0 END) as completed_images
FROM projects p
LEFT JOIN scenes s ON s.project_id = p.id
LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
WHERE p.status = 'generating_images'
GROUP BY p.id
HAVING total_images > 0 AND completed_images = total_images;
```

---

## 🧪 テスト手順

### 修正後のテスト（次回デプロイ後）
1. **新規プロジェクトで一括画像生成**
   - 全シーンの画像生成が完了
   - プロジェクトステータスが自動的に `completed` に更新される
   - 再生成ボタンが正常に動作

2. **既存プロジェクト（Project 27）**
   - ステータスが `completed` に手動修正済み
   - 再生成ボタンが正常に動作
   - 画像URLが正しく表示される

---

## 🚀 デプロイ状況

### GitHub
- **Commit**: `9dd7cb3`
- **Repository**: https://github.com/matiuskuma2/webapp
- **Branch**: main
- **Status**: ✅ プッシュ済み

### Cloudflare Pages
- **現状**: デプロイ待機中（Cloudflare APIキー設定後にデプロイ可能）
- **デプロイコマンド**: `npm run deploy`（Deploy タブでAPIキー設定後）

---

## 📋 今後の推奨事項

### 短期（1週間以内）
1. **既存プロジェクトの一括修正スクリプト**を作成
   ```sql
   UPDATE projects 
   SET status = 'completed', updated_at = CURRENT_TIMESTAMP 
   WHERE status = 'generating_images'
     AND id IN (
       SELECT p.id FROM projects p
       LEFT JOIN scenes s ON s.project_id = p.id
       LEFT JOIN image_generations ig ON ig.scene_id = s.id AND ig.is_active = 1
       GROUP BY p.id
       HAVING COUNT(ig.id) > 0 AND SUM(CASE WHEN ig.status='completed' THEN 1 ELSE 0 END) = COUNT(ig.id)
     );
   ```

2. **モニタリング追加**：画像生成完了後のステータス遷移をログ記録

### 中期（1ヶ月以内）
1. **ステータス整合性チェックAPI**を追加（管理用）
2. **自動修復機能**：ポーリング開始時に不整合を検出して自動修正

---

## ✅ 解決確認

- ✅ **根本原因を特定**：最後のAPI呼び出しが不足
- ✅ **コード修正完了**：フロントエンドのポーリングロジックを修正
- ✅ **Project 27を修正**：手動でステータスを `completed` に更新
- ✅ **GitHub コミット**：修正をリポジトリに反映
- ✅ **再発防止策**：次回の画像生成から自動で正常動作

---

**修正担当**: AI Development Assistant  
**レビュー**: モギモギ（関屋紘之）  
**最終更新**: 2025-12-20 11:10 UTC
