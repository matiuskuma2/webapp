# ElevenLabs TTS 統合計画書

## 文書情報
- 作成日: 2026-01-19
- 最終更新: 2026-01-19
- 目的: ElevenLabs TTS を既存の音声系（Google/Fish）と衝突させず、依存関係を崩さずに統合する

---

## 1. 現状の依存関係マップ

### 1.1 音声生成・参照の入口（UI）

| UI コンポーネント | ファイル | 機能 | API呼び出し |
|-----------------|---------|------|------------|
| Builder（シーンカード） | `project-editor.*.js` | キャラ音声で生成、履歴、再生 | `POST /api/scenes/:id/generate-audio` |
| Scene Edit Modal | `scene-edit-modal.js` | voice_character 選択 | `PATCH /api/scenes/:id/characters` |
| Styles > Characters | `world-character-*.js` | voice_preset_id 設定 | `POST /api/character-models/...` |
| Audio Section | `audio-ui.js`, `audio-state.js`, `audio-client.js` | 統一的な音声UI管理 | 上記API経由 |

### 1.2 バックエンド（API）

| エンドポイント | ファイル | 用途 |
|--------------|---------|------|
| `POST /api/scenes/:id/generate-audio` | `audio-generation.ts` | 音声生成（本体） |
| `POST /api/tts/preview` | `audio-generation.ts` | 短文プレビュー |
| `GET /api/scenes/:id/audio` | `audio-generation.ts` | 履歴・active参照 |
| `POST /api/audio/:id/activate` | `audio-generation.ts` | 音声採用 |
| `DELETE /api/audio/:id` | `audio-generation.ts` | 音声削除 |
| `GET /api/tts/voices` | `audio-generation.ts` | ボイスカタログ（NEW） |
| `GET /audio/*` | `audio.ts` | R2から音声配信 |

### 1.3 データベース

#### audio_generations テーブル（本番）
```sql
CREATE TABLE audio_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',  -- google | fish | elevenlabs
  voice_id TEXT NOT NULL,                   -- 例: ja-JP-Neural2-B, fish:xxx, el-aria
  model TEXT,                               -- 例: eleven_multilingual_v2
  format TEXT NOT NULL DEFAULT 'mp3',
  sample_rate INTEGER DEFAULT 24000,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | generating | completed | failed
  error_message TEXT,
  r2_key TEXT,
  r2_url TEXT,                              -- ⚠️ 現在は相対パス（/audio/...）
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME,
  updated_at DATETIME,
  user_id INTEGER,
  duration_ms INTEGER,                      -- 追加済み（実測or推定）
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);
```

#### project_character_models テーブル（voice_preset_id）
```sql
-- voice_preset_id: キャラクターに紐づく音声プリセット
-- 例: ja-JP-Neural2-B, fish:xxx, el-aria
voice_preset_id TEXT
```

### 1.4 外部サービス連携

| サービス | 用途 | 依存関係 |
|---------|------|---------|
| Cloudflare R2 | 音声ファイル保存 | `r2_key`, `r2_url` |
| Remotion Lambda | Video Build時に音声URL参照 | `audio_url` は絶対URL必須 |
| Google TTS | 既存プロバイダー | `GEMINI_API_KEY` |
| Fish Audio | 既存プロバイダー | `FISH_AUDIO_API_TOKEN` |
| ElevenLabs | 新規プロバイダー | `ELEVENLABS_API_KEY` |

---

## 2. SSOT（Single Source of Truth）定義

### SSOT-1: Provider判定
```typescript
// voice_id の prefix で provider を確定
function detectProvider(voiceId: string): 'elevenlabs' | 'fish' | 'google' {
  if (voiceId.startsWith('elevenlabs:') || voiceId.startsWith('el-')) {
    return 'elevenlabs';
  }
  if (voiceId.startsWith('fish:') || voiceId.startsWith('fish-')) {
    return 'fish';
  }
  return 'google'; // デフォルト
}
```

### SSOT-2: 音声生成の入口は1つ
- 全ての音声生成は `POST /api/scenes/:sceneId/generate-audio` を経由
- 内部関数 `generateAndUploadAudio()` が唯一の生成ロジック
- `/api/tts/preview` は保存なしの薄いラッパー

### SSOT-3: Video Build用URLは必ず絶対URL
```typescript
// r2_url が相対パスの場合、SITE_URL を前置
function toAbsoluteUrl(relativeUrl: string, siteUrl: string): string {
  if (relativeUrl.startsWith('http')) return relativeUrl;
  return `${siteUrl.replace(/\/$/, '')}${relativeUrl.startsWith('/') ? '' : '/'}${relativeUrl}`;
}
```

---

## 3. 影響範囲と変更一覧

### 3.1 変更が必要なファイル

| ファイル | 変更内容 | リスク |
|---------|---------|-------|
| `src/routes/audio-generation.ts` | ElevenLabs provider追加 | 中: 既存provider動作確認必須 |
| `src/utils/elevenlabs.ts` | 新規: ElevenLabs APIクライアント | 低: 新規ファイル |
| `src/types/bindings.ts` | 環境変数追加 | 低: 型定義のみ |
| `public/static/voice-presets.json` | ElevenLabsボイス追加 | 低: JSON追加のみ |
| `src/routes/video-generation.ts` | URL絶対化（✅完了） | 中: Remotion依存 |

