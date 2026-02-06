# 一括音声生成 SSOT仕様書（最終版）

## 概要

本仕様書は、一括音声生成機能のSSOT（Single Source of Truth）を定義します。
DB、API、UI、運用のすべての側面を統一的に記述し、整合性を維持するための指針を提供します。

---

## 1. データベース設計（SSOT）

### 1.1 project_audio_jobs テーブル（マイグレーション 0049）

ジョブの一元管理テーブル。すべてのbulk処理状態はこのテーブルで管理されます。

```sql
CREATE TABLE IF NOT EXISTS project_audio_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  job_type TEXT NOT NULL DEFAULT 'bulk_generate',
  status TEXT NOT NULL DEFAULT 'queued',
  -- queued, running, completed, partial_fail, failed, cancelled
  
  -- ジョブ設定
  target_filter TEXT,  -- 'all', 'missing', 'failed' など
  voice_preset_json TEXT,  -- デフォルトボイス設定
  
  -- 進捗追跡
  total_utterances INTEGER DEFAULT 0,
  processed_utterances INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  skipped_count INTEGER DEFAULT 0,
  
  -- 実行者情報
  started_by_user_id INTEGER,
  
  -- エラー情報
  error_message TEXT,
  error_details_json TEXT,
  
  -- タイムスタンプ
  started_at DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
```

### 1.2 audio_generations テーブル

個別の音声生成記録。`scene_utterances.audio_generation_id` から参照されます。

```sql
-- 重要なカラム
id INTEGER PRIMARY KEY,
scene_id INTEGER,
text TEXT NOT NULL,               -- 生成元テキスト（SSOT: utteranceのtextと一致必須）
voice_preset_json TEXT,           -- 使用したボイス設定
status TEXT NOT NULL,             -- pending, generating, completed, failed
r2_url TEXT,                      -- 完了時は必須
duration_ms INTEGER,
error_message TEXT,               -- 失敗時は必須
```

### 1.3 scene_utterances テーブル

utteranceと音声生成の紐付け。

```sql
-- 重要なカラム
id INTEGER PRIMARY KEY,
scene_id INTEGER NOT NULL,
text TEXT NOT NULL,
audio_generation_id INTEGER,      -- audio_generationsへの参照（SSOT）
voice_preset_json TEXT,           -- 個別ボイス設定（最優先）
```

### 1.4 SSOT整合性ルール

| ルール | 説明 | 検証SQL |
|-------|-----|---------|
| R1 | `completed` の `audio_generations` は `r2_url` 必須 | A-1参照 |
| R2 | `audio_generation_id` が指す `audio_generations` は存在必須 | A-2参照 |
| R3 | `utterance.text` と `audio_generations.text` は一致必須 | A-3参照 |
| R4 | `running` ジョブは30分でtimeout | B-1参照 |

---

## 2. API設計

### 2.1 一括音声生成開始

```
POST /api/projects/:projectId/audio/bulk-generate
```

**リクエスト:**
```json
{
  "target": "all" | "missing" | "failed",
  "voice_preset": {
    "provider": "elevenlabs",
    "voice_id": "xxx",
    "model_id": "eleven_multilingual_v2"
  }
}
```

**レスポンス (201 Created):**
```json
{
  "success": true,
  "job_id": 123,
  "status": "queued",
  "total_utterances": 52,
  "message": "一括音声生成を開始しました"
}
```

**エラーレスポンス:**
```json
{
  "error": {
    "code": "CONCURRENT_LIMIT",
    "message": "別の音声生成が進行中です"
  }
}
```

### 2.2 ジョブステータス確認

```
GET /api/projects/:projectId/audio/bulk-status
```

**レスポンス:**
```json
{
  "success": true,
  "job": {
    "id": 123,
    "status": "running",
    "total_utterances": 52,
    "processed_utterances": 30,
    "success_count": 28,
    "failed_count": 2,
    "skipped_count": 0,
    "progress_percent": 58
  },
  "is_active": true
}
```

### 2.3 ジョブ履歴取得

```
GET /api/projects/:projectId/audio/bulk-history
```

**レスポンス:**
```json
{
  "success": true,
  "jobs": [
    {
      "id": 123,
      "status": "partial_fail",
      "total_utterances": 52,
      "success_count": 50,
      "failed_count": 2,
      "started_at": "2026-02-06T10:00:00Z",
      "completed_at": "2026-02-06T10:05:00Z"
    }
  ],
  "failed_utterances": [
    {
      "utterance_id": 617,
      "scene_idx": 5,
      "text": "TSMC、台湾積体電路製造は...",
      "error_message": "Rate limit exceeded"
    }
  ]
}
```

### 2.4 stuckジョブcleanup（管理者用）

```
GET /api/admin/stuck-audio-jobs
POST /api/admin/cron/cleanup-stuck-audio-jobs
```

---

## 3. 音声決定ロジック（SSOT優先順位）

### 3.1 ボイス選択フロー

