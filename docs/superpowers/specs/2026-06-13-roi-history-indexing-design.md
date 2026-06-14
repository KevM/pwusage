# ROI History Indexing — Opt-In Backfill, Gap Healing & Egress-Aware Rollup

**Date:** 2026-06-13
**Status:** Design approved, pending spec review
**Branch context:** `feat/roi` — builds on the Phase 1 battery-provenance foundation and the Phase 2 ROI report (`2026-06-13-roi-report-design.md`). Depends on the durable `EnergyRollup` (incl. the Phase 2 `solar_only_*` columns) and the `RollupService` / `replayRows` write path.

## Problem

The ROI / Savings report computes lifetime payback by folding **durable `EnergyRollup`** rows. But a site only has rollups for the days it was actually processed:

- `rollupDay` is invoked from exactly one place — `cron/rollup` — and only ever for **yesterday**, for whatever `EnergyData` happens to exist. (This spec also moves that cron to an hourly, timezone-aware cadence — see below.)
- `EnergyData` (the 5-min source) is **activity-driven**: it is imported only on page loads (`/api/import`, `/api/sync`, `/site/[id]/live`) and the restore-reserve cron (battery-hold sites only). Nothing imports it for a dormant site.
- `EnergyData` older than `DATA_RETENTION_DAYS` (default 365) is purged by `cron/cleanup`; the durable rollup is what survives.

Consequences:

1. **New users** have no history before signup, even though Tesla retains their full history back to install. Lifetime payback is meaningless without it.
2. **Existing users** may never have had a rollup run, or only have a partial range.
3. **Dormant periods** leave holes — both historical and ongoing — and the nightly cron structurally cannot backfill a multi-day gap (it only does yesterday).
4. The Phase 2 `solar_only_*` columns default to `0` on pre-existing rollup rows and must be recomputed by re-running the replay.

We need a way to reconstruct a site's **complete, continuous** rollup history from install to yesterday, on demand, without exhausting Tesla API quota or database egress.

## Goal

An **opt-in, gradual, self-healing history indexer**:

- A site is indexed only when its owner opts in (the report is gated on `SiteRoiConfig` anyway). No proactive fleet-wide Tesla spend.
- Indexing re-fetches 5-min history from Tesla back to install and replays it into durable rollups, **oldest → newest**, throttled to a few sites' worth of progress per day.
- Once indexed, a site **self-heals** dormancy gaps on its next Savings-tab visit.
- The nightly cron is hardened so it never persists a rollup computed from partial data.
- The backfill minimizes DB egress by rolling up from rows already held in memory after the Tesla fetch.

## Key facts that shape the design

- **Tesla retains full history regardless of our activity.** Any un-indexed range — pre-signup history or a dormancy gap — is recoverable by re-fetching. A gap is just an un-indexed range.
- **The replay is sequential.** Genesis anchors a full battery at the earliest day; the tank (provenance Wh + cost basis) carries forward via `getSeedTank`. Backfill must walk **forward** from `oldest_date`, and a gap heal must re-replay *through* the gap to re-chain the tank for the days after it.
- **`ensureDataForRange` ≠ rollup.** It only writes raw `EnergyData`; producing the rollup is a separate `rollupDay` call. The worker does both, per day.
- **`planImport` already skips complete days.** It re-fetches a day only when `count === 0 || forceRefetch || missingStart || missingEnd` (`import-planner.ts`). A complete, already-rolled day costs **zero Tesla**; the rollup on top is an idempotent upsert. Safe to call liberally.
- **The importer can fetch without persisting.** `fetchRange` (`importer/index.ts`) pulls history from Tesla and runs `processHistory` (a pure transform), returning rows **without** the `insertEnergyDataBatch` write that `ensureDataForRange`/`loadInterval` perform. So a pre-retention day can be reconstructed Tesla → memory → rollup with **no `EnergyData` written or read** — which is what removes the bloat/cleanup concern entirely.

## Data model — `RollupBackfill` (new table)

One **permanent** row per opted-in site. It is the site's coverage ledger and the cursor for resumable work. Coverage is tracked by the cursor, **not** inferred from which rollup rows exist (a day with no Tesla data must not look perpetually "missing").

