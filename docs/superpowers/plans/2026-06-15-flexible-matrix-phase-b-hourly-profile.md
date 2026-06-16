# Flexible Matrix — Phase B: Hourly Profile Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable plan-agnostic **hourly energy profile** (`EnergyHourly`) — 24 buckets/day of per-flow energies — written alongside the existing `EnergyRollup` (dual-write), so later phases can price any tariff by re-bucketing it.

**Architecture:** Extract the per-interval energy decomposition from `replay.ts` into a shared `intervalFlows(row)` unit. A pure `aggregateHourly(rows, tz)` buckets `EnergyData` by local date + hour using it. A `HourlyRepo` upserts. `RollupService.rollupDay` gains a dual-write of hourly buckets (one shared integration point feeding both the `rollup` and `index-history` crons). No pricing, no provenance, no `EnergyRollup` removal — those are Phase C.

**Tech Stack:** Next.js (App Router), TypeScript, PostgreSQL (`pg` pool), Vitest (pure-logic tests import directly; repo tests mock the `pool`).

**Spec:** `docs/superpowers/specs/2026-06-15-flexible-comparison-matrix-design.md` (Phase B). Phases C/D are out of scope here.

**Conventions to mirror:**
- Migrations idempotent (`CREATE TABLE IF NOT EXISTS`); generated via `npm run db:migration:create`.
- Repo upsert pattern: positional placeholders + `ON CONFLICT … DO UPDATE` (see `battery-provenance/rollup-repo.ts`).
- Pure-logic tests import the function and feed hand-built rows (see `battery-provenance/replay.test.ts`).
- All commands run from `cmd/next-app`. Single test file: `npm test -- src/lib/battery-provenance/hourly-profile`.

---

## File Structure

**Create:**
- `cmd/next-app/db-migrations/<timestamp>_energy_hourly.sql` — `EnergyHourly` table.
- `cmd/next-app/src/lib/battery-provenance/interval-flows.ts` — shared per-interval energy decomposition (extracted from `replay.ts`).
- `cmd/next-app/src/lib/battery-provenance/interval-flows.test.ts`
- `cmd/next-app/src/lib/battery-provenance/hourly-profile.ts` — `aggregateHourly` + `HourlyBucket`.
- `cmd/next-app/src/lib/battery-provenance/hourly-profile.test.ts`
- `cmd/next-app/src/lib/battery-provenance/hourly-repo.ts` — `HourlyRepo` upsert/get.
- `cmd/next-app/src/lib/battery-provenance/hourly-repo.test.ts`

**Modify:**
- `cmd/next-app/src/lib/db.ts` — add `EnergyHourlyRow` interface.
- `cmd/next-app/src/lib/battery-provenance/local-day.ts` — add `localHour`.
- `cmd/next-app/src/lib/battery-provenance/local-day.test.ts` — `localHour` tests.
- `cmd/next-app/src/lib/battery-provenance/replay.ts` — use `intervalFlows` (behavior-neutral).
- `cmd/next-app/src/lib/battery-provenance/rollup-service.ts` — `upsertHourly` dep + dual-write in `rollupDay`.
- `cmd/next-app/src/lib/battery-provenance/rollup-service.test.ts` — assert the dual-write.
- `cmd/next-app/src/app/api/cron/rollup/route.ts` — wire `upsertHourly`.
- `cmd/next-app/src/app/api/cron/index-history/route.ts` — wire `upsertHourly`.

---

## Task 1: Migration — `EnergyHourly` table

**Files:**
- Create: `cmd/next-app/db-migrations/<timestamp>_energy_hourly.sql` (via generator)

- [ ] **Step 1: Generate the migration**

Run: `cd cmd/next-app && npm run db:migration:create energy_hourly`
Expected: prints a new path `db-migrations/<timestamp>_energy_hourly.sql`.

- [ ] **Step 2: Write the SQL**

Replace the generated file's contents with:

