# Flexible Matrix — Phase C2: On-Read Provenance + Retire EnergyRollup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move battery arbitrage/provenance **on read** — replaying the cost-basis tank over the `EnergyHourly` profile with date-resolved metered rates — then **retire `EnergyRollup`** (table, repo, write path, and the now-dead replay/genesis machinery), leaving `EnergyHourly` as the sole stored aggregate.

**Architecture:** A rewritten `computeArbitrage(hourlyRows, meteredTimeline)` replays `chargeTank`/`dischargeTank` over 24-bucket/day hourly rows in chronological order, valuing each hour's charge at the metered rate from the C1 `PlanTimeline` and scoring each hour's discharge against the tank blend. The Savings page already loads `EnergyHourly` (C1) and builds `meteredTimeline`; arbitrage repoints to it. `RollupService.rollupDay` collapses to "aggregate the day to hourly + upsert" (its genesis/tank/period-rollup output is removed), keeping its return shape so `BackfillService` is untouched. The `EnergyRollup` table is dropped via migration; `rollup-repo.ts`, `replay.ts`, `genesis.ts`, and `EnergyRollupRow` are deleted.

**Tech Stack:** Next.js (App Router), TypeScript, PostgreSQL (`pg` pool), Vitest (pure-logic tests import directly; feed hand-built rows; repo tests mock the `pool`).

**Spec:** `docs/superpowers/specs/2026-06-15-flexible-comparison-matrix-design.md` (Phase C). This is **C2**, the second half of the Phase C split. **C1 (pricing engine) is already merged** — `priceColumn`, `PlanTimeline`/`flatTimeline`/`scheduleTimeline`/`meteredTimeline`, and the `EnergyHourly`-sourced matrix/chart exist; the Savings page builds `meteredTimeline` and `flatTimeline` and reads `HourlyRepo.getAllForSite`. The **only** remaining `EnergyRollup` reader after C1 is arbitrage.

**Conventions to mirror:**
- Pure-logic tests import the function and feed hand-built rows; a `PlanTimeline` can be stubbed inline as `{ rateAt: (localDate, hour) => ({ buy, sell }) }` (no `Schedule` needed in tests).
- Repo tests mock `../db`'s `pool.query` and assert the SQL (see `battery-provenance/hourly-repo.test.ts`).
- Migrations idempotent; generated via `npm run db:migration:create`.
- All commands run from `cmd/next-app`.

---

## Decision: no genesis seeding in the on-read replay

The old write-path replay seeded the tank at the first full-battery moment (`computeGenesisSeed`) so the earliest discharges had a cost basis. The on-read engine **starts from an empty tank** and skips discharges that occur before the tank holds attributable energy — exactly the skip the **old** `computeArbitrage` already performed for genesis rows (`entryWh <= 0 → continue`).

**Why this is safe — genesis is already non-functional for the bulk of history.** Genesis anchors on `battery_soc >= 98`, but `battery_soc` is only populated from Tesla's SOE history, and the `index-history` backfill deliberately runs `new Importer(client, { fetchSoe: false })` to halve Tesla calls and avoid 429s ([index-history/route.ts](../../cmd/next-app/src/app/api/cron/index-history/route.ts), [energy-transformer.ts:78](../../cmd/next-app/src/lib/importer/energy-transformer.ts) → `findNearestSoc`). So **every backfilled row has `battery_soc = null`**, `computeGenesisSeed` finds no anchor and returns `null`, and the backfill's per-day genesis retries never anchor — the stored `EnergyRollup` tank for any backfilled site already started empty. C2 doesn't remove a working safeguard; it makes the code honest about a seed the SOE-skip already neutralized.

**Why absolute SOC isn't needed for provenance.** The tank is *relative flow accounting*, not an absolute gauge: it adds observed charge (valued at the hour's metered rate), removes observed discharge proportionally, tracks the solar/grid cost blend, and clamps so it can never go negative. It never references absolute fullness. SOC fed *only* the one-time genesis seed (a cost basis for energy already in the battery before our data window). Without it, the sole loss is attribution of the first ≈1 battery-capacity of discharge at the very start of history — **bounded and non-accumulating**: once the battery cycles once inside the window, the tank is rebuilt entirely from observed flows and attribution self-corrects. This sits well within the spec's accepted **provenance tolerance** ("hourly-grain provenance — intra-hour cycling blurred; full fidelity recoverable from retained raw data").

`computeGenesisSeed` is deleted. Because raw 5-min `EnergyData` is kept forever, a future phase wanting true startup attribution can re-fetch SOE for just the genesis window and reconstruct the seed — without changing the steady-state engine.

This also means absolute parity with the old per-period arbitrage number is **not** a goal — the grain (hourly vs per-period) and the blend model (continuous replay vs prior-period stored tank) differ, on top of the empty-start. Correctness is tested directly on the hourly engine.

---

## File Structure

**Create:**
- `cmd/next-app/db-migrations/<timestamp>_drop_energy_rollup.sql` — `DROP TABLE "EnergyRollup"`.

