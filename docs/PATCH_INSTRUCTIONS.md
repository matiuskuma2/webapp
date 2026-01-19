# ElevenLabs 統合パッチ指示書

## 文書情報
- 作成日: 2026-01-19
- 目的: ElevenLabs TTS 統合の残作業と検証手順を明確化

---

## 1. 現状確認サマリ

### 1.1 実装完了済み ✅

| 項目 | ファイル | 行 | 状態 |
|-----|---------|-----|------|
| toAbsoluteUrl 関数 | `src/routes/video-generation.ts` | L28-43 | ✅ 実装済み |
| audio_url 絶対URL変換（Preflight） | `src/routes/video-generation.ts` | L1192-1195 | ✅ 実装済み |
| audio_url 絶対URL変換（Build） | `src/routes/video-generation.ts` | L1419-1422 | ✅ 実装済み |
| image/comic/video URL変換 | `src/routes/video-generation.ts` | L1217-1222, L1444-1449 | ✅ 実装済み |
| ElevenLabs TTS クライアント | `src/utils/elevenlabs.ts` | 全体 | ✅ 実装済み |
| ElevenLabs provider 自動検出 | `src/routes/audio-generation.ts` | L29-38 | ✅ 実装済み |
| ElevenLabs generate-audio | `src/routes/audio-generation.ts` | L323-343 | ✅ 実装済み |
| ElevenLabs TTS preview | `src/routes/audio-generation.ts` | L455-485 | ✅ 実装済み |
| /api/tts/voices エンドポイント | `src/routes/audio-generation.ts` | L557-605 | ✅ 実装済み |
| Bindings 型更新 | `src/types/bindings.ts` | L27 + ElevenLabs行 | ✅ 実装済み |
| 本番 Secrets 登録 | Cloudflare Pages | - | ✅ 登録済み |

### 1.2 残作業 ❌

| 項目 | 状態 | 優先度 | 備考 |
|-----|------|-------|------|
| Video Build E2E テスト | ❌ 未実施 | **最優先** | Remotion Lambda で 404 が出ないか確認 |
| ElevenLabs 本番動作確認 | ❌ 未確認 | 高 | **Free Tier IP ブロック問題** あり |
| voice-presets.json 更新 | ❌ 未実施 | 中 | UI に ElevenLabs ボイスを追加 |
| 計測・上限・キャッシュ | ❌ 未実施 | 低 | Phase D |

---

## 2. バグ修正：isElevenLabsVoice の二重呼び出し

### 問題箇所
`src/routes/audio-generation.ts` L451 に関数名とインポート名が衝突している：

```typescript
// L451 - 問題のコード
const isElevenLabsVoice = voice_id.startsWith('elevenlabs:') || voice_id.startsWith('el-') || isElevenLabsVoice(voice_id);
```

`isElevenLabsVoice` という変数名がインポートされた関数名と同じになっている。

### 修正方法
**ファイル**: `src/routes/audio-generation.ts`  
**行**: L451

**修正前**:
```typescript
const isElevenLabsVoice = voice_id.startsWith('elevenlabs:') || voice_id.startsWith('el-') || isElevenLabsVoice(voice_id);
```

**修正後**:
```typescript
const isElevenLabs = voice_id.startsWith('elevenlabs:') || voice_id.startsWith('el-') || isElevenLabsVoice(voice_id);
```

**影響範囲**: L451, L453, L455
- L453: `isFishVoice` はそのまま
- L453: `isElevenLabsVoice` → `isElevenLabs` に変更
- L455: `isElevenLabsVoice` → `isElevenLabs` に変更

---

## 3. 検証手順

### 3.1 Phase A: Video Build E2E テスト

**目的**: toAbsoluteUrl が正しく動作し、Remotion Lambda が音声ファイルにアクセスできることを確認

**手順**:
```bash
# 1. 本番 Preflight エンドポイントを確認
curl -s -H "Cookie: session=YOUR_SESSION" \
  "https://webapp-c7n.pages.dev/api/projects/{PROJECT_ID}/video-builds/preflight" | jq

# 2. audio_url が絶対URL（https://webapp-c7n.pages.dev/audio/...）になっていることを確認
# ❌ NG: /audio/35/scene_1/3_1767512834225.mp3
# ✅ OK: https://webapp-c7n.pages.dev/audio/35/scene_1/3_1767512834225.mp3

# 3. Video Build を実行
curl -X POST -H "Cookie: session=YOUR_SESSION" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "https://webapp-c7n.pages.dev/api/projects/{PROJECT_ID}/video-builds"

# 4. ステータス確認（rendering → completed を追う）
curl -s -H "Cookie: session=YOUR_SESSION" \
  "https://webapp-c7n.pages.dev/api/video-builds/{BUILD_ID}/status" | jq
```

