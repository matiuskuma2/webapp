# VIDEO_BUILD_ASSET_SSOT.md

> **目的**
> Video Build において
> 「画像・漫画・生成動画・音声・BGM・SFX・テロップ」
> が **どのルールで選ばれ、どう合成され、どこでエラーになるか** を
> *誰が見ても一意に判断できる* 状態を作る。

---

## 0. 基本原則（最重要）

### 原則 1：SSOT は DB + buildProjectJson

* **UI表示は参考**
* **Video Build の真実は `buildProjectJson()` の出力のみ**

### 原則 2：Silent Fallback 禁止

* 足りない素材を「それっぽく代替」しない
* 必須不足は **preflight 赤エラーで止める**

### 原則 3：1シーン1ビジュアル

* 1シーンに **image / comic / video のどれか1つ**
* 複数存在しても **display_asset_type が絶対**

---

## 1. シーンの視覚素材 SSOT

### 1.1 display_asset_type（唯一の分岐点）

```text
scenes.display_asset_type ∈ {'image', 'comic', 'video'}
```

| 値     | 意味                                         |
| ----- | ------------------------------------------ |
| image | 静止画像（image_generations）                    |
| comic | 漫画画像（image_generations.asset_type='comic'） |
| video | 生成動画（video_generations）                    |

---

### 1.2 素材選択ルール（決定木）

```text
if display_asset_type == 'video':
    use active_video (status='completed', r2_url NOT NULL)
elif display_asset_type == 'comic':
    use active_comic (r2_url NOT NULL)
elif display_asset_type == 'image':
    use active_image (r2_url NOT NULL)
else:
    ERROR
```

**重要**

* 同一シーンに image と video が両方あっても
  → **display_asset_type で決め打ち**
* video が選ばれている場合、**image は完全無視**

---

## 2. preflight 赤エラー仕様（C仕様）

### 2.1 エラーコード一覧（固定）

| code                           | 発生条件（SSOT）                                                                                  | 期待挙動                |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ------------------- |
| `VISUAL_VIDEO_MISSING`         | `display_asset_type='video'` なのに `active_video` が無い / `status!='completed'` / `r2_url null` | **赤**。Video Build不可 |
| `VISUAL_IMAGE_MISSING`         | `display_asset_type='image'` なのに `active_image` が無い / `r2_url null`                         | **赤**。Video Build不可 |
| `VISUAL_COMIC_MISSING`         | `display_asset_type='comic'` なのに `active_comic` が無い / `r2_url null`                         | **赤**。Video Build不可 |
| `VISUAL_ASSET_URL_INVALID`     | 選ばれた素材のURLが不正（空、形式不正）                                                                       | **赤**。Video Build不可 |
| `VISUAL_ASSET_URL_FORBIDDEN`   | 素材URLにアクセスできない（403/404/timeout）                                                             | **赤**。Video Build不可 |
| `VISUAL_CONFLICT_BOTH_PRESENT` | `assets.image` と `assets.video_clip` が同時に生成される（設計違反）                                        | **赤**（内部矛盾）。即修正対象   |

→ **1件でもあれば Video Build ボタン無効**

### 2.2 URL到達性検証（D仕様）

preflight エンドポイントでクエリパラメータ `check_reachability=true` を指定すると、
各素材URLの到達性を HEAD リクエストで検証する。

```
GET /api/projects/{projectId}/video-builds/preflight?check_reachability=true
```

- 403/404/timeout の場合は `VISUAL_ASSET_URL_FORBIDDEN` エラー
- Remotion Lambda が素材を取得できない問題を事前に検出

### 2.2 エラー構造（API レスポンス）

```json
{
  "type": "VISUAL_MISSING",
  "code": "VISUAL_VIDEO_MISSING",
  "severity": "error",
  "scene_id": 1705,
  "scene_idx": 4,
  "display_asset_type": "video",
  "message": "シーン4は「動画」表示ですが、生成動画が見つかりません。",
  "action_hint": "Builderで動画を生成して「動画に切替」を押してください。"
}
```

### 2.3 UI文言テンプレ

#### `VISUAL_VIDEO_MISSING`