**Modify:**
- `cmd/next-app/src/lib/roi/arbitrage-service.ts` — replay tank over hourly rows + metered timeline.
- `cmd/next-app/src/lib/roi/arbitrage-service.test.ts` — hourly fixtures + stub timelines.
- `cmd/next-app/src/app/site/[id]/page.tsx` — arbitrage from `hourly` + `meteredTl`; drop `RollupRepo`.
- `cmd/next-app/src/lib/battery-provenance/hourly-repo.ts` — add `hasHourlyForDate`.
- `cmd/next-app/src/lib/battery-provenance/hourly-repo.test.ts` — assert it.
- `cmd/next-app/src/lib/battery-provenance/rollup-service.ts` — collapse `rollupDay` to hourly-only; trim `RollupDeps`.
- `cmd/next-app/src/lib/battery-provenance/rollup-service.test.ts` — rewrite for the slim service.
- `cmd/next-app/src/app/api/cron/rollup/route.ts` — drop `RollupRepo`; use `hasHourlyForDate`; slim deps.
- `cmd/next-app/src/app/api/cron/index-history/route.ts` — drop `RollupRepo`; slim deps.
- `cmd/next-app/scripts/backfill-rollups.ts` — slim deps; drop `RollupRepo`.
- `cmd/next-app/scripts/backfill-charge-split.ts` — slim deps; drop `RollupRepo`.
- `cmd/next-app/src/lib/db.ts` — remove `EnergyRollupRow`.

**Delete:**
- `cmd/next-app/src/lib/battery-provenance/rollup-repo.ts` + `rollup-repo.test.ts`
- `cmd/next-app/src/lib/battery-provenance/replay.ts` + `replay.test.ts`
- `cmd/next-app/src/lib/battery-provenance/genesis.ts` + `genesis.test.ts`

**Untouched (explicitly):** `battery-provenance/tank.ts` (now used by on-read arbitrage), `battery-provenance/rates.ts` (used by `plan-timeline`), `battery-provenance/backfill-service.ts` + its test, `rollup-backfill-repo.ts`, the `RollupBackfill` schema/`genesis_anchored` column.

---

## Task 1: On-read arbitrage engine

Rewrite `computeArbitrage` to replay the tank over hourly buckets, valuing charge at the date-resolved metered rate and scoring each hour's discharge against the tank blend (after that hour's charge).

**Files:**
- Modify: `cmd/next-app/src/lib/roi/arbitrage-service.ts`
- Test: `cmd/next-app/src/lib/roi/arbitrage-service.test.ts`

- [ ] **Step 1: Rewrite the test**

Replace the entire contents of `src/lib/roi/arbitrage-service.test.ts` with:

```ts
// arbitrage-service.test.ts
import { describe, it, expect } from 'vitest';
import { computeArbitrage } from './arbitrage-service';
import type { PlanTimeline } from './plan-timeline';
import type { EnergyHourlyRow } from '../db';

function hour(over: Partial<EnergyHourlyRow>): EnergyHourlyRow {
    return {
        site_id: 's1', local_date: '2026-01-01', hour: 0,
        load_wh: 0, solar_to_home_wh: 0, solar_to_battery_wh: 0, solar_to_grid_wh: 0,
        grid_to_home_wh: 0, grid_to_battery_wh: 0, battery_to_home_wh: 0, battery_to_grid_wh: 0,
        solar_only_import_wh: 0, solar_only_export_wh: 0, ...over,
    };
}

// Off-peak (hour < 16) cheap; peak (hour >= 16) expensive — drives charge vs discharge valuation.
const peaky = (offBuy: number, peakBuy: number): PlanTimeline => ({
    rateAt: (_d, h) => (h >= 16 ? { buy: peakBuy, sell: 0.04 } : { buy: offBuy, sell: 0.04 }),
});

describe('computeArbitrage', () => {
    it('scores a discharge against the tank blend (charge valued at its hour rate)', () => {
        // hour 6: charge 10 kWh grid @ buy 0.11 → cost basis $0.11/kWh.
        // hour 18: discharge 9 kWh to home @ buy 0.24 → benefit 9×0.24=2.16, cost 9×0.11=0.99.
        const rows = [
            hour({ hour: 6, grid_to_battery_wh: 10000 }),
            hour({ hour: 18, battery_to_home_wh: 9000 }),
        ];
        const a = computeArbitrage(rows, peaky(0.11, 0.24));
        expect(a.netPnl).toBeCloseTo(2.16 - 0.99, 2);
        expect(a.solarFraction).toBe(0); // all grid-origin
        expect(a.dischargedKwh).toBeCloseTo(9, 6);
    });

    it('attributes the solar fraction of discharged energy', () => {
        const rows = [
            hour({ hour: 6, solar_to_battery_wh: 5000, grid_to_battery_wh: 5000 }),
            hour({ hour: 18, battery_to_home_wh: 5000 }),
        ];
        const a = computeArbitrage(rows, peaky(0.11, 0.24));
        expect(a.solarFraction).toBeCloseTo(0.5, 6);
    });

    it('flags a losing cycle when cost basis per kWh exceeds benefit per kWh', () => {
        // charge expensive (0.30), discharge into cheap (0.11).
        const rows = [
            hour({ hour: 6, grid_to_battery_wh: 1000 }),
            hour({ hour: 18, battery_to_home_wh: 1000 }),
        ];
        const a = computeArbitrage(rows, peaky(0.30, 0.11));
        expect(a.losingCycleCount).toBe(1);
    });

    it('skips discharge before the tank holds attributable energy (no genesis seed)', () => {
        const rows = [ hour({ hour: 0, battery_to_home_wh: 5000 }) ];
        const a = computeArbitrage(rows, peaky(0.11, 0.24));
        expect(a.netPnl).toBe(0);
        expect(a.dischargedKwh).toBe(0);
    });

    it('returns zeros for no rows', () => {
        const a = computeArbitrage([], peaky(0.11, 0.24));
        expect(a).toEqual({ netPnl: 0, solarFraction: 0, losingCycleCount: 0, dischargedKwh: 0 });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/arbitrage-service`
