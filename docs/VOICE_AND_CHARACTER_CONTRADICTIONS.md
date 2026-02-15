# 音声利用計画 & キャラクター追加フローの矛盾整理

> **作成日**: 2026-02-15
> **前提**: Ticket A/B/C 完了（commit 4359681, ea6fa69）、設計フリーズ済み
> **目的**: 丸投げ（marunage）に影響を与えずに、音声とキャラクターの設計矛盾を体系的に記録する

---

## 1. 現状のキャラクター追加フロー（As-Is）

### 1.1 キャラクターが「使える」状態になるまでのパイプライン

```
[A] ワールドキャラモーダル（world-character-modal.js）
    │  キャラ作成 = 名前 + 外見 + 音声 + 参照画像（全て必須）
    │  ※ スタイル選択セクション内でキャラを追加する
    ▼
[B] user_characters テーブル（マイキャラ）
    │  POST /api/settings/user/characters
    │  voice_preset_id: "ja-JP-Wavenet-A" | "el-aria" | "fish:71bf4cb7..."
    ▼
[C] 丸投げチャット左ボード（marunage-chat.js）
    │  GET /api/settings/user/characters → チップ表示
    │  選択（最大3名）→ selectedCharacterIds[]
    ▼
[D] /api/marunage/start（marunage.ts:1592-1652）
    │  user_characters → project_character_models へコピー
    │  voice_preset_id も一緒にコピー
    ▼
[E] formatting.ts → character_hints → GPTプロンプト注入
    ▼
[F] dialogue-parser.ts → scene_utterances（3名制限ガード）
    ▼
[G] audio-generation.ts → voice_preset_id → プロバイダ判定 → TTS生成
```

### 1.2 キャラクター追加の唯一の入口

| 入口 | 場所 | 説明 |
|------|------|------|
| ワールドキャラモーダル | `world-character-modal.js` | スタイル新規作成画面から呼び出し |
| プロジェクトからの逆保存 | `character-models.ts: /save-to-library` | PCM → user_characters へ |
| プロジェクトへの直接追加 | `character-models.ts: POST /characters` | プロジェクト単位のみ |

**制約**: 「マイキャラ」に追加するには、ワールドキャラモーダル経由でスタイル作成時に行うか、プロジェクトから逆保存する必要がある。**Settings画面から直接追加するUIは存在しない。**

---

## 2. 音声プロバイダの現状マッピング

### 2.1 プロバイダ一覧と利用条件

| プロバイダ | 環境変数 | voice_preset_id 形式 | 丸投げナレーション | キャラ個別音声 | 利用条件 |
|-----------|----------|---------------------|------------------|-------------|---------|
| Google TTS | `GOOGLE_TTS_API_KEY` or `GEMINI_API_KEY` | `ja-JP-Standard-A` 等 | **使える** | **使える** | APIキーのみ |
| ElevenLabs | `ELEVENLABS_API_KEY` | `el-aria` / `elevenlabs:xxx` | **使える** | **使える** | APIキーのみ |
| Fish Audio | `FISH_AUDIO_API_TOKEN` | `fish:reference_id` / `fish-nanamin` | **選べるが矛盾あり** | **使える（条件付き）** | APIトークン + reference_id |

### 2.2 音声の用途別フロー