* **見出し**：`シーン{N}：動画が見つかりません`
* **本文**：`このシーンは「動画」表示ですが、生成動画が未完了/未選択です。`
* **対処**：`Builderで動画を生成して「動画に切替」を押してください。`
* 追加情報（小さく）：`（画像があっても自動で代替しません）`

#### `VISUAL_IMAGE_MISSING`

* **見出し**：`シーン{N}：画像が見つかりません`
* **本文**：`このシーンは「画像」表示ですが、画像が未生成/未選択です。`
* **対処**：`画像を生成して、シーンの表示素材を確認してください。`

#### `VISUAL_COMIC_MISSING`

* **見出し**：`シーン{N}：漫画画像が見つかりません`
* **本文**：`このシーンは「漫画」表示ですが、漫画画像が未生成/未公開です。`
* **対処**：`漫画編集で「公開」を実行してください。`

#### `VISUAL_ASSET_URL_INVALID`

* **見出し**：`シーン{N}：素材URLにアクセスできません`
* **本文**：`素材のURLが不正です（空、形式不正）。`
* **対処**：`素材を再アップロード/再生成してURLを更新してください。`

#### `VISUAL_CONFLICT_BOTH_PRESENT`

* **見出し**：`内部エラー：素材の選択が矛盾しています`
* **本文**：`画像と動画が同時に指定されました。`
* **対処**：`運営に連絡してください（コード: VISUAL_CONFLICT_BOTH_PRESENT）。`

---

## 3. buildProjectJson の最終構造（抜粋）

```json
{
  "scenes": [
    {
      "idx": 4,
      "display_asset_type": "video",
      "timing": {
        "start_ms": 12000,
        "duration_ms": 5000
      },
      "assets": {
        "video_clip": {
          "url": "https://.../video.mp4",
          "duration_ms": 5000
        },
        "image": null
      }
    }
  ]
}
```

### 重要な禁止事項

* ❌ `display_asset_type='video'` なのに `assets.image` を出す
* ❌ video_clip があるのに image を同時に出す

---

## 4. 尺（duration_ms）決定ルール

### 優先順位（上が最優先）

```
1. display_asset_type='video'
   → video_generations.duration_sec * 1000

2. utterances の音声合計
   → Σ(duration_ms) + 500ms

3. duration_override_ms（手動設定）

4. comic_data（後方互換）

5. テキスト推定
   → 文字数 * 300ms

6. デフォルト
   → 5000ms
```

**音声がある場合、短縮は禁止**

* セリフ切れ防止が最優先

---

## 5. 音声レイヤー合成ルール（完全版）

### レイヤー順（下→上）

```
Layer 1: プロジェクト全体BGM
Layer 2: シーン別BGM（あれば上書き）
Layer 3: SFX（複数）
Layer 4: Voice（utterances）
```

### 重要ルール

* シーン別BGMがある場合 → **全体BGMは完全ダック**
* Voice 再生中 → BGM 自動ダッキング
* Voice が尺の SSOT

---

## 6. モーションの扱い

| display_asset_type | motion               |
| ------------------ | -------------------- |
| image              | kenburns_soft（デフォルト） |
| comic              | none                 |
| video              | none（動画自体が動く）        |

---

## 7. テロップ（字幕）SSOT

### 種類

| 種類           | SSOT                                   | 備考    |
| ------------ | -------------------------------------- | ----- |
| Remotionテロップ | projects.settings_json.telops_remotion | 動的描画  |
| 漫画焼き込み       | projects.settings_json.telops_comic    | 画像再生成 |

### 原則

* video / image / comic いずれでも **Remotionテロップは同一ルール**
* comic + baked は **二重表示防止**

---

## 8. 運用ガイド（インシデントを残さない）

### 8.1 "赤"が出た時の一次切り分け（手順固定）

1. **該当シーン番号**（N）を確認
2. **表示素材タイプ**（image/comic/video）を確認（Sceneカードのラベル）
3. Builderで以下を実施

   * video → そのシーンで動画生成 → 「動画に切替」
   * comic → 漫画編集 → 公開（comic画像ができる）
   * image → 画像生成 → is_active が付く（または選択）
