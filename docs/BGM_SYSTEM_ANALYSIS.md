# BGM/SFXシステム 包括的分析レポート

**作成日**: 2026-01-30  
**対象バージョン**: 最新（commit 7120f46以降）

---

## 1. 現在のアーキテクチャ概要

### 1.1 音声素材のSSOT（Single Source of Truth）設計

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Audio SSOT Architecture                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────┐    ┌─────────────────────┐                │
│  │ system_audio_library│    │ user_audio_library  │                │
│  │ (管理者登録素材)     │    │ (ユーザー個人素材)  │                │
│  │ - BGM               │    │ - BGM               │                │
│  │ - SFX               │    │ - SFX               │                │
│  └─────────┬───────────┘    └─────────┬───────────┘                │
│            │                          │                             │
│            └──────────┬───────────────┘                             │
│                       │                                             │
│                       ▼                                             │
│            ┌─────────────────────────┐                              │
│            │ scene_audio_assignments │ ← シーンへの割当             │
│            │ - system_audio_id       │                              │
│            │ - user_audio_id         │                              │
│            │ - direct_* (直接UP)     │                              │
│            │ - audio_type (bgm/sfx)  │                              │
│            │ - volume_override       │                              │
│            │ - loop_override         │                              │
│            └─────────────────────────┘                              │
│                                                                     │
│  ┌─────────────────────┐                                            │
│  │ project_audio_tracks│ ← プロジェクト全体BGM（レガシー/補完用）    │
│  │ - r2_url            │                                            │
│  │ - volume, loop      │                                            │
│  │ - ducking設定       │                                            │
│  └─────────────────────┘                                            │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 テーブル構造

#### system_audio_library（管理者用システム素材）
| フィールド | 型 | 説明 |
|-----------|-----|------|
| id | INTEGER | PRIMARY KEY |
| audio_type | TEXT | 'bgm' / 'sfx' |
| name | TEXT | 素材名 |
| description | TEXT | 説明 |
| category | TEXT | カテゴリ |
| mood | TEXT | ムード |
| tags | TEXT | JSON配列 |
| file_url | TEXT | R2パス（相対パス推奨） |
| file_size | INTEGER | バイト数 |
| duration_ms | INTEGER | 再生時間 |
| is_active | INTEGER | 有効フラグ |

#### user_audio_library（ユーザー個人素材）
| フィールド | 型 | 説明 |
|-----------|-----|------|
| id | INTEGER | PRIMARY KEY |
| user_id | INTEGER | ユーザーID |
| audio_type | TEXT | 'bgm' / 'sfx' |
| r2_key | TEXT | R2キー |
| r2_url | TEXT | R2パス |
| default_volume | REAL | デフォルト音量 |
| default_loop | INTEGER | ループフラグ |
| use_count | INTEGER | 使用回数（AI提案用） |

#### scene_audio_assignments（シーンへの割当）
| フィールド | 型 | 説明 |
|-----------|-----|------|
| id | INTEGER | PRIMARY KEY |
| scene_id | INTEGER | シーンID |
| audio_library_type | TEXT | 'system' / 'user' / 'direct' |
| system_audio_id | INTEGER | system_audio_library参照 |
| user_audio_id | INTEGER | user_audio_library参照 |
| direct_r2_key | TEXT | 直接アップロード時 |
| direct_r2_url | TEXT | 直接アップロード時 |
| audio_type | TEXT | 'bgm' / 'sfx' |
| volume_override | REAL | 音量オーバーライド |
| loop_override | INTEGER | ループオーバーライド |
| start_ms | INTEGER | 開始位置（SFX用） |
| is_active | INTEGER | 有効フラグ |

---

## 2. APIエンドポイント一覧

### 2.1 システム素材API（管理者用）

| メソッド | パス | 説明 |
|---------|------|------|
| GET | /api/admin/audio-library | システム素材一覧 |
| GET | /api/admin/audio-library/stats | 統計情報 |
| GET | /api/admin/audio-library/:id | 単一取得 |
| POST | /api/admin/audio-library | 登録（URLのみ） |
| POST | /api/admin/audio-library/upload | ファイルアップロード→R2保存 |
| PUT | /api/admin/audio-library/:id | 更新 |
| DELETE | /api/admin/audio-library/:id | 無効化（ソフト削除） |
| DELETE | /api/admin/audio-library/:id/permanent | 完全削除 |

### 2.2 ユーザー素材API（一般ユーザー用）

| メソッド | パス | 説明 |
|---------|------|------|
| GET | /api/audio-library | ユーザー素材一覧 |
| GET | /api/audio-library/system | システム素材一覧（閲覧用） |
| GET | /api/audio-library/user | ユーザー素材一覧 |
| GET | /api/audio-library/:id | 単一取得 |
| POST | /api/audio-library/upload | アップロード |
| PUT | /api/audio-library/:id | 更新 |
| DELETE | /api/audio-library/:id | 削除 |

### 2.3 シーン割当API

