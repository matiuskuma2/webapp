# Production Runbook

## 本番DB運用ルール

### 禁止事項
- **本番DBへの ALTER TABLE 直打ちは禁止**
- **d1_migrations への手動 INSERT は原則禁止**
- **Cloudflare Dashboard からの直接SQL実行は緊急時のみ**

### 必須事項
- schema変更は必ず `migrations/*.sql` 経由
- すべての migration は **idempotent** にする（`IF NOT EXISTS` を使用）
- 緊急対応時は理由と日時を必ず記録

### Migration ワークフロー
```bash
# 1. migration ファイル作成
touch migrations/00XX_description.sql

# 2. ローカルで検証
npx wrangler d1 migrations apply webapp-production --local

# 3. 本番適用
npx wrangler d1 migrations apply webapp-production --remote

# 4. 確認
npx wrangler d1 execute webapp-production --remote --command="SELECT * FROM d1_migrations ORDER BY id DESC LIMIT 5"
```

---

## 現状BGM仕様（2026-02）

### データフロー
1. シーン尺は `audio_generations.duration_ms` がSSOT
2. BGMは `project_audio_tracks` テーブルで管理
3. `buildProjectJson` で Remotion に渡す

### BGMタイムライン設定
| フィールド | 意味 | デフォルト |
|-----------|------|-----------|
| `video_start_ms` | 動画上の開始位置 | 0 |
| `video_end_ms` | 動画上の終了位置 | null (最後まで) |
| `audio_offset_ms` | BGM音源の開始オフセット | 0 |

### 注意事項
- `start_ms/end_ms` は「動画上の位置」であり、音源トリミングではない
- Remotion側で `startFrom/endAt` に変換される（要確認）

---

## 音声生成 SSOT

### 判定ルール
- **生成済み**: `audio_generations.status = 'completed' AND r2_url IS NOT NULL`
- **生成中**: `audio_generations.status = 'generating'`
- **失敗**: `audio_generations.status = 'failed'`

### utterance → audio_generation の紐付け
- `scene_utterances.audio_generation_id` で紐付け
- UIはDBの状態を表示するだけ（キャッシュは可）

---

## ロールバック手順

### Cloudflare Pages ロールバック
```bash
# デプロイ履歴確認
npx wrangler pages deployment list --project-name webapp

# 特定のデプロイメントにロールバック
# Cloudflare Dashboard > Pages > webapp > Deployments から実行
```

### Remotion Bundle ロールバック
- 旧 bundle.js の S3 URL を控えておく
- 問題発生時は Lambda 環境変数で bundle URL を差し替え

---

## 緊急対応ログ

### テンプレート
```
日時: YYYY-MM-DD HH:MM
担当: @username
事象: 
対応内容:
影響範囲:
今後の対策:
```

### 履歴
- 2026-02-03: settings_json カラム追加（手動ALTER実行 → 要no-op化）
- 2026-02-04: d1_migrations SSOT 正常化
  - 13件の不足 migration 記録を追加（0020-0032）
  - 0048_add_bgm_timeline_columns.sql の記録を追加
  - `wrangler d1 migrations apply --remote` が正常動作することを確認

---

## 2026-02-04 修正サマリ

### 完了項目
1. **d1_migrations SSOT 正常化**: 14件の migration 記録を追加。ローカルと本番の整合性を確保
2. **comic-telop-settings**: 正しい payload 形式で動作確認済み
   - ✅ 正: `{"style_preset": "band", "size_preset": "lg", "position_preset": "top"}`
   - ❌ 誤: `{"telops_comic": {...}}` でラップしない
3. **Audio SSOT (scene 1709)**: 全14件の utterance が Fish Audio で生成完了

### BGM Timeline 検証結果
- **preview-json にパラメータは含まれている**:
  - `video_start_ms`: 0
  - `video_end_ms`: null
  - `audio_offset_ms`: 0
- **Remotion 側での適用は要確認**:
  - コメントによると `video_start_ms` → `delay_ms`
  - コメントによると `audio_offset_ms` → `startFrom`
  - 実際の Remotion bundle で適用されているか要確認

### 残タスク
- [ ] Remotion 側で `startFrom/endAt` が BGM に適用されているか確認
- [ ] admin 権限設計の見直し（マルチテナント対応）

---

## admin権限設計（要見直し）

### 現状
- `superadmin`: 全データアクセス可
- `admin`: 全データアクセス可（暫定）
- `user`: 自分のプロジェクトのみ

### 本来あるべき姿（マルチテナント対応時）
- `superadmin`: 全データアクセス可
- `admin`: 自分の組織/テナント内のみ
- `owner`: 自分のプロジェクトのみ
- `viewer`: 閲覧のみ

**注意**: 現状の「adminも全シーン」は情報漏えいリスクあり
