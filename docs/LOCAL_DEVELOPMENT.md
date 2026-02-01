# ローカル開発環境セットアップ

**Version**: 1.0  
**Created**: 2026-02-01

---

## 1. ローカルD1データベースのセットアップ

### 1.1 問題: マイグレーション適用エラー

ローカルD1は `.wrangler/state/v3/d1/` に保存されます。  
マイグレーションの順序や互換性の問題で適用できない場合があります。

**典型的なエラー:**
```
Migration 0002_add_source_type.sql failed: duplicate column name: source_type
```

### 1.2 解決: ローカルDBの完全リセット

```bash
# ローカルD1を完全リセット（データは削除されます）
npm run db:reset:local
```

**このコマンドの内容:**
```bash
rm -rf .wrangler/state/v3/d1 && npm run db:migrate:local && npm run db:seed
```

### 1.3 注意事項

- **ローカルDBのデータは本番と独立**しています
- リセット後はテストデータ（seed.sql）が投入されます
- 本番DBには影響しません

---

## 2. マイグレーション管理

### 2.1 新規マイグレーション作成

```bash
# migrations/ ディレクトリに新規SQLファイルを作成
# 命名規則: {番号}_{説明}.sql
touch migrations/0047_add_new_feature.sql
```

### 2.2 マイグレーション適用

```bash
# ローカルに適用
npm run db:migrate:local

# 本番に適用（注意: 本番データに影響）
npm run db:migrate:prod
```

### 2.3 禁止事項

- **❌ 手動でALTER TABLEを実行しない**  
  マイグレーションファイルを通さない変更は追跡できなくなります。

- **❌ マイグレーションファイルを編集しない**  
  一度適用されたマイグレーションは変更せず、新規ファイルで対応。

---

## 3. 開発サーバー起動

### 3.1 通常の起動（D1なし）

```bash
npm run build
pm2 start ecosystem.config.cjs
```

### 3.2 D1ローカルモードで起動

```bash
npm run build
pm2 start ecosystem.config.cjs  # ecosystem.config.cjs に --d1 オプションあり
```

**ecosystem.config.cjs の設定例:**
```javascript
module.exports = {
  apps: [{
    name: 'webapp',
    script: 'npx',
    args: 'wrangler pages dev dist --d1=webapp-production --local --ip 0.0.0.0 --port 3000',
    // ...
  }]
}
```

---

## 4. トラブルシューティング

### 4.1 「no such column」エラー

**原因:** ローカルDBにカラムが存在しない

**解決:**
```bash
npm run db:reset:local
```

### 4.2 「SQLITE_ERROR」が頻発

**原因:** マイグレーションの不整合

**解決:**
```bash
# .wrangler を完全削除して再作成
rm -rf .wrangler
npm run db:migrate:local
```

### 4.3 本番DBとローカルDBの差異確認

```bash
# ローカルDBのテーブル一覧
npx wrangler d1 execute webapp-production --local --command="SELECT name FROM sqlite_master WHERE type='table'"

# 本番DBのテーブル一覧
npx wrangler d1 execute webapp-production --command="SELECT name FROM sqlite_master WHERE type='table'"
```

---

## 5. package.json スクリプト一覧

| スクリプト | 説明 |
|---|---|
| `npm run dev` | Vite開発サーバー |
| `npm run build` | 本番ビルド |
| `npm run db:migrate:local` | ローカルDBにマイグレーション適用 |
| `npm run db:migrate:prod` | 本番DBにマイグレーション適用 |
| `npm run db:seed` | ローカルDBにテストデータ投入 |
| `npm run db:reset:local` | ローカルDB完全リセット |
| `npm run db:console:local` | ローカルDBコンソール |
| `npm run db:console:prod` | 本番DBコンソール |

---

## 6. 変更履歴

| 日付 | 変更内容 |
|---|---|
| 2026-02-01 | 初版作成 |
