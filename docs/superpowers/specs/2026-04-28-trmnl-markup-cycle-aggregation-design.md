# Trmnl Markup Cycle Aggregation Design

**Date:** 2026-04-28
**Branch:** `worktree-reduce-db-egress`
**Status:** Design approved, ready for implementation plan

## Problem

`/api/trmnl/markup` runs every 15 minutes per Trmnl device. On each call it executes `getRawEnergyData(siteId, billingStart, now)` — a `SELECT *` against `EnergyData` for the entire current billing cycle (up to ~30 days at 5-minute resolution). That returns ~8,640 rows / ~1.3 MB per call. At ~96 calls/day per device, this single endpoint produces roughly **125 MB/day per device** of database egress, and the project is hitting Supabase's free-tier egress limits.

The route only uses these rows to compute per-(tariff, TOU period) totals for the current cycle's bill, plus today's chart and today's totals. The bill aggregation does not need 5-minute resolution; the chart does.

## Goal

Reduce the egress from `/api/trmnl/markup` by an order of magnitude in a way that preserves correctness across all users (some of whom may have non-trivial TOU schedules), without requiring complex schedule-matching SQL or a maintained rollup table.

## Approach

Add a `tariff_schedule_id` column to `EnergyData` populated at write time using the existing `Schedule` class. With each row pre-stamped, the cycle bill query becomes a simple `GROUP BY date_trunc('day', timestamp), tariff_id, tariff_schedule_id` returning ~90 rows per cycle. The markup route splits its data fetch into "today raw" (for chart and live totals) and "prior days aggregated" (for the cycle bill).

The work ships as **three sequential PRs**, each independently safe to land and revert:

1. Schema + importer change
2. Backfill script (one-off, run after PR 1 deploys)
3. Read-side query change (the actual egress win)

Steps 1 and 2 are setup with no behavior change for users. Step 3 lands the egress reduction.

## PR 1: Schema + importer

### Schema migration

New file: `cmd/next-app/db-migrations/<timestamp>_add_energy_data_tariff_schedule.sql`

```sql
ALTER TABLE "EnergyData"
  ADD COLUMN IF NOT EXISTS tariff_schedule_id INTEGER
  REFERENCES "TariffSchedule"(id) ON DELETE SET NULL;
```

**Why nullable:** historical rows start as NULL until backfilled; `Schedule.getTariffPeriod` can also legitimately return null when no schedule matches a timestamp (gap in the tariff config). The read-side handles NULL by routing into the existing "Unknown" TOU bucket.

**Why `ON DELETE SET NULL`:** `Importer.setupTariffs` deletes and recreates `TariffSchedule` rows on tariff re-import (see `importer.ts:428-429`), so schedule IDs are not stable across imports. `SET NULL` lets historical rows survive a re-import and either get re-stamped by the next backfill run or fall through the "Unknown" bucket. CASCADE would silently delete history; RESTRICT would block legitimate tariff updates.

**Index strategy:** no new index required. The aggregate query (`WHERE site_id = $1 AND timestamp >= $2 AND timestamp < $3 GROUP BY ...`) uses the existing `idx_energy_site_ts(site_id, timestamp)` for the range scan; grouping happens in memory. Revisit only if `EXPLAIN` shows a regression.

**Idempotency:** `ADD COLUMN IF NOT EXISTS` makes the migration safe to re-run.

### Importer change

In `cmd/next-app/src/lib/importer.ts`, modify `insertEnergyData` (currently lines 816-925):

- After the tariff remapping loop, construct a `Schedule` once per call from `site.tariffs` and `site.timezone` (the function already receives `SiteWithTariffs site`).
- For each row, compute `tariff_schedule_id` as `schedule.getTariffPeriod(row.timestamp)?.schedule.id ?? null`.
- Extend per-row placeholders from 8 columns to 9; append the schedule ID to the values array.
- Add `tariff_schedule_id` to the INSERT column list and to the `ON CONFLICT DO UPDATE` set, **always overwriting** with `EXCLUDED.tariff_schedule_id` (no `COALESCE`). Rationale: re-imports should re-stamp rows whose FK was nulled by an earlier tariff change; if the schedule lookup legitimately returns null now, that's the correct value.

