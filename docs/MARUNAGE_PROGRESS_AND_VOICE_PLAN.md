# 丸投げチャット — 進捗・音声アーキテクチャ・PersonaPlex-7B統合計画

> 最終更新: 2026-02-17 (commit df9bf59)
> 本ドキュメントは「今どこまでできていて、次に何をすべきか」を即座に再開できるよう網羅的に記録する。

---

## 1. 丸投げチャット — 実装済み機能一覧

### 1.1 コア機能（本番稼働中）

| # | 機能 | コマンド例 | 実装 commit | SSOT |
|---|------|-----------|-------------|------|
| 1 | プロジェクト作成・シーン自動生成 | (自動) | `c413b8c` | `marunage_runs`, `scenes` |
| 2 | 画像生成（シーン別） | (自動) | `c413b8c` | `image_generations` |
| 3 | 音声生成（一括TTS） | (自動) | `c413b8c` | `audio_generations`, `project_audio_jobs` |
| 4 | 動画ビルド（Remotion Lambda） | (自動) | `c413b8c` | `video_builds` |
| 5 | シーン画像修正→再生成 | 「シーン3の画像を暗くして」 | `c413b8c` | `image_generations` |
| 6 | BGM追加 | 「BGMを追加」 | `c413b8c` | `project_audio_tracks` |
| 7 | SE追加 | 「シーン3にドア音」 | `828b00a` | `scene_audio_assignments` |
| 8 | セリフ編集 | 「シーン1のセリフ修正」 | `a776c6d` | `scene_utterances` |
| 9 | DAT切替 | 「画像表示にして」 | `38c17e3` | `scenes.display_asset_type` |
| 10 | I2V生成 | 「シーン1を動画にして」 | `6d5820a` | `video_generations` |
| 11 | Comic v1（自動生成） | 「シーン3を漫画化して」 | `ad333e3` | `image_generations(asset_type='comic')`, `scenes.comic_data` |
| 12 | Comic v2（吹き出しテキスト編集） | 「シーン3の吹き出し1を○○に」 | `9ac099b` | `scenes.comic_data` |
| 13 | Comic v3（吹き出し位置編集） | 「シーン3の吹き出し2を上に」 | `0a5ec9d` | `scenes.comic_data` |
| 14 | シーンカード動画プレビュー (DAT=video) | カード内自動再生 + クリック拡大 | `051b593` | `video_generations` |
| 15 | SEタイミング編集 | 「シーン3のSE +2秒」 | `051b593` | `scene_audio_assignments.start_ms` |
| 16 | バッチ漫画化 | 「シーン1-5を漫画化」 | `051b593` | (既存SSOT) |
| 17 | シーンカード漫画プレビュー (DAT=comic) | カード内漫画画像 + クリック拡大 | `e907ed2` | `image_generations(asset_type='comic')` |
| 18 | 動画リビルド前確認モーダル | 自動表示 | `d938a4e` | `MC._dirtyChanges` |
| 19 | Presigned URL自動更新（期限切れ対策） | 自動 | `df9bf59` | `video_builds.download_url`, `s3_output_key` |

### 1.2 チャットハンドラ一覧（19個）

```
mcHandleBgmIntent        — BGM追加
mcHandleSeIntent          — SE追加
mcHandleSeTimingIntent    — SEタイミング編集開始
mcHandleSeTimingEditReply — SEタイミング編集入力
mcUpdateSeTiming          — SEタイミングAPI呼出
mcShowSeTimingList        — SEタイミング一覧表示
mcHandleDialogueIntent    — セリフ編集開始
mcHandleDialogueEditReply — セリフ編集入力
mcHandleI2vIntent         — I2V生成開始
mcHandleComicIntent       — 漫画化開始
mcHandleComicEditIntent   — 吹き出し編集開始
mcHandleComicEditReply    — 吹き出し編集入力
mcEditComicBubbleText     — 吹き出しテキスト更新
mcMoveComicBubble         — 吹き出し位置変更
mcRenderComicOffscreen    — 漫画オフスクリーン描画
mcHandleBatchComicIntent  — バッチ漫画化
mcHandleDatIntent         — DAT切替
mcPollI2vStatus           — I2Vポーリング
mcOpenVideoModal          — 動画モーダル
```

---

## 2. 音声生成 — 完全アーキテクチャ調査

### 2.1 DB設計（音声関連テーブル）

