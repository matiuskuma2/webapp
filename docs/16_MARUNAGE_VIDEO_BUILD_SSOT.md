# 16_MARUNAGE_VIDEO_BUILD_SSOT

> Single Source of Truth for the Marunage video-build integration.
> Created: 2026-02-13 | Updated: 2026-02-13 | Scope: P1 (flag-gated, non-impacting)

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

**Production deployment (migrations 0054 + 0055):**
```bash
# Apply migrations to remote D1
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

### Flow Diagram (P1) — 3-Stage Gate

```
init → formatting → awaiting_ready → generating_images → generating_audio → ready
                                                                              ↓ (flag ON)
                                                               ┌──────────────────────────┐
                                                               │  GATE 1: Guard checks    │
                                                               │  • video_build_id NULL?  │
                                                               │  • No active build?      │
                                                               │  • 30min cooldown clear? │
                                                               └──────────┬───────────────┘
                                                                          ↓ pass
                                                               ┌──────────────────────────┐
                                                               │  GATE 2: Preflight       │
                                                               │  • GET /preflight        │
                                                               │  • Assets validated?     │
                                                               │  • Cookie auth OK?       │
                                                               └──────────┬───────────────┘
                                                                          ↓ pass
                                                               ┌──────────────────────────┐
                                                               │  GATE 3: Build creation  │
                                                               │  • POST /video-builds    │
                                                               │  • Save video_build_id   │
                                                               └──────────────────────────┘
```

**Phase never changes from `ready`** — video build progress is read from `video_builds` table.
**All gate failures are non-fatal** — errors are recorded in `video_build_error`, phase stays `ready`.

---

## 3. Incident Prevention: 3-Stage Gate

### Gate 1: Duplicate / Cooldown Guard (DB only, no HTTP)

| Check | Skip condition | Log tag |
|-------|---------------|---------|
| `run.video_build_id IS NOT NULL` | Already has a build → skip | `GATE1: video_build_id=N already set` |
| `run.video_build_error` set + `video_build_attempted_at` < 30min ago | Cooldown → skip | `GATE1: Cooldown active (Nmin remaining)` |
| `video_builds` has active row for `project_id` | Another build running → save its ID | `GATE1: Active build N exists` |

**Cooldown period**: 30 minutes (`VIDEO_BUILD_COOLDOWN_MS = 1,800,000ms`)

### Gate 2: Preflight Validation + Cookie Auth

| HTTP call | `GET /api/projects/:id/video-builds/preflight` |
|-----------|-----------------------------------------------|
| **Auth test** | Same `Cookie: session=...` as build POST. If 401/403, skip silently (cookie invalid/expired). |
| **Asset test** | Response `ready: true` (or `ok: true`). If not ready, skip with `missing` count logged. |
| **On fetch error** | Skip build, record error, no retry until cooldown. |

**Why this prevents incidents:**
- Cookie auth failure is detected *before* wasting an AWS job
- Asset gaps (missing images, broken audio links) caught before `validateProjectAssets()` inside POST
- `SITE_URL` dependency validated server-side in preflight response

### Gate 3: Build Creation (POST /video-builds)

| Scenario | Action |
|----------|--------|
| **200 OK** | Save `video_build_id`, clear `video_build_error` |
| **409 Conflict** | Extract `active_build_id` from response, save to run |
| **Other error** | Record error in `video_build_error`, skip (no retry until cooldown) |
| **Fetch exception** | Same as other error |

---

## 4. Where `video_build_id` Is Stored

| Item | Detail |
|------|--------|
| **Column** | `marunage_runs.video_build_id` (INTEGER NULL) |
| **Added by** | Migration `0054_marunage_runs_add_video_phase.sql` (ALTER TABLE ADD COLUMN) |
| **FK reference** | `video_builds(id)` (no formal FK constraint — ADD COLUMN cannot add FK in SQLite) |
| **Written when** | `marunageTriggerVideoBuild()` passes Gate 3 |
| **Read by** | Status API (`GET /:projectId/status`) — queries `video_builds` table for progress |

### Retry Tracking Columns (Migration 0055)

| Column | Type | Purpose |
|--------|------|---------|
| `video_build_attempted_at` | DATETIME NULL | Last trigger attempt timestamp |
| `video_build_error` | TEXT NULL | Short error from last failure (cleared on success) |

### Why `marunage_runs` (not `projects`)?

- A project can have multiple runs; each run may trigger a different video build.
- The `video_build_id` is specific to a single marunage run lifecycle.
- The `video_builds` table already has `project_id` for project-level lookups.

---

## 5. Status API Video Progress

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

## 6. Non-Impact Protocol

| Rule | Status |
|------|--------|
| No changes to `video-generation.ts` | ✅ |
| No changes to `formatting.ts` | ✅ |
| No changes to `image-generation.ts` | ✅ |
| No changes to `projects.ts` | ✅ |
| No changes to `video_builds` table schema | ✅ |
| No changes to `marunage_runs.phase` CHECK constraint | ✅ (CHECK preserved from migration 0050) |
| Video build failure does NOT fail the run | ✅ (phase stays `ready`) |
| Flag default = OFF | ✅ |
| No direct import of `aws-video-build-client.ts` | ✅ (HTTP fetch only) |

---

## 7. DB Schema (P1 + P1.5)

```sql
-- marunage_runs.phase CHECK constraint (unchanged from 0050):
CHECK (phase IN ('init','formatting','awaiting_ready','generating_images',
                 'generating_audio','ready','failed','canceled'))

