# TTS計測・上限・キャッシュ設計書

作成日: 2026-01-19
目的: ElevenLabs / 他プロバイダを増やしても「暴走しない」運用設計

---

## 1. 必須ログ（SSOT）

### 1.1 tts_usage_logs テーブル

```sql
CREATE TABLE IF NOT EXISTS tts_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- 識別子
  user_id INTEGER NOT NULL,
  project_id INTEGER,
  scene_id INTEGER,
  character_key TEXT,
  
  -- プロバイダ情報
  provider TEXT NOT NULL,           -- 'google' | 'fish' | 'elevenlabs'
  voice_id TEXT NOT NULL,
  model TEXT,                       -- 'eleven_multilingual_v2' など
  
  -- 使用量
  text_length INTEGER NOT NULL,     -- 入力文字数
  audio_duration_ms INTEGER,        -- 出力音声長（ミリ秒）
  audio_bytes INTEGER,              -- ファイルサイズ
  
  -- 課金情報
  estimated_cost_usd REAL,          -- 推定コスト（USD）
  billing_unit TEXT,                -- 'characters' | 'seconds'
  billing_amount INTEGER,           -- 課金単位での使用量
  
  -- 結果
  status TEXT NOT NULL,             -- 'success' | 'failed' | 'cached'
  cache_hit INTEGER DEFAULT 0,      -- キャッシュヒットフラグ
  error_message TEXT,
  
  -- タイムスタンプ
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  -- インデックス
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (scene_id) REFERENCES scenes(id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_tts_usage_user ON tts_usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_tts_usage_provider ON tts_usage_logs(provider);
CREATE INDEX IF NOT EXISTS idx_tts_usage_created ON tts_usage_logs(created_at);
```

### 1.2 コスト計算ルール

| プロバイダ | 課金単位 | 単価（USD） | 備考 |
|------------|----------|-------------|------|
| Google TTS | 100万文字 | $4-16 | WaveNet: $16, Standard: $4 |
| Fish Audio | 1,000文字 | $0.015 | 従量課金 |
| ElevenLabs | 1,000文字 | $0.18-0.30 | Starterプラン以上が必要 |

```javascript
// コスト推定関数
function estimateCost(provider, textLength, model) {
  switch (provider) {
    case 'google':
      const ratePerMillion = model?.includes('Wavenet') ? 16 : 4;
      return (textLength / 1_000_000) * ratePerMillion;
    case 'fish':
      return (textLength / 1000) * 0.015;
    case 'elevenlabs':
      return (textLength / 1000) * 0.24; // 平均値
    default:
      return 0;
  }
}
```

---

## 2. 上限制御（段階警告）

### 2.1 設定値

```javascript
const TTS_LIMITS = {
  // 月間上限（USD）
  MONTHLY_LIMIT_USD: 100,
  
  // 警告閾値
  WARNING_70_PERCENT: 70,
  WARNING_85_PERCENT: 85,
  WARNING_95_PERCENT: 95,
  
  // 日次上限（文字数）
  DAILY_LIMIT_CHARACTERS: 500_000,
  
  // 同時生成上限
  CONCURRENT_LIMIT: 5,
};
```

### 2.2 警告レベルと対応

| 使用率 | レベル | UIアクション | バックエンドアクション |
|--------|--------|--------------|------------------------|
| < 70% | 正常 | なし | 通常処理 |
| 70-84% | 警告1 | 管理者に通知、UIに軽く表示 | ログに記録 |
| 85-94% | 警告2 | UIに残量表示、警告バナー | 管理者へメール通知 |
| 95-99% | 警告3 | 生成ボタンに警告表示 | 生成前に確認ダイアログ |
| 100%+ | 上限 | 生成ボタン無効化 | 新規生成を拒否（429） |

### 2.3 使用量チェックAPI

```typescript
// GET /api/tts/usage
interface TTSUsageResponse {
  // 月間使用量
  monthly: {
    used_usd: number;
    limit_usd: number;
    remaining_usd: number;
    percentage: number;
    characters_used: number;
  };
  
  // 日次使用量
  daily: {
    characters_used: number;
    limit_characters: number;
    remaining_characters: number;
  };
  
  // プロバイダ別内訳
  by_provider: {
    google: { characters: number; cost_usd: number };
    fish: { characters: number; cost_usd: number };
    elevenlabs: { characters: number; cost_usd: number };
  };
  
  // 警告レベル
  warning_level: 'none' | 'warning_70' | 'warning_85' | 'warning_95' | 'limit_reached';
  
  // 次回リセット日時
  next_reset: string; // ISO8601
}
```