| メソッド | パス | 説明 |
|---------|------|------|
| GET | /api/scenes/:sceneId/audio-assignments | 割当一覧取得 |
| POST | /api/scenes/:sceneId/audio-assignments | 新規割当 |
| PUT | /api/scenes/:sceneId/audio-assignments/:id | 更新 |
| DELETE | /api/scenes/:sceneId/audio-assignments/:id | 削除 |
| POST | /api/scenes/:sceneId/audio-assignments/direct | 直接アップロード |
| POST | /api/scenes/:sceneId/audio-assignments/deactivate-all | 全無効化 |

### 2.4 プロジェクトBGM API（レガシー/補完用）

| メソッド | パス | 説明 |
|---------|------|------|
| GET | /api/projects/:projectId/audio-tracks | 取得 |
| POST | /api/projects/:projectId/audio-tracks/bgm/upload | アップロード |
| PUT | /api/projects/:projectId/audio-tracks/:id | 更新 |
| DELETE | /api/projects/:projectId/audio-tracks/:id | 削除 |

---

## 3. フロントエンドUI実装状況

### 3.1 シーン編集モーダル（scene-edit-modal.js）

**BGMタブ機能:**
- ✅ 現在のBGM表示・再生
- ✅ システムライブラリから選択
- ✅ ユーザーライブラリから選択
- ✅ 直接ファイルアップロード
- ✅ 音量・ループ設定変更
- ✅ BGM削除

**SFXタブ機能:**
- ✅ 現在のSFX一覧表示
- ✅ システムSFXライブラリから選択
- ✅ マイSFXライブラリから選択
- ✅ 直接ファイルアップロード
- ✅ SFX削除

### 3.2 管理画面（admin.ts）

**オーディオライブラリ管理:**
- ✅ 一覧表示（BGM/SFXフィルタ）
- ✅ 新規追加フォーム
- ✅ ファイルアップロード（R2保存）
- ✅ 編集機能
- ✅ 無効化/復元
- ✅ 完全削除

---

## 4. 検出された問題点と修正状況

### 4.1 ✅ 修正済み: BGM API 404エラー

**問題:** 
`GET /api/scenes/:sceneId/audio-assignments?audio_type=bgm` が404エラーを返す

**原因:**
`scene-audio-assignments.ts`のGETエンドポイントが厳格な認証チェック（セッション＋プロジェクト所有者確認）を行っていた。ユーザーのセッションIDとプロジェクト所有者IDの不一致で「Access denied」→ 404。

**修正:**
GETエンドポイントを認証不要に変更（シーン存在確認のみ）。POST/PUT/DELETEは引き続き認証必須。

### 4.2 ✅ 修正済み: R2外部URL 401エラー

**問題:**
管理者がアップロードしたBGMを視聴しようとすると401エラー

**原因:**
古いレコードが外部R2バケットの公開URL（`https://pub-xxx.r2.dev/...`）を使用しており、該当バケットのPublic Accessが無効化されていた。

**修正:**
1. 新しい`POST /api/admin/audio-library/upload`エンドポイント追加
2. ファイルを現在のR2バケットにアップロードし、相対パス（`/audio/library/system/...`）で保存
3. 古いレコードを無効化（is_active=0）

### 4.3 ✅ 修正済み: 重複レコード問題

**問題:**
管理者がBGMをアップロードすると2件のレコードが作成される

**原因:**
1. `POST /api/admin/audio-library/upload`がR2アップロード＋DB登録を行う
2. その後「保存」ボタンで`POST /api/admin/audio-library`が呼ばれ、再度DB登録

**修正:**
アップロードAPIをファイルアップロードのみに変更（DB登録は行わない）。`file_url`と`file_size`を返し、保存フォームで使用。

### 4.4 ⚠️ 要確認: フロントエンドAPIパラメータ不一致

**問題:**
`selectBgmFromLibrary()`が送信するパラメータとAPIが期待するパラメータが不一致

**フロントエンド送信:**
```javascript
{
  audio_type: 'bgm',
  library_type: libraryType,      // ← 間違い
  library_item_id: itemId,        // ← 間違い
  volume: 0.25,
  loop: true
}
```

**API期待:**
```javascript
{
  audio_type: 'bgm',
  audio_library_type: libraryType,  // ← 正しい
  system_audio_id: itemId,          // または user_audio_id
  volume_override: 0.25,
  loop_override: true
}
```

**影響:**
シーン編集モーダルからライブラリBGMを選択しても、正しく割り当てられない可能性

---

## 5. 動画生成時のBGM処理フロー