```sql
-- Plan-agnostic hourly energy profile: 24 buckets/day of per-flow energies (Wh),
-- re-bucketable into any tariff's TOU windows for the savings comparison matrix.
-- No rates, no provenance — those are computed on read (Phase C).
CREATE TABLE IF NOT EXISTS "EnergyHourly" (
    site_id              text     NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    local_date           date     NOT NULL,
    hour                 smallint NOT NULL,
    load_wh              double precision NOT NULL DEFAULT 0,
    solar_to_home_wh     double precision NOT NULL DEFAULT 0,
    solar_to_battery_wh  double precision NOT NULL DEFAULT 0,
    solar_to_grid_wh     double precision NOT NULL DEFAULT 0,
    grid_to_home_wh      double precision NOT NULL DEFAULT 0,
    grid_to_battery_wh   double precision NOT NULL DEFAULT 0,
    battery_to_home_wh   double precision NOT NULL DEFAULT 0,
    battery_to_grid_wh   double precision NOT NULL DEFAULT 0,
    solar_only_import_wh double precision NOT NULL DEFAULT 0,
    solar_only_export_wh double precision NOT NULL DEFAULT 0,
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, local_date, hour)
);
```

- [ ] **Step 3: Verify the build is unaffected**

Run: `cd cmd/next-app && npm run build`
Expected: build succeeds (migrations aren't run by build; this confirms no syntax slip broke compilation).

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/db-migrations/
git commit -m "feat(hourly): EnergyHourly table — plan-agnostic hourly energy profile"
```

---

## Task 2: `EnergyHourlyRow` type

**Files:**
- Modify: `cmd/next-app/src/lib/db.ts` (near `EnergyRollupRow`, ~line 173)

- [ ] **Step 1: Add the interface**

After the `EnergyRollupRow` interface in `src/lib/db.ts`, add:

```ts
export interface EnergyHourlyRow {
  site_id: string;
  local_date: string; // 'YYYY-MM-DD', site-local
  hour: number;       // 0..23, site-local clock hour
  load_wh: number;
  solar_to_home_wh: number;
  solar_to_battery_wh: number;
  solar_to_grid_wh: number;
  grid_to_home_wh: number;
  grid_to_battery_wh: number;
  battery_to_home_wh: number;
  battery_to_grid_wh: number;
  solar_only_import_wh: number;
  solar_only_export_wh: number;
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd cmd/next-app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/lib/db.ts
git commit -m "feat(hourly): EnergyHourlyRow type"
```

---

## Task 3: `localHour` helper

**Files:**
- Modify: `cmd/next-app/src/lib/battery-provenance/local-day.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/local-day.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/battery-provenance/local-day.test.ts`:

```ts
import { localHour } from './local-day';

describe('localHour', () => {
    it('returns the local clock hour in the site timezone', () => {
        // 2026-01-07T11:30:00Z is 03:30 in America/Los_Angeles (UTC-8)
        expect(localHour(new Date('2026-01-07T11:30:00Z'), 'America/Los_Angeles')).toBe(3);
        // …and 11:30 in UTC
        expect(localHour(new Date('2026-01-07T11:30:00Z'), 'UTC')).toBe(11);
    });

    it('maps local midnight to hour 0', () => {
        // 2026-01-07T08:00:00Z is 00:00 in America/Los_Angeles
        expect(localHour(new Date('2026-01-07T08:00:00Z'), 'America/Los_Angeles')).toBe(0);
    });
});
```

(Keep the existing `import { ... } from './local-day'` at the top; if the test file already imports from `./local-day`, add `localHour` to that import and drop the duplicate import line above.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/battery-provenance/local-day`
Expected: FAIL — `localHour` is not exported.

- [ ] **Step 3: Implement `localHour`**

Add to `src/lib/battery-provenance/local-day.ts`:

```ts
/** Local clock hour (0..23) for the instant in the given IANA timezone. */
export function localHour(ts: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hour: '2-digit', hour12: false,
    }).formatToParts(ts);
    let hour = Number(parts.find(p => p.type === 'hour')!.value);
    if (hour === 24) hour = 0; // some ICU builds render local midnight as 24
    return hour;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/battery-provenance/local-day`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/battery-provenance/local-day.ts cmd/next-app/src/lib/battery-provenance/local-day.test.ts
git commit -m "feat(hourly): localHour helper"
```

---

## Task 4: Extract `intervalFlows` shared unit

Pull the per-interval energy decomposition out of `replay.ts` into one tested unit, used by both the period rollup and the hourly profile so they can never drift. Behavior-neutral — existing `replay.test.ts` guards the rollup.

**Files:**
- Create: `cmd/next-app/src/lib/battery-provenance/interval-flows.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/interval-flows.test.ts`
- Modify: `cmd/next-app/src/lib/battery-provenance/replay.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/battery-provenance/interval-flows.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { intervalFlows } from './interval-flows';
import type { EnergyData } from '../db';

function row(over: Partial<EnergyData>): EnergyData {
    return {
        id: 1, timestamp: new Date('2026-01-07T03:00:00Z'), site_id: 's1', tariff_id: 1,
        load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0,
        battery_soc: 50, tariff_schedule_id: 10,
        battery_charge_from_solar: null, battery_charge_from_grid: null,
        ...over,
    } as EnergyData;
}

describe('intervalFlows', () => {
    it('computes the solar-only counterfactual: surplus exports, deficit imports', () => {
        expect(intervalFlows(row({ load_power: 1000, solar_power: 3000 })).solarOnlyExportWh).toBeCloseTo(2000, 6);
        expect(intervalFlows(row({ load_power: 1000, solar_power: 3000 })).solarOnlyImportWh).toBe(0);
        expect(intervalFlows(row({ load_power: 3000, solar_power: 1000 })).solarOnlyImportWh).toBeCloseTo(2000, 6);
    });

    it('returns non-negative flow fields for a representative interval', () => {
        const f = intervalFlows(row({ load_power: 2000, solar_power: 1000, grid_power: 1000, battery_power: 0 }));
        for (const v of Object.values(f)) expect(v).toBeGreaterThanOrEqual(0);
        expect(f.loadWh).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/battery-provenance/interval-flows`
Expected: FAIL — `intervalFlows` is not defined.

- [ ] **Step 3: Create `interval-flows.ts`**

Create `src/lib/battery-provenance/interval-flows.ts`:

```ts
import type { EnergyData } from '../db';
import { allocateEdges, energyDataToInstant } from '../sankey/build-flow-model';
import type { EdgeCategory } from '../sankey/flow-model';
import { solarOnlyNet } from './counterfactual';

const WH_PER_KWH = 1000;

export interface IntervalFlows {
    loadWh: number;
    solarToHomeWh: number;
    solarToBatteryWh: number;
    solarToGridWh: number;
    gridToHomeWh: number;
    gridToBatteryWh: number;
    batteryToHomeWh: number;
    batteryToGridWh: number;
    solarOnlyImportWh: number;
    solarOnlyExportWh: number;
}

function edgeWh(edges: ReturnType<typeof allocateEdges>, category: EdgeCategory): number {
    const e = edges.find(x => x.category === category);
    return e ? e.energy * WH_PER_KWH : 0;
}

/** Per-interval energy decomposition (Wh), plan-agnostic (no rates, no tank).
 *  Single source of truth shared by the period rollup (replay.ts) and the hourly profile. */
export function intervalFlows(row: EnergyData): IntervalFlows {
    const edges = allocateEdges(energyDataToInstant(row), { buyRate: 0, sellRate: 0 });
    const solarToHomeWh = edgeWh(edges, 'solar-home');
    const gridToHomeWh = edgeWh(edges, 'grid-home');
    const batteryToHomeWh = edgeWh(edges, 'battery-home');
    const so = solarOnlyNet(row.load_power, row.solar_power);
    return {
        loadWh: solarToHomeWh + gridToHomeWh + batteryToHomeWh,
        solarToHomeWh,
        solarToBatteryWh: edgeWh(edges, 'solar-battery'),
        solarToGridWh: edgeWh(edges, 'solar-export'),
        gridToHomeWh,
        gridToBatteryWh: edgeWh(edges, 'grid-battery'),
        batteryToHomeWh,
        batteryToGridWh: edgeWh(edges, 'battery-export'), // allocator names battery→grid 'battery-export'
        solarOnlyImportWh: so.importWh,
        solarOnlyExportWh: so.exportWh,
    };
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npm test -- src/lib/battery-provenance/interval-flows`
Expected: PASS.

- [ ] **Step 5: Refactor `replay.ts` to use `intervalFlows`**

In `src/lib/battery-provenance/replay.ts`:

Add the import (after the existing `solarOnlyNet` import on line 8):

```ts
import { intervalFlows } from './interval-flows';
```

Replace the per-row block (the current lines computing `edges`, the four `…BatteryWh`/`…HomeWh` via `edgeWh`, and the accumulation `r.loadWh += …` through `r.solarOnlyExportWh += so.exportWh`) with:

```ts
        const f = intervalFlows(row);

        // Prefer Tesla's measured charge source; fall back to sankey allocation.
        const chargeSolarWh = row.battery_charge_from_solar ?? f.solarToBatteryWh;
        const chargeGridWh = row.battery_charge_from_grid ?? f.gridToBatteryWh;

        const shouldSimulateTank = !options?.genesisAnchorTimestamp || row.timestamp.getTime() > options.genesisAnchorTimestamp.getTime();
        if (shouldSimulateTank) {
            tank = chargeTank(tank, chargeSolarWh, chargeGridWh, rates.buyRate, rates.sellRate);
            const dischargeWh = f.batteryToHomeWh + f.batteryToGridWh;
            if (dischargeWh > 0) {
                tank = dischargeTank(tank, dischargeWh).tank;
            }
        }

        const localDate = localDateKey(row.timestamp, timeZone);
        const key = `${localDate}|${row.tariff_schedule_id}`;
        let r = byKey.get(key);
        if (!r) {
            r = emptyRollup(row.site_id, localDate, row.tariff_schedule_id);
            byKey.set(key, r);
        }
        r.loadWh += f.loadWh;
        r.solarToHomeWh += f.solarToHomeWh;
        r.solarToBatteryWh += f.solarToBatteryWh;
        r.solarToGridWh += f.solarToGridWh;
        r.gridToHomeWh += f.gridToHomeWh;
        r.gridToBatteryWh += f.gridToBatteryWh;
        r.batteryToHomeWh += f.batteryToHomeWh;
        r.batteryToGridWh += f.batteryToGridWh;
        r.solarOnlyImportWh += f.solarOnlyImportWh;
        r.solarOnlyExportWh += f.solarOnlyExportWh;
        r.buyRate = rates.buyRate;   // constant across the period (one schedule)
        r.sellRate = rates.sellRate;
        r.batterySoc = row.battery_soc; // SOC of the latest interval = end of period
        r.tank = tank;            // continuous tank as of this interval
        r.tankAsOf = row.timestamp;
```

Then delete the now-unused local `edgeWh` function and the now-unused imports (`allocateEdges`, `energyDataToInstant`, `EdgeCategory`, `solarOnlyNet`, `WH_PER_KWH` const) from `replay.ts` — anything `intervalFlows` now owns. Leave `resolveRates`, `chargeTank`, `dischargeTank`, `EMPTY_TANK`, `Tank`, `localDateKey`, `Schedule` imports intact.

- [ ] **Step 6: Run replay tests to verify behavior is unchanged**

Run: `npm test -- src/lib/battery-provenance/replay`
Expected: PASS (the extraction is behavior-neutral). Then `npx tsc --noEmit` — no unused-import errors.

- [ ] **Step 7: Commit**

```bash
git add cmd/next-app/src/lib/battery-provenance/interval-flows.ts cmd/next-app/src/lib/battery-provenance/interval-flows.test.ts cmd/next-app/src/lib/battery-provenance/replay.ts
git commit -m "refactor(hourly): extract intervalFlows shared by replay + hourly profile"
```

---

## Task 5: `aggregateHourly`

**Files:**
- Create: `cmd/next-app/src/lib/battery-provenance/hourly-profile.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/hourly-profile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/battery-provenance/hourly-profile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { aggregateHourly } from './hourly-profile';
import type { EnergyData } from '../db';

function row(over: Partial<EnergyData>): EnergyData {
    return {
        id: 1, timestamp: new Date('2026-01-07T11:00:00Z'), site_id: 's1', tariff_id: 1,
        load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0,
        battery_soc: 50, tariff_schedule_id: 10,
        battery_charge_from_solar: null, battery_charge_from_grid: null,
        ...over,
    } as EnergyData;
}

describe('aggregateHourly', () => {
    it('buckets samples by local date and hour and sums flows', () => {
        // Two samples in the same LA hour (03:00 & 03:30 local = 11:00 & 11:30 UTC), one in the next hour.
        const rows = [
            row({ timestamp: new Date('2026-01-07T11:00:00Z'), load_power: 3000, solar_power: 1000 }),
            row({ timestamp: new Date('2026-01-07T11:30:00Z'), load_power: 1000, solar_power: 3000 }),
            row({ timestamp: new Date('2026-01-07T12:00:00Z'), load_power: 2000, solar_power: 0 }),
        ];
        const buckets = aggregateHourly(rows, 'America/Los_Angeles');
        const h3 = buckets.find(b => b.hour === 3)!;
        const h4 = buckets.find(b => b.hour === 4)!;
        expect(h3.localDate).toBe('2026-01-07');
        // hour 3 (LA): two samples — first imports 2000, second exports 2000
        expect(h3.solarOnlyImportWh).toBeCloseTo(2000, 6);
        expect(h3.solarOnlyExportWh).toBeCloseTo(2000, 6);
        expect(h4.solarOnlyImportWh).toBeCloseTo(2000, 6);
    });

    it('returns an empty array for no rows', () => {
        expect(aggregateHourly([], 'UTC')).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/battery-provenance/hourly-profile`
Expected: FAIL — `aggregateHourly` is not defined.

- [ ] **Step 3: Implement**

Create `src/lib/battery-provenance/hourly-profile.ts`:

```ts
import type { EnergyData } from '../db';
import { intervalFlows } from './interval-flows';
import { localDateKey, localHour } from './local-day';

export interface HourlyBucket {
    siteId: string;
    localDate: string; // 'YYYY-MM-DD'
    hour: number;      // 0..23
    loadWh: number;
    solarToHomeWh: number;
    solarToBatteryWh: number;
    solarToGridWh: number;
    gridToHomeWh: number;
    gridToBatteryWh: number;
    batteryToHomeWh: number;
    batteryToGridWh: number;
    solarOnlyImportWh: number;
    solarOnlyExportWh: number;
}

function emptyBucket(siteId: string, localDate: string, hour: number): HourlyBucket {
    return {
        siteId, localDate, hour,
        loadWh: 0, solarToHomeWh: 0, solarToBatteryWh: 0, solarToGridWh: 0,
        gridToHomeWh: 0, gridToBatteryWh: 0, batteryToHomeWh: 0, batteryToGridWh: 0,
        solarOnlyImportWh: 0, solarOnlyExportWh: 0,
    };
}

/** Aggregate 5-min EnergyData into plan-agnostic (site, local_date, hour) buckets.
 *  Reuses intervalFlows so the energy decomposition matches the period rollup exactly. */
export function aggregateHourly(rows: EnergyData[], timeZone: string): HourlyBucket[] {
    const byKey = new Map<string, HourlyBucket>();
    for (const row of rows) {
        const localDate = localDateKey(row.timestamp, timeZone);
        const hour = localHour(row.timestamp, timeZone);
        const key = `${localDate}|${hour}`;
        let b = byKey.get(key);
        if (!b) { b = emptyBucket(row.site_id, localDate, hour); byKey.set(key, b); }
        const f = intervalFlows(row);
        b.loadWh += f.loadWh;
        b.solarToHomeWh += f.solarToHomeWh;
        b.solarToBatteryWh += f.solarToBatteryWh;
        b.solarToGridWh += f.solarToGridWh;
        b.gridToHomeWh += f.gridToHomeWh;
        b.gridToBatteryWh += f.gridToBatteryWh;
        b.batteryToHomeWh += f.batteryToHomeWh;
        b.batteryToGridWh += f.batteryToGridWh;
        b.solarOnlyImportWh += f.solarOnlyImportWh;
        b.solarOnlyExportWh += f.solarOnlyExportWh;
    }
    return [...byKey.values()];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/battery-provenance/hourly-profile`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/battery-provenance/hourly-profile.ts cmd/next-app/src/lib/battery-provenance/hourly-profile.test.ts
git commit -m "feat(hourly): aggregateHourly buckets EnergyData by local date + hour"
```

---

## Task 6: `HourlyRepo`

**Files:**
- Create: `cmd/next-app/src/lib/battery-provenance/hourly-repo.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/hourly-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/battery-provenance/hourly-repo.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { poolQueryMock } = vi.hoisted(() => ({ poolQueryMock: vi.fn() }));
vi.mock('../db', () => ({ pool: { query: poolQueryMock } }));

import { HourlyRepo } from './hourly-repo';
import type { HourlyBucket } from './hourly-profile';

function bucket(over: Partial<HourlyBucket>): HourlyBucket {
    return {
        siteId: 's1', localDate: '2026-01-07', hour: 3,
        loadWh: 1, solarToHomeWh: 0, solarToBatteryWh: 0, solarToGridWh: 0,
        gridToHomeWh: 0, gridToBatteryWh: 0, batteryToHomeWh: 0, batteryToGridWh: 0,
        solarOnlyImportWh: 0, solarOnlyExportWh: 0, ...over,
    };
}

describe('HourlyRepo.upsertHourly', () => {
    beforeEach(() => poolQueryMock.mockReset());

    it('no-ops on empty input', async () => {
        await new HourlyRepo().upsertHourly([]);
        expect(poolQueryMock).not.toHaveBeenCalled();
    });

    it('inserts with ON CONFLICT upsert on the (site,date,hour) key', async () => {
        poolQueryMock.mockResolvedValue({ rows: [] });
        await new HourlyRepo().upsertHourly([bucket({ hour: 3 }), bucket({ hour: 4 })]);
        const sql = String(poolQueryMock.mock.calls[0][0]);
        expect(sql).toMatch(/INSERT INTO "EnergyHourly"/);
        expect(sql).toMatch(/ON CONFLICT\(site_id, local_date, hour\) DO UPDATE/);
        // 13 columns × 2 rows = 26 params
        expect(poolQueryMock.mock.calls[0][1]).toHaveLength(26);
    });
});

describe('HourlyRepo.getAllForSite', () => {
    beforeEach(() => poolQueryMock.mockReset());
    it('selects the site ordered by date then hour', async () => {
        poolQueryMock.mockResolvedValue({ rows: [] });
        await new HourlyRepo().getAllForSite('s1');
        const sql = String(poolQueryMock.mock.calls[0][0]);
        expect(sql).toMatch(/FROM "EnergyHourly" WHERE site_id = \$1/);
        expect(sql).toMatch(/ORDER BY local_date ASC, hour ASC/);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/battery-provenance/hourly-repo`
Expected: FAIL — `HourlyRepo` is not defined.

- [ ] **Step 3: Implement**

Create `src/lib/battery-provenance/hourly-repo.ts`:

```ts
import { pool } from '../db';
import type { HourlyBucket } from './hourly-profile';
import type { EnergyHourlyRow } from '../db';

export class HourlyRepo {
    async upsertHourly(rows: HourlyBucket[]): Promise<void> {
        if (rows.length === 0) return;
        const cols = 13; // must equal the number of values pushed per row below
        const placeholders: string[] = [];
        const params: unknown[] = [];
        let p = 1;
        for (const r of rows) {
            const ph: string[] = [];
            for (let k = 0; k < cols; k++) ph.push(`$${p++}`);
            placeholders.push(`(${ph.join(', ')})`);
            params.push(
                r.siteId, r.localDate, r.hour,
                r.loadWh, r.solarToHomeWh, r.solarToBatteryWh, r.solarToGridWh,
                r.gridToHomeWh, r.gridToBatteryWh, r.batteryToHomeWh, r.batteryToGridWh,
                r.solarOnlyImportWh, r.solarOnlyExportWh,
            );
        }
        await pool.query(`
            INSERT INTO "EnergyHourly"(
                site_id, local_date, hour,
                load_wh, solar_to_home_wh, solar_to_battery_wh, solar_to_grid_wh,
                grid_to_home_wh, grid_to_battery_wh, battery_to_home_wh, battery_to_grid_wh,
                solar_only_import_wh, solar_only_export_wh
            ) VALUES ${placeholders.join(', ')}
            ON CONFLICT(site_id, local_date, hour) DO UPDATE SET
                load_wh = EXCLUDED.load_wh,
                solar_to_home_wh = EXCLUDED.solar_to_home_wh,
                solar_to_battery_wh = EXCLUDED.solar_to_battery_wh,
                solar_to_grid_wh = EXCLUDED.solar_to_grid_wh,
                grid_to_home_wh = EXCLUDED.grid_to_home_wh,
                grid_to_battery_wh = EXCLUDED.grid_to_battery_wh,
                battery_to_home_wh = EXCLUDED.battery_to_home_wh,
                battery_to_grid_wh = EXCLUDED.battery_to_grid_wh,
                solar_only_import_wh = EXCLUDED.solar_only_import_wh,
                solar_only_export_wh = EXCLUDED.solar_only_export_wh,
                updated_at = now()
        `, params);
    }

    async getAllForSite(siteId: string): Promise<EnergyHourlyRow[]> {
        const res = await pool.query(
            `SELECT site_id, local_date::text AS local_date, hour,
                    load_wh, solar_to_home_wh, solar_to_battery_wh, solar_to_grid_wh,
                    grid_to_home_wh, grid_to_battery_wh, battery_to_home_wh, battery_to_grid_wh,
                    solar_only_import_wh, solar_only_export_wh
             FROM "EnergyHourly" WHERE site_id = $1
             ORDER BY local_date ASC, hour ASC`,
            [siteId],
        );
        return res.rows as EnergyHourlyRow[];
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/battery-provenance/hourly-repo`
Expected: PASS (both describes).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/battery-provenance/hourly-repo.ts cmd/next-app/src/lib/battery-provenance/hourly-repo.test.ts
git commit -m "feat(hourly): HourlyRepo upsert + getAllForSite"
```

---

## Task 7: Dual-write the hourly profile from `rollupDay`

One integration point feeds both crons: `RollupService.rollupDay` already loads the day's rows for the period rollup — aggregate them to hourly and upsert alongside.

**Files:**
- Modify: `cmd/next-app/src/lib/battery-provenance/rollup-service.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/rollup-service.test.ts`
- Modify: `cmd/next-app/src/app/api/cron/rollup/route.ts`
- Modify: `cmd/next-app/src/app/api/cron/index-history/route.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/battery-provenance/rollup-service.test.ts`, add a test asserting `upsertHourly` is called with buckets for the day. Mirror the existing test's deps setup; add an `upsertHourly: vi.fn()` to the deps object and assert:

```ts
    it('dual-writes hourly buckets for the rolled day', async () => {
        const upsertHourly = vi.fn();
        const service = new RollupService({
            loadSite: async () => ({ id: 's1', timezone: 'America/Los_Angeles', tariffs: [touTariff] }),
            loadEnergyData: async () => dayRows,            // reuse the existing fixture rows
            getSeedTank: async () => null,
            hasAnyRollup: async () => false,
            upsertRollups: vi.fn(),
            upsertHourly,
        });
        await service.rollupDay('s1', localDate);
        expect(upsertHourly).toHaveBeenCalledTimes(1);
        const buckets = upsertHourly.mock.calls[0][0];
        expect(buckets.length).toBeGreaterThan(0);
        expect(buckets.every((b: { localDate: string }) => b.localDate === localDate)).toBe(true);
    });
```

(Use the same `touTariff`, `dayRows`, `localDate` fixtures the existing rollup-service tests already define. If the existing tests build deps inline per-test, add `upsertHourly: vi.fn()` to each existing deps literal so the type checks — see Step 3.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/battery-provenance/rollup-service`
Expected: FAIL — `upsertHourly` is not on `RollupDeps` (type error) and/or not called.

- [ ] **Step 3: Add the dep and the dual-write**

In `src/lib/battery-provenance/rollup-service.ts`:

Add imports near the top:

```ts
import { aggregateHourly, type HourlyBucket } from './hourly-profile';
```

Add to the `RollupDeps` interface:

```ts
    upsertHourly: (rows: HourlyBucket[]) => Promise<void>;
```

In `rollupDay`, right after the existing `await this.deps.upsertRollups(forDate);` line, add:

```ts
        const hourly = aggregateHourly(rows, site.timezone).filter(b => b.localDate === localDate);
        await this.deps.upsertHourly(hourly);
```

(`rows` and `site` are already in scope from the existing method body.)

- [ ] **Step 4: Wire both cron routes**

In `src/app/api/cron/rollup/route.ts`, add `import { HourlyRepo } from '@/lib/battery-provenance/hourly-repo';`, construct `const hourlyRepo = new HourlyRepo();` next to `rollupRepo`, and add to the `new RollupService({ … })` deps:

```ts
      upsertHourly: (rows) => hourlyRepo.upsertHourly(rows),
```

In `src/app/api/cron/index-history/route.ts`, do the same: import `HourlyRepo`, construct `const hourlyRepo = new HourlyRepo();` next to the existing `rollupRepo`, and add `upsertHourly: (rows) => hourlyRepo.upsertHourly(rows),` to its `RollupService` deps object.

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test -- src/lib/battery-provenance/rollup-service && npx tsc --noEmit`
Expected: PASS, no type errors (both routes now satisfy `RollupDeps`).

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/battery-provenance/rollup-service.ts cmd/next-app/src/lib/battery-provenance/rollup-service.test.ts cmd/next-app/src/app/api/cron/rollup/route.ts cmd/next-app/src/app/api/cron/index-history/route.ts
git commit -m "feat(hourly): dual-write EnergyHourly from rollupDay (both crons)"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full test suite**

Run: `cd cmd/next-app && npm test`
Expected: all pass, including the new `interval-flows`, `hourly-profile`, `hourly-repo`, `local-day`, and updated `rollup-service` / `replay` tests.

- [ ] **Step 2: Build + lint**

Run: `cd cmd/next-app && npm run build && npm run lint`
Expected: both pass.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A && git commit -m "test(hourly): Phase B hourly profile foundation green"
```

---

## Self-review notes (for the implementer)

- **Parity is the safety net:** Task 4 is behavior-neutral — `replay.test.ts` must stay green after the extraction. The hourly profile reuses the *same* `intervalFlows`, so hourly daily-sums reconcile with period-rollup daily-sums by construction.
- **Dual-write, no cutover:** Phase B does not touch pricing or remove `EnergyRollup`. The Savings tab still reads `EnergyRollup`. `EnergyHourly` is written but not yet read — that's Phase C.
- **Backfill comes for free:** `index-history` drives history through `rollupDay`, so wiring `upsertHourly` there backfills `EnergyHourly` across full retained history with no separate backfill loop.
- **DST:** local-hour bucketing means a fall-back day has a 25th bucket and spring-forward skips one — correct and intended; don't "normalize" to 24.
- **The deliberate stub (Task 6 Step 3):** the first `upsertHourly` is intentionally broken (cols=12, empty query) so the column/param count is corrected in Step 3a with the test asserting 26 params. Don't ship the stub.
