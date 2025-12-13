# 変更履歴

## 📝 変更履歴の記録ルール

### ❗ 重要
**仕様変更がある場合は、必ず先にこのファイルを更新すること**

### 記録対象
- ✅ 外部API変更
- ✅ DBスキーマ変更
- ✅ API仕様変更
- ✅ UI/UX変更
- ✅ ビジネスロジック変更

---

## 📅 変更履歴

### [2025-01-13] Phase 1: プロジェクト初期化・方針修正

#### 変更理由
- プロジェクト新規作成
- **方針修正**: placeholder/簡易版docs禁止、docs先行確定を徹底

#### 変更内容
- プロジェクトディレクトリ構造作成
- **ドキュメント完全版**を先行作成（省略禁止）
- Cloudflare Pages + Hono プロジェクト初期化
- Git リポジトリ初期化
- 外部API固定表確定（OpenAI + Gemini）
- D1データベーススキーマ設計
- R2ストレージ設定準備
- **禁止事項追加**: placeholder禁止、rm -rf禁止、docs消失防止

#### 影響範囲
- ✅ **Docs**: 全ドキュメント完全版作成
- ✅ **Worker**: Honoプロジェクト作成
- ❌ **UI**: 今回は未着手
- ❌ **API**: 今回は未着手
- ❌ **DB**: 今回は未着手（スキーマ設計のみ）
- ❌ **Storage**: 今回は未着手（設計のみ）

#### 関連ドキュメント
- docs/00_INDEX.md
- docs/01_REQUIREMENTS.md
- docs/02_ARCHITECTURE.md
- docs/03_DOMAIN_MODEL.md
- docs/04_DB_SCHEMA.md
- docs/05_API_SPEC.md
- docs/06_UI_SPECS.md
- docs/07_WORKFLOWS.md
- docs/08_CHANGELOG.md（本ファイル）
- docs/09_AI_DEV_RULES.md
- docs/11_GENS_PARK_DEV_BRIEF.md
- docs/12_IMAGE_PROMPT_TEMPLATE.md

---

## 🔮 予定されている変更

### Phase 1: DB/アップロード基盤実装（次回）
- D1マイグレーション作成・実行
- R2バケット作成
- プロジェクト作成API実装
- 音声アップロードAPI実装
- 基本UI実装

### Phase 2: 文字起こし実装
- OpenAI Whisper API統合
- transcriptions テーブル運用開始

### Phase 3: 整形・シーン分割実装
- OpenAI Chat API統合（JSON mode）
- scenes テーブル運用開始
- RILARCシナリオバリデーション実装

### Phase 4: 画像生成実装
- Gemini Image Generation API統合
- image_generations テーブル運用開始
- 画像プロンプトテンプレート適用
- 自動再試行実装

### Phase 5: ダウンロード実装
- ZIP/CSV生成機能
- 署名付きURL発行

---

最終更新: 2025-01-13
