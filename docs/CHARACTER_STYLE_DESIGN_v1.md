# キャラクター固定化 & スタイル選択 — 実装計画 v1

> 最終更新: 2026-02-15
> ステータス: 設計完了 / 実装前

---

## 0. 目的

丸投げを「1回通して作るだけ」から **「固定キャラ × 固定スタイル × 可変演出で回せる制作システム」** へ進化させる。

---

## 1. 現状の棚卸し（コードベース精査結果）

### 1-A. 既に存在する DB テーブル（全て migration 済み・本番稼働中のスキーマ）

| テーブル | 行数目安 | 丸投げでの使用状況 | 拡張必要性 |
|---|---|---|---|
| `user_characters` | — | **未使用**（スキーマのみ） | なし |
| `project_character_models` | — | **未使用**（スキーマのみ） | なし |
| `project_character_instances` | — | **未使用**（スキーマのみ） | なし |
| `scene_character_map` | — | **未使用**（スキーマのみ） | なし |
| `scene_character_traits` | — | **未使用**（スキーマのみ） | なし |
| `scene_utterances` | ✅ 使用中 | `role`=narration/dialogue, `character_key` | なし |
| `style_presets` | ✅ 使用中 | 丸投げ開始時にハードコード「インフォグラフィック」 | なし |
| `project_style_settings` | ✅ 使用中 | 上記を保存 | なし |
| `scene_style_settings` | — | **未使用** | なし |
| `world_settings` | — | **未使用**（スキーマのみ） | なし |
| `audio_generations` | ✅ 使用中 | provider/voice_id/text | なし |
| `projects.settings_json` | ✅ 使用中 | `default_narration_voice`, `marunage_mode` | JSON拡張のみ |
| `marunage_runs.config_json` | ✅ 使用中 | narration_voice, output_preset, target_scene_count | JSON拡張のみ |

**結論: ALTER TABLE は一切不要。既存テーブルをそのまま活用できる。**

### 1-B. 既に存在する API（全てルーティング済み・Builder向けに実装済み）

| API | ファイル | 行数 | 丸投げでの使用状況 |
|---|---|---|---|
| `GET /api/settings/user/characters` | settings.ts:534 | CRUD完備 | **未使用** |
| `POST /api/settings/user/characters` | settings.ts:549 | 新規作成 | **未使用** |
| `PUT /api/settings/user/characters/:key` | settings.ts:710 | 更新 | **未使用** |
| `DELETE /api/settings/user/characters/:key` | settings.ts:773 | 削除 | **未使用** |
| `POST /api/settings/user/characters/from-project` | settings.ts:640 | プロジェクト→ライブラリ | **未使用** |
| `GET /api/projects/:id/characters` | character-models.ts:62 | プロジェクト内キャラ一覧 | **未使用** |
| `POST /api/projects/:id/characters/import` | character-models.ts:292 | ライブラリ→プロジェクト | **未使用** |
| `GET /api/projects/:id/characters/library-available` | character-models.ts:19 | 未インポートキャラ一覧 | **未使用** |
| `GET /api/scenes/:id/characters` | scene-characters.ts:17 | シーン内キャラ一覧 | **未使用** |
| `POST /api/scenes/:id/characters` | scene-characters.ts:50 | シーンにキャラ追加(**最大3制約チェック済み**) | **未使用** |
| `GET /api/style-presets` | styles.ts:8 | スタイル一覧 | **未使用**（丸投げはIDハードコード） |
| `GET /api/tts/voices` | audio-generation.ts:942 | **全プロバイダーのボイス一覧** | **未使用** |

**結論: 新規 API は不要。既存 API をフロントエンドから呼ぶだけ。**

### 1-C. 既に存在するユーティリティ

| ユーティリティ | ファイル | 丸投げでの使用状況 |
|---|---|---|
| `composeStyledPrompt()` | image-prompt-builder.ts:41 | ✅ 使用中（テキスト強化のみ） |
| `enhancePromptWithWorldAndCharacters()` | world-character-helper.ts:130 | ✅ 内部的に使用 |
| `getSceneReferenceImages()` | character-reference-helper.ts:79 | ❌ **未使用（重大ギャップ）** |
| `fetchWorldSettings()` | world-character-helper.ts:36 | ✅ 内部的に使用 |
| `fetchSceneCharacters()` | world-character-helper.ts:60 | ✅ 内部的に使用 |
| `resolveVoiceForUtterance()` | bulk-audio.ts:79 | ✅ 使用中（キャラvoice_preset_id優先解決済み） |

### 1-D. ボイス選択肢（全プロバイダー実装済み）

**GET /api/tts/voices が返すボイス一覧（現在の実装）:**

