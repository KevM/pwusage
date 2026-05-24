# Battery Hold for Charging — Design

**Date:** 2026-05-24
**Status:** Approved design, pre-implementation
**Branch:** builds on `feature/tesla-backup-reserve` (commit `cba710e` adds `TeslaClient.setBackupReserve`)

## Problem

When a homeowner starts a large load — typically EV charging — they usually want
to power it from solar over-production and/or the grid, **not** from the Powerwall.
Today, if the Time-of-Use period is expensive, the Powerwall discharges to serve
the EV. That drains the battery for no benefit and leaves it low for later periods
when the home is in deficit.

The goal: a one-click control, living next to the existing **Load timing** widget
on the live page, that **holds the Powerwall at its current charge level** while the
big load runs, then **automatically restores** the previous backup reserve once the
load finishes.

This is, in effect, a load-aware version of Tesla's "Max Backup" — but built on the
cloud Fleet API, which has no Max-Backup-duration command of its own.

## Goals

- Hold the battery at (or above) its current state of charge on demand, so a large
  load is served by solar/grid instead of the battery.
- Auto-restore the original reserve when the load ends, detected by reusing the
  existing NILM load-signature detection.
- Manual "Restore now" override.
- A safety timeout backstop so the battery is never left parked indefinitely.

## Non-goals (MVP)

- No per-user/per-site configuration knobs (detection sensitivity, safety duration).
- No multiple concurrent holds per site — exactly one active hold per site.
- No LAN/local-gateway control. Cloud Fleet API only.
- No proactive scope pre-check UI; we handle a missing-scope `403` reactively with a
  reconnect prompt.

## Verified Tesla Fleet API behavior

Confirmed live against a real site (2026-05-24) using `scripts/set-backup-reserve.ts`:

| Input | Result |
| --- | --- |
| `reserve` ≤ 80 | Applied as requested. Response: `{"Code":200,"Message":"Backup reserve updated"}` |
| `reserve` 81–99 | **Clamped to 80.** Response reports it: `{"Code":200,"Message":"Max Backup Reserve: 80%..."}` |
| `reserve` = 100 | Applied. Backup-only behavior: holds high, does **not** discharge while grid is up. |
| Restore (e.g. 100→20) | Applied, confirmed. |

Key implications:
- The POST response `Message` reports the **effective** applied reserve. We confirm
  what took effect from the command response, not from the laggy `site_info` cache.
- `site_info.backup_reserve_percent` was accurate and fast (~5s) in testing, but its
  read-back is documented to lag minutes; we do not hard-depend on it.
