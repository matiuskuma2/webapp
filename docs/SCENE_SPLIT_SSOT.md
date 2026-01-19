# Scene Split SSOT（状態遷移と運用ルール）

作成日: 2026-01-19
目的: Scene Split（Parse → Format）処理の無限待ちをゼロにする

---

## 1. 状態遷移図（SSOT）

```
┌─────────────┐
│   created   │  ← プロジェクト作成直後
└──────┬──────┘
       │ テキスト/音声アップロード
       ▼
┌─────────────┐
│  uploaded   │  ← source_text が存在
└──────┬──────┘
       │ POST /api/projects/:id/transcribe (音声のみ)
       ▼
┌─────────────┐
│ transcribed │  ← 音声の場合のみ
└──────┬──────┘
       │ POST /api/projects/:id/parse
       ▼
┌─────────────┐
│   parsing   │  ← text_chunks 生成中（短時間）
└──────┬──────┘
       │ 成功
       ▼
┌─────────────┐
│   parsed    │  ← text_chunks 生成完了
└──────┬──────┘
       │ POST /api/projects/:id/format
       ▼
┌─────────────┐
│ formatting  │  ← chunk単位でシーン生成中
└──────┬──────┘
       │ pending=0 & processing=0 → auto merge
       ▼
┌─────────────┐
│  formatted  │  ← 全シーン生成完了
└─────────────┘
       │
       │ (以降: Image Generation → Video Build)
       ▼
```

### 失敗パターン

```
formatting ──► failed（OpenAI API失敗、タイムアウト等）
                │
                └─► error_message に理由を記録
                    api_error_logs にも記録（推奨）
```

---

## 2. text_chunks ステータス

| status     | 説明                                    |
|------------|-----------------------------------------|
| pending    | 未処理（Format待ち）                    |
| processing | OpenAI API呼び出し中                    |
| done       | シーン生成完了                          |
| failed     | 生成失敗（error_message に理由）        |

---

## 3. UIの振る舞いルール（無限待ちゼロ化）

### 3.1 タイムアウト設定

```javascript
const FORMAT_TIMEOUT_MS = 10 * 60 * 1000; // 10分
const POLLING_INTERVAL_MS = 5000;         // 5秒
```

### 3.2 タイムアウト時の動作

1. ポーリング停止
2. UI表示: 「タイムアウトしました。再試行するか、管理者に連絡してください」
3. ログID表示: `format_timeout_{projectId}_{timestamp}`
4. isProcessing = false（ボタン再有効化）

### 3.3 エラー時の動作

1. ポーリング停止
2. UI表示: 「エラーが発生しました: {error_message}」
3. 失敗チャンク詳細表示（あれば）
4. 再試行ボタン表示

### 3.4 成功時の動作

1. ポーリング停止
2. シーン一覧を取得
3. Builder タブに遷移

---

## 4. バックエンドのルール

### 4.1 二重起動防止

```sql
-- formatting 中のプロジェクトに再度 POST /format は
-- 409 Conflict を返す（Video Build と同じパターン）
```

### 4.2 エラーログ必須化

```javascript
// 例外発生時は必ず記録
await logApiError(c.env.DB, {
  endpoint: 'POST /api/projects/:id/format',
  project_id: projectId,
  error_code: 'FORMAT_ERROR',
  error_message: error.message,
  stack_trace: error.stack
});
```

### 4.3 chunk処理のステップ

1. **pending → processing**: chunk開始時に即更新
2. **processing → done/failed**: OpenAI API完了後に即更新
3. **failed時**: error_message に詳細を記録

---

## 5. チェックリスト（PRマージ前に確認）

- [ ] UIにタイムアウト実装（10分）
- [ ] タイムアウト時のメッセージ表示
- [ ] status='failed' 検出とUI表示
- [ ] 失敗チャンクの詳細表示
- [ ] 再試行ボタン動作確認
- [ ] バックエンドの二重起動防止（409）
- [ ] api_error_logs への記録
- [ ] E2Eテスト: 成功パターン
- [ ] E2Eテスト: タイムアウトパターン
- [ ] E2Eテスト: 失敗チャンクパターン

---

## 6. 関連ファイル

| ファイル | 役割 |
|----------|------|
| `src/routes/parsing.ts` | POST /api/projects/:id/parse |
| `src/routes/formatting.ts` | POST /api/projects/:id/format, GET /format/status |
| `public/static/project-editor.*.js` | UIポーリング・表示 |
| `docs/SCENE_SPLIT_SSOT.md` | この文書 |

---

## 7. 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-01-19 | 初版作成（無限待ちゼロ化対応） |