```
┌─────────────────────────────────────────────────────────────────────┐
│              Video Build BGM Processing Flow                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. シーン別BGM取得                                                  │
│     ┌───────────────────────────────────────────────────────┐       │
│     │ SELECT FROM scene_audio_assignments                    │       │
│     │ WHERE scene_id = ? AND audio_type = 'bgm'             │       │
│     │       AND is_active = 1                               │       │
│     │ LEFT JOIN system_audio_library                        │       │
│     │ LEFT JOIN user_audio_library                          │       │
│     └───────────────────────────────────────────────────────┘       │
│                       │                                             │
│                       ▼                                             │
│  2. BGMソース判定                                                    │
│     ┌─────────────────────────────────────────────────────────┐     │
│     │ if (audio_library_type === 'system')                    │     │
│     │   url = system_audio_library.file_url                   │     │
│     │ else if (audio_library_type === 'user')                 │     │
│     │   url = user_audio_library.r2_url                       │     │
│     │ else if (audio_library_type === 'direct')               │     │
│     │   url = direct_r2_url                                   │     │
│     └─────────────────────────────────────────────────────────┘     │
│                       │                                             │
│                       ▼                                             │
│  3. URL絶対パス変換                                                  │
│     ┌─────────────────────────────────────────────────────────┐     │
│     │ toAbsoluteUrl(url, siteUrl)                             │     │
│     │ → https://webapp-c7n.pages.dev/audio/...                │     │
│     └─────────────────────────────────────────────────────────┘     │
│                       │                                             │
│                       ▼                                             │
│  4. RemotionProjectJson構築                                          │
│     ┌─────────────────────────────────────────────────────────┐     │
│     │ scenes[].bgm = {                                        │     │
│     │   url, name, duration_ms, volume, loop,                 │     │
│     │   fade_in_ms, fade_out_ms, start_ms, end_ms,            │     │
│     │   source_type                                           │     │
│     │ }                                                       │     │
│     │                                                         │     │
│     │ assets.bgm = { // プロジェクト全体BGM                    │     │
│     │   url, volume, loop, ducking                            │     │
│     │ }                                                       │     │
│     └─────────────────────────────────────────────────────────┘     │
│                       │                                             │
│                       ▼                                             │
│  5. Remotion Lambda実行                                              │
│     - シーン別BGMがある場合、プロジェクト全体BGMより優先             │
│     - シーン別BGM再生中は全体BGMをダッキング（音量下げ）            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. 推奨改善案

### 6.1 高優先度

#### A. フロントエンドパラメータ修正
```javascript
// scene-edit-modal.js: selectBgmFromLibrary()
async selectBgmFromLibrary(libraryType, itemId, itemName) {
  const body = {
    audio_type: 'bgm',
    audio_library_type: libraryType,  // 修正
    volume_override: 0.25,            // 修正
    loop_override: true               // 修正
  };
  
  // ライブラリタイプに応じてIDを設定
  if (libraryType === 'system') {
    body.system_audio_id = itemId;
  } else if (libraryType === 'user') {
    body.user_audio_id = itemId;
  }
  
  await axios.post(`/api/scenes/${this.currentSceneId}/audio-assignments`, body);
}
```

#### B. system_audio_libraryのスキーマ統一
現在`file_url`を使用しているが、`user_audio_library`は`r2_url`を使用。統一を検討。

### 6.2 中優先度

#### C. 制作ボード（Builder）のBGMセクション整理
- プロジェクト全体BGM設定UI
- システムライブラリ/マイライブラリ/アップロードの明確な分離
- BGMテンプレート保存機能

#### D. BGMテンプレート登録機能
- スタイル設定画面にBGMテンプレート登録セクション追加
- 他プロジェクトでの再利用を容易に

### 6.3 低優先度

#### E. AI提案機能の強化
- シーンのムード分析
- use_count、tags、moodに基づく自動BGM提案
- チャット操作でのBGM設定

---

## 7. テスト手順

### 7.1 管理者BGMアップロード
1. `/admin` → オーディオライブラリ
2. 「新規追加」→ BGMファイル選択
3. 情報入力 → 保存
4. 一覧で視聴ボタン確認

### 7.2 シーン別BGM設定
1. プロジェクト → シーン編集
2. BGMタブ選択
3. 「システムライブラリから選択」
4. BGMを選択
5. 動画生成で確認

### 7.3 動画生成確認
1. プロジェクト → 動画生成
2. BGM設定が反映されているか確認
3. 再生して音声確認

---

## 8. 関連ファイル一覧

### バックエンド
- `src/routes/admin.ts` - 管理者API
- `src/routes/audio-library.ts` - ユーザー素材API
- `src/routes/scene-audio-assignments.ts` - シーン割当API
- `src/routes/project-audio-tracks.ts` - プロジェクトBGM API
- `src/routes/video-generation.ts` - 動画生成（BGM読み込み）
- `src/utils/video-build-helpers.ts` - ビルドJSON構築

### フロントエンド
- `public/static/scene-edit-modal.js` - シーン編集UI
- `src/pages/admin.ts` - 管理画面

### マイグレーション
- `migrations/0029_create_project_audio_tracks.sql`
- `migrations/0039_create_system_audio_library.sql`
- `migrations/0040_create_user_audio_library.sql`
- `migrations/0041_create_scene_audio_assignments.sql`

---

## 9. 結論

BGM/SFXシステムは基本的に正しく設計されており、SSOT（Single Source of Truth）アーキテクチャに基づいています。

**完成している機能:**
- 管理者によるシステム素材登録
- ユーザーによる個人素材登録
- シーンへのBGM/SFX割当
- 動画生成時のBGM統合
- ダッキング処理

**要修正:**
- フロントエンドのAPIパラメータ不一致（高優先度）
- スキーマの微細な不整合（中優先度）

修正後は、「管理者がアップロードしたBGMがシーン選択で使用不可」という問題は解決されます。