#### Google TTS（8ボイス）
| ID | 名前 | 性別 |
|---|---|---|
| `ja-JP-Standard-A` | Standard A（女性） | female |
| `ja-JP-Standard-B` | Standard B（女性） | female |
| `ja-JP-Standard-C` | Standard C（男性） | male |
| `ja-JP-Standard-D` | Standard D（男性） | male |
| `ja-JP-Wavenet-A` | Wavenet A（女性・自然） | female |
| `ja-JP-Wavenet-B` | Wavenet B（女性・自然） | female |
| `ja-JP-Wavenet-C` | Wavenet C（男性・自然） | male |
| `ja-JP-Wavenet-D` | Wavenet D（男性・自然） | male |

#### ElevenLabs（8ボイス）
| ID | 名前 | 性別 | 特徴 |
|---|---|---|---|
| `el-aria` | Aria（女性・落ち着き） | female | ナレーション向き |
| `el-sarah` | Sarah（女性・優しい） | female | 穏やか |
| `el-charlotte` | Charlotte（女性・明るい） | female | エネルギッシュ |
| `el-lily` | Lily（若い女性） | female | キャラクター向き |
| `el-adam` | Adam（男性・深い） | male | ナレーション向き |
| `el-bill` | Bill（男性・自然） | male | 聞きやすい |
| `el-brian` | Brian（男性・プロ） | male | プロフェッショナル |
| `el-george` | George（男性・落ち着き） | male | 中年男性 |

#### Fish Audio（1ボイス、API TOKEN設定時のみ）
| ID | 名前 | 性別 |
|---|---|---|
| `fish-nanamin` | Nanamin（女性・アニメ） | female |

**voice_id 記法ルール（provider自動判定済み）:**
- `el-xxx` or `elevenlabs:xxx` → ElevenLabs
- `fish-xxx` or `fish:xxx` → Fish Audio
- それ以外 → Google TTS

---

## 2. 現状 vs 拡張の差分マトリクス

### 🔴 変更が必要な箇所

| # | 箇所 | 現状 | 拡張後 | 変更量 | リスク |
|---|---|---|---|---|---|
| **M-1** | `POST /api/marunage/start` の config_json | `{narration_voice, output_preset, target_scene_count}` | `+ characters[], style_preset_id` | JSON拡張 ~30行 | 低 |
| **M-2** | `POST /start` 内部: プロジェクト初期化 | スタイル「インフォグラフィック」ハードコード | 渡された `style_preset_id` を使用 | 1行変更 | 極低 |
| **M-3** | `POST /start` 内部: キャラコピー | なし | `user_characters` → `project_character_models` コピー | ~40行追加 | 低 |
| **M-4** | `POST /start` 内部: settings_json | `{default_narration_voice}` | `+ character_voices{}` | JSON拡張 ~15行 | 低 |
| **M-5** | `marunageFormatStartup()` | キャラ情報なしでformat API呼び出し | format APIにキャラ情報をヒントとして渡す | ~20行追加 | 低 |
| **M-6** | フォーマット完了後: シーンキャラ割り当て | なし | `scene_character_map` INSERT + `scene_utterances` にcharacter_key設定 | ~80行追加 | 中 |
| **M-7** | `generateSingleImage()` in marunage.ts | **参照画像なし**（テキスト強化のみ） | `getSceneReferenceImages()` で参照画像取得 → Gemini API にinlineDataとして渡す | ~30行追加 | 中 |
| **M-8** | 丸投げ開始画面 HTML/JS（index.tsx） | テキスト入力 + ナレーション声 + 出力プリセット | + キャラ選択UI + スタイル選択UI + キャラ別ボイスUI | ~300行追加 | 低（UI専用） |

### 🟢 変更不要な箇所

| 箇所 | 理由 |
|---|---|
| `bulk-audio.ts` の `resolveVoiceForUtterance()` | **既にキャラ別ボイス対応済み**（`project_character_models.voice_preset_id` を優先参照） |
| `composeStyledPrompt()` | **既にキャラ＋世界観テキスト強化済み** |
| `getSceneReferenceImages()` | **既に実装済み**（marunage.tsから呼ぶだけ） |
| `scene_character_map` の最大3制約 | **既にAPI層でチェック済み**（scene-characters.ts:68） |
| `scene_utterances` の dialogue/narration | **既にスキーマ＋ロジック対応済み** |
| DB マイグレーション | **一切不要** |
| 既存 Builder フロー | **一切触らない** |

---

## 3. 実装計画（Phase分割）

### Phase 1: スタイル選択（影響ゼロ・最小変更）

**変更ファイル:** `src/routes/marunage.ts`（1箇所）, `src/index.tsx`（UI）

**バックエンド変更:**
```
POST /start の config_json に style_preset_id を追加（省略時は現行動作＝インフォグラフィック）

// marunage.ts L1514 付近の変更:
// 現在:
const defaultStyle = await c.env.DB.prepare(`
  SELECT id FROM style_presets WHERE name = 'インフォグラフィック' AND is_active = 1 LIMIT 1
