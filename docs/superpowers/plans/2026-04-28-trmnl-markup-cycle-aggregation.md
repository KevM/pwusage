# Trmnl Markup Cycle Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `/api/trmnl/markup` database egress by ~95% by stamping each `EnergyData` row with its TOU schedule at write time, then aggregating prior-day data in SQL instead of pulling raw 5-minute rows.

**Architecture:** Three sequential PRs. PR 1 adds a nullable `tariff_schedule_id` FK column to `EnergyData` and updates the importer to populate it. PR 2 ships a one-off backfill script for the last 45 days of historical rows. PR 3 adds a `getCycleAggregates` repo method and switches the markup route to fetch today's 5-minute rows raw + prior-cycle days as `GROUP BY` aggregates.

**Tech Stack:** Next.js 16 (App Router), TypeScript, PostgreSQL via `pg`, Vitest for tests, `npx tsx` for scripts.

**Spec:** `docs/superpowers/specs/2026-04-28-trmnl-markup-cycle-aggregation-design.md`

**Working directory for all tasks:** `cmd/next-app/`

---

## PR 1 — Schema + Importer

### Task 1.1: Create the schema migration

**Files:**
- Create: `cmd/next-app/db-migrations/<timestamp>_add_energy_data_tariff_schedule.sql` (use `date +%Y%m%d_%H%M%S` for the prefix)

- [ ] **Step 1: Create the migration file**

```bash
cd cmd/next-app
touch db-migrations/$(date +%Y%m%d_%H%M%S)_add_energy_data_tariff_schedule.sql
```

- [ ] **Step 2: Write the migration**

```sql
-- Add tariff_schedule_id to EnergyData for cycle aggregation queries.
-- Nullable: historical rows are unstamped until backfill runs; getTariffPeriod
-- can also legitimately return null when no schedule matches a timestamp.
-- ON DELETE SET NULL: TariffSchedule rows are deleted/recreated by tariff
-- re-imports, so existing EnergyData rows must survive that.

ALTER TABLE "EnergyData"
  ADD COLUMN IF NOT EXISTS tariff_schedule_id INTEGER
  REFERENCES "TariffSchedule"(id) ON DELETE SET NULL;
```

- [ ] **Step 3: Apply locally and verify**

Run (replace `$DATABASE_URL` with your local value):
```bash
supabase migration up --db-url "$DATABASE_URL"
```

Verify the column exists:
```bash
psql "$DATABASE_URL" -c '\d "EnergyData"' | grep tariff_schedule_id
```

