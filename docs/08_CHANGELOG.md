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

### [2025-12-13] Phase 3: 整形・シーン分割実装完了

#### 変更理由
- Phase 3実装（整形・シーン分割機能）

#### 変更内容
- **API実装**:
  - `POST /api/projects/:id/format` エンドポイント追加
  - `GET /api/projects/:id/scenes` エンドポイント追加（idx順ソート）
  - OpenAI Chat API統合 (`gpt-4o-mini` + JSON mode)
- **バリデーション実装**:
  - RILARCScenarioV1 JSON Schema完全準拠バリデーター作成
  - 必須項目チェック（version, metadata, scenes）
  - 制約チェック（scenes数: 3-50, dialogue長: 40-220, bullets数: 2-4）
  - idx連番チェック（1から開始）
  - role enumチェック（8種類）
- **DB操作**:
  - `scenes`テーブルへの一括挿入（D1 batch API使用）
  - トランザクション保証（途中失敗時はロールバック）
  - `projects.status`遷移: `transcribed → formatting → formatted`
  - エラー時は`projects.status = 'failed'`に遷移
- **プロンプト設計**:
  - System Prompt: RILARCルール、role定義、JSON構造を明示
  - User Prompt: 文字起こしテキスト + プロジェクトタイトル
  - Temperature: 0.7（創造性とルール準拠のバランス）

#### 影響範囲
- ✅ **API**: 整形・シーン分割エンドポイント追加、シーン一覧取得追加
- ✅ **DB**: `scenes`テーブル運用開始
- ✅ **Worker**: OpenAI Chat API統合、JSONバリデーション
- ❌ **Storage**: 今回は使用なし
- ❌ **UI**: 今回は変更なし

#### 関連ドキュメント
- docs/03_DOMAIN_MODEL.md（RILARCScenarioV1 JSON Schema）
- docs/04_DB_SCHEMA.md（scenesテーブル）
- docs/05_API_SPEC.md（POST /api/projects/:id/format）
- docs/07_WORKFLOWS.md（Phase 3ワークフロー）
- docs/02_ARCHITECTURE.md（OpenAI Chat API）

---

### [2025-12-13] Phase 4開始前Fix: 仕様統一（矛盾防止）

#### 変更理由
- Phase 4（画像生成）開始前の仕様統一
- RILARCScenario `version`の整合確認
- `image_prompt`の言語縛り緩和（Nano Banana対応）

#### 変更内容

**Fix 1: RILARCScenario version統一**
- 確認結果: 既に統一されていることを確認
  - `docs/03_DOMAIN_MODEL.md`: `version: "1.0"` (固定)
  - `src/routes/formatting.ts`: `version は "1.0" 固定`
  - `src/utils/rilarc-validator.ts`: `data.version !== '1.0'` で検証
- 対応: 変更不要（既に統一済み） ✅

**Fix 2: image_prompt言語縛り緩和**
- 変更前: 「image_promptは英語で記述」（英語固定）
- 変更後: 「image_promptは英語推奨だが日本語も可」（柔軟化）
- 理由:
  - Gemini (Nano Banana) は日本語プロンプトもサポート
  - Phase 4で`buildImagePrompt()`を使用し、スタイル指定を追加する方式
  - `scene.image_prompt`はシーン固有の内容記述として扱う
  - 日本語コンテンツの場合、日本語プロンプトの方が精度が高い可能性
- 更新ファイル:
  - `src/routes/formatting.ts`: system prompt修正
  - `docs/03_DOMAIN_MODEL.md`: descriptionを「英語推奨だが日本語も可」に変更
  - `docs/12_IMAGE_PROMPT_TEMPLATE.md`: 言語説明追加、日本語プロンプト例追加

#### 影響範囲
- ✅ **Docs**: `docs/03_DOMAIN_MODEL.md`、`docs/12_IMAGE_PROMPT_TEMPLATE.md`更新
- ✅ **Worker**: `src/routes/formatting.ts` system prompt修正
- ❌ **API**: 挙動変更なし（内部仕様の柔軟化のみ）
- ❌ **DB**: 変更なし