```
site_id      text         PK, FK → Site
status       text         NOT NULL   -- 'pending' | 'running' | 'complete' | 'error'
oldest_date  date         NOT NULL   -- floor; = site.installed (planImport also floors here)
cursor_date  date         NOT NULL   -- next local day to process; walks forward
newest_date  date         NOT NULL   -- ceiling; = yesterday at (re)enroll time
days_done    integer      NOT NULL DEFAULT 0
days_total   integer      NOT NULL DEFAULT 0   -- for UI progress
last_error   text         NULL
created_at   timestamptz  NOT NULL DEFAULT now()
updated_at   timestamptz  NOT NULL DEFAULT now()
```

Invariants:
- Processed range is `[oldest_date, cursor_date)`. `status = 'complete'` ⟺ `cursor_date > newest_date`.
- The cursor advances **regardless of whether a day yielded rollup rows** (empty/no-data days are processed-and-skipped, never re-flagged).
- The row is never deleted; `status` cycles `complete → pending` when a heal re-opens it.

Migration created via `npm run db:migration:create rollup_backfill` (idempotent, per repo convention).

## Opt-in — `POST /api/site/[id]/index-history`

- Authz: `verifySiteAccess(siteId)`.
- Upserts a `RollupBackfill` row: `oldest_date = site.installed`, `cursor_date = oldest_date`, `newest_date = yesterday (site-local)`, `status = 'pending'`, `days_total = newest_date − oldest_date`.
- Idempotent: if a row exists and is `running`/`pending`/`complete`, no-op (or, for `complete`, treat as a heal — see below). An `error` row is reset to `pending` (retry).
- This is the **only** way a site's first index begins. No auto-enrollment, no activity scan.

## Worker — `GET /api/cron/index-history`

Driven by Supabase **pg_cron** every 15 min, mirroring the `restore-reserve` trigger: a new vault secret `index_history_cron_target_url` + reused `cron_secret`; `net.http_get` with the bearer header. Auth: `Authorization: Bearer ${CRON_SECRET}`.

**Time limits — what actually bounds a tick.** The pg_cron job only enqueues a `net.http_get`; **pg_net is fire-and-forget** (async background worker, statement returns in ms), so no Postgres statement/cron time limit applies — the work runs entirely in the Vercel function. The real bound is therefore the **Vercel function timeout (300s default)**; the route sets `export const maxDuration = 300` to claim the full budget. pg_net's own HTTP timeout (default ~5s) will log a "timeout" in `net._http_response` whenever the worker runs longer — this is a **cosmetic log artifact only**: the function keeps running and commits its work, and the worker is resumable, so a dropped/timed-out response loses nothing. (Optionally raise `timeout_milliseconds` in the `net.http_get` call to keep the log clean; correctness never depends on pg_net waiting.)

Per tick, within a bounded budget:

1. **Pick work.** Select sites with `status IN ('pending','running')`, FIFO by `created_at` (a heal and a first index are equal-priority; both are user-initiated). Process up to `INDEX_HISTORY_SITES_PER_TICK` (default 1).
2. **Lock.** `pg_try_advisory_lock(hashtext(site_id))` so overlapping ticks never double-process a site; if not acquired, skip to the next site. Set `status = 'running'`.
3. **Walk forward** from `cursor_date` until **whichever comes first** — `INDEX_HISTORY_DAYS_PER_TICK` (default ~45) days processed, a **~250s wall-clock budget** elapsed (so a slow Tesla run exits cleanly before the 300s hard kill), or `cursor_date > newest_date`:
   - **Pre-retention day** (older than the retention cutoff, i.e. the multi-year tail being reconstructed): **`fetchRange(site, dayStart, dayEnd)`** — pull from Tesla, transform in memory, and feed the rows **straight into the replay**. `fetchRange` runs `processHistory` (a pure transform) and returns rows **without ever persisting `EnergyData`**, so these days have **zero `EnergyData` footprint** — no write, no read-back. This is the dominant case and the reason there is no bloat and no cleanup interaction.
   - **Within-retention day** (newer than the cutoff): keep the normal path — read the existing day from the DB if present, else `ensureDataForRange` to **persist** it (recent `EnergyData` legitimately lives in the DB for live views / NILM / battery-hold). `planImport` fetches only the missing slice (free if already complete). Then roll up. These DB reads are the only residual egress and are bounded to ~the last year.
   - **Genesis:** pass `forceGenesisAtStart = (cursor_date === oldest_date)` so the install day anchors a full battery even when later (nightly-produced) rollups already exist for the site.
   - Advance `cursor_date += 1 day`, `days_done += 1`, and **commit this progress incrementally** (per day, or in small batches) — so an unexpected hard timeout loses at most the in-flight day and the next tick resumes from the committed cursor.
