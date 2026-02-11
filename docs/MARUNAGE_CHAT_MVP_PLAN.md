# 丸投げチャット MVP 設計書

## 1. 現状把握サマリー

### 1.1 データベース構造（46テーブル）

**コアエンティティ:**
```
projects          → 動画プロジェクトのトップレベル
  ├── scenes      → プロジェクト内のシーン（idx順）
  │   ├── scene_utterances        → 発話（音声TTS単位）
  │   ├── scene_character_map     → キャラ割当（シーン⇔キャラ）
  │   ├── scene_audio_assignments → BGM/SFX割当
  │   ├── scene_balloons          → 吹き出し
  │   ├── scene_telops            → テロップ
  │   ├── scene_motion            → モーション設定
  │   ├── image_generations       → AI画像生成結果
  │   ├── audio_generations       → TTS音声生成結果
  │   └── video_generations       → I2V動画生成結果
  ├── project_character_models    → キャラクター定義
  ├── project_audio_tracks        → プロジェクトBGM
  ├── project_style_settings      → スタイル設定
  └── video_builds                → 最終動画レンダリング
```

**サポートテーブル:**
```
users, sessions                    → 認証
system_audio_library               → BGM/SFXプリセット
style_presets                      → スタイルプリセット
runs, text_chunks                  → パース/フォーマット処理
scene_split_settings               → シーン分割設定
```

### 1.2 既存APIフロー（プロジェクト作成方式）

```
Step 1: POST /api/projects               → プロジェクト作成
Step 2: POST /api/projects/:id/format     → シーン分割（preserve/AI）
Step 3: POST /api/projects/:id/characters → キャラクター登録
Step 4: POST /api/projects/:id/generate-images → 一括画像生成
Step 5: POST /api/projects/:id/audio/bulk-generate → 一括音声生成
Step 6: POST /api/projects/:id/video-builds → 最終動画レンダリング
```

**各ステップの詳細:**

| Step | API | 処理内容 | 依存 |
|------|-----|---------|------|
| 1 | POST /projects | title + source_text/audio を保存 | なし |
| 2 | POST /projects/:id/format | テキスト→シーン分割。preserve=改行分割 / ai=GPT-4o整形 | Step 1 |
| 3 | POST /projects/:id/characters | キャラクター名・外見・声を登録 | Step 1 |
| 4 | POST /projects/:id/generate-images | 全シーンの画像をGeminiで生成 | Step 2, 3 |
| 5 | POST /projects/:id/audio/bulk-generate | 全utteranceのTTS音声生成 | Step 2 (utterances) |
| 6 | POST /projects/:id/video-builds | Remotion + AWS Lambda で最終合成 | Step 4, 5 |

### 1.3 SSOT化されたルール

- **音声解決優先順位**: character → project_default → ja-JP-Neural2-B (fallback)
- **シーン分割モード**: `preserve` (原文維持) / `ai` (AI整形) → `projects.split_mode`
- **Patch API**: `patches` route でチャットから動画を修正（dry-run→apply方式）
- **dialogue-parser**: 「キャラ名：セリフ」を自動パースしてutterances生成
- **reset=true**: format時にシーン制作物を全削除、設定は保持

### 1.4 丸投げチャットの現状

- `/marunage-chat` → **工事中ページ**（UIのみ、バックエンドなし）
- 既存の `patches` route はチャットから既存動画を修正する機能（丸投げとは別）
- TOP画面に「丸投げチャット」ボタンあり（工事中ページへ遷移）

---

## 2. MVP「丸投げチャット」の設計

### 2.1 コンセプト

> **テキストを入力してボタンを1回押すだけで、そのままYouTubeにアップできる動画が完成する**

MVP段階では**朗読系ナレーション動画**に特化。

### 2.2 ユーザー体験フロー