#### Phase 4への準備
- `scene.image_prompt`: シーン固有の内容記述（英語/日本語どちらも可）
- Phase 4実装: `buildImagePrompt(scene.image_prompt)`でスタイル指定を追加
- 最終プロンプト: `[scene.image_prompt] + [スタイル指定（固定部分）]`

---

### [2025-12-13] Phase 4: Gemini画像生成実装完了

#### 変更理由
- Phase 4実装（Gemini Nano Banana画像生成機能）

#### 変更内容
- **API実装**:
  - `POST /api/scenes/:id/generate-image` エンドポイント追加（単体生成）
  - `POST /api/projects/:id/generate-all-images` エンドポイント追加（一括生成）
  - mode指定: `all`（全シーン）、`pending`（未生成）、`failed`（失敗のみ）
- **Gemini API統合**:
  - Model: `gemini-3-pro-image-preview` (Nano Banana Pro)
  - Aspect Ratio: `16:9` (固定)
  - 429リトライ機能実装（最大3回、指数バックオフ）
- **プロンプトビルダー実装**:
  - `buildImagePrompt()`: `scene.image_prompt` + スタイル指定（固定部分）
  - `docs/12_IMAGE_PROMPT_TEMPLATE.md` 完全準拠
- **DB操作**:
  - `image_generations`テーブルへの履歴保存
  - 再生成時は新レコード作成（履歴保持）
  - `is_active`切替: 新しい画像をアクティブ化、既存を無効化
  - エラー時は`status='failed'`, `error_message`保存
- **R2統合**:
  - R2への画像保存
  - パス規約: `images/{project_id}/scene_{idx}/{generation_id}_{timestamp}.png`
- **プロジェクトステータス遷移**:
  - `formatted → generating_images` (一括生成開始時)
  - `generating_images → completed` (全シーン生成成功時)
  - 部分的失敗時は`generating_images`のまま（failedのみ再実行可能）

#### 影響範囲
- ✅ **API**: 画像生成エンドポイント追加（単体・一括）
- ✅ **DB**: `image_generations`テーブル運用開始
- ✅ **Worker**: Gemini API統合、画像処理
- ✅ **Storage**: R2への画像保存
- ❌ **UI**: 今回は変更なし

#### 関連ドキュメント
- docs/04_DB_SCHEMA.md（image_generationsテーブル）
- docs/05_API_SPEC.md（POST /api/scenes/:id/generate-image, POST /api/projects/:id/generate-all-images）
- docs/12_IMAGE_PROMPT_TEMPLATE.md（プロンプトテンプレート）
- docs/02_ARCHITECTURE.md（Gemini API）

---

### [2025-12-13] Phase 4修正: Gemini API呼び出しを公式仕様に修正

#### 変更理由
- Phase 4のGemini API呼び出しが仮実装で404エラーが発生
- 公式仕様（`generateContent`）に合わせて実装修正

#### 変更内容
- **Gemini API呼び出し修正**:
  - エンドポイント: `:generateImage` → `:generateContent`（公式仕様）
  - URL: `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent`
  - 認証: `Authorization: Bearer` → `x-goog-api-key`ヘッダ
  - リクエスト形式:
    ```json
    {
      "contents": [{"parts": [{"text": "<PROMPT>"}]}],
      "generationConfig": {
        "responseModalities": ["Image"],
        "imageConfig": {"aspectRatio": "16:9", "imageSize": "2K"}
      }
    }
    ```
  - レスポンス処理: `candidates[0].content.parts[].inlineData.data`（base64）からPNGバイナリを生成
- **429リトライ**: 既存ロジック維持（最大3回、指数バックオフ）
- **エラーハンドリング**: 既存ロジック維持

#### 影響範囲
- ✅ **Worker**: `src/routes/image-generation.ts`のGemini API呼び出し部分のみ修正
- ✅ **Docs**: `docs/08_CHANGELOG.md`に実装修正記録
- ❌ **API**: インターフェース変更なし
- ❌ **DB**: 変更なし

#### 期待される動作
- APIキー設定後、`POST /api/scenes/:id/generate-image`が成功しR2にPNG保存
- `image_generations.status = 'completed'`, `is_active = 1`が正しく設定される
- `POST /api/projects/:id/generate-all-images`で`success_count`が増加

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