-- Added column (0054):
video_build_id INTEGER NULL           -- links to video_builds(id)

-- Added columns (0055):
video_build_attempted_at DATETIME NULL  -- last trigger attempt
video_build_error TEXT NULL             -- short error from last failure
```

---

## 8. Failure Handling Policy

| Failure type | Outcome | Recovery |
|-------------|---------|----------|
| Cookie/auth (401/403) | Skip silently, record error | Cooldown 30min, then retry on next advance |
| Preflight not ready (assets missing) | Skip, record missing count | Fix assets manually, advance again |
| Preflight fetch error (network) | Skip, record error | Cooldown 30min |
| POST 409 (build exists) | Save existing `build_id` | Already building — no action needed |
| POST error (non-409) | Skip, record error | Cooldown 30min |
| POST success but no ID in response | Skip, record error | Investigate API response format |

**Key principle**: Video build is a "best effort" background task. The run is **always** considered complete at `ready`. Users can manually trigger builds from the production board if automatic triggering fails.

---

## 9. Cost Tracking Reference

Image generation cost logging is fully covered across all paths:

| Path | `generation_type` | Status values |
|------|-------------------|---------------|
| `marunageGenerateImages()` (batch) | `marunage_batch` | `success` / `failed` |
| `advance` (single image) | `marunage_advance` | `success` / `failed` |
| Board (`image-generation.ts`) | `scene_image` | `success` / `failed` / `quota_exceeded` |

**Cost rates:**
- Flash (gemini-2.0-flash-preview-image-generation): $0.039/image
- Pro (gemini-3-pro-image-preview): $0.134/image (x3.4 Flash)
- Future 4K Pro: ~$0.24/image (P2 `image_size` branching)

---

## 10. Production Operations

### CRITICAL: Migration order matters

Migrations **must** be applied in order: **0054 → 0055**.
0055 adds `video_build_attempted_at` / `video_build_error` which depend on the
`marunage_runs` table already having `video_build_id` (from 0054).

```bash
# Apply both migrations (wrangler applies them sequentially)
npx wrangler d1 migrations apply webapp-production --remote

# Verify both are applied
npx wrangler d1 migrations list webapp-production --remote
```

### Pre-deployment checklist

| Step | Action | Why |
|------|--------|-----|
| 1 | Apply migrations 0054 + 0055 remotely (in order) | 0055 depends on 0054 |
| 2 | Deploy code | Flag defaults to OFF — zero behaviour change |
| 3 | Verify flag is OFF | `SELECT key, value FROM system_settings WHERE key = 'MARUNAGE_ENABLE_VIDEO_BUILD';` (0 rows = OFF) |
| **4** | **Pick a known `ready` project and manually call preflight** | **This is the most important step before turning ON** |
| 5 | Turn flag ON only after preflight returns `200 + ready=true` | If preflight returns 401/403 → Cookie issue, builds will silently skip |

### Step 4 detail: Preflight verification (before flag ON)

> **CRITICAL**: `$SITE_URL` must match the production `c.env.SITE_URL` value.
> Preflight internally uses `SITE_URL` to build absolute asset URLs.
> Calling from a different domain will give misleading results.

```bash
# SITE_URL は production の c.env.SITE_URL と一致させること（最重要）
# ※カスタムドメイン運用の場合は SITE_URL をそちらに差し替えてください
SITE_URL="https://webapp-c7n.pages.dev"
PROJECT_ID="123"                        # ← ready 状態のプロジェクトID
SESSION="YOUR_SESSION_COOKIE"           # ← ブラウザDevToolsから取得

