# 丸投げチャット — キャラ固定 & 台本正規化 & 左ボード設計 v1

> **ステータス**: 設計フリーズ（2026-02-15）
> **前提**: CHARACTER_STYLE_DESIGN_v2.1 で確定した方針を、実装可能な最小仕様に落としたもの
> **実装への影響**: 既存プロジェクト（Builder）へのゼロインパクトを保証

---

## 目的

1. 丸投げ開始前に選んだキャラ（最大3名）を、全シーンを通して固定キャラとして扱う
2. GPT出力が崩れても落とさず、scene_utterances / scene_character_map を確実に生成する
3. ユーザーはタグを一切書かない（貼るだけ）
4. 左ボードで「設定→固定→検収」の一本道を可視化する

## 非機能要件（ゼロインパクト保証）

- 新規マイグレーション: **0**
- ALTER TABLE: **0**
- 新規APIエンドポイント: **0**
- 既存Builder UIへの影響: **ゼロ**
- X-Execution-Context=marunage 時のみ追加動作

## フリーズ条件（3つ）

| # | 決定事項 | 根拠 |
|---|---------|------|
| 1 | 3名超の扱い → **黙ってナレーション矯正** | 丸投げUX最優先、v2で確認UIを追加可能 |
| 2 | dialogue + character_key=NULL → **ナレーション声へフォールバック** | 音声生成を止めない |
| 3 | 責務分界 → **formatting=努力義務 / parser=最後の砦** | 2段構えで安全性を担保 |

---

# A) 台本タグ仕様 v1（内部正規化）

## A-0. 用語（内部タグ = 正規化の"結果"）

ユーザー入力には出さない。内部表現としてのみ使う。

- `NARRATION(text)` = `role='narration', character_key=NULL`
- `DIALOGUE(character_key, text)` = `role='dialogue', character_key=...`
- `SCENE_META(optional)` = シーンの付帯情報（v1では保持のみ、生成に必須ではない）

## A-1. 正規化の入力（As-Is）

- formatting.ts が `scenes.dialogue` を生成（行テキスト）
- dialogue-parser.ts が `^([^：:]+)[：:]\s*(.+)$` を会話判定に利用

## A-2. v1で許可する台本行の最小パターン

### 会話行（Dialogue line）

- 形式: `<speaker>：<utterance>` または `<speaker>: <utterance>`
- 例: `太郎：今日はいい天気だね`
- → speaker を character_name/aliases/character_key で解決して character_key を確定
- → `DIALOGUE(character_key, utterance)` に正規化

### ナレーション行（Narration line）

- 形式: 上記の会話形式に一致しない行は **すべてナレーション扱い**
- 例: `朝の森に光が差し込む。`
- → `NARRATION(text)` に正規化

## A-3. speaker解決（優先順位 = As-Is踏襲）

| Pass | 方式 | 例 |
|------|------|-----|
| 1 | character_name 完全一致 | 「太郎」= PCM.character_name「太郎」 |
| 1 | aliases 完全一致 | 「タロー」= PCM.aliases_json["タロー"] |
| 1 | character_key 完全一致 | 「taro」= PCM.character_key「taro」 |
| 2 | 部分一致（2文字以上、ひらがな統一、敬称除去） | 「恵さん」⊃「恵」→ OK |

**未解決の場合**: `role='dialogue'`, `character_key=null`（会話として残すが、声はフォールバック）

## A-4. 3キャラ制約（1シーン最大3名）

`scene_utterances(role='dialogue')` の distinct `character_key` を数える。

- **3名以内** → OK
- **4名以上** → 超過分はナレーションに矯正（安全側で落とさない）
  - 超過した speaker行を `NARRATION("<speaker> <utterance>")` に変換
  - v2で「3名超えてます、どうしますか？」のUIを出すオプションが残る

## A-5. 台本矯正の責務分界

### formatting.ts（GPT出力側の強制 = 努力義務）

- marunage + character_hints の場合は、**会話行を必ず `speaker: text` 形式に寄せる指示**
- 1シーン最大3名を明記
- "余計なメタ"や"speaker無し会話"を避ける指示

### dialogue-parser.ts（最後の砦）

- GPTが崩しても落ちないように矯正
- `character_key=NULL` の dialogue は残すが、ボイスはフォールバックへ

## A-6. ボイス割当（v1確定）

| 条件 | ボイスソース |
|------|------------|
| `role='narration'` | `projects.settings_json.default_narration_voice` |
| `role='dialogue'` + character_keyあり | `project_character_models.voice_preset_id` |
| `role='dialogue'` + character_key=NULL | ナレーションボイスへフォールバック |
| 上記すべて不可 | `google:ja-JP-Neural2-B` |

## A-7. 出力（SSOT）

最終的に scene_utterances に落ちていればOK。ユーザーがタグを書く必要はない。

