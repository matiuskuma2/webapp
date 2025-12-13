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

### [2025-12-13] Phase 1 完了 + Cleanup

#### 変更理由
- Phase 1実装完了（DB/アップロード基盤）
- 環境変数名の統一（`GEMINI_API_KEY`に正式化）
- テスト資産のGit管理除外

#### 変更内容
- **Phase 1実装**:
  - D1マイグレーション作成・適用 (`migrations/0001_initial_schema.sql`)
  - R2バケット設定 (`wrangler.jsonc`)
  - API実装: プロジェクト作成、音声アップロード、一覧取得、詳細取得
  - 基本UI実装（プロジェクト作成・一覧表示）
  - PM2による開発サーバー構築
- **Cleanup**:
  - 環境変数名統一: `GOOGLE_API_KEY` → `GEMINI_API_KEY`（正式名称）
  - テスト資産除外: `test_audio.mp3`をGit追跡から除外・削除

#### 影響範囲
- ✅ **DB**: D1マイグレーション適用、`projects`テーブル作成
- ✅ **Storage**: R2バケット設定完了（ローカル）
- ✅ **API**: プロジェクトCRUD・アップロードAPI実装
- ✅ **UI**: 基本的なプロジェクト管理UI実装
- ✅ **Worker**: Hono実装完了
- ✅ **Env**: `.dev.vars`キー名統一（`GEMINI_API_KEY`）

#### 関連ドキュメント
- docs/04_DB_SCHEMA.md（実装済み）
- docs/05_API_SPEC.md（Phase 1部分実装済み）
- docs/02_ARCHITECTURE.md（環境変数表記確認済み）

---

### [2025-12-13] Phase 2: 文字起こし実装完了

#### 変更理由
- Phase 2実装（文字起こし機能）

#### 変更内容
- **API実装**:
  - `POST /api/projects/:id/transcribe` エンドポイント追加
  - OpenAI Whisper API統合 (`whisper-1`モデル使用)
  - 429エラー自動リトライ機能実装（最大3回、指数バックオフ）
- **DB操作**:
  - `transcriptions`テーブルへのデータ保存
  - `projects.status`遷移: `uploaded → transcribing → transcribed`
  - エラー時は`projects.status = 'error'`に遷移
- **R2統合**:
  - R2から音声ファイル取得して文字起こし
- **エラーハンドリング**:
  - 音声未アップロードチェック
  - ステータス検証
  - R2取得失敗処理
  - API呼び出し失敗処理

#### 影響範囲
- ✅ **API**: 文字起こしエンドポイント追加
- ✅ **DB**: `transcriptions`テーブル運用開始
- ✅ **Worker**: OpenAI API統合
- ✅ **Storage**: R2からの音声ファイル取得
- ❌ **UI**: 今回は変更なし

#### 関連ドキュメント
- docs/04_DB_SCHEMA.md（transcriptionsテーブル）
- docs/05_API_SPEC.md（POST /api/projects/:id/transcribe）
- docs/07_WORKFLOWS.md（Phase 2ワークフロー）
- docs/02_ARCHITECTURE.md（OpenAI Whisper API）

---

## 🔮 予定されている変更

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