4. **Finalize.** If `cursor_date > newest_date` → `status = 'complete'`. On any error → `status = 'error'`, `last_error = …`, **cursor preserved** (already committed) so it resumes next tick. Because progress is committed incrementally, neither the Vercel timeout nor a pg_net drop can roll back completed days.
5. Release the advisory lock (auto-released on connection close regardless).

At `*/15` this is ~96 ticks/day; chunk-size × frequency is the Tesla throttle. Knobs: `INDEX_HISTORY_DAYS_PER_TICK`, `INDEX_HISTORY_SITES_PER_TICK`, pg_cron schedule.

### RollupService / replay change

`RollupService.rollupDay` gains an optional **pre-loaded-rows** path and a `forceGenesisAtStart` flag:

- When rows are supplied (the pre-retention `fetchRange` path), skip `loadEnergyData` entirely — roll up directly from the in-memory rows; still read the (tiny) seed tank via `getSeedTank`.
- `forceGenesisAtStart` makes the genesis branch fire on the first backfilled day even though `hasAnyRollup(site)` is true (the normal case when re-indexing a site that already has forward rollups). Without it, that day would seed `EMPTY_TANK` and corrupt the whole chain. **This is the single most important correctness test.**

`fetchRange` returns `EnergyDataRow[]` (importer output); the replay consumes `EnergyData`. Reconcile the shapes with a thin adapter or a shared type — verified in tests. (`fetchRange` returns Tesla's full-day rows unfiltered; the replay buckets by local date, and `rollupDay` already filters its output to the target `localDate`, so a day's rows map cleanly.)

## Heal on return — cursor-based, on Savings-tab load

When the report loads server-side, after reading `SiteRoiConfig` + `RollupBackfill`:

- **No `RollupBackfill` row** → don't enqueue; the UI shows the **"Index history"** opt-in. (First index always requires the explicit opt-in.)
- **Row `complete` but `newest_date < yesterday`** (site-local) → re-open: set `newest_date = yesterday`, `status = 'pending'`, bump `days_total`. `cursor_date` is already parked at the first unprocessed day (the first dormant day), so the worker resumes there and walks through the gap to yesterday, re-chaining the tank across it and re-rolling any nightly-produced tail (idempotent).
- **Row `running`/`pending`** → show progress; nothing to do.

No gap-detection SQL: the cursor *is* the coverage high-water mark, so trailing dormancy gaps are detected by a single date comparison. (Interior gaps cannot form after a day is processed, because durable rollups never disappear.)

Interim correctness while a heal is pending: the nightly cron seeds the just-returned days from the stale pre-gap tank, so provenance/arbitrage is briefly off for those days; the heal corrects it. Lifetime *payback* (no provenance needed) is simply missing the gap days until healed.

## Hourly, timezone-aware rollup cron — never persist a partial-day rollup

`cron/rollup` changes from a single `0 8 * * *` UTC run to **hourly** (`0 * * * *`), processing each site ~1–2 h after **its own** local midnight rather than at one global UTC time. This guarantees the day being rolled is fully elapsed and published by Tesla (directly mitigating the partial-day risk), and it spreads Tesla/DB load into timezone waves instead of an 8am-UTC thundering herd.

### Site selection (DST-safe)

Each hourly run selects only the sites currently in an early-morning **band** in their own timezone:

```
EXTRACT(hour FROM now() AT TIME ZONE site.timezone) BETWEEN 2 AND 5
```

- A **band**, not an exact hour, so DST "spring forward" (which skips 2am) can never cause a site to miss its window; half-hour zones (e.g. UTC+5:30) still land in the band.
- For each selected site, the target day is **yesterday (site-local)**, but it is **skipped if it already has a complete rollup**. That completeness check is the natural dedup: the first qualifying hour rolls the day; later hours in the band no-op. Idempotent upsert covers any DST "fall back" double-touch.
- Only ~1/24 of sites match each run (cheap `WHERE` filter), so total daily work is unchanged — just redistributed.

### Per-day rule (unchanged)

For the selected (site, yesterday-local) the action is keyed on that day's existing `EnergyData`:

| Day's existing data | Action |
|---|---|
| **None** (`count === 0`) | Do nothing — no import, no rollup. Dormant day; deferred to heal-on-return. |
| **Partial** (`count > 0` but `missingStart`/`missingEnd`) | `ensureDataForRange` to **finish the day** (planImport fetches only the missing slice), then `rollupDay` on complete data. |
| **Complete** | `rollupDay` directly — zero Tesla. |