---

# B) 左ボード情報設計 v1

## B-0. 左ボードの役割（v1）

- **開始前**: 選択（キャラ/スタイル/ナレーション）
- **開始後**: 進捗と結果の"検収ボード"（素材→動画）
- チャットは指示・修正の入口、左は"いまの確定状態"の見える化

## B-1. ボード構成（4セクション固定）

1. **Characters**（キャラ）
2. **Style**（スタイル）
3. **Voice**（音声）
4. **Assets**（素材/進捗/成果物）

## B-2. 状態遷移と編集可否

### 編集できる期間

| フェーズ | Characters | Style | Voice | Assets |
|---------|-----------|-------|-------|--------|
| init / formatting / awaiting_ready | **編集可** | **編集可** | **編集可** | 進捗表示 |
| generating_images 以降 | ロック | ロック | ロック | 進捗表示 |

### ロック表示

ロック中は各セクション右上に `🔒 処理中は変更できません` を小さく表示。

## B-3. セクション別UI仕様

### Characters（キャラ）

#### 開始前（選択モード）

- **最大3名**まで選択
- 表示: 横スクロール or 2列グリッド（カード）
  - サムネ（参照画像）
  - 名前
  - 小バッジ（ボイスあり/なし）
  - 選択チェック
- 3名選択済みで4人目タップ → トースト: `最大3名まで`

#### 実行中〜完了（固定表示モード）

- 選択済みキャラを固定表示
- 各キャラに「登場: X/Yシーン」（dialogue-parser結果から集計、薄く表示）

> **v1の重要ポイント**: キャラは「選ぶ」だけ。シーンへの割当は台本正規化（A仕様）で自動。UIでシーンごとのキャラ割当編集はしない。

### Style（スタイル）

#### 開始前

- `style_presets` のカード一覧（名前 + 1行説明）
- 選択は1つ（ラジオ）

#### 実行中〜完了

- 選択されたスタイルを固定表示（変更不可）

### Voice（音声）

#### 開始前

- **ナレーション音声**のみ（v1確定）
- Provider タブ（All/Google/ElevenLabs/Fish）+ 検索 + リスト + 選択中表示
- SSOT: `GET /api/tts/voices`

#### 実行中〜完了

- `ナレーション: {provider}:{voice_id}` を固定表示
- キャラ別はv1ではUIなし（Charactersカードでバッジ表示のみ）

### Assets（素材/進捗/成果物）

#### 進捗（常時）

- 6ステップの極細バー（整形→確認→画像→音声→動画→完了）
- 各ステップの数値: 画像 `done/total`、音声 `done/total`、動画 `state + %`
- 今のフェーズを文字で表示（例: `動画レンダリング中 42%`）

#### シーン一覧（生成後）

- シーンカード（縦並び）
  - サムネ + scene idx + 状態（画像OK/音声OK）
- v1ではシーン編集はしない。検収のみ。

#### 動画（ready以降）

- 動画パネル: pending/running/done/failed
- download_url（doneのみ）
- failed時は原因（短文）を表示

## B-4. 更新タイミング

左ボード更新のSSOTは **status API** だけに寄せる。

| タイミング | データソース |
|-----------|-------------|
| 開始前 Characters | `GET /api/settings/user/characters` |
| 開始前 Style | `GET /api/style-presets` |
| 開始前 Voice | `GET /api/tts/voices` |
| 開始後すべて | `GET /api/marunage/:projectId/status` をポーリング |

## B-5. チャットとの連携（v1）

- 右チャット: 入力→開始→進捗ログ→完了
- 左ボード: 設定→固定→検収
- v1ではチャットでのコマンド編集（キャラ変更/スタイル変更/再生成）はやらない

---

# C) キャラ固定の適用戦略 v1（ルールベース一本道）

## C-0. 目的（v1）

- 丸投げ開始前に選んだキャラを、全シーンを通して固定キャラとして扱う
- 台本（GPT出力）が多少壊れても落とさずに scene_utterances / scene_character_map を生成できる
- 既存プロジェクト機構（Builder）には影響ゼロ

## C-1. SSOT（正の情報源）

| レイヤー | SSOT | 説明 |
|---------|------|------|
| 入力 | `POST /start` の `selected_character_ids[]` | ユーザーが選んだキャラID |
| 生成 | `project_character_models` | プロジェクト内キャラ定義（character_key確定） |
| 運用 | `scene_character_map` | シーンごとのキャラ割当（最大3） |
| 発話 | `scene_utterances` | role / character_key / text |

> v1では "キャラ集合" は start時に確定し、処理中はロック（B仕様）

## C-2. フロー（一本道）