**成功基準**:
- Preflight の audio_url が絶対URL
- Video Build が completed になる
- Remotion Lambda ログに audio 404 エラーがない

### 3.2 Phase B: ElevenLabs 本番動作確認

**現状**: Free Tier が Cloudflare Workers の IP をブロック

**回避策**:
1. ElevenLabs Starter プラン ($5/月) 以上にアップグレード
2. または Google TTS / Fish Audio を使用

**テストコマンド**（有料プラン後）:
```bash
# TTS Preview テスト
curl -X POST "https://webapp-c7n.pages.dev/api/tts/preview" \
  -H "Content-Type: application/json" \
  -d '{"voice_id": "el-aria", "text": "こんにちは"}'

# 期待結果
# { "success": true, "audio_url": "data:audio/mpeg;base64,..." }
```

### 3.3 Phase C: voice-presets.json 更新

**ファイル**: `public/static/voice-presets.json`

**追加内容**:
```json
{
  "voice_presets": {
    "el-aria": {
      "name": "Aria（女性・落ち着き）",
      "language": "ja-JP",
      "gender": "female",
      "provider": "elevenlabs",
      "description": "落ち着いた女性の声、ナレーション向き"
    },
    "el-sarah": {
      "name": "Sarah（女性・優しい）",
      "language": "ja-JP",
      "gender": "female",
      "provider": "elevenlabs",
      "description": "優しく穏やかな女性の声"
    },
    "el-charlotte": {
      "name": "Charlotte（女性・明るい）",
      "language": "ja-JP",
      "gender": "female",
      "provider": "elevenlabs",
      "description": "明るくエネルギッシュな女性の声"
    },
    "el-adam": {
      "name": "Adam（男性・深い）",
      "language": "ja-JP",
      "gender": "male",
      "provider": "elevenlabs",
      "description": "深みのある男性の声、ナレーション向き"
    },
    "el-bill": {
      "name": "Bill（男性・自然）",
      "language": "ja-JP",
      "gender": "male",
      "provider": "elevenlabs",
      "description": "自然で聞きやすい男性の声"
    },
    "el-brian": {
      "name": "Brian（男性・プロ）",
      "language": "ja-JP",
      "gender": "male",
      "provider": "elevenlabs",
      "description": "プロフェッショナルな男性の声"
    },
    "el-lily": {
      "name": "Lily（若い女性）",
      "language": "ja-JP",
      "gender": "female",
      "provider": "elevenlabs",
      "description": "若々しい女性の声、キャラクター向き"
    },
    "el-george": {
      "name": "George（男性・落ち着き）",
      "language": "ja-JP",
      "gender": "male",
      "provider": "elevenlabs",
      "description": "落ち着いた中年男性の声"
    }
  }
}
```

---

## 4. 依存関係マップ

```
┌───────────────────────────────────────────────────────────────────────┐
│                           UI Layer                                     │
├───────────────────────────────────────────────────────────────────────┤
│ project-editor.*.js ──→ POST /api/scenes/:id/generate-audio           │
│ scene-edit-modal.js ──→ PATCH /api/scenes/:id/characters              │
│ audio-client.js     ──→ GET /api/scenes/:id/audio                     │
│                     ──→ POST /api/audio/:id/activate                  │
│ voice-presets.json  ──→ /api/tts/voices (参照用)                      │
└───────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│                         API Layer (Hono)                              │
├───────────────────────────────────────────────────────────────────────┤
│ audio-generation.ts:                                                   │
│   ├── POST /api/scenes/:id/generate-audio                             │
│   │     └── provider判定: el-* → elevenlabs, fish:* → fish, else google│
│   │     └── generateAndUploadAudio() → R2保存 → DB更新                 │
│   ├── GET /api/scenes/:id/audio                                       │
│   ├── POST /api/audio/:id/activate                                    │
│   ├── DELETE /api/audio/:id                                           │
│   ├── POST /api/tts/preview                                           │
│   └── GET /api/tts/voices                                             │
│                                                                        │
│ video-generation.ts:                                                   │
│   ├── GET /api/projects/:id/video-builds/preflight                    │
│   │     └── toAbsoluteUrl(audio.r2_url, SITE_URL)                     │
│   └── POST /api/projects/:id/video-builds                             │
│         └── buildProjectJson() → Remotion Lambda 送信                  │
└───────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│                      Storage & External Services                       │
├───────────────────────────────────────────────────────────────────────┤
│ D1: audio_generations                                                  │
│   ├── provider: 'google' | 'fish' | 'elevenlabs'                      │
│   ├── r2_key: 'audio/{project_id}/scene_{idx}/{id}_{ts}.mp3'          │
│   └── r2_url: '/audio/...' (相対パス)                                  │
│                                                                        │
│ R2: webapp-bucket                                                      │
│   └── audio/{project_id}/scene_{idx}/{id}_{timestamp}.mp3             │
│                                                                        │
│ Cloudflare Pages Secrets:                                              │
│   ├── ELEVENLABS_API_KEY                                              │
│   ├── ELEVENLABS_DEFAULT_MODEL                                        │
│   ├── FISH_AUDIO_API_TOKEN                                            │
│   ├── GEMINI_API_KEY (Google TTS用)                                   │
│   └── SITE_URL: https://webapp-c7n.pages.dev                          │
│                                                                        │
│ External APIs:                                                         │
│   ├── ElevenLabs: https://api.elevenlabs.io/v1/text-to-speech/{id}    │
│   ├── Google TTS: https://texttospeech.googleapis.com/v1/text:synthesize│
│   ├── Fish Audio: (via fish-audio.ts)                                 │
│   └── Remotion Lambda: AWS_ORCH_BASE_URL + /render                    │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 5. SSOT 定義（再確認）

### SSOT-1: Provider 判定
```typescript
// src/routes/audio-generation.ts L29-38
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