Expected: a line showing `tariff_schedule_id | integer` and the FK reference to `TariffSchedule(id)`.

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/db-migrations/*_add_energy_data_tariff_schedule.sql
git commit -m "Add tariff_schedule_id column to EnergyData"
```

---

### Task 1.2: Extend `EnergyData` TypeScript interface

**Files:**
- Modify: `cmd/next-app/src/lib/db.ts:109-119`

- [ ] **Step 1: Add the field to the interface**

Replace the `EnergyData` interface in `src/lib/db.ts:109-119` with:

```ts
export interface EnergyData {
  id: number;
  timestamp: Date;
  site_id: string;
  tariff_id: number;
  tariff_schedule_id: number | null;
  load_power: number;
  solar_power: number;
  grid_power: number;
  battery_power: number;
  battery_soc: number | null;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd cmd/next-app
npx tsc --noEmit
```

Expected: no errors. (Existing `getRawEnergyData` mappings spread the row with `...row` so the new column flows through automatically; consumers that don't reference it stay unaffected.)

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/lib/db.ts
git commit -m "Add tariff_schedule_id to EnergyData interface"
```

---

### Task 1.3: Populate `tariff_schedule_id` in `Importer.insertEnergyData`

**Files:**
- Modify: `cmd/next-app/src/lib/importer.ts:816-925`

- [ ] **Step 1: Construct `Schedule` once per insert call**

In `insertEnergyData`, after the tariff remapping loop completes (immediately before `if (validRows.length === 0) return;` at line 883), add:

```ts
const schedule = new Schedule(site.tariffs, site.timezone);
```

Add the import at the top of the file if not already present:

```ts
import { Schedule } from '@/lib/schedule';
```

- [ ] **Step 2: Update the per-row placeholder count from 8 to 9**

Replace the placeholder line at `importer.ts:899` (`placeholders.push(`($${pIdx}, ..., $${pIdx + 7})`);`) with:

```ts
placeholders.push(`($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7}, $${pIdx + 8})`);
```

- [ ] **Step 3: Append the schedule_id to the values array**

Replace the `values.push(...)` block at `importer.ts:900-909` with:

```ts
values.push(
    row.site_id,
    row.tariff_id,
    row.timestamp,
    row.load_power,
    row.solar_power,
    row.grid_power,
    row.battery_power,
    row.battery_soc,
    schedule.getTariffPeriod(row.timestamp)?.schedule.id ?? null
);
```

Update `pIdx += 8` (line 910) to `pIdx += 9`.

- [ ] **Step 4: Update the INSERT and ON CONFLICT clauses**

Replace the query string at `importer.ts:913-922` with:

```ts
const query = `
    INSERT INTO "EnergyData"(site_id, tariff_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc, tariff_schedule_id)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT(timestamp, site_id, tariff_id) DO UPDATE SET
        load_power=EXCLUDED.load_power,
        solar_power=EXCLUDED.solar_power,
        grid_power=EXCLUDED.grid_power,
        battery_power=EXCLUDED.battery_power,
        battery_soc=COALESCE(EXCLUDED.battery_soc, "EnergyData".battery_soc),
        tariff_schedule_id=EXCLUDED.tariff_schedule_id
`;
```

Note: `tariff_schedule_id` is always overwritten (no `COALESCE`) so re-imports re-stamp rows whose FK was nulled by an earlier tariff change.

- [ ] **Step 5: Verify build and tests**

```bash
cd cmd/next-app
npm run lint
npm run build
npm test -- src/lib/importer.test.ts
```

Expected: all green. The existing importer tests mock the pool and assert higher-level sync logic; they should continue to pass since the call signature of `insertEnergyData` is unchanged.

- [ ] **Step 6: Smoke-test against the local DB**

Trigger an import (e.g., load a site dashboard, or run an existing import script). Then verify:

```bash
psql "$DATABASE_URL" -c '
  SELECT count(*) AS total,
         count(*) FILTER (WHERE tariff_schedule_id IS NOT NULL) AS stamped
  FROM "EnergyData"
  WHERE timestamp > now() - interval '\''1 hour'\'';'
```

Expected: `stamped` should equal `total` (modulo timestamps where the schedule legitimately doesn't match).

- [ ] **Step 7: Commit**

```bash
git add cmd/next-app/src/lib/importer.ts
git commit -m "Populate tariff_schedule_id when inserting EnergyData"
```

---

### Task 1.4: Open PR 1

- [ ] **Step 1: Push and open PR**

```bash
git push -u origin worktree-reduce-db-egress
gh pr create --title "Add tariff_schedule_id to EnergyData" --body "$(cat <<'EOF'
## Summary

- Adds nullable `tariff_schedule_id INTEGER REFERENCES TariffSchedule(id) ON DELETE SET NULL` column to `EnergyData`
- Updates `Importer.insertEnergyData` to compute and persist the schedule per row using the existing `Schedule` class
- `ON CONFLICT` always overwrites `tariff_schedule_id` so tariff re-imports re-stamp historical rows

This is the foundation for cycle-bill aggregation (egress reduction). Backfill of historical rows ships in PR 2; the read-side change ships in PR 3.

## Test plan

- [ ] CI verify-db migration test passes against production schema
- [ ] After deploy, confirm new EnergyData rows have non-null tariff_schedule_id within 1 hour: `SELECT count(*) FILTER (WHERE tariff_schedule_id IS NULL) FROM "EnergyData" WHERE timestamp > now() - interval '1 hour'`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Wait for CI to pass and merge**

Once CI is green, merge to main. Confirm production deploy populates new rows correctly before proceeding to PR 2.

---

## PR 2 — Backfill Script

### Task 2.1: Create the backfill script

**Files:**
- Create: `cmd/next-app/scripts/backfill-tariff-schedule.ts`

- [ ] **Step 1: Create the script file**

Write the following to `cmd/next-app/scripts/backfill-tariff-schedule.ts`:

```ts
import { loadEnvConfig } from '@next/env';
import path from 'path';

// Load env before importing app modules that depend on DATABASE_URL.
loadEnvConfig(path.resolve(__dirname, '../'));

import { pool } from '@/lib/db';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';

const CUTOFF_DAYS = 45;
const UPDATE_CHUNK = 1000;

interface NullRow {
    id: number;
    timestamp: Date;
}

async function backfillSite(siteId: string): Promise<void> {
    const repo = new EnergyRepo();
    const site = await repo.getSite(siteId);
    if (!site) {
        console.log(`[backfill] site ${siteId}: not found, skipping`);
        return;
    }

    const cutoff = new Date(Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000);
    const rowsRes = await pool.query<NullRow>(
        `SELECT id, timestamp FROM "EnergyData"
         WHERE site_id = $1 AND timestamp >= $2 AND tariff_schedule_id IS NULL`,
        [siteId, cutoff]
    );

    if (rowsRes.rows.length === 0) {
        console.log(`[backfill] site ${siteId}: no NULL rows in window`);
        return;
    }

    const schedule = new Schedule(site.tariffs, site.timezone);
    const buckets = new Map<number, number[]>();
    let unmatched = 0;

    for (const row of rowsRes.rows) {
        const ts = new Date(row.timestamp);
        const sid = schedule.getTariffPeriod(ts)?.schedule.id;
        if (sid == null) {
            unmatched++;
            continue;
        }
        const bucket = buckets.get(sid) ?? [];
        bucket.push(row.id);
        buckets.set(sid, bucket);
    }

    let updated = 0;
    for (const [scheduleId, ids] of buckets) {
        for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
            const chunk = ids.slice(i, i + UPDATE_CHUNK);
            const res = await pool.query(
                `UPDATE "EnergyData"
                 SET tariff_schedule_id = $1
                 WHERE id = ANY($2::int[]) AND tariff_schedule_id IS NULL`,
                [scheduleId, chunk]
            );
            updated += res.rowCount ?? 0;
        }
    }

    console.log(`[backfill] site ${siteId}: scanned=${rowsRes.rows.length} updated=${updated} unmatched=${unmatched}`);
}

async function main(): Promise<void> {
    const repo = new EnergyRepo();
    const siteIds = await repo.getSiteIds();
    console.log(`[backfill] processing ${siteIds.length} sites, cutoff=${CUTOFF_DAYS} days`);

    for (const siteId of siteIds) {
        try {
            await backfillSite(siteId);
        } catch (err) {
            console.error(`[backfill] site ${siteId} failed:`, err);
        }
    }

    await pool.end();
    console.log('[backfill] done');
}

main().catch(err => {
    console.error('[backfill] fatal:', err);
    process.exit(1);
});
```

- [ ] **Step 2: Verify it compiles and lints**

```bash
cd cmd/next-app
npx tsc --noEmit
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Dry-run against the local DB**

```bash
cd cmd/next-app
npx tsx scripts/backfill-tariff-schedule.ts
```

Expected output: a `[backfill]` line per site with `scanned=`, `updated=`, `unmatched=` counts. Re-run immediately and confirm `updated=0` on the second run (idempotency).

- [ ] **Step 4: Verify rows are stamped**

```bash
psql "$DATABASE_URL" -c '
  SELECT
    count(*) AS total_recent,
    count(*) FILTER (WHERE tariff_schedule_id IS NOT NULL) AS stamped
  FROM "EnergyData"
  WHERE timestamp > now() - interval '\''45 days'\'';'
```

Expected: `stamped` covers the vast majority of `total_recent`. Any difference should reflect rows whose timestamp doesn't match any current schedule (pre-existing tariff config gaps).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/scripts/backfill-tariff-schedule.ts
git commit -m "Add backfill script for tariff_schedule_id (45-day window)"
```

---

### Task 2.2: Open PR 2 and run backfill in production

- [ ] **Step 1: Push and open PR**

```bash
git push
gh pr create --title "Backfill script for tariff_schedule_id" --body "$(cat <<'EOF'
## Summary

- One-off script to backfill `tariff_schedule_id` on EnergyData rows from the last 45 days
- Idempotent (re-runnable): only processes rows where `tariff_schedule_id IS NULL`
- Group-then-bulk-update by schedule_id, chunked at 1000 IDs

Run after PR 1 deploys: `cd cmd/next-app && npx tsx scripts/backfill-tariff-schedule.ts`

## Test plan

- [ ] Verified locally: rows stamp correctly, second run is a no-op
- [ ] After production run, confirm: `SELECT count(*) FILTER (WHERE tariff_schedule_id IS NULL) FROM "EnergyData" WHERE timestamp > now() - interval '45 days'` is small (only legitimately-unmatched rows)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Merge and run against production**

After CI passes and the PR merges, pull main locally and run:

```bash
cd cmd/next-app
DATABASE_URL="<production-database-url>" npx tsx scripts/backfill-tariff-schedule.ts
```

Save the output. Verify with the SQL count query from Task 2.1 Step 4 against the production database.

---

## PR 3 — Read-Side Aggregation

### Task 3.1: Add `CycleAggregateRow` type to `db.ts`

**Files:**
- Modify: `cmd/next-app/src/lib/db.ts` (append new interface)

- [ ] **Step 1: Append the interface**

Add to the end of `src/lib/db.ts`:

```ts
export interface CycleAggregateRow {
  day: Date;
  tariff_id: number;
  tariff_schedule_id: number | null;
  load_power: number;
  solar_power: number;
  grid_power: number;
  battery_power: number;
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd cmd/next-app
npx tsc --noEmit
```

Expected: no errors.

---

### Task 3.2: Add failing test for `getCycleAggregates`

**Files:**
- Modify: `cmd/next-app/src/lib/energy-repo.test.ts` (append new describe block)

- [ ] **Step 1: Add the failing test**

Append to `src/lib/energy-repo.test.ts`:

```ts
describe('EnergyRepo getCycleAggregates', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('issues a GROUP BY query against EnergyData and maps numeric strings', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [
                {
                    day: '2026-04-01T00:00:00.000Z',
                    tariff_id: '7',
                    tariff_schedule_id: '12',
                    load_power: '1234.5',
                    solar_power: '900.0',
                    grid_power: '300.0',
                    battery_power: '-50.0'
                },
                {
                    day: '2026-04-02T00:00:00.000Z',
                    tariff_id: '7',
                    tariff_schedule_id: null,
                    load_power: '500',
                    solar_power: '0',
                    grid_power: '500',
                    battery_power: '0'
                }
            ]
        });

        const repo = new EnergyRepo();
        const start = new Date('2026-04-01T00:00:00Z');
        const end = new Date('2026-04-15T00:00:00Z');
        const result = await repo.getCycleAggregates('site-1', start, end);

        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining(`date_trunc('day', timestamp)`),
            ['site-1', start, end]
        );
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('GROUP BY day, tariff_id, tariff_schedule_id'),
            expect.anything()
        );
        expect(result).toHaveLength(2);
        expect(result[0].tariff_schedule_id).toBe(12);
        expect(result[0].load_power).toBe(1234.5);
        expect(result[1].tariff_schedule_id).toBeNull();
    });
});
```

- [ ] **Step 2: Verify the test fails**

```bash
cd cmd/next-app
npm test -- src/lib/energy-repo.test.ts
```

Expected: FAIL — `repo.getCycleAggregates is not a function`.

---

### Task 3.3: Implement `getCycleAggregates` to make the test pass

**Files:**
- Modify: `cmd/next-app/src/lib/energy-repo.ts` (add new method near `getRawEnergyData` at line 406)

- [ ] **Step 1: Add the import for the new type**

In `src/lib/energy-repo.ts`, find the existing imports from `@/lib/db` (or `./db`) and add `CycleAggregateRow` to the imported types.

- [ ] **Step 2: Add the method**

Insert this method after `getRawEnergyDataWithTz` (around line 469):

```ts
async getCycleAggregates(siteId: string, start: Date, end: Date): Promise<CycleAggregateRow[]> {
    const queryStart = Date.now();
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
    const queryDuration = Date.now() - queryStart;
    console.log(`[EnergyRepo] getCycleAggregates: Query = ${queryDuration}ms, Rows = ${res.rows.length}`);

    return res.rows.map(row => ({
        day: new Date(row.day),
        tariff_id: Number(row.tariff_id),
        tariff_schedule_id: row.tariff_schedule_id == null ? null : Number(row.tariff_schedule_id),
        load_power: Number(row.load_power),
        solar_power: Number(row.solar_power),
        grid_power: Number(row.grid_power),
        battery_power: Number(row.battery_power)
    }));
}
```

- [ ] **Step 3: Verify the test passes**

```bash
cd cmd/next-app
npm test -- src/lib/energy-repo.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/src/lib/db.ts cmd/next-app/src/lib/energy-repo.ts cmd/next-app/src/lib/energy-repo.test.ts
git commit -m "Add EnergyRepo.getCycleAggregates for cycle bill aggregation"
```

---

### Task 3.4: Add `getScheduleById` helper to `Schedule`

**Files:**
- Modify: `cmd/next-app/src/lib/schedule.ts` (extend `Schedule` class)
- Modify: `cmd/next-app/src/lib/schedule.test.ts` (if it exists; otherwise inline assertion in route test is fine)

- [ ] **Step 1: Add the method**

In `src/lib/schedule.ts`, inside the `Schedule` class, add (placement near `getTariffPeriod` is fine):

```ts
private scheduleByIdCache: Map<number, { tariff: Tariff; schedule: TariffSchedule }> | null = null;

getScheduleById(id: number): { tariff: Tariff; schedule: TariffSchedule } | null {
    if (!this.scheduleByIdCache) {
        const cache = new Map<number, { tariff: Tariff; schedule: TariffSchedule }>();
        for (const tariff of this.tariffs) {
            for (const season of tariff.seasons ?? []) {
                for (const sched of season.schedules ?? []) {
                    if (sched.id != null) cache.set(sched.id, { tariff, schedule: sched });
                }
            }
        }
        this.scheduleByIdCache = cache;
    }
    return this.scheduleByIdCache.get(id) ?? null;
}
```

`Tariff`, `TariffSeason`, and `TariffSchedule` are already imported at the top of `schedule.ts` (line 1). The `tariffs` private field on `Schedule` is already declared. The interface property names match: `Tariff.seasons?: TariffSeason[]` and `TariffSeason.schedules?: TariffSchedule[]` (verified in `db.ts:74-93`).

- [ ] **Step 2: Verify build**

```bash
cd cmd/next-app
npx tsc --noEmit
npm test -- src/lib/schedule
```

Expected: no errors; existing schedule tests pass.

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/lib/schedule.ts
git commit -m "Add Schedule.getScheduleById lookup helper"
```

---

### Task 3.5: Update markup route to use split fetch

**Files:**
- Modify: `cmd/next-app/src/app/api/trmnl/markup/route.ts:237-253` (DB fetch block) and `:361-479` (aggregation loop)

- [ ] **Step 1: Replace the DB fetch block with split queries**

In `route.ts`, replace lines 237-253 (the `dbLatestPromise` / `dbCyclePromise` block) with:

```ts
let dbLatestMs = 0;
let dbCycleAggMs = 0;
let dbTodayMs = 0;
let aggregationMs = 0;
let renderMs = 0;

const todayStart = EnergyRepo.getSiteMidnight(now, site.timezone);

const dbLatestPromise = (async () => {
    const startMs = Date.now();
    const res = await repo.getLatestEnergyData(site!.id);
    dbLatestMs = Date.now() - startMs;
    console.log(`[TrmnlMarkup] DB Latest Energy Lookup: ${dbLatestMs}ms`);
    return res;
})();

const dbPriorAggPromise = (async () => {
    const startMs = Date.now();
    const res = await repo.getCycleAggregates(site!.id, start, todayStart);
    dbCycleAggMs = Date.now() - startMs;
    console.log(`[TrmnlMarkup] DB Cycle Aggregates: ${dbCycleAggMs}ms, Rows = ${res.length}`);
    return res;
})();

const dbTodayPromise = (async () => {
    const startMs = Date.now();
    const res = await repo.getRawEnergyData(site!.id, todayStart, now);
    dbTodayMs = Date.now() - startMs;
    console.log(`[TrmnlMarkup] DB Today Raw: ${dbTodayMs}ms, Rows = ${res.length}`);
    return res;
})();

const [latestData, priorAggregates, todayRaw] = await Promise.all([dbLatestPromise, dbPriorAggPromise, dbTodayPromise]);
const latestTimestamp = latestData?.timestamp ?? null;
```

(The `todayStart` declaration that previously appeared at line 366 is moved up here. Remove the old `const todayStart = EnergyRepo.getSiteMidnight(now, tz);` from inside the aggregation block and use this earlier one.)

- [ ] **Step 2: Replace the aggregation loop with two passes**

In the aggregation block (formerly lines 361-479), replace the single `for (const row of allCycleData)` loop with this two-pass structure:

```ts
// --- IN-MEMORY AGGREGATION (TOU Stats & Chart Extraction) ---
const aggregationStart = Date.now();

const tz = site.timezone || 'UTC';
const schedule = new Schedule(site.tariffs, tz);
const tariffMap = new Map<number, import('@/lib/db').Tariff>();
site.tariffs.forEach(t => tariffMap.set(t.id, t));

const aggregation = new Map<string, {
    tariff: import('@/lib/db').Tariff;
    tariffName: string;
    touName: string;
    label: string;
    homeUsage: number;
    gridUsage: number;
    solarProduction: number;
    batteryChange: number;
    cost: number;
    buyRate: number;
    sellRate: number;
}>();

const touLabelCache = new Map<string, string>();
const getTouLabel = (name: string): string => {
    const cached = touLabelCache.get(name);
    if (cached) return cached;
    const label = (name || 'Standard')
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, c => c.toUpperCase())
        .replace(' ', '-');
    touLabelCache.set(name, label);
    return label;
};

const bucketRow = (
    tariff: import('@/lib/db').Tariff,
    tariffName: string,
    touName: string,
    buyRate: number,
    sellRate: number,
    home: number, grid: number, solar: number, battery: number
) => {
    const key = `${tariff.id}|${touName}|${buyRate}|${sellRate}`;
    let data = aggregation.get(key);
    if (!data) {
        data = {
            tariff, tariffName, touName,
            label: getTouLabel(touName),
            homeUsage: 0, gridUsage: 0, solarProduction: 0, batteryChange: 0,
            cost: 0, buyRate, sellRate
        };
        aggregation.set(key, data);
    }
    data.homeUsage += home;
    data.gridUsage += grid;
    data.solarProduction += solar;
    data.batteryChange += battery;
};

// Pass 1: prior-day aggregates — schedule already known per row
for (const agg of priorAggregates) {
    let touName = 'Unknown';
    let tariffName = 'Unknown';
    let buyRate = 0;
    let sellRate = 0;
    let currentTariff = tariffMap.get(agg.tariff_id) ?? site.tariffs[0];

    if (agg.tariff_schedule_id != null) {
        const found = schedule.getScheduleById(agg.tariff_schedule_id);
        if (found) {
            currentTariff = found.tariff;
            tariffName = found.tariff.name || 'Unknown';
            touName = found.schedule.name || 'Standard';
            buyRate = found.schedule.buy_rate || 0;
            sellRate = found.schedule.sell_rate || 0;
        }
    } else {
        const t = tariffMap.get(agg.tariff_id);
        if (t) {
            tariffName = t.name || 'Unknown';
            currentTariff = t;
        }
    }

    bucketRow(currentTariff, tariffName, touName, buyRate, sellRate,
        agg.load_power, agg.grid_power, agg.solar_power, agg.battery_power);
}

// Pass 2: today's raw rows — drive chart, today totals, latest SoC, and TOU bucket
const seriesData: import('@/lib/db').EnergyData[] = [];
let todayHome = 0;
let todayGrid = 0;
let todaySolar = 0;
let latestSeriesSoc: { value: number; timestamp: Date } | null = null;

for (const row of todayRaw) {
    seriesData.push(row);
    todayHome += row.load_power;
    todayGrid += row.grid_power;
    todaySolar += row.solar_power;
    if (typeof row.battery_soc === 'number') {
        latestSeriesSoc = { value: row.battery_soc, timestamp: row.timestamp };
    }

    const tp = schedule.getTariffPeriod(row.timestamp);
    let touName = 'Unknown';
    let tariffName = 'Unknown';
    let buyRate = 0;
    let sellRate = 0;
    let currentTariff = site.tariffs[0];

    if (tp) {
        currentTariff = tp.tariff;
        tariffName = tp.tariff.name || 'Unknown';
        touName = tp.schedule.name || 'Standard';
        buyRate = tp.schedule.buy_rate || 0;
        sellRate = tp.schedule.sell_rate || 0;
    } else {
        const t = tariffMap.get(row.tariff_id);
        if (t) {
            tariffName = t.name || 'Unknown';
            currentTariff = t;
        }
    }

    bucketRow(currentTariff, tariffName, touName, buyRate, sellRate,
        row.load_power, row.grid_power, row.solar_power, row.battery_power);
}

aggregationMs = Date.now() - aggregationStart;
```

(Convert today totals to kWh after the loop — keep the existing lines that do `todayHome = wattsToKilowatts(todayHome)` etc. unchanged.)

- [ ] **Step 3: Update the Server-Timing header to expose the new metrics**

Find the `serverTiming` array (formerly around line 634) and replace `db_cycle;dur=${dbCycleMs.toFixed(1)}` with:

```ts
`db_cycle_agg;dur=${dbCycleAggMs.toFixed(1)}`,
`db_today;dur=${dbTodayMs.toFixed(1)}`,
```

- [ ] **Step 4: Verify lint, build, and tests**

```bash
cd cmd/next-app
npm run lint
npm run build
npm test
```

Expected: all green. There is no existing test for `src/app/api/trmnl/markup/route.ts` (verified: no `cmd/next-app/src/app/api/trmnl/**/*.test.ts` files exist), so verification of the route's behavior is the manual smoke test in Step 5.

- [ ] **Step 5: Manual smoke test**

Start the dev server (`npm run dev:agent` to avoid colliding with the user's port 5173). Hit `http://localhost:5174/api/trmnl/markup?site_id=<your-site-id>` while logged in. Inspect:

- Response body's `markup` field renders the same TOU groups, costs, and chart as production.
- `Server-Timing` header shows `db_cycle_agg;dur=X` with X in single-digit-millisecond range, and `db_today;dur=Y` similarly small.
- `X-Data-Age-Minutes` and `X-Debug-Battery-SOC` headers continue to show plausible values.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/app/api/trmnl/markup/route.ts
git commit -m "Split markup cycle fetch into prior aggregates + today raw"
```

---

### Task 3.6: Open PR 3 and validate egress

- [ ] **Step 1: Push and open PR**

```bash
git push
gh pr create --title "Split Trmnl markup cycle fetch (egress reduction)" --body "$(cat <<'EOF'
## Summary

- New `EnergyRepo.getCycleAggregates` returns per-(day, tariff, schedule) sums via SQL `GROUP BY`
- Markup route fetches prior-cycle days as ~90 aggregate rows and today as ~288 raw rows (was: ~8,640 raw rows for the whole cycle)
- `Schedule.getScheduleById` resolves pre-stamped `tariff_schedule_id` without per-row period matching
- Wire size per markup call: ~1.3 MB → ~60 KB (~20× reduction)
- Daily egress per device: ~125 MB → ~6 MB

Depends on PR 1 (column) being deployed and PR 2 backfill having run.

## Test plan

- [ ] `getCycleAggregates` unit test passes (added to `energy-repo.test.ts`)
- [ ] Markup route renders identically to pre-change for the same input data (manual smoke test against local DB)
- [ ] After deploy: Supabase egress dashboard shows drop within 24-48 hours
- [ ] After deploy: `Server-Timing` `db_cycle_agg;dur=` markedly lower than the previous `db_cycle;dur=`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Validate egress impact in production**

24-48 hours after merge, check the Supabase egress dashboard. Expect a drop in egress on the order of ~125 MB/day per device → ~6 MB/day per device.

If egress hasn't dropped: check production logs for `[TrmnlMarkup] DB Cycle Aggregates: ...ms, Rows = N`. `N` should be in the tens (not thousands). If it's in the thousands, the backfill may not have run or rows aren't being grouped — re-check `tariff_schedule_id` populated state via the SQL count query.

---

## Out of scope

The follow-up egress reductions tracked in [`TODO.md`](../../../TODO.md) (column projection in `getRawEnergyData`, `HeaderLiveStats` polling cadence, `/api/site-live-data` sparkline aggregation) are deliberately deferred until this PR's impact is measured. Pick them up next session.