Rationale: partial data exists **only because the user was active that day** (a load triggered the 14-day auto-import, leaving the in-progress day partial). We therefore spend Tesla *only to finish a day the user already started* — never on a fully dormant day, and never persisting a partial rollup. Safety net: if the finish-import still cannot complete the day (rare Tesla lag), skip the rollup; a later hourly run or a heal catches it.

This makes the dangerous "present-but-wrong" partial rollup impossible — every missing day is *absent* (cursor/heal-detectable), never silently incorrect.

## Egress & storage strategy

DB egress/footprint ≈ 5-min `EnergyData` rows shipped to/from Node (~288/day). The rollup *output* and report reads are negligible by comparison.

- **Pre-retention days never touch `EnergyData` at all.** The dominant case — the multi-year tail — uses `fetchRange` (Tesla → memory → replay → upsert rollup), so it incurs **no `EnergyData` read and no write**. This is also what makes the backfill completely independent of `cron/cleanup`: there is no scratch data to bloat the table or to race the cleanup (see below).
- **Residual reads are bounded** to within-retention days that are already in the DB (read during the initial index) plus the small per-day rollup-cron read. These are the legitimately-retained recent rows.
- The replay stays in **TypeScript** (one tested source of truth). A full in-DB (PL/pgSQL) rollup that would eliminate *all* residual read egress is explicitly **deferred** — it would duplicate the tank cost-basis logic in SQL with high divergence risk; revisit only if residual egress proves prohibitive.

## UI — Savings tab

Reads `RollupBackfill` alongside `SiteRoiConfig`:

- **No row** → **"Index history"** button (`POST /api/site/[id]/index-history`), with a note that it runs in the background and may take a while for long histories.
- **`pending`/`running`** → progress: "Indexing your history…" with `days_done / days_total` and the current `cursor_date`.
- **`complete`** → the normal ROI report. (A `complete` row with `newest_date < yesterday` is re-opened on load per heal-on-return, then renders as `running`.)
- **`error`** → a retry affordance (re-`POST` resets to `pending`).

## Admin — indexing status in the site list

The admin dashboard (`AdminDashboard.tsx`, fed by `UserRepo.getAllUsers()`) is a per-user table whose **Sites** column lists each user's sites. Augment that column so an admin can see, at a glance, where every site sits in the migration and drill into the details on hover.

### Data

Extend the admin query to include each site's `RollupBackfill` summary (a `LEFT JOIN "RollupBackfill" ON site_id`, so un-opted-in sites come back `NULL`). Per site, surface: `status`, `oldest_date`, `cursor_date`, `newest_date`, `days_done`, `days_total`, `last_error`, `updated_at`. Egress/perf is negligible — admin-only, one small row per opted-in site. Authz is the existing `isUserAdmin()` gate; no new endpoint.

### UI — status badge + hover details

Beside each site name, render a compact **status badge** derived from the row:

| Row state | Badge | Tone |
|---|---|---|
| no row | "Not indexed" | muted |
| `pending` | "Queued" | neutral |
| `running` | "Indexing N%" (`days_done/days_total`) | in-progress |
| `complete` | "Indexed" | success |
| `error` | "Error" | danger |

On **hover**, a tooltip shows the migration detail:
- `status`, percent complete (`days_done / days_total`)
- current `cursor_date`, and the full range `oldest_date → newest_date`
- `updated_at` (last progress) and, if `status = 'error'`, `last_error`

The tooltip mechanism follows existing UI primitives (a lightweight popover or native `title`); content is the contract here, not the widget. This is read-only — no admin action to start/stop a migration in v1 (the worker self-drives; opt-in is user-initiated).

## Concurrency & interaction notes

- **Worker vs worker:** advisory lock per site.
- **Worker vs rollup cron:** both call idempotent `rollupDay`. The backfill operates on historical dates behind `newest_date`; the hourly cron fires per site shortly after its local midnight on a separate cadence, so the two rarely coincide, and when they do the idempotent upsert makes it a harmless re-write. No `newest_date` offset is needed — idempotency is the guarantee.
- **`cron/cleanup`: untouched, no coordination.** Because pre-retention days are reconstructed via `fetchRange` (in-memory, never persisted), the backfill writes **no** scratch `EnergyData`. So there is nothing to bloat the table and nothing for cleanup to delete out from under an in-flight, multi-day backfill — the cleanup race simply cannot occur. No per-site suppression, no proactive scratch-delete, no awareness of `RollupBackfill` in the cleanup job.

