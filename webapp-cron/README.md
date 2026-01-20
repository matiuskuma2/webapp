# webapp-cron

Cloudflare Workers Cron job for webapp maintenance tasks.

## Purpose

This Worker runs scheduled tasks for the main webapp, currently handling automatic cleanup of old video files.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Cloudflare                                             │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Workers Cron                                        ││
│  │                                                     ││
│  │  Schedule: 0 19 * * * (UTC 19:00 = JST 04:00)      ││
│  │  Daily execution                                    ││
│  └─────────────────────────────────────────────────────┘│
│                      │                                  │
│                      ▼                                  │
│  ┌─────────────────────────────────────────────────────┐│
│  │ webapp-cron Worker                                  ││
│  │                                                     ││
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

### Video Cleanup
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

# Cron schedule: UTC 19:00 = JST 04:00
[triggers]
crons = ["0 19 * * *"]

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
npx wrangler deploy
```

## Manual Trigger

For testing or manual execution:

```bash
# Local
curl -X POST http://localhost:8787/trigger

# Production (requires authentication)
# Use Cloudflare dashboard or wrangler tail
```

## Monitoring

```bash
# View logs
npx wrangler tail webapp-cron

# Check deployment status
npx wrangler deployments list
```

## Extending

To add new cron tasks:

1. Add handler in `src/index.ts`
2. Update cron schedule if needed
3. Deploy with `npx wrangler deploy`

## Related

- Main webapp: Uses same D1 database and R2 bucket
- `video-builds` table: Source of cleanup targets

## License

Proprietary - All rights reserved
