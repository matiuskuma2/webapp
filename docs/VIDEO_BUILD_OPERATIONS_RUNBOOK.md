# VIDEO_BUILD_OPERATIONS_RUNBOOK.md

> **目的**
> Video Build で発生するインシデントに対して、
> **誰が対応しても同じ判断・同じ手順で解決できる** 状態を作る。

---

## 0. 緊急連絡先

| 担当 | 連絡先 |
| --- | --- |
| 開発責任者 | @aitanoshimu |
| インフラ | Cloudflare Dashboard / AWS Console |

---

## 1. 赤エラー発生時の対応フロー

### 1.1 ユーザーが直せるエラー

| エラーコード | 症状 | ユーザー対応 |
| --- | --- | --- |
| `VISUAL_VIDEO_MISSING` | 「動画が見つかりません」 | Builder → 動画生成 → 「動画に切替」 |
| `VISUAL_IMAGE_MISSING` | 「画像が見つかりません」 | Builder → 画像生成 → 選択 |
| `VISUAL_COMIC_MISSING` | 「漫画画像が見つかりません」 | 漫画編集 → 公開 |
| `VISUAL_ASSET_URL_INVALID` | 「URLが不正」 | 素材を再生成 |
| `VISUAL_ASSET_URL_FORBIDDEN` | 「URLにアクセスできない」 | 素材を再生成 |

**対応手順（ユーザー向け案内）**

1. エラーメッセージで **シーン番号（N）** を確認
2. Builder で該当シーンに移動
3. `action_hint` に従って素材を修正
4. preflight を再実行（Video Build ボタンを押す）

### 1.2 ユーザーが直せないエラー（運営対応）

| エラーコード | 症状 | 対応 |
| --- | --- | --- |
| `VISUAL_CONFLICT_BOTH_PRESENT` | 「画像と動画が同時に指定」 | DB直接修正 or 調査 |
| `VISUAL_ASSET_URL_FORBIDDEN`（再生成しても再発） | CDN/R2ポリシー問題 | インフラ調査 |

---

## 2. ログの見方

### 2.1 サーバーログ（Cloudflare Workers）

**確認場所**: Cloudflare Dashboard → Workers & Pages → webapp → Logs

**重要なログパターン**

```
[buildProjectJson] Scene N visual selection: {...}
```
- 各シーンで何が選ばれたかの最終決定ログ
- `chosen_visual` が `display_asset_type` と一致しているか確認

```
[buildProjectJson] SSOT MISMATCH: Scene N has display_asset_type='...' but chosen_visual='...'
```
- SSOT違反の警告
- display_asset_type と実際の選択が一致していない

```
[buildProjectJson] CRITICAL: Scene N display_asset_type='video' but video_clip NOT generated!
```
- 致命的エラー
- video モードなのに video_clip が生成されなかった

```
[VideoBuild] Preflight: Visual validation failed
```
- preflight 検証失敗
- `errors` と `debug_info` を確認

```
[validateVisualAssetsAsync] URL unreachable: scene=N, url=..., error=...
```
- URL到達性検証失敗
- R2/CDN の状態を確認

### 2.2 Remotion Lambda ログ（AWS CloudWatch）

**確認場所**: AWS Console → CloudWatch → Log groups → /aws/lambda/remotion-*

**重要なログパターン**

```
Scene N: Using video_clip, url=...
Scene N: Using image, url=...
```
- Remotion 側で何が使われたか

```
WARN: Scene N has both video_clip and image
```
- SSOT違反（両方入っている）

---

## 3. よくあるインシデントと復旧手順

### 3.1 動画にしたのに静止画になる

**症状**: ユーザーが「動画に切替」を押したのに、生成された動画が静止画

**原因の切り分け**

1. **preflight チェック**
   ```
   GET /api/projects/{projectId}/video-builds/preflight?check_reachability=true
   ```
   - `visual_validation.errors` に `VISUAL_VIDEO_MISSING` があるか
   - `debug_info` で `has_active_video` を確認

2. **DB 確認**
   ```sql
   SELECT id, display_asset_type FROM scenes WHERE project_id = ?;
   SELECT scene_id, status, r2_url FROM video_generations WHERE scene_id = ? AND is_active = 1;
   ```

3. **buildProjectJson ログ確認**
   - `chosen_visual` が `video` になっているか
   - `CRITICAL` ログが出ていないか

**復旧手順**