- The `81–99 → 80` clamp is why holding above 80 must send **`100`** (sending the raw
  SoC would clamp to 80 — a partial discharge we don't want).
- The write requires the `energy_cmds` scope. Tokens issued before that scope was
  added (or invalid/expired tokens) return `403`/`401` and require re-auth via `/login`.

## Strategy: park target rule

At park time, read live SoC and current reserve, then choose the reserve to send:

```
floorSoc = Math.floor(SoC)
target   = floorSoc <= 80 ? floorSoc : 100
```

- SoC < 81 → send `floor(SoC)` (≤ 80): exact hold (≤ ~1% incidental discharge at the
  80–81 boundary, negligible).
- SoC ≥ 81 → send `100`: hold-high, never discharges (matches the user's manual
  "Max Backup" habit). This was the explicitly chosen behavior for the 81–99 band.

`original_reserve` (the reserve read before parking — always a previously-valid value,
i.e. ≤ 80 or 100) is what we restore to.

## Data model: `BatteryHold`

One row per hold. At most one `active` row per site. Raw-SQL repo, PascalCase quoted
identifier, consistent with existing tables.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint / serial PK | |
| `site_id` | text | FK → `Site(id)` |
| `status` | text | `active` \| `restored` \| `failed` |
| `original_reserve` | int | Reserve before park; restore target |
| `target_reserve` | int | Reserve we sent: `floor(SoC)` or `100` |
| `parked_soc` | numeric | Raw measured SoC at park (display/verification) |
| `baseline_load_w` | numeric | Home load (W) at park; anchor for return-to-baseline |
| `restore_reason` | text \| null | `load_ended` \| `manual` \| `safety_timeout` |
| `created_at` | timestamptz | Park time |
| `restored_at` | timestamptz \| null | When restore confirmed |
| `safety_expires_at` | timestamptz | `created_at + 16h` backstop |

Single-active-hold enforcement:

```sql
CREATE UNIQUE INDEX battery_hold_one_active_per_site
  ON "BatteryHold" (site_id) WHERE status = 'active';
```

Migration: timestamp-prefixed file in `db-migrations/`, idempotent (guarded
`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`).

Accessed via a thin `BatteryHoldRepo` (`getActiveHold(siteId)`, `createHold(...)`,
`markRestored(id, reason)`, `getAllActiveHolds()`).

## Components

### 1. Tesla client — done (`cba710e`)

`TeslaClient.setBackupReserve(siteId, percent)` → `POST /api/1/energy_sites/{id}/backup`,
validates integer 0–100, returns `EnergyCommandResponse { Code?, Message? }`. Read side
reuses `getLiveStatus` (live SoC + `load_power`) and `getEnergySiteInfo` (current reserve).

### 2. `lib/battery-hold-service.ts` — the cohesive core

- `parkBattery(siteId)`:
  1. Read `getLiveStatus` (SoC + `load_power`) and `getEnergySiteInfo` (current reserve).
  2. Guard: no existing active hold; SoC available; (scope errors surface as a typed result).
  3. Compute `target` (rule above); `setBackupReserve(siteId, target)`.
  4. Inspect response `Message`; if it indicates a clamp other than the intended target,
     log a warning (not expected — we only send valid values).
  5. Insert `active` hold row capturing `original_reserve`, `target_reserve`,
     `parked_soc`, `baseline_load_w = load_power`, `safety_expires_at`.
  6. Return a typed result (`ok` | `needs_reauth` | `no_soc` | `already_active`).

- `restoreBattery(siteId, reason)`:
  1. Load active hold; `setBackupReserve(siteId, original_reserve)`.
  2. On success, `markRestored(id, reason)`. On failure, leave `active` for retry; log.
  Used by both the manual button and the cron.

- `evaluateHold(hold, recentPower): { restore: true, reason } | null` — **pure**, the
  unit-tested decision core (see Detection).

### 3. Detection — reuses NILM `detectLoads`

`evaluateHold(hold, recentPower)`:

1. If `now >= hold.safety_expires_at` → `{ restore: true, reason: 'safety_timeout' }`.
2. Run `detectLoads(recentPower)` over `[parkedAt − 30min, now]`. Find the event whose
   `startTime ≈ parkedAt` (±20min) — the charging event. If that event has **closed**
   (`endTime <= now`) → `{ restore: true, reason: 'load_ended' }`.
3. Fallback (already-charging-at-park, so no rising edge near park): if the last ~15 min
   of samples are all `≤ baseline_load_w + tolerance` → `{ restore: true, reason: 'load_ended' }`.
4. Else `null` (keep holding).

Tolerances mirror `detectLoads`: `tolerance = max(400W, 20% of the event magnitude)`;
the closure check requires a sustained return to baseline (≥ ~10–15 min), so a brief
mid-charge lull does not false-trigger.

Why load, not SoC: while parked the battery sits flat at its reserve, so SoC barely
moves and carries no signal. Whole-home `load_power` (which includes the EV) is the only
observable that reflects whether the big load is still running.

### 4. Cron — `/api/cron/restore-reserve` (~every 15 min)

`vercel.json` entry `*/15 * * * *`, `CRON_SECRET` bearer auth (matching existing crons).
Per active hold:
1. Refresh today's `EnergyData` for the site (existing `refreshTodayData` / `Importer` path).
2. Load recent power samples (adapted to watts, as the analysis route does).
3. `evaluateHold`; if it returns a restore decision, `restoreBattery(siteId, reason)`.

Only does work when holds exist, so billable Tesla calls stay bounded. Detection latency
is ~5–15 min (5-min `EnergyData` resolution + cron cadence), acceptable here.

> Cadence assumes the Vercel plan permits sub-daily crons (Pro). If not, fall back to a
> coarser cadence or trigger evaluation opportunistically on live-page loads in addition.

### 5. API route — `/api/site/[id]/battery-hold`

- `POST { action: 'park' | 'restore' }` → calls the service. Authorized via
  `verifySiteAccess` / `site_auth` cookie (consistent with existing site routes).
- `GET` → current hold status for the widget to render and poll.
- A scope/`403` result returns a structured error (`{ error: 'needs_reauth' }`) so the
  UI can show a reconnect prompt rather than a generic failure.

### 6. UI — `BatteryHoldCard`

A new `SectionCard` placed next to "Load timing this cycle" in
`components/site/live/LiveDetailView.tsx`. The live page already fetches live SoC and can
fetch the active-hold status server-side and pass both as props; a client component
handles the POST, optimistic state, and light polling. States:

- **Idle** (SoC available, no active hold): shows current SoC and a primary action,
  "Hold battery at NN%" (NN = the effective target — the SoC, or "100% (max)" above 80).
- **Holding**: "Holding at NN% since <time>. Auto-restores to MM% when charging ends, or
  by <safety time>." Secondary action: "Restore now".
- **Needs reconnect** (`403`): "Reconnect your Tesla account to enable battery control" →
  link to `/login`.
- **Unavailable**: no live SoC or no tariff context → disabled with a short hint.

## Data flow

- **Park:** user clicks → `POST park` → service reads Tesla (SoC, reserve, load), sets
  reserve = target, writes `active` hold → UI shows "Holding".
- **Auto-restore:** cron (~15 min) → `evaluateHold` detects load ended (NILM) → service
  sets reserve = `original_reserve` → `markRestored('load_ended')`.
- **Manual restore:** `POST restore` → service restores → `markRestored('manual')`.
- **Safety:** cron sees `now >= safety_expires_at` → restore → `markRestored('safety_timeout')`.

## Error handling & edge cases

- **Invalid/expired token or missing `energy_cmds`** → `401`/`403`; surface
  `needs_reauth`; UI shows reconnect prompt. (Encountered live during design: the primary
  account's refresh token was invalid; re-auth via `/login` also (re)grants `energy_cmds`.)
- **SoC unavailable at park** → refuse with a message; do not write a hold.
- **Restore command fails in cron** → leave the hold `active`, retry next tick, log.
  Never lose `original_reserve` before a confirmed restore.
- **Clamp surprise** → if a write's response `Message` reports an effective value other
  than the intended target, log a warning (should not happen given the target rule).
- **Concurrency** → the partial unique index prevents a second active hold per site;
  `parkBattery` also checks first and returns `already_active`.

## Testing (TDD)

- Unit-test `evaluateHold` (pure): load-ended via closed NILM event; still-running;
  safety-expired; already-charging-at-park fallback; brief-lull does-not-trigger.
- Unit-test `parkBattery`/`restoreBattery` with a mocked `TeslaClient` + repo: target-rule
  branches (≤80, 81–99→100, =100), missing-scope → `needs_reauth`, no-SoC → refuse,
  single-active guard, restore marks the row.
- `detectLoads` is already covered.
- Route handler: auth gating + `park`/`restore` actions.

## Dependencies & sequencing

1. `setBackupReserve` — landed (`cba710e`).
2. `BatteryHold` migration + `BatteryHoldRepo`.
3. `battery-hold-service` + `evaluateHold` (TDD).
4. API route.
5. Cron + `vercel.json` entry.
6. `BatteryHoldCard` UI + wiring in `LiveDetailView` / the live page.

Requires the NILM `detectLoads` + `tesla-adapter` and the live-page load-timing UI, which
exist on `main`/`arch-review-2`. The implementation branch must include both those and the
`setBackupReserve` commit; the implementation plan will resolve the exact branch base.

## Open questions / future work

- **`reserve=100` hold vs top-up:** when SoC is, say, 90 and we send 100, does the
  Powerwall hold at 90 or grid-charge toward 100? Sources indicate "hold"; confirm by
  observation on a live hold during implementation. Either way it never discharges (the
  primary goal).
- **Live-polling detection (future):** a `getLiveStatus`-based cron would cut detection
  latency at the cost of more billable calls — deferred.
- **Per-site config (future):** safety duration and detection sensitivity as settings.
