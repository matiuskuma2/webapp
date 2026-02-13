# 16_MARUNAGE_VIDEO_BUILD_SSOT

> Single Source of Truth for the Marunage video-build integration.
> Created: 2026-02-13 | Scope: P1 (flag-gated, non-impacting)

---

## 1. Feature Flag

| Item | Value |
|------|-------|
| **Flag name** | `MARUNAGE_ENABLE_VIDEO_BUILD` |
| **Storage** | `system_settings` table (`key` / `value` columns) |
| **Default** | OFF (`false`) — video build is disabled until manually enabled |
| **Read function** | `isVideoBuildEnabled(db)` in `marunage.ts` |
| **Accepted values** | `'true'` or `'1'` = ON, anything else = OFF |

**Enable/disable:**
```sql
-- Enable video build
INSERT INTO system_settings (key, value, updated_at)
VALUES ('MARUNAGE_ENABLE_VIDEO_BUILD', 'true', datetime('now'))
ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = datetime('now');

-- Disable video build (emergency stop)
UPDATE system_settings SET value = 'false', updated_at = datetime('now')
WHERE key = 'MARUNAGE_ENABLE_VIDEO_BUILD';

-- Check current state
SELECT key, value, updated_at FROM system_settings
WHERE key = 'MARUNAGE_ENABLE_VIDEO_BUILD';
```

**Production deployment (migration 0054):**
```bash
# Apply migration to remote D1
npx wrangler d1 migrations apply webapp-production --remote

# Verify applied migrations
npx wrangler d1 migrations list webapp-production --remote
```

---

## 2. When Video Build Is Invoked

| Trigger | Condition | Action |
|---------|-----------|--------|
| **Audio completes** → `ready` | Flag = ON | `marunageTriggerVideoBuild()` via `waitUntil` |
| **Audio completes** → `ready` | Flag = OFF | No video build; run is complete |
| **Existing audio job found** (completed) | Flag = ON | Same as above |

### Flow Diagram (P1)

```
init → formatting → awaiting_ready → generating_images → generating_audio → ready
                                                                              ↓ (flag ON)
                                                                 [background] POST /api/projects/:id/video-builds
                                                                              ↓
                                                                 video_build_id saved to marunage_runs
                                                                              ↓
                                                                 video_builds table tracks progress
```

**Phase never changes from `ready`** — video build progress is read from `video_builds` table.

---

## 3. Where `video_build_id` Is Stored

| Item | Detail |
|------|--------|
| **Column** | `marunage_runs.video_build_id` (INTEGER NULL) |
| **Added by** | Migration `0054_marunage_runs_add_video_phase.sql` (ALTER TABLE ADD COLUMN) |
| **FK reference** | `video_builds(id)` (no formal FK constraint — ADD COLUMN cannot add FK in SQLite) |
| **Written when** | `marunageTriggerVideoBuild()` successfully calls video-builds API |
| **Read by** | Status API (`GET /:projectId/status`) — queries `video_builds` table for progress |

### Why `marunage_runs` (not `projects`)?

- A project can have multiple runs; each run may trigger a different video build.
- The `video_build_id` is specific to a single marunage run lifecycle.
- The `video_builds` table already has `project_id` for project-level lookups.

---

## 4. Status API Video Progress

The status endpoint `GET /api/marunage/:projectId/status` returns a `video` section:

```json
{
  "progress": {
    "video": {
      "state": "off | pending | running | done | failed",
      "build_id": null | 123,
      "build_status": null | "queued | rendering | completed | ...",
      "progress_percent": null | 45,
      "download_url": null | "https://..."
    }
  }
}
```

**State mapping:**

| `state` | Condition |
|---------|-----------|
| `off` | No `video_build_id` (flag was OFF or build not yet triggered) |
| `pending` | `video_build_id` exists but status not yet in active set |
| `running` | Build status is `queued`, `validating`, `submitted`, `rendering`, or `uploading` |
| `done` | Build status is `completed` |
| `failed` | Build status is `failed` or `cancelled` |

---

## 5. Non-Impact Protocol

| Rule | Status |
|------|--------|
| No changes to `video-generation.ts` | ✅ |
| No changes to `formatting.ts` | ✅ |
| No changes to `image-generation.ts` | ✅ |
| No changes to `video_builds` table schema | ✅ |
| No changes to `marunage_runs.phase` CHECK constraint | ✅ (CHECK preserved from migration 0050) |
| Video build failure does NOT fail the run | ✅ (phase stays `ready`) |
| Flag default = OFF | ✅ |

---

## 6. DB Schema (P1)

```sql
-- marunage_runs.phase CHECK constraint (unchanged from 0050):
CHECK (phase IN ('init','formatting','awaiting_ready','generating_images',
                 'generating_audio','ready','failed','canceled'))

-- Added column (0054):
video_build_id INTEGER NULL  -- links to video_builds(id)
```

---

## 7. Cost Tracking Reference

Image generation cost logging is fully covered across all paths:

| Path | `generation_type` | Status values |
|------|-------------------|---------------|
| `marunageGenerateImages()` (batch) | `marunage_batch` | `success` / `failed` |
| `advance` (single image) | `marunage_advance` | `success` / `failed` |
| Board (`image-generation.ts`) | `scene_image` | `success` / `failed` / `quota_exceeded` |

**Cost rates:**
- Flash (gemini-2.0-flash-preview-image-generation): $0.039/image
- Pro (gemini-3-pro-image-preview): $0.134/image (×3.4 Flash)
- Future 4K Pro: ~$0.24/image (P2 `image_size` branching)

---

## 8. P2 Roadmap (deferred)

When the feature is stable:

1. **Remove CHECK constraint** — migration to recreate `marunage_runs` without CHECK
2. **Add phases** — `building_video` and `video_ready` to `MarunagePhase` type
3. **Add `building_video` case** to advance handler (poll video build status)
4. **Update TERMINAL_PHASES** — include `video_ready`
5. **Update unique index** — `WHERE phase NOT IN ('ready', 'video_ready', 'failed', 'canceled')`
6. **4K pricing** — add `image_size` column to `image_generation_logs`, branching cost logic

---

## 9. Aggregation SQL (from §12 of docs/15)

```sql
-- Daily cost by generation_type
SELECT
  DATE(created_at) AS day,
  generation_type,
  status,
  COUNT(*) AS count,
  SUM(estimated_cost_usd) AS total_cost_usd
FROM image_generation_logs
GROUP BY day, generation_type, status
ORDER BY day DESC, generation_type;

-- Per-project marunage totals
SELECT
  project_id,
  COUNT(*) AS total_images,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
  SUM(estimated_cost_usd) AS total_cost_usd
FROM image_generation_logs
WHERE generation_type IN ('marunage_batch', 'marunage_advance')
GROUP BY project_id
ORDER BY total_cost_usd DESC;
```