```
┌─────────────────────────────────┐
│ scene_utterances (SSOT: 発話)    │
│ ─────────────────────────────── │
│ id, scene_id, order_no          │
│ role: 'narration' | 'dialogue'  │
│ character_key (dialogue時)       │
│ text                            │
│ audio_generation_id → FK        │
│ duration_ms (キャッシュ)         │
└────────────┬────────────────────┘
             │ 1:1
┌────────────▼────────────────────┐
│ audio_generations (SSOT: 音声)   │
│ ─────────────────────────────── │
│ id, scene_id                    │
│ provider: 'google'|'elevenlabs' │
│          |'fish'                │
│ voice_id, model                 │
│ format: 'mp3', sample_rate      │
│ text, status, error_message     │
│ r2_key, r2_url                  │
│ is_active (0/1)                 │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ project_audio_jobs (SSOT: 一括)  │
│ ─────────────────────────────── │
│ id, project_id                  │
│ mode: 'missing'|'pending'|'all' │
│ narration_provider, voice_id    │
│ status: queued→running→done     │
│ total/processed/success/failed  │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ project_character_models         │
│ (SSOT: キャラ音声設定)           │
│ ─────────────────────────────── │
│ voice_preset_id TEXT             │
│   例: 'el-aria', 'fish-nanamin' │
│   例: 'ja-JP-Wavenet-A'         │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ project_audio_tracks             │
│ (SSOT: 通しBGM)                 │
│ ─────────────────────────────── │
│ id, project_id, track_type='bgm'│
│ r2_key, r2_url, volume, loop    │
│ ducking_enabled (将来)           │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ scene_audio_assignments          │
│ (SSOT: シーン別BGM/SFX割当)     │
│ ─────────────────────────────── │
│ id, scene_id                    │
│ audio_type: 'bgm' | 'sfx'      │
│ audio_library_type: system/user │
│ start_ms, end_ms                │
│ volume_override, loop_override  │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ system_audio_library             │
│ (管理者登録BGM/SFX)             │
├─────────────────────────────────┤
│ user_audio_library               │
│ (ユーザー登録BGM/SFX)           │
└─────────────────────────────────┘
```

### 2.2 TTS プロバイダー（現在3つ）

| Provider | util file | API | 声の数 | 特徴 |
|----------|-----------|-----|--------|------|
| **Google TTS** | (inline in audio-generation.ts) | `texttospeech.googleapis.com/v1` | 8声（Standard×4 + Wavenet×4） + Neural2-B | デフォルト、日本語専用 |
| **ElevenLabs** | `src/utils/elevenlabs.ts` (274行) | `api.elevenlabs.io/v1` | 6声（Aria, Sarah, Charlotte, Adam, Bill, Brian） | Multilingual v2、高品質 |
| **Fish Audio** | `src/utils/fish-audio.ts` (133行) | `api.fish.audio/v1/tts` | 1声（Nanamin） | reference_id方式、アニメ向き |

### 2.3 音声解決の優先順位（Voice Resolution Priority）

```
1. character → project_character_models.voice_preset_id
   （dialogue 時: キャラに設定されたvoice）
2. project_default → projects.settings_json.default_narration_voice
   （narration 時: プロジェクトデフォルト音声）
3. fallback → google: ja-JP-Neural2-B
```

### 2.4 API エンドポイント（音声関連）

```
GET  /api/tts/voices                         — 全プロバイダーの声一覧
POST /api/scenes/:sceneId/audio/generate     — 単一シーン音声生成
POST /api/projects/:projectId/audio/generate-all — 一括音声生成
GET  /api/projects/:projectId/audio/job-status   — 一括ジョブ進捗
POST /api/scenes/:sceneId/audio/preview      — プレビュー再生用
GET  /api/scenes/:sceneId/utterances         — シーンの発話一覧
PUT  /api/scenes/:sceneId/utterances/:id     — 発話テキスト編集
GET  /api/scenes/:sceneId/audio-assignments  — シーンのBGM/SFX割当
PUT  /api/scenes/:sceneId/audio-assignments/:id — SFX start_ms 更新
POST /api/audio-library/system               — システム音源登録（管理者）
GET  /api/audio-library/system               — システム音源一覧
```

### 2.5 依存関係マップ（音声→動画ビルド）

```
scene_utterances
  → audio_generations (r2_key → R2 → CloudFront URL)
    → video_builds buildProjectJson()
      → utterances[].audio_url (絶対URL)
      → Remotion Lambda
        → 動画内の音声トラック

project_audio_tracks (BGM)
  → video_builds buildProjectJson()
    → audio_global.bgm

scene_audio_assignments (SFX)
  → video_builds buildProjectJson()
    → scenes[].sfx[]
```