### 3.2 DBマイグレーション（不要）
- `audio_generations.provider` は既に TEXT型で制約なし
- `audio_generations.model` も既に存在
- **追加カラム不要**（ElevenLabsは既存スキーマで対応可能）

### 3.3 フロントエンド変更

| ファイル | 変更内容 |
|---------|---------|
| `public/static/voice-presets.json` | ElevenLabsボイス追加（8種） |
| `public/static/audio-ui.js` | provider表示（任意） |
| `public/static/project-editor.*.js` | provider判定ロジック追加 |

---

## 4. 実装フェーズ（順番が重要）

### Phase A: Video Build 404 修正（✅完了）
- [x] `toAbsoluteUrl()` 関数追加
- [x] audio_url, image_url, comic_url, video_url を絶対URL化
- [ ] E2Eテストで Remotion 404 が発生しないことを確認

### Phase B: ElevenLabs Provider追加
- [x] `src/utils/elevenlabs.ts` 作成
- [x] `/api/tts/preview` に ElevenLabs分岐追加
- [x] `/api/scenes/:id/generate-audio` に ElevenLabs分岐追加
- [x] `/api/tts/voices` エンドポイント追加
- [ ] 本番環境で ElevenLabs TTS 動作確認

### Phase C: ボイスカタログ更新
- [ ] `voice-presets.json` に ElevenLabs ボイス追加
- [ ] UI で ElevenLabs ボイスが選択可能になることを確認

### Phase D: 計測・上限・キャッシュ（将来）
- [ ] tts_usage_logs テーブル追加（または api_usage_logs 拡張）
- [ ] 生成時に usage 記録
- [ ] $100上限の判定とUI表示
- [ ] キャッシュ（cache_key）で重複生成防止

---

## 5. テスト計画

### 5.1 ユニットテスト
- [ ] `detectProvider()` 関数のテスト
- [ ] `resolveElevenLabsVoiceId()` 関数のテスト
- [ ] `toAbsoluteUrl()` 関数のテスト

### 5.2 統合テスト
- [ ] Google TTS 生成が既存通り動作すること
- [ ] Fish Audio 生成が既存通り動作すること
- [ ] ElevenLabs 生成が正常に動作すること
- [ ] 生成した音声が R2 に正しく保存されること
- [ ] `r2_url` が絶対URL化されていること

### 5.3 E2Eテスト
- [ ] Video Build で音声付き動画が生成できること
- [ ] Remotion Lambda が音声ファイルをダウンロードできること
- [ ] キャラクター設定で voice_preset_id が正しく保存されること

---

## 6. リスク評価

| リスク | 影響度 | 発生確率 | 対策 |
|-------|-------|---------|------|
| 既存Google/Fish TTSが壊れる | 高 | 低 | provider判定を厳密に、デフォルトはgoogle |
| ElevenLabs API キー漏洩 | 高 | 低 | Secrets管理、チャットに貼らない |
| Video Build 404 再発 | 高 | 中 | URL絶対化の徹底、E2Eテスト |
| ElevenLabs Free Tier ブロック | 中 | 高 | Starter以上のプランが必要（対応済み） |
| $100上限超過 | 中 | 中 | 計測・上限機能を Phase D で実装 |

---

## 7. 環境変数

### 7.1 本番環境（Cloudflare Pages Secrets）
```
ELEVENLABS_API_KEY=sk_xxx...      # ✅ 登録済み
ELEVENLABS_DEFAULT_MODEL=eleven_multilingual_v2  # ✅ 登録済み
```

### 7.2 ローカル開発（.dev.vars）
```
ELEVENLABS_API_KEY=sk_xxx...
ELEVENLABS_DEFAULT_MODEL=eleven_multilingual_v2
```

---

## 8. ボイスカタログ（ElevenLabs）

| Preset Key | Voice ID | 名前 | 性別 | 用途 |
|-----------|----------|------|-----|------|
| el-aria | 9BWtsMINqrJLrRacOk9x | Aria | 女性 | ナレーション |
| el-sarah | EXAVITQu4vr4xnSDxMaL | Sarah | 女性 | 優しい |
| el-charlotte | XB0fDUnXU5powFXDhCwa | Charlotte | 女性 | 明るい |
| el-adam | pNInz6obpgDQGcFmaJgB | Adam | 男性 | ナレーション |
| el-bill | pqHfZKP75CvOlQylNhV4 | Bill | 男性 | 自然 |
| el-brian | nPczCjzI2devNBz1zQrb | Brian | 男性 | プロ |
| el-lily | pFZP5JQG7iQjIQuC4Bku | Lily | 女性 | 若い |
| el-george | JBFqnCBsd6RMkjVDRZzb | George | 男性 | 落ち着き |

---

## 9. 次のアクション

1. **即座に**: ElevenLabs/Cloudflare APIキーをローテーション
2. **Phase A確認**: Video Build E2E テストで 404 が解消されていることを確認
3. **Phase B確認**: 本番環境で ElevenLabs TTS が動作することを確認
4. **Phase C**: voice-presets.json に ElevenLabs ボイスを追加
5. **Phase D**: 計測・上限機能の設計・実装

---

## 10. 参考資料

- [ElevenLabs API Docs](https://elevenlabs.io/docs/api-reference)
- [Remotion Lambda Docs](https://www.remotion.dev/docs/lambda)
- [Cloudflare R2 Docs](https://developers.cloudflare.com/r2/)