### 2.4 バックエンド実装

```typescript
// src/routes/audio-generation.ts に追加

async function checkTTSLimits(db: D1Database, userId: number): Promise<{
  allowed: boolean;
  warning_level: string;
  usage: any;
}> {
  // 月初からの合計を取得
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  
  const usage = await db.prepare(`
    SELECT 
      SUM(CASE WHEN status = 'success' THEN estimated_cost_usd ELSE 0 END) as total_cost,
      SUM(CASE WHEN status = 'success' THEN text_length ELSE 0 END) as total_characters,
      COUNT(*) as total_requests
    FROM tts_usage_logs
    WHERE user_id = ?
      AND created_at >= ?
  `).bind(userId, monthStart.toISOString()).first();
  
  const totalCost = usage?.total_cost || 0;
  const percentage = (totalCost / TTS_LIMITS.MONTHLY_LIMIT_USD) * 100;
  
  let warning_level = 'none';
  if (percentage >= 100) warning_level = 'limit_reached';
  else if (percentage >= 95) warning_level = 'warning_95';
  else if (percentage >= 85) warning_level = 'warning_85';
  else if (percentage >= 70) warning_level = 'warning_70';
  
  return {
    allowed: percentage < 100,
    warning_level,
    usage: {
      monthly_cost_usd: totalCost,
      monthly_limit_usd: TTS_LIMITS.MONTHLY_LIMIT_USD,
      percentage,
      characters_used: usage?.total_characters || 0
    }
  };
}
```

---

## 3. キャッシュ（原価を守る）

### 3.1 キャッシュキー設計

```javascript
// キャッシュキー = ハッシュ(provider + voice_id + model + settings + text)
function generateTTSCacheKey(params) {
  const normalized = {
    provider: params.provider,
    voice_id: params.voice_id,
    model: params.model || '',
    // 設定を正規化（順序を固定）
    settings: JSON.stringify({
      format: params.format || 'mp3',
      sample_rate: params.sample_rate || 24000,
      stability: params.stability,
      similarity_boost: params.similarity_boost
    }),
    // テキストは正規化（空白除去、小文字化など不要）
    text: params.text
  };
  
  const str = JSON.stringify(normalized);
  // SHA-256 ハッシュ
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
    .then(buf => Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join(''));
}
```

### 3.2 tts_cache テーブル

```sql
CREATE TABLE IF NOT EXISTS tts_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- キャッシュキー（ハッシュ）
  cache_key TEXT NOT NULL UNIQUE,
  
  -- 元のパラメータ（デバッグ用）
  provider TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  text_length INTEGER NOT NULL,
  
  -- キャッシュデータ
  r2_key TEXT NOT NULL,            -- R2保存先
  audio_duration_ms INTEGER,
  audio_bytes INTEGER,
  
  -- メタデータ
  hit_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,             -- NULL = 無期限
  
  -- インデックス
  UNIQUE(cache_key)
);

CREATE INDEX IF NOT EXISTS idx_tts_cache_key ON tts_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_tts_cache_expires ON tts_cache(expires_at);
```

### 3.3 キャッシュロジック