### 2.6 マイグレーション一覧（音声関連）

| # | Migration | 内容 |
|---|-----------|------|
| 0009 | create_audio_generations | TTS音声生成履歴 |
| 0018 | create_tts_usage_logs | TTS使用量追跡 |
| 0019 | add_scene_speech_type | シーンの発話タイプ |
| 0022 | create_scene_utterances | 発話SSOT（マルチスピーカー） |
| 0029 | create_project_audio_tracks | 通しBGM |
| 0031 | create_scene_audio_cues | 音声キュー（旧・非推奨） |
| 0039 | create_system_audio_library | システムBGM/SFXライブラリ |
| 0040 | create_user_audio_library | ユーザーBGM/SFXライブラリ |
| 0041 | create_scene_audio_assignments | シーンへの音素材割当 |
| 0048 | add_bgm_timeline_columns | BGMタイムラインカラム |
| 0049 | create_project_audio_jobs | 一括音声生成ジョブ |

---

## 3. PersonaPlex-7B 統合計画

### 3.1 PersonaPlex-7B とは（実態の正確な把握）

**重要な事実**: PersonaPlex-7B は **Speech-to-Speech (S2S) 全二重対話モデル** であり、
一般的な Text-to-Speech (TTS) モデルではない。

| 属性 | 値 |
|------|-----|
| 開発元 | NVIDIA Research (ADLR) |
| リリース | 2026年1月15日 |
| パラメータ | 7B |
| アーキテクチャ | Moshi (Kyutai) ベース |
| 入力 | 音声 (WAV 24kHz) + テキストプロンプト + 音声プロンプト |
| 出力 | 音声 (WAV 24kHz) + テキスト |
| 対応言語 | **英語のみ** |
| ライセンス | NVIDIA Open Model License (商用利用可) |
| 必要GPU | A100 / H100 (VRAM 80GB推奨) |
| ランタイム | PyTorch, CUDA |

### 3.2 PersonaPlex-7B の強み

1. **全二重対話**: 聞きながら同時に話す（割り込み、バックチャネル対応）
2. **ペルソナ制御**: テキストプロンプトで役割設定、音声プロンプトで声質設定
3. **超低遅延**: 170ms（ターン交代）、240ms（割り込み応答）
4. **自然な「間」**: フィラー、呼吸音、考える間の再現
5. **オープンソース**: HuggingFace で公開、商用利用可

### 3.3 統合における制約と課題

#### ❌ 根本的な制約

| 制約 | 影響 | 対策 |
|------|------|------|
| **英語のみ** | 日本語TTS としては使用不可 | 日本語対応の後続モデル待ち、または多言語ファインチューニング |
| **S2S モデル（TTSではない）** | テキスト→音声の直接変換は本来の用途ではない | Offline モードで「入力WAV + テキスト → 出力WAV」として擬似TTS利用は可能 |
| **GPU必須 (A100/H100)** | Cloudflare Workers からは直接実行不可 | AWS SageMaker / EC2 にデプロイし、REST API 経由で呼び出す |
| **7Bパラメータ** | 推論コスト高い（ElevenLabs比で数倍） | バッチ処理、キャッシュ戦略が必須 |

#### ⚠️ 技術的ハードル

1. **日本語対応が公式にない** — Fisher English コーパスで訓練されており、日本語の「間」「フィラー」「敬語トーン」は未学習
2. **TTSとしての使い方が非標準** — Offline モードで voice prompt + text prompt + 入力WAVから出力WAVを生成できるが、純粋なTTSパイプラインとは異なる
3. **インフラコスト** — A100 1台で $3-5/時間、常時稼働で月$2,000-3,500

### 3.4 推奨アーキテクチャ（統合する場合）

```
┌─────────────────────────────────────────────────┐
│ Cloudflare Workers (既存)                        │
│                                                 │
│ POST /api/scenes/:id/audio/generate             │
│   provider判定:                                  │
│     'google'      → Google TTS API (直接)        │
│     'elevenlabs'  → ElevenLabs API (直接)        │
│     'fish'        → Fish Audio API (直接)        │
│     'personaplex' → AWS推論エンドポイント         │
│                                                 │
└──────────────────┬──────────────────────────────┘
                   │ (personaplex の場合)
                   ▼
┌──────────────────────────────────────────────────┐
│ AWS SageMaker Endpoint / EC2 + FastAPI           │
│                                                  │
│ POST /api/v1/synthesize                          │
│ {                                                │
│   "text": "こんにちは、今日はいい天気ですね",      │
│   "voice_prompt_url": "s3://voices/narrator.wav",│
│   "persona_text": "You are a warm narrator...",  │
│   "language": "ja"  // 将来の多言語拡張           │
│ }                                                │
│                                                  │
│ → PersonaPlex-7B 推論                            │
│ → WAV → MP3 変換                                 │
│ → S3 アップロード                                │
│ → { audio_url, duration_ms }                     │
└──────────────────────────────────────────────────┘
```