`).first()

// 変更後:
const stylePresetId = body.style_preset_id || null
let styleId = stylePresetId
if (!styleId) {
  const defaultStyle = await c.env.DB.prepare(`
    SELECT id FROM style_presets WHERE name = 'インフォグラフィック' AND is_active = 1 LIMIT 1
  `).first()
  styleId = defaultStyle?.id
}
```

**フロントエンド変更:**
- `/marunage` 開始画面に `GET /api/style-presets` を呼んでカード一覧表示
- 選択されたIDを `POST /start` の body に含める

**テスト:**
- `style_preset_id` 省略 → 従来通り「インフォグラフィック」
- `style_preset_id` 指定 → そのスタイルの prefix/suffix が画像に適用される

---

### Phase 2: キャラクター選択（開始前UIのみ）

**変更ファイル:** `src/routes/marunage.ts`（~70行追加）, `src/index.tsx`（UI）

**バックエンド変更（POST /start 内部）:**
```
Step 1: config_json.characters[] を受け取る
  characters: [
    { user_character_id: 5, voice_override: null },
    { user_character_id: 8, voice_override: { provider: "elevenlabs", voice_id: "el-aria" } }
  ]

Step 2: 各 user_character を project_character_models にコピー
  // 既存API: POST /api/projects/:id/characters/import と同じロジック
  for (const char of characters) {
    const uc = await db.prepare('SELECT * FROM user_characters WHERE id = ? AND user_id = ?')
      .bind(char.user_character_id, user.id).first()
    
    await db.prepare(`
      INSERT INTO project_character_models
        (project_id, character_key, character_name, description,
         appearance_description, reference_image_r2_key, reference_image_r2_url,
         voice_preset_id, aliases_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(projectId, uc.character_key, uc.character_name, ...)
  }

Step 3: settings_json に character_voices マップを保存
  settings.character_voices = {
    "taro": { provider: "elevenlabs", voice_id: "el-adam" },
    "hanako": { provider: "google", voice_id: "ja-JP-Wavenet-A" }
  }
  // ※ voice_override が null なら user_characters.voice_preset_id を使用
```

**フロントエンド変更:**
- `/marunage` 開始画面に `GET /api/settings/user/characters` でキャラ一覧取得
- キャラカード表示（画像サムネ + 名前 + チェック + ボイス選択）
- ボイス選択は `GET /api/tts/voices` で全プロバイダー一覧を取得

**依存関係:** なし（Phase 1 と独立して実装可能）

---

### Phase 3: フォーマットAIへのキャラ情報注入

**変更ファイル:** `src/routes/marunage.ts`（marunageFormatStartup内）, `src/routes/formatting.ts`（プロンプト追加）

**変更内容:**
```
1. POST /api/projects/:id/format の body にキャラヒントを追加
   body: {
     split_mode: 'ai',
     target_scene_count: 5,
     character_hints: [
       { key: "taro", name: "太郎", description: "主人公。黒髪の青年。" },
       { key: "hanako", name: "花子", description: "ヒロイン。赤髪の少女。" }
     ]
   }

2. formatting.ts の GPT プロンプトに追加:
   "以下のキャラクターが登場します:
    - 太郎（主人公。黒髪の青年）
    - 花子（ヒロイン。赤髪の少女）
    各シーンのセリフにはキャラクター名を speaker として指定してください。
    ナレーションは N: で記載してください。
    1シーンあたり最大3人のキャラクターが登場できます。"

3. フォーマット結果のパース後に:
   - scene_character_map に INSERT（GPT出力から解析）
   - scene_utterances の dialogue 行に character_key を設定
```

**リスク:** 中（GPT出力の変動あり → バリデーション + フォールバック必要）

---

### Phase 4: 画像生成への参照画像追加（キャラ固定の核心）

**変更ファイル:** `src/routes/marunage.ts`（generateSingleImage / 画像ループ部分）

**現状のギャップ:**
```
// 現在の marunage.ts L726-728:
let prompt = scene.image_prompt
prompt = await composeStyledPrompt(db, projectId, scene.id, prompt)
// ← テキスト強化はされるが、参照画像がGemini APIに渡されていない

// 一方 image-generation.ts L918-925:
const ssotReferenceImages = await getSceneReferenceImages(db, r2, sceneId, 5)
// ← Builder では参照画像をbase64で取得してGemini に渡している
```

**変更内容:**
```
// marunage.ts の画像生成ループ内に追加:
const { getSceneReferenceImages } = await import('../utils/character-reference-helper')
const referenceImages = await getSceneReferenceImages(db, r2, scene.id, 5)

// generateSingleImage() の引数を拡張:
async function generateSingleImage(
  apiKey: string,
  prompt: string,
  aspectRatio: string,
  referenceImages?: ReferenceImage[]  // 追加
)

