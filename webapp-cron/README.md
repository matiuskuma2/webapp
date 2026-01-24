# webapp-cron

Cloudflare Workers Cron job for webapp maintenance tasks.

## Purpose

This Worker runs scheduled tasks for the main webapp:
1. **Stuck builds cleanup** (5分ごと) - 長時間更新されないビルドを自動キャンセル
2. **Video cleanup** (毎日 UTC 19:00 = JST 04:00) - 30日以上経過した動画ファイルを自動削除

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Cloudflare                                             │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Workers Cron                                        ││
│  │                                                     ││
│  │  Schedule 1: */5 * * * * (5分ごと)                 ││
│  │    → Stuck builds cleanup                          ││
│  │                                                     ││
│  │  Schedule 2: 0 19 * * * (UTC 19:00 = JST 04:00)   ││
│  │    → Video file cleanup                            ││
│  └─────────────────────────────────────────────────────┘│
│                      │                                  │
│                      ▼                                  │
│  ┌─────────────────────────────────────────────────────┐│
│  │ webapp-cron Worker                                  ││
│  │                                                     ││
│  │  Stuck builds:                                     ││
│  │  1. Acquire D1 lock (cron_locks table)             ││
│  │  2. Find builds stuck for 30+ minutes              ││
│  │  3. Mark as failed with TIMEOUT_STUCK error        ││
│  │  4. Write audit log to api_usage_logs              ││
│  │                                                     ││
│  │  Video cleanup:                                    ││
│  │  1. Query expired video_builds from D1             ││
│  │  2. Delete R2 objects for expired videos           ││
│  │  3. Update database records                        ││
│  └─────────────────────────────────────────────────────┘│
│                      │                                  │
│         ┌───────────┴───────────┐                      │
│         ▼                       ▼                      │
│  ┌─────────────┐        ┌─────────────┐               │
│  │ D1 Database │        │ R2 Storage  │               │
│  │ webapp-prod │        │ webapp-bucket│               │
│  └─────────────┘        └─────────────┘               │
└─────────────────────────────────────────────────────────┘
```

## Features

### Stuck Builds Cleanup (5分ごと)
- **対象ステータス**: `submitted`, `queued`, `rendering`, `uploading`, `validating`
- **タイムアウト**: 30分以上更新がないビルドを自動キャンセル
- **二重実行防止**: `cron_locks` テーブルでD1ロック
- **監査ログ**: `api_usage_logs` に記録
- **エラーコード**: `TIMEOUT_STUCK`

### Video Cleanup (毎日 JST 04:00)
- **Retention Period**: Configurable via `system_settings.video_retention_days` (default: 30 days)
- **Batch Processing**: Processes up to 500 videos per execution
- **R2 Cleanup**: Deletes video files from R2 storage
- **Safe Deletion**: Logs errors but continues processing

## Configuration

### wrangler.toml

```toml
name = "webapp-cron"
main = "src/index.ts"
compatibility_date = "2024-01-01"

# Cron Triggers
# - */5 * * * *   = 5分ごと（Stuck builds cleanup）
# - 0 19 * * *    = 毎日 UTC 19:00 = JST 04:00（Video cleanup）
[triggers]
crons = ["*/5 * * * *", "0 19 * * *"]

# Shared D1 Database
[[d1_databases]]
binding = "DB"
database_name = "webapp-production"
database_id = "51860cd3-bfa8-4eab-8a11-aa230adee686"

# Shared R2 Bucket
[[r2_buckets]]
binding = "R2"
bucket_name = "webapp-bucket"
```

## Scripts

```bash
# Install dependencies
npm install

# Local development
npm run dev

# Manual trigger (local)
npm run trigger

# Check status (local)
npm run status

# Deploy to Cloudflare
npm run deploy
# or
npx wrangler deploy --config wrangler.toml
```

## Production Endpoints

**URL**: https://webapp-cron.polished-disk-21bf.workers.dev

### Health Check
```bash
curl https://webapp-cron.polished-disk-21bf.workers.dev/health
```

### Status Check
```bash
curl https://webapp-cron.polished-disk-21bf.workers.dev/status
```

### Manual Triggers

```bash
# Stuck builds cleanup
curl -X POST https://webapp-cron.polished-disk-21bf.workers.dev/trigger/stuck-builds

# Video cleanup
curl -X POST https://webapp-cron.polished-disk-21bf.workers.dev/trigger/video-cleanup
```

## Monitoring

```bash
# View logs
npx wrangler tail webapp-cron --config wrangler.toml

# Check deployment status
npx wrangler deployments list
```

## D1 Requirements

### cron_locks table
```sql
CREATE TABLE IF NOT EXISTS cron_locks (
  key TEXT PRIMARY KEY,
  locked_until DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cron_locks_locked_until ON cron_locks(locked_until);
```

## Related

- Main webapp: Uses same D1 database and R2 bucket
- `video_builds` table: Source of stuck builds cleanup
- `video_generations` table: Source of video cleanup targets
- `cron_locks` table: Lock mechanism for preventing duplicate execution
- `api_usage_logs` table: Audit log destination

## License

Proprietary - All rights reserved