Expected: FAIL — `computeArbitrage` still has the old `EnergyRollupRow[]` signature (type error / wrong results).

- [ ] **Step 3: Rewrite `arbitrage-service.ts`**

Replace the entire contents of `src/lib/roi/arbitrage-service.ts` with:

```ts
// arbitrage-service.ts
import type { EnergyHourlyRow } from '../db';
import type { PlanTimeline } from './plan-timeline';
import { chargeTank, dischargeTank, EMPTY_TANK, type Tank } from '../battery-provenance/tank';

const WH_PER_KWH = 1000;

export interface ArbitrageSummary {
    netPnl: number;          // dollars
    solarFraction: number;   // 0..1 of discharged energy that was solar-origin
    losingCycleCount: number;
    dischargedKwh: number;
}

/** On-read battery arbitrage P&L. Replays the cost-basis tank over hourly buckets in
 *  chronological order, valuing each hour's charge at the date-resolved metered rate and
 *  scoring that hour's discharge against the tank blend (after the hour's charge).
 *  Rows MUST be ordered by (local_date, hour) — HourlyRepo.getAllForSite already is.
 *  Starts from an empty tank: discharges before the tank holds attributable energy are
 *  skipped (matching the prior genesis-skip), a one-time startup gap within tolerance. */
export function computeArbitrage(rows: EnergyHourlyRow[], metered: PlanTimeline): ArbitrageSummary {
    let tank: Tank = EMPTY_TANK;
    let netPnl = 0, solarDischargeWh = 0, totalDischargeWh = 0, losing = 0;
    for (const r of rows) {
        const { buy, sell } = metered.rateAt(r.local_date, r.hour);
        tank = chargeTank(tank, Number(r.solar_to_battery_wh), Number(r.grid_to_battery_wh), buy, sell);

        const dischargeHomeWh = Number(r.battery_to_home_wh);
        const dischargeGridWh = Number(r.battery_to_grid_wh);
        const dischargeWh = dischargeHomeWh + dischargeGridWh;
        if (dischargeWh <= 0) continue;

        const tankWh = tank.solarWh + tank.gridWh;
        if (tankWh <= 0) continue; // nothing to attribute yet

        const solarFrac = tank.solarWh / tankWh;
        const costPerKwh = (tank.solarCost + tank.gridCost) / (tankWh / WH_PER_KWH); // $/kWh blended
        const dischargeKwh = dischargeWh / WH_PER_KWH;
        const benefit = (dischargeHomeWh / WH_PER_KWH) * buy + (dischargeGridWh / WH_PER_KWH) * sell;
        const costBasis = dischargeKwh * costPerKwh;
        const benefitPerKwh = benefit / dischargeKwh;

        tank = dischargeTank(tank, dischargeWh).tank;

        netPnl += benefit - costBasis;
        solarDischargeWh += dischargeWh * solarFrac;
        totalDischargeWh += dischargeWh;
        if (costPerKwh >= benefitPerKwh) losing += 1;
    }
    return {
        netPnl,
        solarFraction: totalDischargeWh > 0 ? solarDischargeWh / totalDischargeWh : 0,
        losingCycleCount: losing,
        dischargedKwh: totalDischargeWh / WH_PER_KWH,
    };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/arbitrage-service`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/arbitrage-service.ts cmd/next-app/src/lib/roi/arbitrage-service.test.ts