```
┌─────────────────────────────────────────────────────────────┐
│ ナレーション音声（プロジェクト全体のデフォルト）              │
│                                                               │
│ 丸投げ左ボード Voice セクション                               │
│   ↓ mcLoadVoices() → GET /api/tts/voices                    │
│   ↓ Google / ElevenLabs / Fish タブ切り替え                  │
│   ↓ MC.selectedVoice = { provider, voice_id }               │
│   ↓ /api/marunage/start body.narration_voice                │
│   ↓ settings_json.default_narration_voice                    │
│                                                               │
│ ※ Fish は voice_id = "fish-nanamin" のみ（プリセット1個）    │
│ ※ カスタム Fish ID を入力するUIは丸投げボードにない           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ キャラクター個別音声（キャラごとのセリフ用）                  │
│                                                               │
│ ワールドキャラモーダル（world-character-modal.js）            │
│   ↓ Preset タブ: Google TTS / ElevenLabs のセレクト          │
│   ↓ Fish タブ: テキスト入力 → fish:${fishId} 形式に変換     │
│   ↓ user_characters.voice_preset_id に保存                   │
│   ↓ /start でコピー → project_character_models.voice_preset_id │
│   ↓ audio-generation.ts が voice_preset_id から provider 判定 │
│                                                               │
│ ※ Fish ID を自由に入力できる（モーダルに入力欄あり）         │
│ ※ ただしキャラ作成がスタイル新規作成に紐づいている           │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 矛盾・不整合の一覧

### 矛盾 #1: Fish Audio ナレーション選択の非対称性

| 項目 | 状態 |
|------|------|
| **問題** | 丸投げ左ボードの Voice セクションで Fish Audio が選択可能だが、選択肢は「fish-nanamin」の1プリセットのみ。カスタム Fish ID を入力する手段がない |
| **一方** | キャラクター作成時のワールドキャラモーダルでは、Fish Audio の任意の reference_id を入力できる |
| **矛盾** | ナレーション = 固定プリセットのみ、キャラ = 自由入力。同じプロバイダなのにUXが異なる |
| **影響** | 丸投げでは Fish ナレーションの活用がほぼ不可能（nanamin以外使えない） |
| **関連コード** | `audio-generation.ts:968-970`（fishVoices は FISH_AUDIO_API_TOKEN 存在時に nanamin のみ返す） |

### 矛盾 #2: キャラクター追加がスタイル作成に依存

| 項目 | 状態 |
|------|------|
| **問題** | 「マイキャラ」に新規追加するには、ワールドキャラモーダルを開く必要があるが、これはスタイル設定画面からのみアクセス可能 |
| **一方** | 丸投げ左ボードの Characters セクションには「マイキャラ」の一覧が表示されるが、追加リンクは存在しない |
| **矛盾** | キャラを使いたい → スタイルを新規作成する必要がある → スタイル作成はキャラ追加とは別の概念 |
| **影響** | 初回ユーザーがキャラを登録する導線が不明瞭。「丸投げ」の UX 目標（何も考えずに完成させる）と相反 |
| **関連コード** | `marunage-chat.js:1635-1663`（mcLoadUserCharacters は GET /api/settings/user/characters を読むだけ） |

### 矛盾 #3: Fish Audio の「利用可能」判定基準の不統一

| 項目 | 状態 |
|------|------|
| **問題** | `/api/tts/voices` は `FISH_AUDIO_API_TOKEN` の有無でプリセットを返す/返さないを切り替える |
| **一方** | キャラの voice_preset_id に `fish:xxx` を書き込むのは token の有無に関係なく可能 |
| **矛盾** | キャラに Fish 音声を設定しても、FISH_AUDIO_API_TOKEN が未設定なら TTS 生成時に `Error: FISH_AUDIO_API_TOKEN is not configured` で失敗する。しかしキャラ登録時にはバリデーションされない |
| **影響** | キャラ登録 → 丸投げ実行 → 音声生成で初めて失敗。エラーが遅延する |
| **関連コード** | `audio-generation.ts:216-217`（生成時に初めてチェック）、`settings.ts:593-608`（登録時はチェックなし） |

### 矛盾 #4: 丸投げボード/シーンエディタから Fish キャラを追加できない

| 項目 | 状態 |
|------|------|
| **問題** | 丸投げの左ボードやプロジェクトのシーンエディタには、キャラクターの音声を変更するUIがない |
| **一方** | ワールドキャラモーダルには Preset/Fish の切り替えタブがあり、Fish ID を入力できる |
| **矛盾** | 丸投げフローの中で Fish キャラを作成・変更する手段がない。事前にワールドキャラモーダルでの設定が必須 |
| **影響** | 丸投げ中に「この声を変えたい」が不可能 |
| **関連コード** | `marunage-chat.js` に voice_preset_id 編集UIなし |

### 矛盾 #5: ナレーション音声のフォールバック順序に Fish が不完全

| 項目 | 状態 |
|------|------|
| **問題** | `audio-generation.ts` の voice 解決は character → project_default → fallback(Google) の3段階 |
| **一方** | `fish-nanamin` を選択した場合の voice_id はプリセット名のまま保存される（`fish-nanamin`） |
| **矛盾** | `getFishReferenceId()` でプリセット名 → reference_id への変換が行われるが、VOICE_PRESETS に登録されたプリセットしか対応しない。カスタム Fish ID（`fish:xxx`）はハンドリングされる |
| **影響** | プリセット追加が VOICE_PRESETS 定数のハードコードに依存。動的追加不可 |
| **関連コード** | `audio-generation.ts:542-574`（VOICE_PRESETS と getFishReferenceId） |

---

## 4. 丸投げへの影響評価

| 矛盾# | 丸投げに影響あり？ | 理由 |
|--------|-------------------|------|
| #1 | **低** | ナレーションは Google/ElevenLabs で十分。Fish プリセットは「おまけ」レベル |
| #2 | **中** | 初回ユーザーのキャラ登録導線が不明瞭だが、丸投げ自体はキャラなしでも動作する |
| #3 | **高** | キャラに Fish を設定して丸投げすると音声生成フェーズで失敗する可能性 |
| #4 | **低** | 丸投げはロック状態のため、途中変更は元々想定外 |
| #5 | **低** | 現状 nanamin 1つしかないため実害は限定的 |

---

## 5. 推奨対応方針（優先度順）

### P1: Fish 音声の事前バリデーション（矛盾 #3 対策）

```
タイミング: /api/marunage/start 実行時
対策: selected_character_ids のキャラに fish: プリセットが含まれ、
      かつ FISH_AUDIO_API_TOKEN が未設定なら、警告を返す