`Schedule` is constructed once per insert call rather than per row (it's pure with no I/O, but instantiation across thousands of rows in a tight loop would still be wasteful).

### Tests

The schedule-matching logic is already covered by tests on the `Schedule` class. PR 1 needs only a smoke check that newly-inserted rows have `tariff_schedule_id` populated end-to-end — folded into the PR 3 read-side test fixtures rather than added separately here.

### Rollback

Revert the migration (`ALTER TABLE "EnergyData" DROP COLUMN IF EXISTS tariff_schedule_id`) and the importer code change. New rows lose their schedule_id but everything else continues working.

## PR 2: Backfill script

### Location and run

- File: `cmd/next-app/scripts/backfill-tariff-schedule.ts`
- Run: `npx tsx scripts/backfill-tariff-schedule.ts`
- Per `Agents.md`, scripts must load `.env` explicitly via `dotenv` at the top.

### Scope

Last 45 days only. Billing cycles are monthly (≤31 days), so 45 days covers any in-flight cycle with margin. At 5-minute resolution this is ~13,000 rows per site — fast enough to process all sites sequentially in seconds.

### Algorithm

For each site:

1. Load the site with tariffs (`EnergyRepo.getSite`) and construct `Schedule` from its tariffs and timezone.
2. `SELECT id, timestamp FROM "EnergyData" WHERE site_id = $siteId AND timestamp >= $cutoff AND tariff_schedule_id IS NULL`.
3. In memory, group the row IDs by the schedule ID each row should receive (`schedule.getTariffPeriod(timestamp)?.schedule.id`).
4. For each schedule_id bucket, `UPDATE "EnergyData" SET tariff_schedule_id = $schedId WHERE id = ANY($ids::int[]) AND tariff_schedule_id IS NULL` in chunks of 1000 IDs.
5. Log a one-line summary per site: `scanned=N updated=M unmatched=K`.

### Idempotency and safety

- The `SELECT` filter and the `UPDATE` predicate both check `tariff_schedule_id IS NULL`, so re-runs do not re-process already-stamped rows and a concurrent importer write between SELECT and UPDATE will not be clobbered.
- Rows where `Schedule.getTariffPeriod` returns null are left as NULL and counted as `unmatched`. They flow through the read-side "Unknown" bucket — same behavior as today.
- Sequential per-site, no parallelism. With ~50 sites worst case the run finishes in seconds; parallelism is premature.
- The script closes the connection pool at the end so `npx tsx` exits cleanly.

### Sequencing relative to deploys

PR 2 lands the script but does not run it. The script is run manually (or via a one-off operator action) after PR 1 has deployed and the importer is populating new rows. Running the script before PR 1 deploys is a no-op (the column doesn't exist).

### Rollback

The script is self-contained — there's nothing to "roll back" beyond reverting the file. Re-running the script with rows already stamped is safe (idempotent).

## PR 3: Read-side query change

### New repo method

In `cmd/next-app/src/lib/energy-repo.ts`:

```ts
interface CycleAggregateRow {
    day: Date;
    tariff_id: number;
    tariff_schedule_id: number | null;
    load_power: number;
    solar_power: number;
    grid_power: number;
    battery_power: number;
}

async getCycleAggregates(
    siteId: string, start: Date, end: Date
): Promise<CycleAggregateRow[]> {
    const res = await pool.query(`
        SELECT
            date_trunc('day', timestamp) AS day,
            tariff_id,
            tariff_schedule_id,
            SUM(load_power) AS load_power,
            SUM(solar_power) AS solar_power,
            SUM(grid_power) AS grid_power,
            SUM(battery_power) AS battery_power
        FROM "EnergyData"
        WHERE site_id = $1 AND timestamp >= $2 AND timestamp < $3
        GROUP BY day, tariff_id, tariff_schedule_id
        ORDER BY day ASC
    `, [siteId, start, end]);
    return res.rows.map(row => ({
        day: new Date(row.day),
        tariff_id: Number(row.tariff_id),
        tariff_schedule_id: row.tariff_schedule_id == null ? null : Number(row.tariff_schedule_id),
        load_power: Number(row.load_power),
        solar_power: Number(row.solar_power),
        grid_power: Number(row.grid_power),
        battery_power: Number(row.battery_power),
    }));
}
```

`battery_soc` is intentionally not aggregated. Display SoC for the markup already comes from `getLatestEnergyData` and the live-status cache — never from prior-cycle rows.

### Markup route changes

Replace the single `getRawEnergyData(siteId, start, now)` call with two queries running in parallel:

```ts
const todayStart = EnergyRepo.getSiteMidnight(now, tz);

const [latestData, priorAggregates, todayRaw] = await Promise.all([
    repo.getLatestEnergyData(site.id),
    repo.getCycleAggregates(site.id, start, todayStart),
    repo.getRawEnergyData(site.id, todayStart, now),
]);
```

The existing single aggregation loop becomes two passes:

- **Today's raw rows** keep the current logic verbatim. They populate `seriesData` for the chart, contribute to `todayHome/Grid/Solar` totals, drive `latestSeriesSoc`, and bucket into TOU periods via `schedule.getTariffPeriod(row.timestamp)`. Bounded at ~288 rows.
- **Prior-day aggregates** use a simpler loop: each row already carries `tariff_id` and `tariff_schedule_id`, so we look up the `TariffSchedule` from a small ID-keyed map built once from `site.tariffs` and bucket the pre-summed power values directly. No per-row schedule matching needed.

The downstream aggregation map (`Map<key, {homeUsage, gridUsage, solarProduction, batteryChange, ...}>`) and the bill-cost computation are unchanged — they still iterate the per-(tariff, TOU period) buckets and produce the same `tariffGroups` shape for the renderer.

### Handling NULL `tariff_schedule_id`

Rows older than the 45-day backfill window or with no matching schedule will have `tariff_schedule_id = NULL`. They naturally form a single `(tariff_id, NULL)` group from the SQL aggregation. On the JS side they go through the existing `'Unknown'` fallback path — same behavior the current code produces today when `getTariffPeriod` returns null. No new branching logic.

### Tests

- New unit test for `getCycleAggregates`: insert a known set of rows (including a row with NULL `tariff_schedule_id`), assert the returned aggregation matches hand-computed sums for each `(day, tariff_id, tariff_schedule_id)` bucket.
- Update or add a markup route test that uses two fixtures: prior-day rows that get aggregated + today rows raw. Assert `totalCost` and `tariffGroups` shape match the pre-change output for the same input.

### Rollback

Revert the route change. The old query path (`getRawEnergyData` over the entire cycle) still works — the new column is unused by the old code. PR 3 can be reverted independently of PR 1 and PR 2.

## Egress impact

Per Trmnl markup call, `EnergyData` rows on the wire drop from ~8,640 to ~378 (~288 today raw + ~90 prior aggregates). With column projection in the aggregate query (`SUM(...) AS ...` returns only the requested columns), wire size goes from ~1.3 MB to roughly 60 KB — **~20× reduction on the heaviest call**. Multiplied by ~96 calls/day per device, daily egress from this endpoint goes from ~125 MB to ~6 MB per device.

## Success criteria

- After PR 1 deploys: every newly-inserted `EnergyData` row has a non-null `tariff_schedule_id` (verifiable via `SELECT count(*) FROM "EnergyData" WHERE timestamp > now() - interval '1 hour' AND tariff_schedule_id IS NULL`).
- After backfill runs: `tariff_schedule_id IS NULL` count for rows in the last 45 days is dominated by legitimately-unmatched timestamps (gaps in tariff config), not by un-processed rows.
- After PR 3 deploys: Supabase egress dashboard shows a drop in egress attributable to the markup endpoint within 24-48 hours of the deploy, on the order of the predicted ~95% reduction (~125 MB/day → ~6 MB/day per device). Markup route's existing `Server-Timing` headers (`db_cycle;dur=`) should also drop substantially since `getCycleAggregates` returns ~20× fewer rows than the previous full-cycle query.

## Out of scope / follow-ups

These were identified in the same audit and are tracked in [`TODO.md`](../../../TODO.md):

- Replace `SELECT *` with column projection in `getRawEnergyData` (and `getRawEnergyDataWithTz`)
- Lower `HeaderLiveStats` polling cadence and pause when tab is hidden
- Aggregate sparkline data in SQL for `/api/site-live-data`

These will be picked up after the present work lands and the egress impact is validated. Larger structural changes (introducing historical `Tariff`/`TariffSeason`/`TariffSchedule` rather than overwriting on re-import) are deliberately out of scope — `ON DELETE SET NULL` plus the backfill cycle handles the local case adequately.