```
┌─────────────────────────────────────────────────────────┐
│  丸投げチャット画面                                       │
│                                                         │
│  ┌─────────────────────────┐  ┌───────────────────────┐ │
│  │ チャット（右側）          │  │ ボード（左側）         │ │
│  │                         │  │                       │ │
│  │ [台本テキストを貼付]      │  │ シーン1: ✅画像 ✅音声 │ │
│  │                         │  │ シーン2: 🔄画像 ✅音声 │ │
│  │ > 5シーンに分割しました   │  │ シーン3: ⏳待機       │ │
│  │ > キャラ2体を検出しました │  │ ...                   │ │
│  │ > 画像生成中... (3/5)    │  │                       │ │
│  │ > 音声生成中... (5/5)    │  │ BGM: ✅ ヘビメタ(歌付) │ │
│  │ > BGM選択中...           │  │                       │ │
│  │ > 動画レンダリング中...   │  │ [🎬 動画プレビュー]    │ │
│  │                         │  │ [⬇ ダウンロード]       │ │
│  │ > 完成しました！🎉       │  │                       │ │
│  └─────────────────────────┘  └───────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 2.3 MVP最小スコープ（幹のみ）

**やること:**
1. テキスト入力 → 自動シーン分割
2. キャラクター自動検出 → デフォルト声割当
3. 全シーン画像一括生成（静止画）
4. 全シーン音声一括生成（TTS）
5. BGM自動選択（system_audio_libraryから）
6. 最終動画レンダリング → ダウンロード

**やらないこと（v2以降）:**
- ❌ キャラの顔一致（一貫性）→ 参照画像なしで生成
- ❌ 漫画モード
- ❌ ズーム・パンのモーション細かい制御
- ❌ SFX（効果音）
- ❌ テロップ・吹き出し
- ❌ AI動画（I2V）→ 静止画 + Ken Burns エフェクトで十分
- ❌ チャットでの修正指示（v1は作り直し）
- ❌ 複数BGM切り替え

### 2.4 パイプライン設計（1ボタンで全自動）

```
[テキスト入力] 
    ↓
Step 1: プロジェクト作成
    POST /api/projects { title: "自動生成", source_text, source_type: "text" }
    ↓
Step 2: シーン分割（preserveモード = 改行で分割）
    POST /api/projects/:id/format { split_mode: "preserve", target_scene_count: N }
    ↓ ※ 台本にキャラ名があれば dialogue-parser が自動認識
Step 3: キャラクター自動登録
    → dialogue-parser で検出されたキャラ名を project_character_models に登録
    → デフォルト声を自動割当（Fish Audio or Google TTS）
    ↓
Step 4: 画像一括生成
    POST /api/projects/:id/generate-images
    → 各シーンの image_prompt で Gemini が画像生成
    ↓ ※ 並行して音声も生成可能
Step 5: 音声一括生成
    POST /api/projects/:id/audio/bulk-generate
    → bulk-audio の resolveVoiceForUtterance でキャラ声自動解決
    ↓
Step 6: BGM自動割当
    → system_audio_library から mood=bright の BGM を自動選択
    → project_audio_tracks に登録
    ↓
Step 7: 動画レンダリング
    POST /api/projects/:id/video-builds
    → Remotion + AWS Lambda で最終合成
    ↓
[ダウンロード可能]
```

### 2.5 新規バックエンドAPI

**1つの「オーケストレーションAPI」で全ステップを順次実行:**

```typescript
// POST /api/marunage/generate
// Body: { text: string, title?: string, settings?: { bgm_mood?, voice_style?, scene_count? } }
// Response: { project_id, job_id } → SSEでリアルタイム進捗

