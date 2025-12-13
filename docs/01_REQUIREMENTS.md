# プロジェクト要件定義

## 🎯 プロジェクト概要

### 目的
音声ファイルを入力として、ニュース風インフォグラフィック画像とセリフを生成する**素材生成ツール**を構築する。

動画編集（画像結合・BGM追加等）は人が行い、本システムは**素材（画像＋セリフ）の生成に特化**する。

---

## 📋 機能要件（MVP）

### Phase 1：DB / アップロード基盤
- 音声ファイルアップロード（R2ストレージ保存）
- プロジェクト管理（DB：projects テーブル）
- 完了条件：
  - ✅ 音声ファイルをR2にアップロード可能
  - ✅ projects テーブルにレコード作成
  - ✅ status が 'uploaded' に更新

### Phase 2：文字起こし
- 音声 → テキスト変換（OpenAI Whisper API）
- 文字起こし結果の保存（DB：transcriptions テーブル）
- 完了条件：
  - ✅ OpenAI Whisper API 呼び出し成功
  - ✅ transcriptions テーブルにレコード作成
  - ✅ projects.status が 'transcribed' に更新

### Phase 3：整形・シーン分割
- テキスト整形（OpenAI Chat API）
- RILARCシナリオ形式への変換
- シーン分割（3〜50シーン）
- JSON Schema準拠の出力
- 完了条件：
  - ✅ OpenAI Chat API（JSON mode）呼び出し成功
  - ✅ RILARCScenarioV1 JSON Schema に準拠
  - ✅ scenes テーブルに全シーン保存
  - ✅ projects.status が 'formatted' に更新

### Phase 4：画像生成
- シーンごとのインフォグラフィック画像生成（Gemini Nano Banana）
- プロンプト編集による再生成
- 生成失敗・ポリシー違反のハンドリング
- 完了条件：
  - ✅ Gemini Image Generation API 呼び出し成功
  - ✅ 画像をR2に保存
  - ✅ image_generations テーブルにレコード作成
  - ✅ プロンプト編集→再生成が可能
  - ✅ 429エラー時の自動再試行（最大3回）実装
  - ✅ projects.status が 'completed' に更新

### Phase 5：一括ダウンロード
- images.zip（全画像）
- dialogue.csv（全セリフ）
- all.zip（画像＋CSV）
- 完了条件：
  - ✅ 画像ZIPダウンロード可能
  - ✅ セリフCSVダウンロード可能
  - ✅ 全ファイルZIPダウンロード可能
  - ✅ ファイル名が適切（project_N_images.zip等）

---

## 🚫 非機能（MVPでは対応しない）

### Phase 2以降に検討
- 画像編集（クロップ、テキスト差し替え、部分編集）
- 動画編集（画像結合、BGM追加、エフェクト）
- マルチユーザー対応
- 認証・権限管理
- リアルタイム進捗通知（WebSocket）

---

## 📏 制約条件

### RILARCシナリオ仕様（固定・変更禁止）
- **最小シーン数**: 3
- **最大シーン数**: 50
- **1シーンのdialogue**: 40〜220文字（読み上げ10〜30秒目安）
- **bullets**: 2〜4個（各6〜26文字）
- **role**: hook / context / main_point / evidence / timeline / analysis / summary / cta から選択

### 画像生成ルール（固定・変更禁止）
- スタイル：ニュース風インフォグラフィック
- テンプレート：`docs/12_IMAGE_PROMPT_TEMPLATE.md` を使用
- プロンプト編集による再生成のみ対応（画像編集は非対応）

### エラーハンドリング（固定・変更禁止）
- **429エラー**: 自動再試行（最大3回、指数バックオフ：1s → 2s → 4s）
- **生成失敗**: エラーメッセージ表示＋手動再試行
- **ポリシー違反**: プロンプト編集を促す

---

## 🎨 UI/UX要件

### 基本構成
- Sceneカードを縦並びで表示
- 各Sceneに以下を表示：
  - dialogue（セリフ）
  - bullets（要点）
  - image_prompt（編集可能）
  - 生成画像
  - 生成 / 再生成 / 失敗再試行 ボタン

### 一括操作
- **全生成**: 全シーンの画像を一括生成
- **未生成のみ**: 画像未生成のシーンのみ生成
- **失敗のみ**: 生成失敗したシーンのみ再試行

### ダウンロード
- **images.zip**: 全画像（PNG/JPEG）
- **dialogue.csv**: 全セリフ（idx, role, title, dialogue, bullets）
- **all.zip**: 画像＋CSV

---

## 🔒 セキュリティ要件

### APIキー管理
- OpenAI API Key: Cloudflare Secrets（環境変数: `OPENAI_API_KEY`）
- Gemini API Key: Cloudflare Secrets（環境変数: `GEMINI_API_KEY`）
- ローカル開発: `.dev.vars` ファイル（Gitignore）

### データ保護
- 音声ファイル: R2バケット（プライベート）
- 生成画像: R2バケット（プライベート）
- ダウンロードURL: 署名付き一時URL（1時間有効）

---

## 📊 パフォーマンス要件

### Cloudflare制限
- CPU時間: 無料プラン10ms/リクエスト、有料プラン30ms/リクエスト
- 対処: 外部API呼び出しはCPU時間に含まれない（ネットワーク待機）

### ストレージ制限
- R2: 無料枠10GB/月
- D1: 無料枠5GB

---

## 🎯 成功基準（Definition of Done）

### MVP完了条件
1. ✅ 音声ファイルアップロード → R2保存
2. ✅ 文字起こし → transcription保存
3. ✅ 整形・シーン分割 → RILARCシナリオJSON生成
4. ✅ 画像生成 → シーンごとのインフォグラフィック画像
5. ✅ プロンプト編集 → 再生成
6. ✅ 一括ダウンロード → ZIP/CSV出力

### ユーザー体験
- 各ステップをUIで順番に確認できる
- エラー発生時に適切なメッセージと再試行オプションが表示される
- 生成結果を編集（プロンプト変更）→ 再生成できる

### 品質基準
- 全Phase動作確認完了
- エラーハンドリング実装完了
- ドキュメント完全同期

---

## 🔄 変更管理ルール

### 仕様変更時の手順（必須）
1. **必ず先に** `docs/08_CHANGELOG.md` を更新
2. 影響範囲を明示（UI / API / DB / Worker / Storage）
3. 関連ドキュメントを更新
4. 実装を開始

### 禁止事項
- ❌ ドキュメント更新なしでコード変更
- ❌ placeholder/簡易版でドキュメント作成
- ❌ "..."で省略してドキュメント作成
- ❌ 独自解釈で仕様を拡張

---

最終更新: 2025-01-13