// Gemini API リクエストの contents を拡張:
contents: [{
  parts: [
    // 参照画像を inlineData として追加
    ...referenceImages.map(img => ({
      inlineData: { mimeType: img.mimeType, data: img.base64Data }
    })),
    { text: enhancedPrompt }
  ]
}]
```

**これが最も重要な変更。** これにより:
- `scene_character_map` にキャラが割り当てられているシーンでは
- そのキャラの `reference_image_r2_url` から R2経由でbase64画像を取得し
- Gemini API にプロンプト＋参照画像として送信
- **キャラの見た目が一貫する**

---

### Phase 5: キャラ別ボイス（変更不要の確認）

**変更不要。** `bulk-audio.ts` の `resolveVoiceForUtterance()` が既に以下の優先順位で処理:

```typescript
// bulk-audio.ts L79-123:
async function resolveVoiceForUtterance(db, utterance, projectSettings) {
  // Priority 1: dialogue + character_key → project_character_models.voice_preset_id
  if (utterance.role === 'dialogue' && utterance.character_key) {
    const character = await db.prepare(`
      SELECT voice_preset_id FROM project_character_models
      WHERE project_id = ? AND character_key = ?
    `).bind(utterance.project_id, utterance.character_key).first()
    
    if (character?.voice_preset_id) {
      // voice_preset_id のプレフィックスでプロバイダー自動判定
      return { provider, voiceId, source: 'character' }
    }
  }
  
  // Priority 2: default_narration_voice from settings_json
  // Priority 3: fallback → Google ja-JP-Neural2-B
}
```

つまり Phase 2 で `project_character_models.voice_preset_id` をセットすれば、
Phase 5 は**自動的に動作する**。追加コード不要。

---

## 4. 影響評価サマリ

### 変更するファイル（全4ファイル）

| ファイル | 行数 | 変更内容 | 変更量 |
|---|---|---|---|
| `src/routes/marunage.ts` | 2613行 | POST /start 拡張 + 画像生成に参照画像追加 | ~120行追加 |
| `src/index.tsx` | ~4700行 | /marunage 開始画面にキャラ/スタイル選択UI | ~300行追加 |
| `src/routes/formatting.ts` | 2247行 | GPTプロンプトにキャラヒント追加 | ~30行追加 |
| 新規マイグレーション | — | **なし** | 0 |

### 変更しないファイル（影響ゼロ）

- `src/routes/bulk-audio.ts` — ボイス解決済み
- `src/routes/audio-generation.ts` — TTS生成済み
- `src/routes/character-models.ts` — CRUD済み
- `src/routes/scene-characters.ts` — 最大3制約済み
- `src/routes/settings.ts` — ユーザーキャラCRUD済み
- `src/routes/styles.ts` — スタイル一覧済み
- `src/utils/character-reference-helper.ts` — 参照画像取得済み
- `src/utils/world-character-helper.ts` — テキスト強化済み
- `src/utils/image-prompt-builder.ts` — スタイル合成済み
- `src/utils/elevenlabs.ts` — ElevenLabs TTS済み
- 全マイグレーションファイル — 変更なし

---

## 5. 確定仕様（決定事項）

| 項目 | 決定 |
|---|---|
| シーン内キャラ上限 | **最大3名/シーン**（画像＋dialogue共通） |
| ナレーション行 | **無制限** |
| dialogue行（セリフ数） | **無制限**（ただし speaker は3名以内） |
| 台本タグ | **ユーザー不要**（フォーマットAIが自動構造化） |
| キャラ選択タイミング | **丸投げ開始前**（run進行中は変更不可） |
| スタイル選択タイミング | **丸投げ開始前** |
| キャラ例外（妖精→人間） | **v1は非対応**（将来 scene_character_traits で対応可能） |
| ボイス選択肢 | **全プロバイダー**（Google 8 + ElevenLabs 8 + Fish 1 = 17ボイス） |
| キャラ途中追加 | **v1は非対応**（開始前に選択したキャラで固定） |
| DB マイグレーション | **なし** |
| 既存APIの破壊的変更 | **なし** |

---

## 6. 未決事項（将来Phase）

| 項目 | 優先度 | Phase |
|---|---|---|
| キャラ登録UIの改善（画像アップロード付き） | 中 | Phase 2+ |
| シーン単位でのキャラ入れ替えUI | 低 | Phase 6 |
| scene_character_traits（C層: 例外状態） | 低 | Phase 6 |
| 左ボードにCharactersセクション追加 | 中 | Phase 3+ |
| フォルダ整理（/marunage/folders） | 低 | 別チケット |
| ボイスプレビュー（試聴） | 中 | Phase 2+ |
| カスタムボイスクローニング | 低 | 将来 |
