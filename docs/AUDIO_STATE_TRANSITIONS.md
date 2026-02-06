# 音声生成 状態遷移図

## 概要
音声生成システムの状態遷移を定義し、SSOT（Single Source of Truth）を維持するためのドキュメントです。

---

## 1. project_audio_jobs 状態遷移

```
                                    ┌─────────────┐
                                    │   (開始)    │
                                    └──────┬──────┘
                                           │
                                           ▼
                                    ┌─────────────┐
                                    │   queued    │ ← 初期状態
                                    └──────┬──────┘
                                           │ ジョブ開始
                                           ▼
                                    ┌─────────────┐
                                    │   running   │ ← 処理中
                                    └──────┬──────┘
                                           │
              ┌────────────────────────────┼────────────────────────────┐
              │                            │                            │
              ▼                            ▼                            ▼
       ┌─────────────┐              ┌─────────────┐              ┌─────────────┐
       │  completed  │              │partial_fail │              │   failed    │
       │  (全成功)   │              │ (一部失敗)  │              │  (全失敗)   │
       └─────────────┘              └─────────────┘              └─────────────┘
                                           │
                                           │ 再実行
                                           ▼
                                    ┌─────────────┐
                                    │   queued    │
                                    └─────────────┘
```

### 状態定義

| 状態 | 説明 | 次の状態 |
|-----|-----|---------|
| `queued` | ジョブ作成済み、処理待ち | `running` |
| `running` | 処理中（utteranceを順次処理） | `completed`, `partial_fail`, `failed` |
| `completed` | 全utterance成功 | (終了) |
| `partial_fail` | 一部utterance失敗 | `queued`(再実行時) |
| `failed` | 全utterance失敗、またはシステムエラー | `queued`(再実行時) |

### stuck検知ルール
- `running` 状態が **30分以上** 更新なし → stuck判定
- 対応: `failed` に変更し、cleanup処理を実行

---

## 2. audio_generations 状態遷移

```
                                    ┌─────────────┐
                                    │   (開始)    │
                                    └──────┬──────┘
                                           │
                                           ▼
                                    ┌─────────────┐
                                    │   pending   │ ← 初期状態
                                    └──────┬──────┘
                                           │ TTS API呼び出し
                                           ▼
                                    ┌─────────────┐
                                    │ generating  │ ← API処理中
                                    └──────┬──────┘
                                           │
              ┌────────────────────────────┴────────────────────────────┐
              │                                                         │
              ▼                                                         ▼
       ┌─────────────┐                                           ┌─────────────┐
       │  completed  │                                           │   failed    │
       │ + r2_url    │                                           │+ error_msg  │
       └─────────────┘                                           └─────────────┘
```

### 状態定義

| 状態 | 説明 | r2_url | error_message |
|-----|-----|--------|---------------|
| `pending` | 生成待ち | null | null |
| `generating` | API呼び出し中 | null | null |
| `completed` | 生成完了 | **必須** | null |
| `failed` | 生成失敗 | null | **必須** |

### SSOT整合ルール
1. `completed` の場合、`r2_url` は必ず非null
2. `failed` の場合、`error_message` は必ず非null
3. `scene_utterances.audio_generation_id` が指す `audio_generations` は必ず存在

---

## 3. video_builds 状態遷移

```
                                    ┌─────────────┐
                                    │   (開始)    │
                                    └──────┬──────┘
                                           │
                                           ▼
                                    ┌─────────────┐
                                    │ validating  │ ← 初期状態（素材検証中）
                                    └──────┬──────┘
                                           │ 検証完了
                                           ▼
                                    ┌─────────────┐
                                    │  submitted  │ ← AWS送信完了
                                    └──────┬──────┘
                                           │ Remotion開始
                                           ▼
                                    ┌─────────────┐
                                    │  rendering  │ ← レンダリング中
                                    └──────┬──────┘
                                           │
              ┌────────────────────────────┴────────────────────────────┐
              │                                                         │
              ▼                                                         ▼
       ┌─────────────┐                                           ┌─────────────┐
       │  completed  │                                           │   failed    │
       │+ download   │                                           │+ error_code │
       └─────────────┘                                           └─────────────┘
```

### 状態定義