## Testing

- **Opt-in route:** creates the row with correct bounds; idempotent on existing `pending`/`running`/`complete`; resets `error` → `pending`; `verifySiteAccess` enforced.
- **Worker:** advances cursor by the chunk budget; **stops at the ~250s wall-clock guard even when days remain under the day cap**; commits cursor incrementally so a simulated mid-tick abort resumes from the last committed day with no lost/duplicated work; resumes from `cursor_date` across ticks; marks `complete` at `newest_date`; error path sets `status='error'` + `last_error` and **preserves** the cursor; advisory lock prevents concurrent double-processing.
- **Genesis force-anchor (critical):** with later rollups already present for the site, the first backfilled day (`cursor === oldest_date`) anchors a full battery rather than `EMPTY_TANK`; the tank chains correctly forward.
- **Pre-retention fetch-only:** a pre-retention day rolls up from `fetchRange`'s in-memory rows with **no `EnergyData` read or write** (assert neither `loadEnergyData` nor `insertEnergyDataBatch` is called); a within-retention day reads/persists via the normal DB path.
- **Heal-on-return:** a `complete` row with `newest_date < yesterday` is re-opened from the parked cursor; the worker re-rolls the gap and re-chains the tank; a no-data day in the gap advances the cursor without re-flagging.
- **Hourly timezone selection:** a site is selected only when its local time is in the 2–5 band; selection is DST-safe (spring-forward day still selects within the band); a site already holding a complete yesterday-local rollup is skipped (dedup across band hours); half-hour-offset zones land in the band.
- **Partial/empty/complete rule:** empty day → no import, no rollup; partial day → finish-import then roll a complete day; complete day → roll with zero Tesla; finish-import that still can't complete → skip (no partial rollup persisted).
- **Admin status:** the admin query LEFT-JOINs `RollupBackfill` (un-opted-in sites → no row → "Not indexed"); badge state maps correctly for each status; `running` shows the right percent; the hover detail includes cursor/range/updated_at and surfaces `last_error` on `error`.
- **Idempotency:** re-running any processed day yields identical rollup rows (incl. `solar_only_*`).
- **Integration:** a synthetic multi-day site indexed end-to-end produces continuous rollups with correct `solar_only_*` and a continuous tank chain across a seeded gap.

## Out of scope / deferred

- **Full in-DB (PL/pgSQL) rollup** — deferred behind measured residual egress.
- **Interior intra-day holes** from Powerwall outages (the completeness check guards trailing partial days, not mid-day gaps) — a separate data-quality concern.
- **Proactive nightly indexing of dormant sites** — explicitly rejected; healing is on-return only.
- **Auto-enrollment / launch migration** — rejected in favor of pure opt-in.

## Resolved decisions (from brainstorming)

1. **Trigger:** explicit per-site opt-in ("Index history"); no auto-enrollment, no launch migration.
2. **Depth:** full history, re-fetched from Tesla back to `site.installed`.
3. **Enrollment scope:** any site whose owner opts in (new or existing, active or dormant).
4. **Orchestration:** Supabase pg_cron every 15 min → bounded, resumable worker endpoint (reuses the restore-reserve pattern).
5. **Coverage model:** cursor-based ledger (`RollupBackfill`), not rollup-row inference — robust to no-data days.
6. **Gap healing:** on Savings-tab load, re-open a `complete` row when `newest_date < yesterday`; the parked cursor resumes through the gap.
7. **Partial-day safety:** the rollup cron finishes partial days before rolling and skips empty days, so a partial rollup is never persisted.
7b. **Rollup cadence:** `cron/rollup` moves to hourly, processing each site ~1–2 h after its own local midnight via a DST-safe 2–5 local-hour band with complete-day dedup; replaces the single 8am-UTC run and removes the need for a `newest_date` boundary offset.
8. **Egress & cleanup:** reconstruct pre-retention days via `fetchRange` (Tesla → memory → rollup, never persisting `EnergyData`), so the backfill has zero scratch footprint and `cron/cleanup` needs no coordination; keep the replay in TypeScript; defer the full in-DB rollup.
9. **Genesis:** `forceGenesisAtStart` when `cursor === oldest_date` so re-indexing a site that already has forward rollups anchors correctly.
10. **Admin visibility:** the admin site list shows a per-site indexing badge with hover details (read-only in v1), via a `LEFT JOIN "RollupBackfill"` on the existing admin query.
