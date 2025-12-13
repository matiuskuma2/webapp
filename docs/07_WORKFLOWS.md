# ワークフロー仕様

## 🔄 全体フロー

```
Phase 1: Upload → Phase 2: Transcribe → Phase 3: Format → Phase 4: Generate → Phase 5: Download
```

## 📊 ステータス遷移

### projects.status
```
created → uploaded → transcribing → transcribed → formatting → formatted → generating_images → completed
                                                                                              ↓
                                                                                            failed
```

### image_generations.status
```
pending → generating → completed
                    ↓
                  failed
                    ↓
              policy_violation
```

---

## 🎯 Phase 1: アップロード

### ワークフロー
```
1. プロジェクト作成 (POST /api/projects)
2. projects.status = 'created'
3. 音声アップロード (POST /api/projects/:id/upload)
4. R2に保存: audio/{project_id}/{filename}_{timestamp}_{random}.{ext}
5. projects.status = 'uploaded'
```

### エラーハンドリング
| エラー | 対処 |
|-------|------|
| ファイル形式不正 | 400エラー、対応形式を表示 |
| サイズ超過（25MB） | 400エラー、制限値を表示 |
| R2アップロード失敗 | 500エラー、再試行を促す |

---

## 🎯 Phase 2: 文字起こし

### ワークフロー
```
1. projects.status = 'transcribing'
2. R2から音声ファイル取得
3. OpenAI Whisper API 呼び出し
4. transcriptions レコード作成
5. projects.status = 'transcribed'
```

### エラーハンドリング
| エラー | 対処 |
|-------|------|
| 音声未アップロード | 400エラー |
| OpenAI API エラー | 500エラー |

---

## 🎯 Phase 3: 整形・シーン分割

### ワークフロー
```
1. projects.status = 'formatting'
2. transcriptions.raw_text 取得
3. OpenAI Chat API (JSON mode) 呼び出し
4. JSON バリデーション
5. scenes レコード一括作成（トランザクション）
6. projects.status = 'formatted'
```

### バリデーション
```javascript
✅ version === "1.0"
✅ metadata.total_scenes === scenes.length
✅ scenes.length >= 3 && scenes.length <= 50
✅ scenes[].idx が 1 から連番
✅ scenes[].dialogue.length >= 40 && <= 220
✅ scenes[].bullets.length >= 2 && <= 4
```

---

## 🎯 Phase 4: 画像生成

### 単体生成
```
1. scene.image_prompt取得
2. 12_IMAGE_PROMPT_TEMPLATE.md スタイル付与
3. Gemini API 呼び出し
4. R2に保存: images/{scene_id}/gen_{id}_{timestamp}.png
5. image_generations レコード作成
6. is_active = 1, 既存を無効化
```

### 一括生成
```
1. projects.status = 'generating_images'
2. 対象シーン抽出（mode: all/pending/failed）
3. 各シーン順次処理
4. 429エラー時：自動再試行（最大3回）
5. projects.status = 'completed'
```

### 自動再試行
```javascript
async function generateWithRetry(sceneId, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await callGeminiAPI(sceneId);
    } catch (error) {
      if (error.status === 429 && i < maxRetries - 1) {
        await sleep(Math.pow(2, i) * 1000); // 1s, 2s, 4s
        continue;
      }
      throw error;
    }
  }
}
```

---

## 🎯 Phase 5: ダウンロード

### 画像ZIP
```
1. 完了画像一覧取得（is_active=1）
2. R2から各画像取得
3. ZIP生成（scene_{idx}.{ext}）
4. ダウンロードレスポンス返却
```

### セリフCSV
```
1. シーン一覧取得（idx昇順）
2. CSV生成（idx,role,title,dialogue,bullets）
3. bullets: パイプ区切り
4. ダウンロードレスポンス返却
```

### 全ファイルZIP
```
1. 画像ZIP生成
2. CSV生成
3. 統合ZIP生成（images/ + dialogue.csv）
4. ダウンロードレスポンス返却
```

---

## 🔐 セキュリティ

### APIキー管理
- 環境変数で管理（Cloudflare Secrets）
- フロントエンドには露出しない

### R2アクセス制御
- 署名付き一時URL（1時間有効）
- バケットはプライベート設定

---

最終更新: 2025-01-13