```
Step C-1: 開始前（左ボードで最大3名選択）
    ↓
Step C-2: /start でプロジェクトキャラ確定
    user_characters → project_character_models にコピー
    character_key が確定（固定キャラ集合）
    ↓
Step C-3: formatting.ts（努力義務）
    GPTに固定キャラ集合（character_hints）を渡す
    「キャラ名: セリフ」形式を強く要求
    ↓
Step C-4: dialogue-parser.ts（最後の砦）
    scenes.dialogue を1行ずつ解析 → scene_utterances 作成
    3名制約を確実に守る（超過→ナレーション矯正）
    ↓
Step C-5: scene_character_map を確定
    utterances の dialogue（character_key != null）から
    DISTINCT 3名までを抽出し map にINSERT
    ↓
Step C-6: 画像生成（参照画像でキャラ維持）
    ↓
Step C-7: 音声生成（voice_preset_id or ナレーションフォールバック）
    ↓
Step C-8: 動画合成 → DL
    ↓
Step C-9: 左ボードで検収
```

## C-3. ユーザーの台本指定（v1）

**ユーザーはタグを書かない。** ただし以下は許容（任意、強制ではない）:

- `太郎: 〜〜`（コロン区切り）
- `太郎：〜〜`（全角コロン）
- `「セリフ」`（speaker不明なら narration fallback）
- 地の文（narration）

## C-4. キャラ固定のコア制約（v1）

| 制約 | ルール | フォールバック |
|------|-------|-------------|
| C-1: 1シーン最大3名 | dialogue の distinct character_key が4超 → 4人目以降をナレーション矯正 | テキストからspeaker除去、narration化 |
| C-2: 不明キャラ | dialogue + character_key=NULL | ナレーション声へフォールバック |
| C-3: 見た目維持 | getSceneReferenceImages() で参照画像を投入 | 画像取得失敗時はテキストのみで生成 |

## C-5. ボイス割当（v1 = A-6と同一）

- narration → `projects.settings_json.default_narration_voice`
- dialogue + character_key → `project_character_models.voice_preset_id`
- dialogue + character_key=NULL → ナレーションへフォールバック

> v1は「キャラ別ボイスUI」なし。キャラにvoice_preset_idが無ければナレーション声。

## C-6. 画像でのキャラ維持（v1）

### v1で保証すること

- 固定キャラの参照画像がある場合、参照画像を常に投入して生成（既存の仕組み）
- "見た目のブレ"は最小化される

### v1で保証しないこと（v2以降）

- シーンごとの外見変化（妖精→人間）をUIから制御
- キャラ固有設定（A層/B層/C層）を丸投げ側UIで細かく編集

## C-7. 左ボードでの見え方（B仕様との接続）

- Characters: 固定キャラ3名を表示（編集不可）+ 登場シーン数（薄く）
- Assets: シーンカードに登場キャラ表示（任意、薄く）

---

# 実装チケット

## Ticket A: 台本正規化

| 項目 | 内容 |
|------|------|
| 変更ファイル | `formatting.ts` (~15行), `dialogue-parser.ts` (~20行) |
| 内容 | GPTプロンプト強化（speaker形式厳密化、3名制約明記）+ 3名超→ナレーション矯正ロジック |
| 依存 | なし |
| テスト | character_hints付きformat → utterancesで3名以内確認 |

## Ticket B: 左ボードUI

| 項目 | 内容 |
|------|------|
| 変更ファイル | `index.tsx` (~100行), `marunage-chat.js` (~200行), `styles.css` (~50行), `marunage.ts` status API (~30行) |
| 内容 | 4セクション化、選択UIを右→左移動、進捗/シーンカード/動画パネル表示、ロック表示 |
| 依存 | Ticket A 完了後が理想（表示内容が確定するため） |
| テスト | 開始前の選択→開始後のロック→ready後の検収表示 |

## Ticket C: キャラ固定（追加実装なし）

| 項目 | 内容 |
|------|------|
| 変更ファイル | なし（A+Bの結果で成立） |
| 内容 | A（正規化）+ B（UI）が正しく動けば、C（キャラ固定）は自動的に成立 |
| テスト | 3名選択→格納→formatting→parser→utterances→音声のE2Eテスト |

## 実装順序

```
Ticket A（台本正規化）→ Ticket B（左ボードUI）→ Ticket C（E2Eテスト）
```

---

# v2拡張（設計フリーズ時点の合意）

| 項目 | v1 | v2 |
|------|-----|-----|
| 3名超 | 黙ってナレーション矯正 | 確認UIを追加可能 |
| 例外変身（妖精→人間） | UIなし | **見た目のみ**（scene_character_traits） |
| 声が変わるケース | 別キャラとして登録 | 同上（別character_keyで対応） |
| キャラ別ボイスUI | なし | 左ボードのキャラカードに声編集を追加 |
| チャットコマンド編集 | なし | 再ビルドとセットで追加 |
| voice_policy SSOT | `project_character_models.voice_preset_id` | 同上（UIが更新するだけ） |