curl -v -b "session=${SESSION}" \
  "${SITE_URL}/api/projects/${PROJECT_ID}/video-builds/preflight"
```

**Expected responses and what they mean:**

| Response | Meaning | Action |
|----------|---------|--------|
| `200 { ready: true }` | Assets OK, Cookie OK → safe to enable flag | Proceed to step 5 |
| `200 { ready: false, missing: [...] }` | Assets incomplete → builds would be skipped | Fix assets first |
| `401` / `403` | Cookie invalid or expired | Flag ON would be "silently doing nothing" — investigate auth |
| `500` / network error | Server issue | Do not enable until resolved |

> **Why this matters**: If preflight returns 401/403, turning the flag ON is safe (no crash)
> but meaningless — every trigger will silently skip at Gate 2. The build won't fire and
> there's no visible error to the user. Test first to avoid "it's ON but nothing happens".

### Troubleshooting: "flag ON but nothing happens"

| `video_build_attempted_at` | Meaning | Next step |
|---------------------------|---------|-----------|
| **増えている** | trigger は走っている → `video_build_error` を見る | Gate 2 or 3 のエラー内容を確認 |
| **増えていない** | trigger 自体が呼ばれていない | run が `ready` に到達しているか / flag が本当に ON か / advance 呼び出し経路を確認 |

### Post-ON monitoring

After turning the flag ON, monitor these three things:

#### 1. Are builds actually firing?

```sql
-- Runs that attempted video build (should see video_build_attempted_at filled)
SELECT id, project_id, phase, video_build_id,
       video_build_attempted_at, video_build_error, updated_at
FROM marunage_runs
WHERE phase = 'ready' AND video_build_attempted_at IS NOT NULL
ORDER BY updated_at DESC LIMIT 10;
```

#### 2. Are builds succeeding or failing?

```sql
-- Success vs failure breakdown
SELECT
  CASE WHEN video_build_id IS NOT NULL THEN 'success' ELSE 'failed' END AS outcome,
  COUNT(*) AS count,
  video_build_error
FROM marunage_runs
WHERE phase = 'ready' AND video_build_attempted_at IS NOT NULL
GROUP BY outcome, video_build_error
ORDER BY count DESC;
```

#### 3. Is cooldown kicking in? (failure loop prevention)

```sql
-- Runs stuck in cooldown (error + recent attempt)
SELECT id, project_id, video_build_error,
       video_build_attempted_at,
       ROUND((julianday('now') - julianday(video_build_attempted_at)) * 24 * 60, 1)
         AS minutes_since_attempt
FROM marunage_runs
WHERE phase = 'ready'
  AND video_build_error IS NOT NULL
  AND video_build_attempted_at IS NOT NULL