git commit -m "feat(roi): on-read arbitrage — replay tank over EnergyHourly with metered timeline"
```

---

## Task 2: Repoint the Savings page arbitrage to the hourly profile

`hourly` and `meteredTl` already exist in scope from C1. Switch arbitrage onto them and remove the last `EnergyRollup` reader.

**Files:**
- Modify: `cmd/next-app/src/app/site/[id]/page.tsx`

- [ ] **Step 1: Remove the `RollupRepo` import**

In `src/app/site/[id]/page.tsx`, delete this line (currently line 26):

```ts
import { RollupRepo } from '@/lib/battery-provenance/rollup-repo';
```

- [ ] **Step 2: Repoint arbitrage**

In the ROI computation block, replace these three lines (the arbitrage tail added in C1):

```ts
        // Arbitrage still reads EnergyRollup (Phase C2 re-grains tank replay to hourly on read).
        const rollups = await new RollupRepo().getAllForSite(finalSite.id);
        arbitrage = computeArbitrage(rollups);
```

with:

```ts
        arbitrage = computeArbitrage(hourly, meteredTl);
```

(`hourly` = `await new HourlyRepo().getAllForSite(...)` and `meteredTl` = `meteredTimeline(...)` are already declared earlier in this block from C1. `computeArbitrage` is already imported.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (No file imports `RollupRepo` from `page.tsx` anymore; `rollup-repo.ts` still exists but is now unreferenced — deleted in Task 6.)

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: both pass. The Savings tab now reads **only** `EnergyHourly`.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/app/site/[id]/page.tsx
git commit -m "feat(roi): Savings arbitrage reads EnergyHourly on read (last EnergyRollup reader removed)"
```

---

## Task 3: `HourlyRepo.hasHourlyForDate`

The daily `rollup` cron skips days already built (today via `RollupRepo.hasRollupForDate`). Add the `EnergyHourly` equivalent so Task 5 can drop `RollupRepo` from the cron.

**Files:**
- Modify: `cmd/next-app/src/lib/battery-provenance/hourly-repo.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/hourly-repo.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/battery-provenance/hourly-repo.test.ts`, add this describe block (after the existing `getAllForSite` describe):

```ts
describe('HourlyRepo.hasHourlyForDate', () => {
    beforeEach(() => poolQueryMock.mockReset());
    it('returns true when a row exists for the (site,date)', async () => {
        poolQueryMock.mockResolvedValue({ rows: [{ '1': 1 }] });
        const has = await new HourlyRepo().hasHourlyForDate('s1', '2026-01-07');
        expect(has).toBe(true);
        const sql = String(poolQueryMock.mock.calls[0][0]);
        expect(sql).toMatch(/FROM "EnergyHourly" WHERE site_id = \$1 AND local_date = \$2 LIMIT 1/);
        expect(poolQueryMock.mock.calls[0][1]).toEqual(['s1', '2026-01-07']);
    });
    it('returns false when no row exists', async () => {
        poolQueryMock.mockResolvedValue({ rows: [] });
        expect(await new HourlyRepo().hasHourlyForDate('s1', '2026-01-07')).toBe(false);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/battery-provenance/hourly-repo`
Expected: FAIL — `hasHourlyForDate` is not a function.

- [ ] **Step 3: Implement**

In `src/lib/battery-provenance/hourly-repo.ts`, add this method to the `HourlyRepo` class (after `getAllForSite`):

```ts
    /** True if any hourly bucket already exists for this local date (⇒ the day was built). */
    async hasHourlyForDate(siteId: string, localDate: string): Promise<boolean> {
        const res = await pool.query(
            `SELECT 1 FROM "EnergyHourly" WHERE site_id = $1 AND local_date = $2 LIMIT 1`,
            [siteId, localDate],
        );
        return res.rows.length > 0;
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/battery-provenance/hourly-repo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/battery-provenance/hourly-repo.ts cmd/next-app/src/lib/battery-provenance/hourly-repo.test.ts
git commit -m "feat(hourly): HourlyRepo.hasHourlyForDate skip-guard for the rollup cron"
```

---

## Task 4: Collapse `RollupService` to hourly-only

`rollupDay` no longer seeds a tank, runs genesis, replays periods, or writes `EnergyRollup`. It aggregates the day to hourly and upserts. The return shape (`{ rollupCount, genesisAnchored }`) and the `opts` param are **kept** so `BackfillService` and its tests need no changes (`forceGenesisAtStart` is accepted and ignored; `genesisAnchored` is always `false`).

**Files:**
- Modify: `cmd/next-app/src/lib/battery-provenance/rollup-service.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/rollup-service.test.ts`

- [ ] **Step 1: Rewrite the test**

Replace the entire contents of `src/lib/battery-provenance/rollup-service.test.ts` with:

```ts
import { describe, it, expect, vi } from 'vitest';
import { RollupService, type RollupDeps } from './rollup-service';
import type { EnergyData } from '../db';
import type { HourlyBucket } from './hourly-profile';

function row(ts: string, fields: Partial<EnergyData>): EnergyData {
    return { timestamp: new Date(ts), site_id: 'S1', tariff_id: 1, tariff_schedule_id: 10,
        load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0, battery_soc: null,
        battery_charge_from_solar: null, battery_charge_from_grid: null, ...fields };
}

describe('RollupService.rollupDay', () => {
    it('aggregates the day into hourly buckets and upserts them', async () => {
        const persisted: HourlyBucket[] = [];
        const deps: RollupDeps = {
            loadSite: async () => ({ id: 'S1', timezone: 'UTC', tariffs: [] }),
            loadEnergyData: async () => [ row('2026-01-02T13:00:00Z', { load_power: 3000, grid_power: 3000 }) ],
            upsertHourly: async (b) => { persisted.push(...b); },
        };
        const res = await new RollupService(deps).rollupDay('S1', '2026-01-02');
        expect(res.rollupCount).toBeGreaterThan(0);
        expect(res.genesisAnchored).toBe(false);
        expect(persisted.length).toBeGreaterThan(0);
        expect(persisted.every(b => b.localDate === '2026-01-02')).toBe(true);
    });

    it('no-ops when the day has no rows', async () => {
        const upsertHourly = vi.fn();
        const deps: RollupDeps = {
            loadSite: async () => ({ id: 'S1', timezone: 'UTC', tariffs: [] }),
            loadEnergyData: async () => [],
            upsertHourly,
        };
        const res = await new RollupService(deps).rollupDay('S1', '2026-01-02');
        expect(res.rollupCount).toBe(0);
        expect(upsertHourly).not.toHaveBeenCalled();
    });

    it('uses supplied rows and never calls loadEnergyData', async () => {
        const loadEnergyData = vi.fn();
        const deps: RollupDeps = {
            loadSite: async () => ({ id: 'S1', timezone: 'UTC', tariffs: [] }),
            loadEnergyData,
            upsertHourly: async () => {},
        };
        await new RollupService(deps).rollupDay('S1', '2026-01-02', {
            rows: [ row('2026-01-02T12:00:00Z', { load_power: 1000, grid_power: 1000 }) ],
        });
        expect(loadEnergyData).not.toHaveBeenCalled();
    });

    it('filters buckets to the requested local day', async () => {
        const persisted: HourlyBucket[] = [];
        const deps: RollupDeps = {
            loadSite: async () => ({ id: 'S1', timezone: 'America/Los_Angeles', tariffs: [] }),
            loadEnergyData: async () => [
                // 2026-01-02T07:00:00Z = 2026-01-01 23:00 LA (previous local day) — filtered out
                row('2026-01-02T07:00:00Z', { load_power: 1000, grid_power: 1000 }),
                // 2026-01-02T20:00:00Z = 2026-01-02 12:00 LA — kept
                row('2026-01-02T20:00:00Z', { load_power: 1000, grid_power: 1000 }),
            ],
            upsertHourly: async (b) => { persisted.push(...b); },
        };
        await new RollupService(deps).rollupDay('S1', '2026-01-02');
        expect(persisted.length).toBe(1);
        expect(persisted.every(b => b.localDate === '2026-01-02')).toBe(true);
    });

    it('accepts forceGenesisAtStart for backfill compatibility (no-op, anchored stays false)', async () => {
        const deps: RollupDeps = {
            loadSite: async () => ({ id: 'S1', timezone: 'UTC', tariffs: [] }),
            loadEnergyData: async () => [ row('2026-01-02T12:00:00Z', { load_power: 1000, grid_power: 1000 }) ],
            upsertHourly: async () => {},
        };
        const res = await new RollupService(deps).rollupDay('S1', '2026-01-02', { forceGenesisAtStart: true });
        expect(res.genesisAnchored).toBe(false);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/battery-provenance/rollup-service`
Expected: FAIL — old `RollupDeps` requires `getSeedTank`/`hasAnyRollup`/`upsertRollups` (type errors); the new slim deps don't satisfy it yet.

- [ ] **Step 3: Rewrite `rollup-service.ts`**

Replace the entire contents of `src/lib/battery-provenance/rollup-service.ts` with:

```ts
import type { Tariff } from '../db';
import type { EnergyData } from '../db';
import { aggregateHourly, type HourlyBucket } from './hourly-profile';
import { localDayBoundsUtc } from './local-day';

export interface RollupSite {
    id: string;
    timezone: string;
    tariffs: Tariff[];
}

export interface RollupDeps {
    loadSite: (siteId: string) => Promise<RollupSite>;
    loadEnergyData: (siteId: string, start: Date, end: Date) => Promise<EnergyData[]>;
    upsertHourly: (rows: HourlyBucket[]) => Promise<void>;
}

export class RollupService {
    constructor(private deps: RollupDeps) {}

    /** Build the hourly profile for a single local calendar day. Idempotent.
     *  opts.rows — aggregate these in-memory rows instead of reading the DB (backfill fetch-only path).
     *  opts.forceGenesisAtStart — accepted for BackfillService compatibility; no longer used.
     *    Battery provenance is computed on read (Phase C2), so genesis seeding was removed;
     *    genesisAnchored is always false. */
    async rollupDay(
        siteId: string,
        localDate: string,
        opts?: { rows?: EnergyData[]; forceGenesisAtStart?: boolean },
    ): Promise<{ rollupCount: number; genesisAnchored: boolean }> {
        const site = await this.deps.loadSite(siteId);
        const { start, end } = localDayBoundsUtc(localDate, site.timezone);

        const rows = opts?.rows ?? await this.deps.loadEnergyData(siteId, start, end);
        if (rows.length === 0) return { rollupCount: 0, genesisAnchored: false };

        const hourly = aggregateHourly(rows, site.timezone).filter(b => b.localDate === localDate);
        await this.deps.upsertHourly(hourly);
        return { rollupCount: hourly.length, genesisAnchored: false };
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/battery-provenance/rollup-service`
Expected: PASS.

