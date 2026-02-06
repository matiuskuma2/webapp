# SSOT_ONEPAGER.md  
## RILARC / Marumuviai 動画生成システム ― 全体SSOT 1枚図

---

## 0. 基本原則（これを破ったら設計事故）

1. **Remotion / Veo は DB を直接見ない**
   - 入力は **project.json のみ**
2. **DB は「生成物の真実」**
   - 履歴 / active / 失敗理由 / 再実行可否
3. **UI は状態表示だけ**
   - 判定・分岐ロジックを持たない
4. **Silent Fallback 禁止**
   - 素材が無いなら「赤エラー」で止める

---

## 1. 視覚素材 SSOT（Scene Visual）

**SSOTキー：`scenes.display_asset_type`**

| display_asset_type | 参照テーブル | 採用条件（active） | project.json |
|---|---|---|---|
| image | image_generations | is_active=1 | assets.image.url |
| comic | image_generations (asset_type='comic') | is_active=1 | assets.image.url |
| video | video_generations | is_active=1 & status=completed | assets.video_clip.url |

### 重要ルール
- 画像と動画が両方存在しても **display_asset_type が全て**
- 同一シーンで image + video を同時使用しない

---

## 2. 音声 SSOT（Utterance単位）

### 2.1 生成単位
**SSOT：`scene_utterances.audio_generation_id → audio_generations.id`**

- **1 utterance = 1 audio_generation**
- completed があれば **再利用（skipped=true）**
- 409エラーは **同一utteranceが generating のときのみ**

---

### 2.2 声の決定 SSOT（固定優先順位）

**SSOTキー**
- キャラ声：`project_character_models.voice_preset_id`
- ナレーション：`projects.settings_json.default_narration_voice`

**優先順位**
1. dialogue + character_key → キャラ声
2. narration → project default narration
3. fallback（安全デフォルト）

---

## 3. 一括音声生成 SSOT（Job制御）

**SSOT：`project_audio_jobs`**

- 開始：`POST /projects/:id/audio/bulk-generate`
- 進捗：`GET /projects/:id/audio/bulk-status`
- 再実行：mode=missing（冪等）

### 安全設計
- Worker制限で途中停止しても **再実行可能**
- 完了条件：
  - completed or skipped が対象数に一致

---

## 4. シーン尺 SSOT（Video Build）

**最終SSOT：`project.json.scenes[].timing.duration_ms`**

### 計算ルール（固定）
1. display_asset_type=video & active_video.duration_sec
2. utterances 合計 + padding
3. duration_override_ms
4. 推定（テキスト）
5. default

➡ **原則 `max(voiceDurationMs, videoDurationMs)`**

---

## 5. BGM / SFX SSOT

### 5.1 プロジェクト全体BGM
**SSOT：`project_audio_tracks(track_type='bgm', is_active=1)`**

### 5.2 シーン別BGM
**SSOT：`scene_audio_assignments(audio_type='bgm', is_active=1)`**

- シーン別がある場合は **プロジェクトBGMより優先**
- ループは原則OFF

### 5.3 SFX
**SSOT：`scene_audio_assignments(audio_type='sfx')`**
- 複数可

---

## 6. カメラワーク（Motion）SSOT

**SSOT：`scene_motion.preset → project.json.scenes[].motion`**

### 重要ルール
- Remotion側でランダム禁止
- `auto` の場合：
  - buildProjectJson で **seed固定 → chosen確定**
  - Remotionは chosen を描画するだけ

---

## 7. 動画生成（Veo）SSOT

**SSOT：`video_generations`**

### 操作
- プロンプト保存のみ：
  - `PUT /video-generations/:id/prompt`
- 再生成：
  - `POST /scenes/:id/video-regenerate`
  - **新レコード作成**
  - 成功時のみ is_active 切替

### 事故防止
- 失敗時は既存activeを保持

---

## 8. Preflight SSOT（生成可否の唯一判定）

**SSOT：`preflight.visual_validation.errors[]`**

- 1件でも存在 → `can_generate = false`

### 代表エラー
- VISUAL_VIDEO_MISSING
- VISUAL_IMAGE_MISSING
- VISUAL_COMIC_MISSING
- VISUAL_ASSET_URL_INVALID

➡ UIは **この結果を表示するだけ**

---

## 9. 運用 Gate（最低限）

### Gate-1（DB整合）
- completed + URL null がない
- utterance参照切れがない
- text不一致がない

### Gate-2（Active安全）
- is_active は成功時のみ切替
- 二重生成は同一単位のみブロック

### Gate-3（Preflight絶対）
- UI独自判定禁止
- Silent fallback禁止

---

## 10. このSSOTの使い方

- 新規実装 / 修正時に必ず確認：
  - **「このSSOTを壊していないか？」**
- PRテンプレに以下を追加推奨：

```text
☑ この変更は SSOT_ONEPAGER.md に反していない
☑ Silent fallback を新たに導入していない
☑ is_active 切替は成功時のみ
```

---

## 関連ドキュメント

- [AUDIO_BULK_SSOT_SPEC.md](./AUDIO_BULK_SSOT_SPEC.md)
- [VIDEO_GENERATION_SSOT.md](./VIDEO_GENERATION_SSOT.md)
- [MOTION_PRESET_SPEC.md](./MOTION_PRESET_SPEC.md)
- [VIDEO_BUILD_ASSET_SSOT.md](./VIDEO_BUILD_ASSET_SSOT.md)

---

## この1枚が真実。これ以外に「暗黙仕様」を作らない。

---

### 履歴

| 日付 | 変更内容 |
|------|----------|
| 2026-02-06 | 初版作成（Audio/Video/Motion/BGM/Preflight統合） |
