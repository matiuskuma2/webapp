# DB/Migrations SSOT (Single Source of Truth)

## 概要

このドキュメントは、データベースマイグレーションの「正」を定義し、技術負債と運用インシデントを防ぐためのSSOTです。

---

## 正の定義

### 本番環境（Production）
- **適用方法**: 増分マイグレーションのみ（`0002_*.sql` 以降を順次適用）
- **コマンド**: `npx wrangler d1 migrations apply webapp-production --remote`
- **注意**: 本番DBは既に全マイグレーションが適用済み

### ローカル環境（Local Development）
- **適用方法**: フルスキーマ → 増分マイグレーション
- **コマンド**: `npm run db:reset:local`
- **手順**:
  1. `.wrangler/state/v3/d1` を削除
  2. `0001_full_schema_from_production.sql` を適用
  3. `0043_*.sql` 以降の新規マイグレーションを適用
  4. SSOT検証（必須テーブル/カラムの存在確認）

---

## マイグレーションファイル構成

```
migrations/
├── 0001_full_schema_from_production.sql  # ★正のスキーマ（本番から取得）
├── 0002_add_source_type.sql              # 増分（本番適用済み）
├── ...
├── 0042_add_project_audio_library_refs.sql
├── 0043_add_scenes_is_hidden.sql         # ★新機能: ソフトデリート
├── 0044_create_audit_logs.sql            # ★新機能: 監査ログ
├── 0045_add_scene_split_settings.sql     # ★新機能: Split設定
└── _archive/                             # アーカイブ（使用禁止）
    ├── 0001_initial_schema.sql           # 旧版（0001_full_schemaに統合）
    ├── 0007_world_character_bible.sql    # 重複
    └── 0010_world_character_bible.sql    # 重複
```

---

## 禁止事項

### 1. 手動ALTER禁止
```sql
-- ❌ 禁止: 直接ALTER TABLE
ALTER TABLE projects ADD COLUMN new_column TEXT;

-- ✅ 正しい方法: マイグレーションファイルを作成
-- migrations/0046_add_new_column.sql
ALTER TABLE projects ADD COLUMN new_column TEXT;
```

### 2. _archive内ファイルの使用禁止
`migrations/_archive/` 内のファイルは過去の証跡として保持しています。**絶対に使用しないでください**。

### 3. 本番DBへの直接SQL実行禁止
```bash
# ❌ 禁止: 本番に直接SQLを実行
npx wrangler d1 execute webapp-production --remote --command="ALTER TABLE..."

# ✅ 正しい方法: マイグレーションファイル経由
npx wrangler d1 migrations apply webapp-production --remote
```

---

## 新規マイグレーション作成手順

### Step 1: ファイル作成
```bash
# 次の番号を確認
ls migrations/*.sql | grep -v _archive | tail -1
# 例: 0045_add_scene_split_settings.sql

# 新規ファイル作成
touch migrations/0046_add_new_feature.sql
```

### Step 2: SQLを記述
```sql
-- Migration: 0046_add_new_feature
-- Description: 新機能の説明
-- Date: YYYY-MM-DD

ALTER TABLE table_name ADD COLUMN new_column TYPE;
CREATE INDEX IF NOT EXISTS idx_name ON table_name(column);
```

### Step 3: ローカルでテスト
```bash
# ローカルDBリセット＆適用
npm run db:reset:local

# 動作確認
npm run dev
curl http://localhost:3000/api/...
```

### Step 4: 本番適用
```bash
# 本番に適用（レビュー後）
npx wrangler d1 migrations apply webapp-production --remote
```

---

## npm scripts リファレンス

| コマンド | 説明 |
|---------|------|
| `npm run db:reset:local` | ローカルD1を完全リセット＆再構築 |
| `npm run db:migrate:local` | ローカルに増分マイグレーションのみ適用 |
| `npm run db:migrate:prod` | 本番に増分マイグレーション適用 |
| `npm run db:verify` | SSOT検証（必須テーブル/カラム確認） |

---

## SSOT検証チェックリスト

ローカルDBリセット後、以下が存在することを確認:

### 必須テーブル
- [x] `users`
- [x] `projects`
- [x] `scenes`
- [x] `audit_logs`
- [x] `scene_split_settings`

### 必須カラム
- [x] `projects.split_mode`
- [x] `projects.target_scene_count`
- [x] `projects.output_preset`
- [x] `scenes.is_hidden`

---

## トラブルシューティング

### Q: ローカルで「no such column」エラーが出る
**A**: ローカルDBが古い状態です。
```bash
npm run db:reset:local
```

### Q: 本番と違う新規テーブルがない
**A**: 増分マイグレーションが適用されていない可能性があります。
```bash
# ローカル
npm run db:reset:local

# 本番（確認後）
npx wrangler d1 migrations apply webapp-production --remote
```

### Q: マイグレーションが「already exists」で失敗する
**A**: `IF NOT EXISTS` を使用してください。
```sql
CREATE TABLE IF NOT EXISTS table_name (...);
CREATE INDEX IF NOT EXISTS idx_name ON table_name(column);
ALTER TABLE table_name ADD COLUMN column_name TYPE; -- これは重複不可
```

---

## 更新履歴

| 日付 | 内容 |
|------|------|
| 2026-02-01 | 初版作成: SSOT定義、禁止事項、手順を明文化 |