- [ ] **Step 5: Typecheck (expect caller breakage, fixed in Task 5)**

Run: `npx tsc --noEmit`
Expected: errors ONLY in the four `RollupService` callers that still pass the removed deps — `src/app/api/cron/rollup/route.ts`, `src/app/api/cron/index-history/route.ts`, `scripts/backfill-rollups.ts`, `scripts/backfill-charge-split.ts`. No other files. Fixed in Task 5.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/battery-provenance/rollup-service.ts cmd/next-app/src/lib/battery-provenance/rollup-service.test.ts
git commit -m "refactor(hourly): RollupService.rollupDay is hourly-only (provenance moved on read)"
```

---

## Task 5: Update the crons and scripts to the slim `RollupService`

Drop `RollupRepo` construction and the removed deps from all four callers; switch the rollup cron's skip-guard to `hasHourlyForDate`.

**Files:**
- Modify: `cmd/next-app/src/app/api/cron/rollup/route.ts`
- Modify: `cmd/next-app/src/app/api/cron/index-history/route.ts`
- Modify: `cmd/next-app/scripts/backfill-rollups.ts`
- Modify: `cmd/next-app/scripts/backfill-charge-split.ts`

- [ ] **Step 1: `cron/rollup/route.ts`**

Delete the import line:

```ts
import { RollupRepo } from '@/lib/battery-provenance/rollup-repo';
```

Delete the construction line:

```ts
    const rollupRepo = new RollupRepo();
```

Replace the `buildService` deps object:

```ts
    const buildService = () => new RollupService({
      loadSite: async (siteId) => {
        const site = await siteRepo.getSite(siteId);
        if (!site) throw new Error(`site ${siteId} not found`);
        return { id: site.id, timezone: site.timezone, tariffs: site.tariffs ?? [] };
      },
      loadEnergyData: (siteId, start, end) => energyRepo.getRawEnergyData(siteId, start, end),
      getSeedTank: (siteId, beforeTs) => rollupRepo.getSeedTank(siteId, beforeTs),
      hasAnyRollup: (siteId) => rollupRepo.hasAnyRollup(siteId),
      upsertRollups: (rows) => rollupRepo.upsertRollups(rows),
      upsertHourly: (rows) => hourlyRepo.upsertHourly(rows),
    });
```

with:

```ts
    const buildService = () => new RollupService({
      loadSite: async (siteId) => {
        const site = await siteRepo.getSite(siteId);
        if (!site) throw new Error(`site ${siteId} not found`);
        return { id: site.id, timezone: site.timezone, tariffs: site.tariffs ?? [] };
      },
      loadEnergyData: (siteId, start, end) => energyRepo.getRawEnergyData(siteId, start, end),
      upsertHourly: (rows) => hourlyRepo.upsertHourly(rows),
    });