### SSOT-2: 音声生成の入口
- **唯一の入口**: `POST /api/scenes/:id/generate-audio`
- **内部関数**: `generateAndUploadAudio()` がすべての provider を統一処理
- **/api/tts/preview**: プレビュー専用（保存しない）

### SSOT-3: Video Build 用 URL は絶対URL
```typescript
// src/routes/video-generation.ts L28-43
function toAbsoluteUrl(relativeUrl: string | null | undefined, siteUrl: string | undefined): string | null {
  if (!relativeUrl) return null;
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
    return relativeUrl;
  }
  if (siteUrl) {
    const baseUrl = siteUrl.replace(/\/$/, '');
    const path = relativeUrl.startsWith('/') ? relativeUrl : `/${relativeUrl}`;
    return `${baseUrl}${path}`;
  }
  console.warn('[Video Build] No SITE_URL configured, relative URLs will not work in Remotion');
  return relativeUrl;
}
```

---

## 6. チェックリスト

### 即時対応（セキュリティ）
- [ ] ElevenLabs API キーをローテーション（旧キー無効化 → 新規発行）
- [ ] Cloudflare トークンをローテーション（最小権限で新規発行）
- [ ] 今後キーをチャットに貼らないポリシーを徹底

### Phase A: Video Build E2E
- [ ] Preflight で audio_url が絶対URL になっていることを確認
- [ ] Video Build を実行し completed になることを確認
- [ ] Remotion Lambda ログに 404 エラーがないことを確認

### Phase B: ElevenLabs 本番動作
- [ ] ElevenLabs Starter プラン以上にアップグレード
- [ ] /api/tts/preview で el-aria の TTS 生成が成功することを確認
- [ ] /api/scenes/:id/generate-audio で ElevenLabs provider が動作することを確認

### Phase C: UI 統合
- [ ] voice-presets.json に ElevenLabs ボイスを追加
- [ ] キャラクター設定で ElevenLabs ボイスが選択可能になることを確認
- [ ] 生成した音声が正しく再生されることを確認

### Phase D: 計測・上限（将来）
- [ ] tts_usage_logs テーブル追加（または api_usage_logs 拡張）
- [ ] 生成時に usage 記録
- [ ] $100 上限の判定と UI 表示
- [ ] キャッシュ（cache_key）で重複生成防止

---

## 7. 次のアクション

1. **バグ修正**: `isElevenLabsVoice` 変数名の衝突を修正
2. **Phase A**: Video Build E2E テストで 404 解消を確認
3. **Phase B**: ElevenLabs 有料プラン検討
4. **Phase C**: voice-presets.json 更新
5. **Phase D**: 計測・上限機能設計

---

## 8. 参考: 本番環境 Secrets 一覧

```
AWS_ACCESS_KEY_ID
AWS_ORCH_BASE_URL
AWS_REGION
AWS_SECRET_ACCESS_KEY
CRON_SECRET
ELEVENLABS_API_KEY       ← 新規追加済み
ELEVENLABS_DEFAULT_MODEL ← 新規追加済み
ENCRYPTION_KEY
FISH_AUDIO_API_TOKEN
GEMINI_API_KEY
IMAGE_URL_SIGNING_SECRET
OPENAI_API_KEY
SENDGRID_API_KEY
SENDGRID_FROM_EMAIL
SITE_URL
```