| 状態 | 説明 | progress_percent | download_url |
|-----|-----|-----------------|--------------|
| `validating` | 素材検証中 | 0 | null |
| `submitted` | AWS送信済み | 0~5 | null |
| `rendering` | Remotionレンダリング中 | 5~99 | null |
| `completed` | 完了 | 100 | **必須** |
| `failed` | 失敗 | any | null |

### render_config保存（Too many functions対策）

`settings_json.render_config` に以下を保存:

```json
{
  "total_frames": 27000,
  "frames_per_lambda": 200,
  "estimated_functions": 135,
  "max_lambda_functions": 190,
  "fps": 30,
  "total_duration_ms": 900000,
  "total_duration_sec": 900
}
```

---

## 4. 音声決定ロジック（SSOT優先順位）

```
┌─────────────────────────────────────────────────────────────────────┐
│                        音声ボイス決定フロー                          │
└─────────────────────────────────────────────────────────────────────┘

    ┌───────────────────┐
    │ utterance.voice   │ ← 1. 最優先: utterance個別設定
    │ (character_voice) │
    └─────────┬─────────┘
              │ nullの場合
              ▼
    ┌───────────────────┐
    │ character.voice   │ ← 2. キャラクター設定
    │ (project_chars)   │
    └─────────┬─────────┘
              │ nullの場合
              ▼
    ┌───────────────────┐
    │ project.default_  │ ← 3. プロジェクトデフォルト
    │ narration_voice   │    (settings_json)
    └─────────┬─────────┘
              │ nullの場合
              ▼
    ┌───────────────────┐
    │ system_fallback   │ ← 4. システムフォールバック
    │ (Tomoko/standard) │
    └───────────────────┘
```

### 優先順位ルール

| 優先度 | ソース | 説明 |
|-------|-------|-----|
| 1 | `scene_utterances.voice_preset_json` | utterance個別設定 |
| 2 | `project_characters.voice_preset_json` | キャラクター設定 |
| 3 | `projects.settings_json.default_narration_voice` | プロジェクトデフォルト |
| 4 | システムデフォルト | Tomoko (standard) |

---

## 5. api_usage_logs 記録タイミング

```
┌─────────────────────────────────────────────────────────────────────┐
│                      api_usage_logs 記録フロー                       │
└─────────────────────────────────────────────────────────────────────┘

【個別音声生成】
  generateUtteranceAudio() 
       │
       └─→ api_usage_logs (api_type='audio_generation')
            - provider: 'elevenlabs' / 'openai'
            - model: voice_id
            - estimated_cost_usd: 計算値
            - metadata_json: { utterance_id, scene_id, character_name, ... }

【一括音声生成】
  bulkGenerateAudio()
       │
       └─→ api_usage_logs (api_type='bulk_audio_generation')
            - provider: 'internal'
            - model: 'bulk_audio'
            - metadata_json: { job_id, total, success, failed, skipped, ... }

【動画ビルド】
  startVideoBuild()
       │
       └─→ api_usage_logs (api_type='video_build')
            - provider: 'remotion-lambda'
            - model: 'remotion'
            - estimated_cost_usd: estimateRemotionBuildCost()
            - metadata_json: { video_build_id, scene_count, total_duration_sec, ... }
```

---

## 6. 整合性チェックSQL

### 不整合検出クエリ

```sql
-- A-1: completed + null r2_url
SELECT COUNT(*) as broken_audio_count
FROM audio_generations
WHERE status='completed' AND (r2_url IS NULL OR r2_url='');

-- A-2: 参照切れ
SELECT COUNT(*) as orphan_ref_count
FROM scene_utterances su
LEFT JOIN audio_generations ag ON ag.id = su.audio_generation_id
WHERE su.audio_generation_id IS NOT NULL AND ag.id IS NULL;

-- A-3: テキスト不一致
SELECT COUNT(*) as mismatch_count
FROM scene_utterances su
JOIN audio_generations ag ON ag.id = su.audio_generation_id
WHERE su.text IS NOT NULL AND ag.text IS NOT NULL AND su.text != ag.text;

-- B-1: stuckジョブ
SELECT COUNT(*) as stuck_count
FROM project_audio_jobs
WHERE status IN ('queued','running')
  AND updated_at < datetime('now', '-30 minutes');
```

---

## 更新履歴

| 日付 | 変更内容 |
|-----|---------|
| 2026-02-06 | 初版作成 |
| 2026-02-06 | render_config保存追加（Too many functions対策） |