影響: marunage.ts に 10行程度の追加
リスク: ゼロ（エラー応答の追加のみ）
```

### P2: 丸投げボードへのキャラ追加導線（矛盾 #2 対策）

```
タイミング: v2 以降
対策: 左ボード Characters セクションに
      「+ キャラ追加」リンク → Settings画面のキャラ管理へ遷移
      または簡易キャラ追加モーダルを実装
影響: marunage-chat.js + index.tsx に UI追加
リスク: 低（UIのみの変更）
```

### P3: Fish ナレーション選択の拡張（矛盾 #1 対策）

```
タイミング: v2 以降
対策A: /api/tts/voices に「カスタム Fish ID」入力欄を追加
対策B: user_characters の Fish キャラから声をインポートする機能
影響: audio-generation.ts + marunage-chat.js
リスク: 低（ナレーション声の選択肢拡張のみ）
```

### P4: VOICE_PRESETS の動的化（矛盾 #5 対策）

```
タイミング: v3 以降
対策: VOICE_PRESETS を DB（user_voice_presets テーブル等）に移行
影響: 新テーブル + audio-generation.ts リファクタ
リスク: 中（テーブル追加、マイグレーション必要）
```

---

## 6. 音声利用の設計マトリクス（整理済み）

```
                     ┌──────────────────────────────────────────┐
                     │         音声の流れ（設計マトリクス）       │
                     ├──────────┬────────────┬─────────────────-┤
                     │ 設定場所 │ 保存先      │ 利用タイミング    │
  ┌──────────────────┼──────────┼────────────┼─────────────────-┤
  │ ナレーション声   │ 丸投げ   │ settings_  │ character_key    │
  │ (プロジェクト    │ 左ボード │ json.      │ = NULL の発話時  │
  │  デフォルト)     │ Voice    │ default_   │ に自動適用       │
  │                  │ セクション│ narration_ │                  │
  │                  │          │ voice      │                  │
  ├──────────────────┼──────────┼────────────┼─────────────────-┤
  │ キャラ個別声     │ ワールド │ user_      │ character_key    │
  │ (キャラごと)     │ キャラ   │ characters.│ が一致する発話時 │
  │                  │ モーダル │ voice_     │ に適用           │
  │                  │          │ preset_id  │                  │
  ├──────────────────┼──────────┼────────────┼─────────────────-┤
  │ フォールバック   │ なし     │ ハードコード│ 上記2つとも未設定 │
  │ (最終手段)       │ (自動)   │ Google     │ 時に適用         │
  │                  │          │ Neural2-B  │                  │
  └──────────────────┴──────────┴────────────┴─────────────────-┘
```

### 音声解決の優先順位（audio-generation.ts）

```
1. フロントからの明示的 voice_id
2. scene_utterances.character_key → project_character_models.voice_preset_id
3. settings_json.default_narration_voice（ナレーション声）
4. ハードコード: Google ja-JP-Neural2-B
```

---

## 7. 「丸投げに影響を与えない」ための原則

1. **P1 のみ即座対応可能** — `/start` 時のバリデーション追加（FISH_AUDIO_API_TOKEN チェック）
2. **P2〜P4 は v2 以降** — UI変更や新テーブルが伴うため、丸投げの動作に影響しない
3. **現状の安全策**:
   - Ticket A の 3キャラ制限ガード（formatting.ts + dialogue-parser.ts）
   - character_key=NULL → ナレーション声フォールバック（audio-generation.ts:168-180）
   - Fish API Token 未設定時の明示的エラー（audio-generation.ts:216-217）

---

## 8. 参照ファイル一覧

| ファイル | 役割 |
|---------|------|
| `src/routes/audio-generation.ts` | TTS生成 + `/api/tts/voices` SSOT + Fish/Google/EL プロバイダ分岐 |
| `src/routes/marunage.ts` | `/start` パイプライン + `/status` API + narration_voice 保存 |
| `src/routes/settings.ts` | user_characters CRUD（マイキャラ管理） |
| `src/routes/character-models.ts` | project_character_models CRUD + ライブラリインポート |
| `src/routes/utterances.ts` | 個別 utterance TTS 生成（Fish 含む） |
| `src/routes/bulk-audio.ts` | 一括 TTS 生成（Fish 含む） |
| `public/static/marunage-chat.js` | 丸投げ左ボードUI（Voice 選択 + キャラ選択） |
| `public/static/world-character-modal.js` | キャラ追加モーダル（Fish ID 入力 + Preset 選択） |
| `public/static/world-character-ui.js` | キャラ一覧表示（voice_preset_id 表示） |
| `src/routes/formatting.ts` | GPT プロンプト注入（character_hints + 3名制限指示） |
| `src/utils/dialogue-parser.ts` | 台本パース + 3キャラ上限ガード |
| `docs/MARUNAGE_ABC_SPEC_v1.md` | 設計フリーズ仕様（Ticket A/B/C） |