```
優先度1: utterance.voice_preset_json (個別設定)
    ↓ nullの場合
優先度2: character.voice_preset_json (キャラクター設定)
    ↓ nullの場合
優先度3: project.settings_json.default_narration_voice (プロジェクトデフォルト)
    ↓ nullの場合
優先度4: システムフォールバック (Tomoko/standard)
```

### 3.2 コード例

```typescript
function resolveVoice(utterance, character, projectSettings): VoicePreset {
  // 1. utterance個別設定
  if (utterance.voice_preset_json) {
    return JSON.parse(utterance.voice_preset_json);
  }
  
  // 2. キャラクター設定
  if (character?.voice_preset_json) {
    return JSON.parse(character.voice_preset_json);
  }
  
  // 3. プロジェクトデフォルト
  if (projectSettings?.default_narration_voice) {
    return projectSettings.default_narration_voice;
  }
  
  // 4. システムフォールバック
  return {
    provider: 'openai',
    voice: 'alloy',
    model: 'tts-1'
  };
}
```

---

## 4. UI/UX設計

### 4.1 進捗表示

```
┌─────────────────────────────────────────────────────┐
│ 一括音声生成中... 58% (30/52)                       │
│ ████████████████████░░░░░░░░░░░░░░░░░░░░           │
│                                                     │
│ ✅ 成功: 28  ❌ 失敗: 2  ⏭️ スキップ: 0           │
│                                                     │
│ 推定残り時間: 約2分                                 │
└─────────────────────────────────────────────────────┘
```

### 4.2 エラー表示

| エラーコード | ユーザー向けメッセージ |
|------------|---------------------|
| `CONCURRENT_LIMIT` | 別の音声生成が進行中です。完了までお待ちください。 |
| `MONTHLY_LIMIT` | 月間の音声生成上限に達しました。 |
| `NO_UTTERANCES` | 生成対象のテキストがありません。 |
| `RATE_LIMIT` | APIのレート制限に達しました。しばらくしてから再試行してください。 |

### 4.3 ポーリング戦略

```javascript
// ポーリング間隔: 5秒
const POLLING_INTERVAL = 5000;

// アクティブステータス
const ACTIVE_STATUSES = ['queued', 'running'];

// ポーリング停止条件
// - ジョブがアクティブでなくなった
// - ユーザーがページを離れた
// - エラーが発生した
```

---

## 5. コスト追跡（api_usage_logs）

### 5.1 記録内容

```json
{
  "api_type": "bulk_audio_generation",
  "provider": "internal",
  "model": "bulk_audio",
  "estimated_cost_usd": 0.15,
  "metadata_json": {
    "job_id": 123,
    "project_id": 126,
    "total": 52,
    "success": 50,
    "failed": 2,
    "skipped": 0,
    "duration_sec": 120,
    "billing_source": "platform"
  }
}
```

### 5.2 コスト計算式

```typescript
// ElevenLabs: $0.30/1000文字
// OpenAI TTS: $0.015/1000文字

function estimateAudioCost(text: string, provider: string): number {
  const charCount = text.length;
  const rate = provider === 'elevenlabs' ? 0.00030 : 0.000015;
  return charCount * rate;
}
```

---

## 6. 運用ガイド

### 6.1 日常運用

1. **ジョブ開始前**: preflightで`utterance_errors`を確認
2. **ジョブ実行中**: bulk-statusで進捗監視
3. **ジョブ完了後**: 失敗があればbulk-historyで詳細確認
4. **定期チェック**: stuck検知とcleanup実行

### 6.2 トラブルシューティング

| 症状 | 原因 | 対応 |
|-----|-----|-----|
| ジョブが30分以上running | stuck | cleanup API実行 |
| 大量の409エラー | 並列制限 | ジョブ完了を待つ |
| preflightで警告が消えない | SSOT不整合 | A-1〜A-3チェック |
| コストログが不一致 | 記録漏れ | api_usage_logs確認 |

### 6.3 緊急対応

```bash
# stuckジョブの強制cleanup
curl -X POST https://webapp-c7n.pages.dev/api/admin/cron/cleanup-stuck-audio-jobs

# 特定ジョブのキャンセル（実装予定）
# curl -X POST https://webapp-c7n.pages.dev/api/projects/126/audio/bulk-cancel
```

---

## 7. 変更履歴

| 日付 | バージョン | 変更内容 |
|-----|----------|---------|
| 2026-02-06 | 1.0 | 初版作成 |
| 2026-02-06 | 1.1 | framesPerLambda対応追加 |

---

## 8. 関連ドキュメント

- [AUDIO_SSOT_CHECKLIST.md](./AUDIO_SSOT_CHECKLIST.md) - チェックリスト
- [AUDIO_STATE_TRANSITIONS.md](./AUDIO_STATE_TRANSITIONS.md) - 状態遷移図
- [TELOP_COMPLETE_REFERENCE.md](./TELOP_COMPLETE_REFERENCE.md) - テロップ仕様