```typescript
// 生成前にキャッシュチェック
async function generateWithCache(
  db: D1Database,
  r2: R2Bucket,
  params: TTSParams
): Promise<TTSResult> {
  const cacheKey = await generateTTSCacheKey(params);
  
  // 1. キャッシュチェック
  const cached = await db.prepare(`
    SELECT r2_key, audio_duration_ms, audio_bytes
    FROM tts_cache
    WHERE cache_key = ?
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
  `).bind(cacheKey).first();
  
  if (cached) {
    // キャッシュヒット
    await db.prepare(`
      UPDATE tts_cache
      SET hit_count = hit_count + 1,
          last_accessed_at = CURRENT_TIMESTAMP
      WHERE cache_key = ?
    `).bind(cacheKey).run();
    
    // 使用ログ（キャッシュヒット）
    await logTTSUsage(db, {
      ...params,
      status: 'cached',
      cache_hit: 1,
      estimated_cost_usd: 0 // キャッシュヒットはコストゼロ
    });
    
    return {
      r2_key: cached.r2_key,
      duration_ms: cached.audio_duration_ms,
      from_cache: true
    };
  }
  
  // 2. キャッシュミス → 生成
  const result = await generateTTS(params);
  
  // 3. キャッシュ保存
  await db.prepare(`
    INSERT INTO tts_cache (
      cache_key, provider, voice_id, text_hash, text_length,
      r2_key, audio_duration_ms, audio_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    cacheKey,
    params.provider,
    params.voice_id,
    await hashText(params.text),
    params.text.length,
    result.r2_key,
    result.duration_ms,
    result.bytes
  ).run();
  
  // 4. 使用ログ
  await logTTSUsage(db, {
    ...params,
    status: 'success',
    cache_hit: 0,
    estimated_cost_usd: estimateCost(params.provider, params.text.length, params.model)
  });
  
  return result;
}
```

### 3.4 キャッシュ有効期限

| 用途 | 有効期限 | 理由 |
|------|----------|------|
| 生成済み音声 | 無期限 | 同一テキスト・設定なら再利用可 |
| プレビュー音声 | 7日 | 一時的な確認用 |
| 失敗リトライ | 1時間 | 一時的なAPIエラー対策 |

---

## 4. UI表示

### 4.1 使用量バー（ヘッダー表示）

```html
<!-- 警告レベルに応じた色 -->
<div class="tts-usage-bar">
  <div class="flex items-center gap-2 text-sm">
    <span>TTS使用量:</span>
    <div class="w-32 bg-gray-200 rounded-full h-2">
      <div 
        class="h-2 rounded-full transition-all"
        style="width: ${percentage}%"
        :class="{
          'bg-green-500': percentage < 70,
          'bg-yellow-500': percentage >= 70 && percentage < 85,
          'bg-orange-500': percentage >= 85 && percentage < 95,
          'bg-red-500': percentage >= 95
        }"
      ></div>
    </div>
    <span class="font-mono">${usedUsd.toFixed(2)} / $${limitUsd}</span>
  </div>
</div>
```

### 4.2 上限到達ダイアログ

```html
<div class="limit-reached-dialog">
  <div class="bg-red-50 border border-red-200 rounded-lg p-6">
    <div class="flex items-start gap-4">
      <i class="fas fa-exclamation-circle text-red-500 text-2xl"></i>
      <div>
        <h3 class="font-bold text-red-800">月間上限に達しました</h3>
        <p class="text-sm text-red-700 mt-2">
          今月の音声生成上限（$100）に達しました。<br>
          次回リセット: ${nextResetDate}
        </p>
        <div class="mt-4 flex gap-2">
          <button class="px-4 py-2 bg-gray-600 text-white rounded">
            閉じる
          </button>
          <a href="/settings/billing" class="px-4 py-2 bg-blue-600 text-white rounded">
            プランをアップグレード
          </a>
        </div>
      </div>
    </div>
  </div>
</div>
```

---

## 5. 実装フェーズ

### Phase 4-A: ログ基盤（1-2日）
- [ ] tts_usage_logs テーブル作成
- [ ] 既存生成処理にログ追加
- [ ] コスト計算関数

### Phase 4-B: 上限制御（1-2日）
- [ ] checkTTSLimits 関数
- [ ] 警告レベル判定
- [ ] 生成前チェック
- [ ] 429レスポンス実装

### Phase 4-C: UI表示（1日）
- [ ] 使用量バー
- [ ] 警告バナー
- [ ] 上限到達ダイアログ

### Phase 4-D: キャッシュ（2-3日）
- [ ] tts_cache テーブル作成
- [ ] キャッシュキー生成
- [ ] キャッシュヒット処理
- [ ] キャッシュミス時の保存

### Phase 4-E: 運用（継続）
- [ ] 管理者ダッシュボード
- [ ] 月次レポート
- [ ] 異常検知アラート

---

## 6. 関連ファイル

| ファイル | 役割 |
|----------|------|
| `src/routes/audio-generation.ts` | TTS生成API |
| `migrations/0XXX_create_tts_usage_logs.sql` | 使用ログテーブル |
| `migrations/0XXX_create_tts_cache.sql` | キャッシュテーブル |
| `public/static/audio-ui.js` | 音声生成UI |
| `docs/TTS_USAGE_LIMITS_SPEC.md` | この文書 |

---

## 7. 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-01-19 | 初版作成（計測・上限・キャッシュ設計） |