1. DB で `scenes.display_asset_type` が `video` か確認
2. `video_generations` に `status='completed'` かつ `r2_url` があるか確認
3. なければユーザーに動画再生成を依頼
4. あるのに静止画になる場合は、開発チームに報告

### 3.2 素材があるのに「URLにアクセスできない」

**症状**: `VISUAL_ASSET_URL_FORBIDDEN` エラー

**原因の切り分け**

1. **URL を直接アクセス**
   - ブラウザで URL を開いて 403/404 を確認

2. **R2 バケット確認**
   - Cloudflare Dashboard → R2 → バケット → オブジェクト確認

3. **署名付きURL の期限切れ**
   - presigned URL を使っていないか確認（使用禁止）

**復旧手順**

1. R2 に素材が存在するか確認
2. 存在しない場合: ユーザーに再生成を依頼
3. 存在するが 403 の場合: R2 バケットのアクセス設定を確認

### 3.3 Video Build がタイムアウト

**症状**: Video Build が完了しない、AWS からエラー

**原因の切り分け**

1. **video_builds テーブル確認**
   ```sql
   SELECT * FROM video_builds WHERE project_id = ? ORDER BY created_at DESC LIMIT 5;
   ```
   - `status` が `stuck` になっていないか

2. **AWS Lambda ログ確認**
   - タイムアウトエラーが出ていないか
   - メモリ不足エラーが出ていないか

**復旧手順**

1. `video_builds.status` を `failed` に更新
2. ユーザーに再試行を依頼
3. 頻発する場合は Lambda の設定を見直し

---

## 4. ロールバック手順

### 4.1 コードのロールバック

```bash
# 前のデプロイに戻す
cd /home/user/webapp
git log --oneline -10  # 戻したいコミットを確認
git revert HEAD  # 直近のコミットを取り消し
git push origin main

# または特定のコミットに戻す
git reset --hard <commit_hash>
git push -f origin main

# Cloudflare Pages に再デプロイ
npm run build
npx wrangler pages deploy dist --project-name webapp
```

### 4.2 DB のロールバック

**注意**: D1 にはトランザクションロールバックがないため、手動で復旧

```sql
-- 例: display_asset_type を image に戻す
UPDATE scenes SET display_asset_type = 'image' WHERE id = ? AND project_id = ?;

-- 例: video_generations の is_active をリセット
UPDATE video_generations SET is_active = 0 WHERE scene_id = ?;
```

### 4.3 Remotion Bundle のロールバック

Remotion Lambda の bundle は S3 に保存されているため、AWS Console から前のバージョンを有効化

1. AWS Console → S3 → remotion-* バケット
2. バージョニングが有効なら前のバージョンを復元
3. Lambda の環境変数で bundle URL を更新

---

## 5. 監視・アラート設定（推奨）

### 5.1 Cloudflare Workers

- **エラー率**: 5xx エラーが 1% を超えたらアラート
- **レイテンシ**: p99 が 5秒を超えたらアラート

### 5.2 AWS Lambda

- **エラー数**: 1時間に 10 回以上エラーでアラート
- **タイムアウト**: タイムアウトが発生したらアラート

### 5.3 R2/S3

- **4xx エラー率**: 5% を超えたらアラート（URL期限切れの兆候）

---

## 6. 定期メンテナンス

### 6.1 週次

- [ ] `video_builds` で `status='stuck'` のレコードを確認・クリーンアップ
- [ ] Cloudflare Workers のエラーログを確認

### 6.2 月次

- [ ] R2 の使用量を確認
- [ ] Lambda の実行時間・メモリ使用量を確認
- [ ] presigned URL が使われていないか監査

---

## 7. 連絡テンプレート

### 7.1 ユーザーへの案内（赤エラー）

```
【Video Build エラーのご案内】

シーン{N}で以下のエラーが発生しています：
「{エラーメッセージ}」

【対処方法】
{action_hint}

上記をお試しいただいても解決しない場合は、
プロジェクトID：{projectId}
シーン番号：{N}
をお知らせください。
```

### 7.2 開発チームへのエスカレーション

```
【Video Build インシデント】

■ 発生日時: YYYY-MM-DD HH:MM
■ プロジェクトID: {projectId}
■ 症状: {症状の説明}
■ エラーコード: {VISUAL_*}
■ ログ抜粋:
{関連ログ}

■ 試した対応:
- ...

■ 現状:
- ユーザー対応済み / 未対応
- 継続発生 / 単発
```

---

## 変更履歴

| 日付 | 変更内容 |
| --- | --- |
| 2026-02-05 | 初版作成（C/A/D仕様に基づく） |
