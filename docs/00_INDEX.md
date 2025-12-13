# ドキュメント索引

本プロジェクトの全ドキュメント一覧と読む順序。

## 📚 必読順序

### 1. プロジェクト理解
- **01_REQUIREMENTS.md** - プロジェクト要件定義（目的・機能・制約）
- **02_ARCHITECTURE.md** - アーキテクチャ・外部API固定・採用スタック
- **11_GENS_PARK_DEV_BRIEF.md** - GensPark開発環境ブリーフ

### 2. 実装前に必読
- **09_AI_DEV_RULES.md** - AI開発ルール（最優先事項）
- **03_DOMAIN_MODEL.md** - RILARCScenarioV1 JSON Schema
- **04_DB_SCHEMA.md** - D1データベーススキーマ
- **05_API_SPEC.md** - APIエンドポイント仕様

### 3. 詳細仕様
- **06_UI_SPECS.md** - UI/UX仕様
- **07_WORKFLOWS.md** - ワークフロー・状態遷移
- **12_IMAGE_PROMPT_TEMPLATE.md** - 画像プロンプトテンプレート

### 4. 変更履歴
- **08_CHANGELOG.md** - 変更履歴（仕様変更は必ずここから更新）

---

## 🎯 AI開発者向けクイックリファレンス

### 実装前チェックリスト
1. ✅ `09_AI_DEV_RULES.md` を読んだ
2. ✅ `08_CHANGELOG.md` に仕様変更を記録した
3. ✅ 影響範囲を明示した（UI / API / DB / Worker / Storage）
4. ✅ 外部API固定表（02_ARCHITECTURE.md）を確認した
5. ✅ DBスキーマ（04_DB_SCHEMA.md）を確認した

### 禁止事項
- ❌ 外部APIを勝手に追加・変更
- ❌ APIレスポンスやDBスキーマを暗黙に変更
- ❌ docsに書かれていない仕様を独自解釈で実装
- ❌ placeholder/簡易版でdocsを作成
- ❌ "..."で省略してdocsを作成
- ❌ docsを消失させる運用（rm -rf）

---

## 📁 ドキュメント一覧

| ファイル名 | 概要 |
|-----------|------|
| 00_INDEX.md | 本ファイル（ドキュメント索引） |
| 01_REQUIREMENTS.md | プロジェクト要件定義 |
| 02_ARCHITECTURE.md | アーキテクチャ・外部API固定・スタック固定 |
| 03_DOMAIN_MODEL.md | RILARCScenarioV1 JSON Schema |
| 04_DB_SCHEMA.md | D1データベーススキーマ |
| 05_API_SPEC.md | APIエンドポイント仕様 |
| 06_UI_SPECS.md | UI/UX仕様 |
| 07_WORKFLOWS.md | ワークフロー・状態遷移 |
| 08_CHANGELOG.md | 変更履歴 |
| 09_AI_DEV_RULES.md | AI開発ルール |
| 11_GENS_PARK_DEV_BRIEF.md | GensPark開発環境ブリーフ |
| 12_IMAGE_PROMPT_TEMPLATE.md | 画像プロンプトテンプレート |

---

最終更新: 2025-01-13