ORDER BY video_build_attempted_at DESC LIMIT 10;
```

> If `video_build_error` keeps appearing with the same message, investigate the root
> cause (usually auth, missing assets, or AWS config). The 30min cooldown prevents
> log floods but the underlying issue needs manual resolution.

#### 4. Active video builds for marunage runs

```sql
SELECT vb.id, vb.project_id, vb.status, vb.progress_percent, vb.download_url
FROM video_builds vb
JOIN marunage_runs mr ON mr.video_build_id = vb.id
WHERE mr.phase = 'ready'
ORDER BY vb.created_at DESC LIMIT 10;
```

---

## 11. Aggregation SQL (from docs/15 section 12)

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

---

## 12. P2 Roadmap (deferred)

When the feature is stable:

1. **Remove CHECK constraint** — migration to recreate `marunage_runs` without CHECK
2. **Add phases** — `building_video` and `video_ready` to `MarunagePhase` type
3. **Add `building_video` case** to advance handler (poll video build status)
4. **Update TERMINAL_PHASES** — include `video_ready`
5. **Update unique index** — `WHERE phase NOT IN ('ready', 'video_ready', 'failed', 'canceled')`
6. **4K pricing** — add `image_size` column to `image_generation_logs`, branching cost logic
7. **Audio preview** — add audio URLs to status API response (D7)
8. **Video rebuild button** — manual re-trigger from Result View (D5)
9. **Dedicated `is_marunage` column** — replace `json_extract` filter if project count > 10K (D10)

---

## 13. Marunage UI Separation (P1, commit c494a9f)

> Added: 2026-02-14 | Scope: Complete UI separation of Marunage from Builder

### 13.1 Problem Statement

Marunage projects shared the `projects` table with regular projects. On completion (`ready` phase):
- Dashboard card linked to `/projects/:id` (Builder)
- Chat completion messages linked to Builder
- Builder had no guard against marunage projects
- Regular project list included marunage projects

### 13.2 Identification Method

Marunage projects are identified by `settings_json` containing `marunage_mode: true`:
```sql
-- Set during /api/marunage/start (marunage.ts L1391-1395)
json_extract(settings_json, '$.marunage_mode') = 1
```

### 13.3 Changes (3 files, +102/-13)

| File | Change |
|------|--------|
| `src/routes/projects.ts` L317 | `AND json_extract(settings_json, '$.marunage_mode') IS NOT 1` |
| `src/index.tsx` L537-557 | Server-side guard: `json_extract` → redirect to `/marunage-chat?run=X` |
| `src/index.tsx` L4300 | Ready card link: `/marunage-chat?run=X` (was `/projects/:id`) |
| `marunage-chat.js` L97 | Ready message: removed Builder reference |
| `marunage-chat.js` L335-345 | Polling: continues during `video.state = running/pending` |
| `marunage-chat.js` L446-451 | Completion message: removed Builder link |
| `marunage-chat.js` L877-960 | `mcShowReadyActions` → Result View with video panel |

### 13.4 Builder Guard (Server-Side)

```
GET /projects/:id
  → DB: SELECT json_extract(settings_json, '$.marunage_mode') as is_marunage
  → if is_marunage === 1:
      → SELECT id FROM marunage_runs WHERE project_id = ?
      → 302 redirect to /marunage-chat?run={id} or /marunage
  → else: normal Builder HTML
```

### 13.5 Result View (mcShowReadyActions)

Displays inline in chat right pane:
- Image completion count (e.g., "8/8")
- Audio completion count (e.g., "8/8")
- Video build panel (`mcRenderVideoPanel`):
  - `off`: "動画ビルドは無効です"
  - `pending`: "ビルド準備中..."
  - `running`: progress bar with percentage
  - `done`: download button
  - `failed`: error message
- Action buttons: "新しく作る" + "一覧に戻る" (NO Builder link)

### 13.6 Polling Behavior

```
phase = ready AND video.state in (running, pending) → continue polling
phase = ready AND video.state in (off, done, failed) → stop polling
phase in (failed, canceled) → stop polling
```

### 13.7 Verification Checklist

```bash
# ※カスタムドメイン運用の場合は SITE_URL をそちらに差し替えてください
SITE_URL="https://webapp-c7n.pages.dev"

# 1. Regular project list excludes marunage
curl -b "session=..." "${SITE_URL}/api/projects"

# 2. Builder direct access redirects
curl -v "${SITE_URL}/projects/<marunage-project-id>"
# Expected: 302 → /marunage-chat?run=X

# 3. Marunage dashboard ready card → /marunage-chat?run=X

# 4. Chat ready state → Result View (no Builder link)

# 5. Video panel states: off/pending/running/done/failed
```

### 13.8 Non-Impact Confirmation

- `formatting.ts`: unchanged
- `image-generation.ts`: unchanged
- `video-generation.ts`: unchanged
- `marunage_runs.phase` CHECK: unchanged
- No new migrations required
- `building_video`/`video_ready`: comment-only (P2)