```

Replace the skip-guard line:

```ts
        if (await rollupRepo.hasRollupForDate(siteId, localDate)) {
```

with:

```ts
        if (await hourlyRepo.hasHourlyForDate(siteId, localDate)) {
```

- [ ] **Step 2: `cron/index-history/route.ts`**

Delete the import line:

```ts
import { RollupRepo } from '@/lib/battery-provenance/rollup-repo';
```

Delete the construction line:

```ts
  const rollupRepo = new RollupRepo();
```

Replace the `rollupService` deps object:

```ts
    const rollupService = new RollupService({
      loadSite: async (id) => {
        const s = await siteRepo.getSite(id);
        if (!s) throw new Error(`site ${id} not found`);
        return { id: s.id, timezone: s.timezone, tariffs: s.tariffs ?? [] };
      },
      loadEnergyData: (id, start, end) => energyRepo.getRawEnergyData(id, start, end),
      getSeedTank: (id, beforeTs) => rollupRepo.getSeedTank(id, beforeTs),
      hasAnyRollup: (id) => rollupRepo.hasAnyRollup(id),
      upsertRollups: (rows) => rollupRepo.upsertRollups(rows),
      upsertHourly: (rows) => hourlyRepo.upsertHourly(rows),
    });
```

with:

```ts
    const rollupService = new RollupService({
      loadSite: async (id) => {
        const s = await siteRepo.getSite(id);
        if (!s) throw new Error(`site ${id} not found`);
        return { id: s.id, timezone: s.timezone, tariffs: s.tariffs ?? [] };
      },
      loadEnergyData: (id, start, end) => energyRepo.getRawEnergyData(id, start, end),
      upsertHourly: (rows) => hourlyRepo.upsertHourly(rows),
    });
```

(Leave the `BackfillService` block and the `genesis_anchored` job field untouched — they still work.)

- [ ] **Step 3: `scripts/backfill-rollups.ts`**

Delete the dynamic import line:

```ts
    const { RollupRepo } = await import('../src/lib/battery-provenance/rollup-repo');
```

Delete the construction line:

```ts
    const rollupRepo = new RollupRepo();
```

Replace the `RollupService` deps object:

```ts
    const service = new RollupService({
        loadSite: async () => ({ id: site.id, timezone: site.timezone, tariffs: site.tariffs ?? [] }),
        loadEnergyData: (id, start, end) => energyRepo.getRawEnergyData(id, start, end),
        getSeedTank: (id, beforeTs) => rollupRepo.getSeedTank(id, beforeTs),
        hasAnyRollup: (id) => rollupRepo.hasAnyRollup(id),
        upsertRollups: (rows) => rollupRepo.upsertRollups(rows),
        upsertHourly: (rows) => hourlyRepo.upsertHourly(rows),
    });
```

with:

```ts
    const service = new RollupService({
        loadSite: async () => ({ id: site.id, timezone: site.timezone, tariffs: site.tariffs ?? [] }),
        loadEnergyData: (id, start, end) => energyRepo.getRawEnergyData(id, start, end),
        upsertHourly: (rows) => hourlyRepo.upsertHourly(rows),
    });
```

Update the log line for accuracy:

```ts
            console.log(`Rolled up date ${localDate}: ${rollupCount} periods`);
```

to:

```ts
            console.log(`Built hourly buckets for ${localDate}: ${rollupCount} hours`);
```

- [ ] **Step 4: `scripts/backfill-charge-split.ts`**

Delete the dynamic import line:

```ts
    const { RollupRepo } = await import('../src/lib/battery-provenance/rollup-repo');
```

Delete the construction line:

```ts
    const rollupRepo = new RollupRepo();
```

Replace the `RollupService` deps object:

```ts
    const rollupService = new RollupService({
        loadSite: async () => ({ id: site.id, timezone: site.timezone, tariffs: site.tariffs ?? [] }),
        loadEnergyData: (id, start, end) => energyRepo.getRawEnergyData(id, start, end),
        getSeedTank: (id, beforeTs) => rollupRepo.getSeedTank(id, beforeTs),
        hasAnyRollup: (id) => rollupRepo.hasAnyRollup(id),
        upsertRollups: (rows) => rollupRepo.upsertRollups(rows),
        upsertHourly: (rows) => hourlyRepo.upsertHourly(rows),
    });
```

with:

```ts
    const rollupService = new RollupService({
        loadSite: async () => ({ id: site.id, timezone: site.timezone, tariffs: site.tariffs ?? [] }),
        loadEnergyData: (id, start, end) => energyRepo.getRawEnergyData(id, start, end),
        upsertHourly: (rows) => hourlyRepo.upsertHourly(rows),
    });
```

Update the log line:

```ts
                console.log(`  [Rollup] Completed rollup for ${localDate} (${rollupCount} periods)`);
```

to:

```ts
                console.log(`  [Hourly] Built ${rollupCount} hourly buckets for ${localDate}`);
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. All four callers now match the slim `RollupDeps`. (`rollup-repo.ts`, `replay.ts`, `genesis.ts` still exist but are unreferenced — deleted in Task 6.)

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/app/api/cron/rollup/route.ts cmd/next-app/src/app/api/cron/index-history/route.ts cmd/next-app/scripts/backfill-rollups.ts cmd/next-app/scripts/backfill-charge-split.ts
git commit -m "refactor(hourly): point crons + backfill scripts at the slim RollupService"
```

---

## Task 6: Delete dead `EnergyRollup` code

With nothing reading or writing `EnergyRollup`, remove the repo, the period-rollup replay, genesis seeding, and the row type.

**Files:**
- Delete: `rollup-repo.ts` (+ test), `replay.ts` (+ test), `genesis.ts` (+ test)
- Modify: `cmd/next-app/src/lib/db.ts` (remove `EnergyRollupRow`)

- [ ] **Step 1: Confirm nothing references the doomed symbols**

Run:
```bash
cd cmd/next-app && grep -rn "rollup-repo\|RollupRepo\|from './replay'\|from '../replay'\|replayRows\|PeriodRollup\|genesis\|computeGenesisSeed\|EnergyRollupRow" src scripts
```
Expected: matches ONLY inside the files about to be deleted (`replay.ts`, `replay.test.ts`, `genesis.ts`, `genesis.test.ts`, `rollup-repo.ts`, `rollup-repo.test.ts`) and the `EnergyRollupRow` definition in `db.ts`. If anything else matches, stop and reconcile.

- [ ] **Step 2: Delete the files**

```bash
cd cmd/next-app && git rm \
  src/lib/battery-provenance/rollup-repo.ts \
  src/lib/battery-provenance/rollup-repo.test.ts \
  src/lib/battery-provenance/replay.ts \
  src/lib/battery-provenance/replay.test.ts \
  src/lib/battery-provenance/genesis.ts \
  src/lib/battery-provenance/genesis.test.ts
```

- [ ] **Step 3: Remove `EnergyRollupRow` from `db.ts`**

In `src/lib/db.ts`, delete the entire `EnergyRollupRow` interface (currently ~lines 173–195, the block beginning `export interface EnergyRollupRow {` through its closing `}`). Leave `EnergyHourlyRow` (immediately after it) intact.

- [ ] **Step 4: Typecheck + test + lint**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: all green. The suite no longer includes `replay`/`genesis`/`rollup-repo` tests; everything else passes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(hourly): delete EnergyRollup repo, period replay, genesis seeding, row type"
```

---

## Task 7: Migration — drop the `EnergyRollup` table

**Files:**
- Create: `cmd/next-app/db-migrations/<timestamp>_drop_energy_rollup.sql` (via generator)

- [ ] **Step 1: Generate the migration**

Run: `cd cmd/next-app && npm run db:migration:create drop_energy_rollup`
Expected: prints a new path `db-migrations/<timestamp>_drop_energy_rollup.sql`.

- [ ] **Step 2: Write the SQL**

Replace the generated file's contents with:

```sql
-- Retire EnergyRollup: the per-tariff-period daily aggregate is superseded by the
-- plan-agnostic EnergyHourly profile (Phase B), with pricing AND battery provenance
-- now computed on read (Phase C). Raw 5-min EnergyData is retained forever, so this
-- aggregate is fully recomputable if ever needed. Idempotent.
DROP TABLE IF EXISTS "EnergyRollup";
```

- [ ] **Step 3: Verify the build is unaffected**

Run: `cd cmd/next-app && npm run build`
Expected: build succeeds (migrations aren't run by build; this confirms no syntax slip).

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/db-migrations/
git commit -m "feat(hourly): drop EnergyRollup table — EnergyHourly is the sole aggregate"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full test suite**

Run: `cd cmd/next-app && npm test`
Expected: all pass — including the rewritten `arbitrage-service`, `rollup-service`, and `hourly-repo` tests; `backfill-service` tests unchanged and green.

- [ ] **Step 2: Build + lint + typecheck**

Run: `cd cmd/next-app && npm run build && npm run lint && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 3: Confirm `EnergyRollup` is fully retired**

Run: `cd cmd/next-app && grep -rn "EnergyRollup\|RollupRepo\|replayRows\|computeGenesisSeed" src scripts`
Expected: **no matches.** (The only `EnergyHourly` references remain.)

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "test(hourly): Phase C2 on-read provenance + EnergyRollup retirement green"
```

---

## Self-review notes (for the implementer)

- **Genesis was intentionally dropped (see the decision section).** Start-empty + skip-unattributable matches the old `computeArbitrage` genesis-skip; the startup gap is within the spec's accepted tolerance. Don't reintroduce genesis to "fix" a small early-history arbitrage difference — that's expected.
- **`ArbitrageSummary` shape is frozen** — `ArbitragePanel` consumes `{ netPnl, solarFraction, losingCycleCount, dischargedKwh }` and needs no changes.
- **`BackfillService` is deliberately untouched.** `RollupService.rollupDay` keeps `{ rollupCount, genesisAnchored }` and the `opts` param; `genesisAnchored` is hard-`false`, so the backfill's `forceGenesisAtStart`/`anchored` bookkeeping is a harmless no-op and `RollupBackfill.genesis_anchored` simply stays `false`. Do not refactor the backfill state machine in this plan.
- **`tank.ts` and `rates.ts` survive** — `tank.ts` is now arbitrage's engine; `rates.ts` is used by `plan-timeline` (C1). Only `replay.ts`/`genesis.ts`/`rollup-repo.ts` are dead.
- **Charge-then-discharge per hour** is the chosen intra-hour convention (matches the original per-5-min replay order, and is closer to it than the old prior-period-tank blend). Absolute parity with the old per-period arbitrage number is not expected — different grain.
- **Migration ordering:** the table drop (Task 7) lands after all code stops referencing it (Tasks 1–6). On deploy, CI runs the migration after the code that no longer needs the table — safe. `EnergyRollup` holds no production data (it was never in production per the spec), so the drop is non-destructive to users.
- **Pre-merge operational check (carried from C1):** the matrix, chart, **and now arbitrage** all read `EnergyHourly`. Confirm `EnergyHourly` is backfilled (index-history complete) for active sites before this reaches users, or the Savings tab shows empty/zero where `EnergyRollup` previously had history.
```