// GET /api/marunage/status/:jobId
// Response: { status, current_step, progress_percent, steps: [...] }
```

### 2.6 新規フロントエンド

**ページ**: `/marunage-chat` (既存の工事中ページを置き換え)

**レイアウト**: 2カラム
- **左**: ボード（シーンの進捗一覧 + プレビュー）
- **右**: チャット（テキスト入力 + ステータスメッセージ）

**UIステート:**
```
idle        → テキスト入力待ち
processing  → パイプライン実行中（各ステップの進捗表示）
completed   → 完成（プレビュー + ダウンロード）
error       → エラー表示 + リトライ
```

---

## 3. 実装フェーズ分割

### Phase 0: 基盤準備（1日）
- [ ] `marunage_jobs` テーブル作成（ジョブ管理）
- [ ] `/api/marunage/generate` エンドポイント作成
- [ ] `/api/marunage/status/:jobId` エンドポイント作成

### Phase 1: 幹の体験（2-3日）
- [ ] テキスト入力 → 自動シーン分割 → 自動キャラ登録
- [ ] 画像一括生成（既存API活用）
- [ ] 音声一括生成（既存API活用）
- [ ] BGM自動選択・割当
- [ ] 動画レンダリング起動（既存API活用）
- [ ] チャットUIで進捗表示

### Phase 2: ボードUI（1-2日）
- [ ] 左カラムにシーン進捗カード
- [ ] 画像サムネイル表示
- [ ] 音声再生ボタン
- [ ] 完成動画プレビュー + ダウンロード

### Phase 3: 仕上げ（1日）
- [ ] エラーハンドリング強化
- [ ] リトライ機能
- [ ] 設定オプション（BGMムード選択、声の選択など）

---

## 4. 技術判断

### 4.1 既存APIの再利用 vs 新規

| 機能 | 判断 | 理由 |
|------|------|------|
| プロジェクト作成 | **再利用** | POST /api/projects そのまま |
| シーン分割 | **再利用** | POST /api/projects/:id/format そのまま |
| キャラ登録 | **一部新規** | dialogue-parser + 自動登録ロジック追加 |
| 画像生成 | **再利用** | POST /api/projects/:id/generate-images |
| 音声生成 | **再利用** | POST /api/projects/:id/audio/bulk-generate |
| BGM割当 | **新規** | system_audio_library → project_audio_tracks 自動割当 |
| 動画レンダリング | **再利用** | POST /api/projects/:id/video-builds |
| オーケストレーション | **新規** | 上記を順次呼び出すコントローラー |
| 進捗管理 | **新規** | marunage_jobs テーブル + ポーリングAPI |

### 4.2 シーン分割の選択

**MVP: `preserve` モード固定**
- 理由: ユーザーが台本を貼るので改行位置をそのまま使う
- `target_scene_count` はデフォルト5、テキスト量に応じて自動調整

### 4.3 画像の扱い

**MVP: AI生成静止画 + Ken Burns エフェクト**
- image_prompt は format API が自動生成
- ユーザーの画像アップロードは v2 以降

### 4.4 キャラ声の自動割当

**MVP: dialogue-parser で検出 → デフォルト声**
- 検出されたキャラにはデフォルトの Fish Audio / Google TTS 声を自動割当
- ナレーション部分は `ja-JP-Neural2-B` (デフォルト fallback)

### 4.5 BGM自動選択

**MVP: system_audio_library の先頭BGMを自動割当**
- `mood` は `bright` をデフォルト
- v2 でチャットから「もっと暗い曲にして」等の指示に対応

---

## 5. DB変更（マイグレーション）

### 新テーブル: `marunage_jobs`

```sql
CREATE TABLE marunage_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  
  -- ジョブ状態
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'splitting', 'generating_images', 'generating_audio',
    'assigning_bgm', 'rendering', 'completed', 'failed'
  )),
  
  -- 進捗
  current_step TEXT,
  progress_percent REAL DEFAULT 0,
  progress_message TEXT,
  
  -- 設定（ユーザーが指定可能）
  settings_json TEXT DEFAULT '{}',
  -- { bgm_mood: "bright", voice_style: "natural", scene_count: 5 }
  
  -- 結果
  video_build_id INTEGER,
  download_url TEXT,
  
  -- エラー
  error_message TEXT,
  
  -- タイムスタンプ
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (video_build_id) REFERENCES video_builds(id)
);
```

---

## 6. 依存関係図

```
                     ┌──────────────────────┐
                     │  /marunage-chat UI   │
                     │  (フロントエンド)      │
                     └──────────┬───────────┘
                                │
                     ┌──────────▼───────────┐
                     │  POST /api/marunage/ │
                     │  generate            │
                     │  (オーケストレーター)   │
                     └──────────┬───────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
     ┌────────────┐   ┌────────────────┐  ┌───────────────┐
     │ projects   │   │ formatting     │  │ dialogue-     │
     │ (create)   │   │ (scene split)  │  │ parser        │
     └─────┬──────┘   └──────┬─────────┘  └───────┬───────┘
           │                 │                     │
           │          ┌──────▼─────────┐           │
           │          │ image-         │           │
           │          │ generation     │           │
           │          │ (bulk)         │           │
           │          └──────┬─────────┘           │
           │                 │                     │
           │          ┌──────▼─────────┐    ┌──────▼──────────┐
           │          │ bulk-audio     │    │ character-      │
           │          │ (TTS)          │    │ models (auto)   │
           │          └──────┬─────────┘    └─────────────────┘
           │                 │
           │          ┌──────▼─────────┐
           │          │ project-audio- │
           │          │ tracks (BGM)   │
           │          └──────┬─────────┘
           │                 │
           └────────┬────────┘
                    ▼
           ┌────────────────┐
           │ video-builds   │
           │ (Remotion +    │
           │  AWS Lambda)   │
           └────────┬───────┘
                    ▼
           ┌────────────────┐
           │ ダウンロード    │
           └────────────────┘
```

---

## 7. 開始の推奨手順

1. **このドキュメントをレビュー** → 方向性の合意
2. **Phase 0**: `marunage_jobs` テーブル + オーケストレーションAPI
3. **Phase 1**: 幹の体験を構築（テキスト → 動画完成）
4. **Phase 2**: ボードUIでリアルタイム進捗
5. **Phase 3**: 仕上げ + 設定オプション

**最初の一歩**: Phase 0 のテーブル作成 + `/api/marunage/generate` の空エンドポイント