### 3.5 DB変更（最小限）

```sql
-- audio_generations.provider に 'personaplex' を追加（CHECK制約がないため変更不要）
-- 既存の provider TEXT カラムにそのまま格納可能

-- voice prompt の管理テーブル（新規）
CREATE TABLE IF NOT EXISTS voice_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,                    -- 「ナレーターA」「キャラX」
  description TEXT,
  provider TEXT NOT NULL DEFAULT 'personaplex',
  -- 音声プロンプト（WAVファイルのR2参照）
  voice_sample_r2_key TEXT NOT NULL,     -- 24kHz WAV
  voice_sample_r2_url TEXT NOT NULL,
  voice_sample_duration_ms INTEGER,
  -- ペルソナテキスト
  persona_text TEXT,                     -- "You are a warm, friendly narrator..."
  -- メタデータ
  language TEXT DEFAULT 'en',            -- 対応言語
  gender TEXT,
  tags TEXT,                             -- JSON配列
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### 3.6 実装フェーズ（段階的導入）

#### Phase 0: 調査・検証（1-2週間）
- [ ] PersonaPlex-7B の Offline TTS モード実証実験（ローカルGPU）
- [ ] 日本語入力での出力品質評価
- [ ] 代替案の評価: 
  - **Qwen3-TTS** (Alibaba, 多言語対応)
  - **Fish Speech 1.6** (既に統合済み、日本語良好)
  - **ElevenLabs Turbo v2.5** (最も手軽、日本語対応済み)
  - **NVIDIA Riva** (NIM API として提供、日本語ASR/TTS有り)

#### Phase 1: AWS推論エンドポイント構築（2-3週間）
- [ ] SageMaker / EC2 (g5.2xlarge, A10G) にデプロイ
- [ ] FastAPI ラッパー作成（REST API化）
- [ ] voice prompt アップロード・管理機能
- [ ] S3連携（音声ファイル保存）

#### Phase 2: プロバイダー統合（1-2週間）
- [ ] `src/utils/personaplex.ts` 作成
- [ ] `audio-generation.ts` に provider='personaplex' 追加
- [ ] `GET /api/tts/voices` に PersonaPlex 声一覧追加
- [ ] `voice_prompts` テーブルマイグレーション
- [ ] フロントエンド: 声選択UIに PersonaPlex タブ追加

#### Phase 3: 丸投げチャット統合（1週間）
- [ ] `mcLoadVoices()` に personaplex プロバイダー追加
- [ ] voice prompt 選択UI
- [ ] `bulk-audio.ts` の resolveVoice に personaplex 対応追加

### 3.7 コスト試算

| 項目 | 月額コスト |
|------|-----------|
| AWS EC2 g5.2xlarge (A10G) | ~$1,200/月（常時稼働）、~$400/月（オンデマンド） |
| S3 + CloudFront | ~$50/月 |
| Google TTS (現行) | ~$4-16/10万文字 |
| ElevenLabs (現行) | $22-99/月（プラン依存） |
| Fish Audio (現行) | ~$15/月 |

### 3.8 現実的な推奨

**PersonaPlex-7B は現時点では MARUMUVI への統合を保留すべき。理由:**

1. **英語のみ対応** — MARUMUVIのユーザーは日本語コンテンツが主
2. **S2S モデル** — 純粋なTTSモデルではなく、TTSとして使うには非効率
3. **インフラコスト** — 月$400-1,200の追加コスト（既存TTS比で10-50倍）
4. **品質の不確実性** — 日本語でのフィラー・間・敬語トーンの再現は未検証

**代わりに、次の優先順位でTTS品質を改善すべき:**

1. **Fish Audio Speech 1.6 の活用強化** — 既に統合済み、reference_id でカスタム声作成可能、日本語良好
2. **ElevenLabs の声拡充** — Multilingual v2 は日本語対応、カスタムボイスクローン可能
3. **NVIDIA NIM (Riva TTS)** — クラウドAPI として利用可能、日本語TTS対応、GPUデプロイ不要
4. **PersonaPlex-7B** — 日本語ファインチューニング版リリース後に再検討

---

## 4. 未実装・保留項目（次のステップ）

### 4.1 即時対応可能（既存SSOT/APIのみ）

| 優先度 | 項目 | 工数 | 説明 |
|--------|------|------|------|
| ★★★ | `/help` コマンドヘルプUI | 0.5日 | 入力欄で `/help` 入力時にコマンド一覧表示 |
| ★★★ | キャラ別ボイスUI（段階的） | 1-2日 | 丸投げチャット内でキャラごとの voice_preset_id を選択・変更 |
| ★★☆ | シーン並べ替え | 1日 | ドラッグ&ドロップまたはチャットコマンドで順序変更 |
| ★★☆ | シーン削除/非表示 | 0.5日 | `scenes.is_hidden` を活用 |
| ★☆☆ | ダッキング設定UI | 1日 | BGM音量を声に応じて自動調整 |

### 4.2 インフラ改善

| 優先度 | 項目 | 工数 | 説明 |
|--------|------|------|------|
| ★★★ | presigned URL expires_at カラム追加 | 0.5日 | URLパース方式より堅牢（現在はURLパース方式B で対応中） |
| ★★☆ | video_builds CloudFront 導入 | 2-3日 | Remotion Lambda バケットに CloudFront 追加し、presigned URL問題を根本解決 |
| ★☆☆ | D1 write 最適化 | 1日 | ポーリング毎のUPDATEを条件付きに |

### 4.3 TTS品質改善ロードマップ

| Phase | 内容 | 期間 |
|-------|------|------|
| A (現在) | Google TTS + ElevenLabs + Fish Audio | 稼働中 |
| B | Fish Audio カスタムボイス拡充（reference_id 追加登録） | 1週間 |
| C | ElevenLabs カスタムボイスクローン連携 | 1-2週間 |
| D | NVIDIA NIM Riva TTS 検証・統合 | 2-3週間 |
| E | PersonaPlex-7B 日本語FT版（リリース待ち） | TBD |

---

## 5. 技術スタック早見表

```
Frontend:   Vanilla JS + Tailwind CSS + Font Awesome (CDN)
Backend:    Hono (TypeScript) on Cloudflare Workers
Database:   Cloudflare D1 (SQLite)
Storage:    Cloudflare R2 + AWS S3 + CloudFront
TTS:        Google TTS, ElevenLabs, Fish Audio
Image Gen:  外部API (Flux等)
Video:      Remotion Lambda (AWS)
I2V:        外部API
Hosting:    Cloudflare Pages
CI/CD:      手動デプロイ (wrangler pages deploy)
VCS:        GitHub (matiuskuma2/webapp)
```

---

## 6. 再開手順（次回セッション用）

1. `cd /home/user/webapp && git log --oneline -5` で最新commit確認
2. `npm run build && pm2 start ecosystem.config.cjs` でローカル起動
3. `curl http://localhost:3000/marunage-chat` で動作確認
4. 本ドキュメントの「4. 未実装・保留項目」から作業を選択
5. 実装 → テスト → `git commit` → `npx wrangler pages deploy dist --project-name webapp`

---

## 付録A: 環境変数（音声関連）

```
GOOGLE_TTS_API_KEY      — Google TTS API キー（GEMINI_API_KEY でも可）
ELEVENLABS_API_KEY      — ElevenLabs API キー
FISH_AUDIO_API_TOKEN    — Fish Audio API トークン
ELEVENLABS_DEFAULT_MODEL — デフォルトモデル（eleven_multilingual_v2）
```

## 付録B: ファイル構成（音声関連）

```
src/routes/audio-generation.ts  — 単一音声生成 + voices一覧 (1,243行)
src/routes/bulk-audio.ts        — 一括音声生成 (880行)
src/routes/utterances.ts        — 発話CRUD (987行)
src/utils/fish-audio.ts         — Fish Audio TTS クライアント (133行)
src/utils/elevenlabs.ts         — ElevenLabs TTS クライアント (274行)
public/static/marunage-chat.js  — フロントエンド (4,400行+)
  mcLoadVoices()                  — 声一覧読み込み
  mcSelectVoice()                 — 声選択
  mcRenderVoiceList()             — 声リスト描画
  mcFilterVoices()                — プロバイダーフィルター
```
