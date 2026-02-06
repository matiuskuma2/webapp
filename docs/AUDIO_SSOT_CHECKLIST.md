# 音声生成 SSOT チェックリスト

## 概要
このチェックリストは、音声生成システムのSSOT（Single Source of Truth）整合性を確認するためのものです。
定期的に実行して、データ不整合を早期に検出・修正します。

---

## Gate-A: 音声SSOT整合チェック

### A-1: completed なのに r2_url が null
**理想: 0件**（生成済みなのに再生不可を防ぐ）

```sql
SELECT id, scene_id, status, r2_url, error_message, created_at
FROM audio_generations
WHERE status='completed' AND (r2_url IS NULL OR r2_url='')
ORDER BY id DESC
LIMIT 50;
```

| チェック項目 | 期待値 | 実測値 | 結果 | 備考 |
|------------|-------|-------|-----|-----|
| 該当件数 | 0件 | | | |

**対応**: 該当があれば、音声生成ロジックのR2アップロード後の更新処理を確認

---

### A-2: utterance が audio_generation_id を持つのに audio_generations が存在しない
**理想: 0件**（参照切れを防ぐ）

```sql
SELECT su.id AS utterance_id, su.scene_id, su.audio_generation_id
FROM scene_utterances su
LEFT JOIN audio_generations ag ON ag.id = su.audio_generation_id
WHERE su.audio_generation_id IS NOT NULL AND ag.id IS NULL
LIMIT 50;
```

| チェック項目 | 期待値 | 実測値 | 結果 | 備考 |
|------------|-------|-------|-----|-----|
| 該当件数 | 0件 | | | |

**対応**: 該当があれば、audio_generation_idをNULLにクリアする

---

### A-3: utterance の text と audio_generations.text の不一致
**理想: 0件**（古い音声の再生成を防止）

```sql
SELECT su.id AS utterance_id, su.scene_id,
       substr(su.text,1,60) AS utter_text,
       substr(ag.text,1,60) AS audio_text,
       ag.id AS audio_id, ag.status
FROM scene_utterances su
JOIN audio_generations ag ON ag.id = su.audio_generation_id
WHERE su.text IS NOT NULL
  AND ag.text IS NOT NULL
  AND su.text != ag.text
ORDER BY su.id DESC
LIMIT 50;
```

| チェック項目 | 期待値 | 実測値 | 結果 | 備考 |
|------------|-------|-------|-----|-----|
| 該当件数 | 0件 | | | |

**対応**: テキスト変更時にaudio_generation_idをクリアするロジックを確認

---

## Gate-B: Bulkジョブ整合チェック

### B-1: 進行中ジョブ（stuck検知）
**理想: 0件 または cleanup対象のみ**

```sql
SELECT id, project_id, status, started_at, updated_at
FROM project_audio_jobs
WHERE status IN ('queued','running')
ORDER BY updated_at ASC
LIMIT 50;
```

| チェック項目 | 期待値 | 実測値 | 結果 | 備考 |
|------------|-------|-------|-----|-----|
| 該当件数 | 0件 | | | |
| 30分以上経過したジョブ | 0件 | | | stuck |

**対応**: 30分以上stuckしていたらcleanup APIを実行

---

### B-2: cleanup API動作確認

```bash
# stuck確認
curl -s https://webapp-c7n.pages.dev/api/admin/stuck-audio-jobs

# cleanup実行
curl -s -X POST https://webapp-c7n.pages.dev/api/admin/cron/cleanup-stuck-audio-jobs
```

| チェック項目 | 期待値 | 実測値 | 結果 | 備考 |
|------------|-------|-------|-----|-----|
| API応答 | 200 OK | | | |
| stuck件数 | 0件 | | | |

---

## Gate-C: UI/UX矛盾チェック

### C-1: bulk完了後のpreflight確認

```bash
curl -s https://webapp-c7n.pages.dev/api/projects/{PROJECT_ID}/video-builds/preflight | jq '.utterance_summary, .utterance_errors | length'
```

| チェック項目 | 期待値 | 実測値 | 結果 | 備考 |
|------------|-------|-------|-----|-----|
| utterance_errors数 | 0または減少 | | | |
| is_ready | true | | | |
| can_generate | true | | | |

---

### C-2: 409競合エラー対応

| エラーコード | 原因 | UI対応 |
|------------|-----|-------|
| AUDIO_GENERATING | 同一utteranceが生成中 | 「少し待って再試行」表示 |
| CONCURRENT_LIMIT | 並列制限 | 「他の生成が完了するまでお待ちください」表示 |

---

## Gate-D: コスト/請求事故ゼロチェック

### D-1: api_usage_logsの一致確認

```sql
SELECT api_type, COUNT(*) cnt
FROM api_usage_logs
WHERE api_type IN ('bulk_audio_generation', 'audio_generation', 'video_build')
GROUP BY api_type;
```

| チェック項目 | 期待値 | 実測値 | 結果 | 備考 |
|------------|-------|-------|-----|-----|
| bulk_audio_generation | bulk実行数と一致 | | | |
| audio_generation | 個別生成数と一致 | | | |
| video_build | ビルド数と一致 | | | |

---

### D-2: audit_logsの確認

```sql
SELECT id, entity_type, entity_id, action, created_at
FROM audit_logs
WHERE action LIKE '%audio%' OR action LIKE '%bulk%'
ORDER BY id DESC
LIMIT 50;
```

| チェック項目 | 期待値 | 実測値 | 結果 | 備考 |
|------------|-------|-------|-----|-----|
| 操作履歴 | 主要操作が記録されている | | | |

---

## framesPerLambda チェック

### 設定値確認

| 設定項目 | 値 | 対応可能動画長 |
|---------|---|--------------|
| MAX_LAMBDA_FUNCTIONS | 190 | - |
| MIN_FRAMES_PER_LAMBDA | 200 | ~22分 @ 30fps |
| MAX_FRAMES_PER_LAMBDA | 2400 | ~2時間40分 @ 30fps |

### 計算例（30fps）

| 動画長 | フレーム数 | framesPerLambda | 関数数 | 上限内 |
|-------|----------|----------------|-------|-------|
| 5分 | 9,000 | 200 | 45 | ✅ |
| 15分 | 27,000 | 200 | 135 | ✅ |
| 30分 | 54,000 | 285 | 190 | ✅ |
| 45分 | 81,000 | 427 | 190 | ✅ |
| 1時間 | 108,000 | 569 | 190 | ✅ |
| 2時間 | 216,000 | 1,138 | 190 | ✅ |

---

## 運用Runbook

### 1. bulk実行フロー
```
1. 一括音声生成ボタン → bulk-status で進捗確認
2. 失敗が混ざった → bulk-history で失敗 utterance を抽出 → 再実行（failedだけ）
3. 進行中が止まった → admin cleanup → 再実行
4. preflight が赤 → visual_validation.errors の action_hint に沿って直す
```

### 2. silent fallback禁止
- エラーは必ずユーザーに表示
- 問題箇所を明示的に示す
- 修正方法を提案

### 3. 定期チェック推奨
- **毎日**: Gate-A (A-1のみ)
- **週1回**: Gate-A, Gate-B 全項目
- **月1回**: 全Gate実行

---

## 履歴

| 日付 | 実施者 | 結果 | 備考 |
|-----|-------|-----|-----|
| 2026-02-06 | システム | Gate-A全合格 | ローカルDB確認済み |