4. preflight再実行（自動）→ 赤が消えることを確認

### 8.2 インシデント級（ユーザーで直らない）判定

* `VISUAL_CONFLICT_BOTH_PRESENT`
* `VISUAL_ASSET_URL_INVALID` が **同じ素材で再生成しても再発**
* これらは **SSOT破綻 or CDN/R2/S3ポリシー** の可能性が高い
  → 対応フロー：ログID/scene_id/asset_url を添えて調査

### 8.3 必須ログ（必ず残す）

preflightの返却に含める（サーバログにも出す）：

* `scene_id, scene_idx, display_asset_type`
* `active_image/comic/video` の有無と `status, r2_url`
* `resolved_visual`（最終的に選ぼうとしたもの）
* URLアクセス検証結果（403/404/timeout）

---

## 9. よくある事故と防止策

### ❌ 事故1：動画にしたのに静止画になる

**原因**

* display_asset_type='video' だが buildProjectJson が image を出していた

**防止**

* preflight で `VISUAL_VIDEO_MISSING`
* buildProjectJson に video_clip 分岐を必須実装（2026-02-05対応済み）

---

### ❌ 事故2：素材があるのに build できない

**原因**

* r2_url が 403 / 期限切れ

**防止**

* preflight で URL HEAD チェック（将来実装）
* presigned URL 禁止（公開URLのみ）

---

## 10. 実装者チェックリスト（抜粋）

- [ ] display_asset_type 以外で素材選択していないか
- [ ] image / comic / video の **同時出力がないか**
- [ ] preflight の赤エラーを握り潰していないか
- [ ] duration_ms の計算順が壊れていないか
- [ ] 「たぶん大丈夫」な fallback がないか

---

## 11. API レスポンス形式（preflight）

```json
{
  "ok": false,
  "can_generate": false,
  "validation": {
    "can_generate": false,
    "errors": [
      {
        "type": "VISUAL_MISSING",
        "code": "VISUAL_VIDEO_MISSING",
        "severity": "error",
        "scene_id": 1705,
        "scene_idx": 4,
        "display_asset_type": "video",
        "message": "シーン4：動画が見つかりません - このシーンは「動画」表示ですが、生成動画が未完了/未選択です。",
        "action_hint": "Builderで動画を生成して「動画に切替」を押してください。"
      }
    ],
    "warnings": [...]
  },
  "visual_validation": {
    "is_valid": false,
    "errors": [...],
    "debug_info": [
      {
        "scene_id": 1705,
        "scene_idx": 4,
        "display_asset_type": "video",
        "has_active_image": true,
        "has_active_comic": false,
        "has_active_video": false,
        "video_status": null,
        "resolved_visual": "none"
      }
    ]
  }
}
```

---

## 12. このドキュメントの使い方

* **新機能追加前**：SSOTに反しないか確認
* **障害時**：どのレイヤーで壊れているか切り分け
* **レビュー時**：display_asset_type 起点で必ず追う

---

## 13. 実装ファイル参照

| ファイル | 役割 |
| --- | --- |
| `src/utils/video-build-helpers.ts` | SSOT検証ロジック（validateVisualAssets, selectSceneVisual, buildProjectJson） |
| `src/routes/video-generation.ts` | preflight/POST API エンドポイント |
| `public/static/project-editor.js` | フロントエンドUI（エラー表示） |

---

## 変更履歴

| 日付 | 変更内容 |
| --- | --- |
| 2026-02-05 | D仕様（ログ強化・URL到達性検証）実装完了 |
| 2026-02-05 | VISUAL_ASSET_URL_FORBIDDEN エラーコード追加 |
| 2026-02-05 | buildProjectJson に最終選択ログ・混入検知ログを追加 |
| 2026-02-05 | VIDEO_BUILD_OPERATIONS_RUNBOOK.md 作成 |
| 2026-02-05 | C仕様（赤エラー）実装完了。VISUAL_VIDEO_MISSING等のエラーコード追加 |
| 2026-02-05 | buildProjectJson に video_clip 分岐を追加（静止画化バグ修正） |
| 2026-02-05 | 本ドキュメント作成 |
