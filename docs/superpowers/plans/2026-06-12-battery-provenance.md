# Battery Power Provenance & Per-Period Rollups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track the solar-vs-grid origin and cost basis of energy stored in the Powerwall, and roll up per-tariff-period energy flows daily, so every battery discharge can be attributed to a source and a dollar cost.

**Architecture:** A daily cron replays each site's 5-minute `EnergyData` in timestamp order through a weighted-average "tank" (running `{solarWh, gridWh, solarCost, gridCost}`), writing one `EnergyRollup` row per `(site, local_date, tariff_schedule_id)`. The tank carries forward chronologically via a `tank_as_of` timestamp. Charge source comes from Tesla's `battery_energy_imported_from_solar/grid` (newly persisted), falling back to the existing sankey merit-order allocation. Resolved `buy_rate`/`sell_rate` are snapshotted onto each rollup row, so period costs are stored-rate × stored-energy with no join, and an `EnergyRollup` row is fully self-contained.

**Tech Stack:** TypeScript, Next.js App Router, raw `pg` (node-postgres), Vitest, Vercel cron. Reuses `src/lib/sankey/build-flow-model.ts` (`allocateEdges`, `energyDataToInstant`) and `src/lib/schedule.ts` (`Schedule`, `TariffPeriod`).

**Spec:** `docs/superpowers/specs/2026-06-12-battery-provenance-design.md`

---

## File Structure

**New files:**
- `cmd/next-app/db-migrations/20260612_000000_battery_provenance.sql` — schema migration
- `cmd/next-app/src/lib/battery-provenance/tank.ts` — pure tank charge/discharge model
- `cmd/next-app/src/lib/battery-provenance/tank.test.ts`
- `cmd/next-app/src/lib/battery-provenance/rates.ts` — schedule→season rate resolution
- `cmd/next-app/src/lib/battery-provenance/rates.test.ts`
- `cmd/next-app/src/lib/battery-provenance/local-day.ts` — timezone date helpers
- `cmd/next-app/src/lib/battery-provenance/local-day.test.ts`
- `cmd/next-app/src/lib/battery-provenance/replay.ts` — replay rows → period rollups + tank
- `cmd/next-app/src/lib/battery-provenance/replay.test.ts`
- `cmd/next-app/src/lib/battery-provenance/genesis.ts` — genesis tank seeding
- `cmd/next-app/src/lib/battery-provenance/genesis.test.ts`
- `cmd/next-app/src/lib/battery-provenance/rollup-repo.ts` — `EnergyRollup` persistence + seed lookup
- `cmd/next-app/src/lib/battery-provenance/rollup-service.ts` — orchestration (rollup a day, backfill a site)
- `cmd/next-app/src/lib/battery-provenance/rollup-service.test.ts`
- `cmd/next-app/src/app/api/cron/rollup/route.ts` — daily cron endpoint
- `cmd/next-app/scripts/backfill-charge-split.ts` — one-time Tesla re-fetch of charge source
- `cmd/next-app/scripts/backfill-rollups.ts` — chronological rollup backfill

**Modified files:**
- `cmd/next-app/src/lib/db.ts` — add two optional fields to `EnergyData` interface
- `cmd/next-app/src/lib/importer/energy-transformer.ts` — add + populate charge-split fields
- `cmd/next-app/src/lib/importer/energy-transformer.test.ts` — assert new fields
- `cmd/next-app/src/lib/energy-repo.ts` — extend `insertEnergyDataBatch`
- `cmd/next-app/src/lib/importer/index.ts` — pass charge-split through two insert mappings
- `cmd/next-app/vercel.json` — register the rollup cron

All commands below run from `cmd/next-app/`.

---

## Task 0: (removed)

The earlier "verify `TariffSchedule` immutability" gate is no longer needed: `buy_rate`/`sell_rate` are snapshotted onto each `EnergyRollup` row at rollup time (Task 6), so later tariff edits cannot rewrite historical costs. No action required. Proceed to Task 1.

---

## Task 1: Schema migration

**Files:**
- Create: `db-migrations/20260612_000000_battery_provenance.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Battery power provenance + per-tariff-period energy rollups.
-- Idempotent (safe to re-run).

-- 1. Persist Tesla's per-interval battery charge source (Wh). Nullable:
--    historical rows we cannot re-fetch fall back to sankey-derived split.
ALTER TABLE "EnergyData" ADD COLUMN IF NOT EXISTS battery_charge_from_solar INTEGER;
ALTER TABLE "EnergyData" ADD COLUMN IF NOT EXISTS battery_charge_from_grid INTEGER;

-- 2. One row per (site, local calendar date, tariff period).
CREATE TABLE IF NOT EXISTS "EnergyRollup" (
    site_id            TEXT    NOT NULL,
    local_date         DATE    NOT NULL,
    tariff_schedule_id INTEGER NOT NULL,

    -- Period energy flows (Wh).
    load_wh             DOUBLE PRECISION NOT NULL DEFAULT 0,
    solar_to_home_wh    DOUBLE PRECISION NOT NULL DEFAULT 0,
    solar_to_battery_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
    solar_to_grid_wh    DOUBLE PRECISION NOT NULL DEFAULT 0,
    grid_to_home_wh     DOUBLE PRECISION NOT NULL DEFAULT 0,
    grid_to_battery_wh  DOUBLE PRECISION NOT NULL DEFAULT 0,
    battery_to_home_wh  DOUBLE PRECISION NOT NULL DEFAULT 0,
    battery_to_grid_wh  DOUBLE PRECISION NOT NULL DEFAULT 0,

    -- End-of-period tank state (path-dependent carry-forward seed).
    tank_solar_wh   DOUBLE PRECISION NOT NULL DEFAULT 0,
    tank_grid_wh    DOUBLE PRECISION NOT NULL DEFAULT 0,
    tank_solar_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
    tank_grid_cost  DOUBLE PRECISION NOT NULL DEFAULT 0,
    tank_as_of      TIMESTAMPTZ NOT NULL,

    -- Snapshot fields: resolved rates frozen at rollup time (no join needed),
    -- and end-of-period SOC.
    buy_rate    DOUBLE PRECISION NOT NULL DEFAULT 0,
    sell_rate   DOUBLE PRECISION NOT NULL DEFAULT 0,
    battery_soc DOUBLE PRECISION,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (site_id, local_date, tariff_schedule_id)
);

-- Range reads for a site.
CREATE INDEX IF NOT EXISTS idx_energyrollup_site_date
    ON "EnergyRollup" (site_id, local_date);

-- Carry-forward seed lookup: row with greatest tank_as_of before a given instant.
CREATE INDEX IF NOT EXISTS idx_energyrollup_seed
    ON "EnergyRollup" (site_id, tank_as_of);
```

- [ ] **Step 2: Apply the migration locally**

Run: `supabase migration up --db-url "$DATABASE_URL"` (or, against local SQLite dev, apply via the project's normal migration path).
Expected: succeeds; re-running is a no-op.

- [ ] **Step 3: Verify the table exists**

Run: `psql "$DATABASE_URL" -c '\d "EnergyRollup"'`
Expected: lists all columns with the composite primary key.

- [ ] **Step 4: Commit**

```bash
git add db-migrations/20260612_000000_battery_provenance.sql
git commit -m "feat(db): EnergyData charge-split columns + EnergyRollup table"
```

---

## Task 2: Persist Tesla charge source on import

**Files:**
- Modify: `src/lib/db.ts` (`EnergyData` interface, ~line 110)
- Modify: `src/lib/importer/energy-transformer.ts` (`EnergyDataRow` + `transformEnergyPoints`)
- Test: `src/lib/importer/energy-transformer.test.ts`
- Modify: `src/lib/energy-repo.ts` (`insertEnergyDataBatch`, ~line 493)
- Modify: `src/lib/importer/index.ts` (insert mappings ~line 83 and ~line 395)

- [ ] **Step 1: Write the failing test**

Add to `src/lib/importer/energy-transformer.test.ts` (the existing test fixtures already include `battery_energy_imported_from_solar`/`_from_grid`):

```typescript
it('carries Tesla battery charge source into the row', () => {
    const history = [{
        timestamp: '2026-01-01T10:00:00Z',
        total_solar_generation: 1000,
        total_home_usage: 500,
        grid_energy_imported: 0,
        total_grid_energy_exported: 0,
        total_battery_charge: 800,
        total_battery_discharge: 0,
        battery_energy_imported_from_solar: 600,
        battery_energy_imported_from_grid: 200,
        // remaining required EnergyHistoryEntry fields default to 0:
        grid_energy_exported_from_solar: 0,
        battery_energy_exported: 0,
        battery_energy_imported_from_generator: 0,
        consumer_energy_imported_from_grid: 0,
        consumer_energy_imported_from_solar: 0,
    }] as unknown as Parameters<typeof transformEnergyPoints>[0];

    const rows = transformEnergyPoints(history, [], 'day', 24, {
        siteId: 'S1',
        getTariffId: () => 1,
        getTariffScheduleId: () => 10,
    });

    expect(rows[0].battery_charge_from_solar).toBe(600);
    expect(rows[0].battery_charge_from_grid).toBe(200);
});
```

(If existing fixtures in this file already define all `EnergyHistoryEntry` fields, reuse that fixture shape instead of the inline cast.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/importer/energy-transformer.test.ts`
Expected: FAIL — `battery_charge_from_solar` is `undefined`.

- [ ] **Step 3: Add the fields to `EnergyDataRow` and populate them**

In `src/lib/importer/energy-transformer.ts`, extend the interface:

```typescript
export interface EnergyDataRow {
    site_id: string;
    tariff_id: number;
    tariff_schedule_id: number | null;
    timestamp: Date;
    load_power: number;
    solar_power: number;
    grid_power: number;
    battery_power: number;
    battery_soc: number | null;
    battery_charge_from_solar: number | null;
    battery_charge_from_grid: number | null;
}
```

In `transformEnergyPoints`, inside the `results.push({ ... })`, add (using the same `scale` the other aggregates use):

```typescript
        battery_charge_from_solar: (h.battery_energy_imported_from_solar ?? 0) * scale,
        battery_charge_from_grid: (h.battery_energy_imported_from_grid ?? 0) * scale,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/importer/energy-transformer.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the fields to the `EnergyData` DB interface**

In `src/lib/db.ts`, extend the `EnergyData` interface:

```typescript
export interface EnergyData {
  id?: number;
  timestamp: Date;
  site_id: string;
  tariff_id: number;
  tariff_schedule_id: number | null;
  load_power: number;
  solar_power: number;
  grid_power: number;
  battery_power: number;
  battery_soc: number | null;
  battery_charge_from_solar?: number | null;
  battery_charge_from_grid?: number | null;
}
```

- [ ] **Step 6: Extend `insertEnergyDataBatch`**

In `src/lib/energy-repo.ts`, replace the `insertEnergyDataBatch` method body so the new columns are written. Update the row type, placeholders (now 11 per row), params, the column list, and the `ON CONFLICT` set:

```typescript
    async insertEnergyDataBatch(rows: Array<{
        site_id: string;
        tariff_id: number;
        tariff_schedule_id?: number | null;
        timestamp: Date;
        load_power: number;
        solar_power: number;
        grid_power: number;
        battery_power: number;
        battery_soc: number | null;
        battery_charge_from_solar?: number | null;
        battery_charge_from_grid?: number | null;
    }>): Promise<void> {
        if (rows.length === 0) return;

        const valuePlaceholders: string[] = [];
        const params: unknown[] = [];
        let p = 1;
        for (const r of rows) {
            valuePlaceholders.push(
                `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
            );
            params.push(
                r.site_id, r.tariff_id, r.timestamp,
                r.load_power, r.solar_power, r.grid_power, r.battery_power,
                r.battery_soc, r.tariff_schedule_id ?? null,
                r.battery_charge_from_solar ?? null,
                r.battery_charge_from_grid ?? null
            );
        }

        await pool.query(`
            INSERT INTO "EnergyData"(site_id, tariff_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc, tariff_schedule_id, battery_charge_from_solar, battery_charge_from_grid)
            VALUES ${valuePlaceholders.join(', ')}
            ON CONFLICT(timestamp, site_id) DO UPDATE SET
                tariff_id = EXCLUDED.tariff_id,
                load_power = EXCLUDED.load_power,
                solar_power = EXCLUDED.solar_power,
                grid_power = EXCLUDED.grid_power,
                battery_power = EXCLUDED.battery_power,
                battery_soc = COALESCE(EXCLUDED.battery_soc, "EnergyData".battery_soc),
                tariff_schedule_id = EXCLUDED.tariff_schedule_id,
                battery_charge_from_solar = COALESCE(EXCLUDED.battery_charge_from_solar, "EnergyData".battery_charge_from_solar),
                battery_charge_from_grid = COALESCE(EXCLUDED.battery_charge_from_grid, "EnergyData".battery_charge_from_grid)
        `, params);
    }
```

- [ ] **Step 7: Pass the fields through both importer insert mappings**

In `src/lib/importer/index.ts`, both `insertEnergyDataBatch(...map(...))` call sites (around lines 83 and 395) build an object from `row`. Add to each mapped object:

```typescript
            battery_charge_from_solar: row.battery_charge_from_solar,
            battery_charge_from_grid: row.battery_charge_from_grid,
```

- [ ] **Step 8: Verify build + full transformer tests**

Run: `npm test -- src/lib/importer/ && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/db.ts src/lib/importer/energy-transformer.ts src/lib/importer/energy-transformer.test.ts src/lib/energy-repo.ts src/lib/importer/index.ts
git commit -m "feat(importer): persist Tesla battery charge source (solar/grid)"
```

---

## Task 3: Rate resolution helper

**Files:**
- Create: `src/lib/battery-provenance/rates.ts`
- Test: `src/lib/battery-provenance/rates.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { resolveRates } from './rates';
import type { TariffPeriod } from '../schedule';

function period(scheduleRates: { buy: number | null; sell: number | null }, seasonRates: { buy: number; sell: number }): TariffPeriod {
    return {
        start: new Date(), end: new Date(),
        tariff: {} as TariffPeriod['tariff'],
        season: { buy_rate: seasonRates.buy, sell_rate: seasonRates.sell } as TariffPeriod['season'],
        schedule: { buy_rate: scheduleRates.buy, sell_rate: scheduleRates.sell } as TariffPeriod['schedule'],
    };
}

describe('resolveRates', () => {
    it('uses schedule rates when present', () => {
        expect(resolveRates(period({ buy: 0.24, sell: 0.04 }, { buy: 0.11, sell: 0.03 })))
            .toEqual({ buyRate: 0.24, sellRate: 0.04 });
    });

    it('falls back to season rates when schedule rates are null', () => {
        expect(resolveRates(period({ buy: null, sell: null }, { buy: 0.11, sell: 0.03 })))
            .toEqual({ buyRate: 0.11, sellRate: 0.03 });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/battery-provenance/rates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import type { TariffPeriod } from '../schedule';

export interface Rates {
    buyRate: number;
    sellRate: number;
}

/** Schedule rates win; fall back to the parent season's rates when null. */
export function resolveRates(period: TariffPeriod): Rates {
    return {
        buyRate: period.schedule.buy_rate ?? period.season.buy_rate,
        sellRate: period.schedule.sell_rate ?? period.season.sell_rate,
    };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/battery-provenance/rates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/battery-provenance/rates.ts src/lib/battery-provenance/rates.test.ts
git commit -m "feat(provenance): tariff rate resolution helper"
```

---

## Task 4: Tank model

**Files:**
- Create: `src/lib/battery-provenance/tank.ts`
- Test: `src/lib/battery-provenance/tank.test.ts`

Rates are $/kWh; energy is Wh. Cost contributions convert via `/1000`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { EMPTY_TANK, chargeTank, dischargeTank } from './tank';

describe('tank', () => {
    it('charges grid at buy rate and solar at sell rate ($/kWh, energy Wh)', () => {
        let t = chargeTank(EMPTY_TANK, 0, 4000, 0.11, 0.04);   // 4 kWh grid @ $0.11
        t = chargeTank(t, 5000, 0, 0.11, 0.04);                // 5 kWh solar @ $0.04
        expect(t.gridWh).toBe(4000);
        expect(t.solarWh).toBe(5000);
        expect(t.gridCost).toBeCloseTo(0.44, 6);
        expect(t.solarCost).toBeCloseTo(0.20, 6);
    });

    it('discharges proportionally, preserving ratio and drawing cost pro-rata', () => {
        let t = chargeTank(EMPTY_TANK, 0, 4000, 0.11, 0.04);
        t = chargeTank(t, 5000, 0, 0.11, 0.04);                // tank: 9 kWh, $0.64
        const { tank, draw } = dischargeTank(t, 4500);         // draw half
        expect(draw.solarWh).toBeCloseTo(2500, 6);
        expect(draw.gridWh).toBeCloseTo(2000, 6);
        expect(draw.solarCost + draw.gridCost).toBeCloseTo(0.32, 6);
        expect(tank.solarWh).toBeCloseTo(2500, 6);
        expect(tank.gridWh).toBeCloseTo(2000, 6);
    });

    it('is a no-op when discharging an empty tank', () => {
        const { tank, draw } = dischargeTank(EMPTY_TANK, 1000);
        expect(draw).toEqual({ solarWh: 0, gridWh: 0, solarCost: 0, gridCost: 0 });
        expect(tank).toEqual(EMPTY_TANK);
    });

    it('caps the draw at what is in the tank', () => {
        const t = chargeTank(EMPTY_TANK, 1000, 0, 0.11, 0.04); // 1 kWh solar
        const { tank, draw } = dischargeTank(t, 5000);         // ask for more than available
        expect(draw.solarWh).toBeCloseTo(1000, 6);
        expect(tank.solarWh).toBeCloseTo(0, 6);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/battery-provenance/tank.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
const WH_PER_KWH = 1000;

export interface Tank {
    solarWh: number;
    gridWh: number;
    solarCost: number; // dollars
    gridCost: number;  // dollars
}

export interface DischargeDraw {
    solarWh: number;
    gridWh: number;
    solarCost: number;
    gridCost: number;
}

export const EMPTY_TANK: Tank = { solarWh: 0, gridWh: 0, solarCost: 0, gridCost: 0 };

/** Add charge to the tank, valued at charge time. Rates are $/kWh; energy is Wh. */
export function chargeTank(tank: Tank, solarWh: number, gridWh: number, buyRate: number, sellRate: number): Tank {
    return {
        solarWh: tank.solarWh + solarWh,
        gridWh: tank.gridWh + gridWh,
        // Solar's cost basis is its forgone export value (sell rate); grid's is cash paid (buy rate).
        solarCost: tank.solarCost + (solarWh / WH_PER_KWH) * sellRate,
        gridCost: tank.gridCost + (gridWh / WH_PER_KWH) * buyRate,
    };
}

/** Remove energy proportionally across both sources, preserving the blend. */
export function dischargeTank(tank: Tank, dischargeWh: number): { tank: Tank; draw: DischargeDraw } {
    const total = tank.solarWh + tank.gridWh;
    if (dischargeWh <= 0 || total <= 0) {
        return { tank, draw: { solarWh: 0, gridWh: 0, solarCost: 0, gridCost: 0 } };
    }
    const f = Math.min(dischargeWh, total) / total;
    const draw: DischargeDraw = {
        solarWh: tank.solarWh * f,
        gridWh: tank.gridWh * f,
        solarCost: tank.solarCost * f,
        gridCost: tank.gridCost * f,
    };
    return {
        tank: {
            solarWh: tank.solarWh - draw.solarWh,
            gridWh: tank.gridWh - draw.gridWh,
            solarCost: tank.solarCost - draw.solarCost,
            gridCost: tank.gridCost - draw.gridCost,
        },
        draw,
    };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/battery-provenance/tank.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/battery-provenance/tank.ts src/lib/battery-provenance/tank.test.ts
git commit -m "feat(provenance): weighted-average battery tank model"
```

---

## Task 5: Timezone date helpers

**Files:**
- Create: `src/lib/battery-provenance/local-day.ts`
- Test: `src/lib/battery-provenance/local-day.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { localDateKey, localDayBoundsUtc } from './local-day';

describe('local-day', () => {
    it('maps an instant to its local calendar date', () => {
        // 2026-01-02T03:00:00Z is still 2026-01-01 in America/Los_Angeles (UTC-8).
        expect(localDateKey(new Date('2026-01-02T03:00:00Z'), 'America/Los_Angeles')).toBe('2026-01-01');
    });

    it('computes UTC bounds for a local day', () => {
        const { start, end } = localDayBoundsUtc('2026-01-01', 'America/Los_Angeles');
        // PST is UTC-8: local midnight = 08:00Z.
        expect(start.toISOString()).toBe('2026-01-01T08:00:00.000Z');
        expect(end.toISOString()).toBe('2026-01-02T08:00:00.000Z');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/battery-provenance/local-day.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/** 'YYYY-MM-DD' for the given instant in the given IANA timezone. */
export function localDateKey(ts: Date, timeZone: string): string {
    // en-CA renders as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(ts);
}

/** Offset (ms) of `timeZone` from UTC at instant `ts`: localWallClock - utc. */
function tzOffsetMs(ts: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(ts);
    const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
    let hour = get('hour');
    if (hour === 24) hour = 0;
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
    return asUtc - ts.getTime();
}

/** UTC [start, end) instants bounding the given local calendar date. */
export function localDayBoundsUtc(localDate: string, timeZone: string): { start: Date; end: Date } {
    const [y, m, d] = localDate.split('-').map(Number);
    const startGuess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    const start = new Date(startGuess.getTime() - tzOffsetMs(startGuess, timeZone));
    const endGuess = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
    const end = new Date(endGuess.getTime() - tzOffsetMs(endGuess, timeZone));
    return { start, end };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/battery-provenance/local-day.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/battery-provenance/local-day.ts src/lib/battery-provenance/local-day.test.ts
git commit -m "feat(provenance): timezone-aware local-day helpers"
```

---

## Task 6: Replay rows into period rollups

**Files:**
- Create: `src/lib/battery-provenance/replay.ts`
- Test: `src/lib/battery-provenance/replay.test.ts`

Reuses `allocateEdges` + `energyDataToInstant` from `../sankey/build-flow-model` (edge energies are kWh; multiply by 1000 for Wh). The charge split prefers Tesla's stored Wh, else the sankey `solar-battery`/`grid-battery` edges.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { replayRows } from './replay';
import { EMPTY_TANK } from './tank';
import { Schedule } from '../schedule';
import type { EnergyData } from '../db';

// One tariff (id 1) / season / schedule (id 10), flat rates, all hours.
const tariffs = [{
    id: 1, name: 't', site_id: 'S1',
    seasons: [{
        id: 1, tariff_id: 1, name: 's', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
        buy_rate: 0.11, sell_rate: 0.04,
        schedules: [{
            id: 10, season_id: 1, name: 'flat',
            buy_rate: 0.11, sell_rate: 0.04,
            from_day_of_week: 0, to_day_of_week: 6,
            from_hour: null, from_minute: null, to_hour: null, to_minute: null,
        }],
    }],
}] as unknown as ConstructorParameters<typeof Schedule>[0];

function row(ts: string, fields: Partial<EnergyData>): EnergyData {
    return {
        timestamp: new Date(ts), site_id: 'S1', tariff_id: 1, tariff_schedule_id: 10,
        load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0, battery_soc: null,
        battery_charge_from_solar: null, battery_charge_from_grid: null, ...fields,
    };
}

describe('replayRows', () => {
    it('charges from Tesla split, discharges at the blended ratio, and snapshots the tank', () => {
        const schedule = new Schedule(tariffs, 'UTC');
        const rows: EnergyData[] = [
            // Grid charge 4000 Wh (battery_power + = charge), Tesla says all grid.
            row('2026-01-01T02:00:00Z', { battery_power: 4000, grid_power: 4000, load_power: 0,
                battery_charge_from_solar: 0, battery_charge_from_grid: 4000 }),
            // Solar charge 5000 Wh from solar.
            row('2026-01-01T13:00:00Z', { battery_power: 5000, solar_power: 5000, load_power: 0,
                battery_charge_from_solar: 5000, battery_charge_from_grid: 0 }),
            // Discharge 4500 Wh to home (battery_power - = discharge).
            row('2026-01-01T19:00:00Z', { battery_power: -4500, load_power: 4500, battery_soc: 55 }),
        ];

        const { rollups, endTank } = replayRows(rows, schedule, 'UTC', EMPTY_TANK);

        expect(rollups).toHaveLength(1);
        const r = rollups[0];
        expect(r.localDate).toBe('2026-01-01');
        expect(r.tariffScheduleId).toBe(10);
        expect(r.solarToBatteryWh).toBeCloseTo(5000, 3);
        expect(r.gridToBatteryWh).toBeCloseTo(4000, 3);
        expect(r.batteryToHomeWh).toBeCloseTo(4500, 3);
        expect(r.buyRate).toBeCloseTo(0.11, 6);
        expect(r.sellRate).toBeCloseTo(0.04, 6);
        expect(r.batterySoc).toBe(55); // SOC of the last interval
        // After charging: 5000 solar + 4000 grid = 9000; discharge 4500 = half.
        expect(endTank.solarWh).toBeCloseTo(2500, 3);
        expect(endTank.gridWh).toBeCloseTo(2000, 3);
        expect(r.tank.solarWh).toBeCloseTo(2500, 3);
        expect(r.tankAsOf.toISOString()).toBe('2026-01-01T19:00:00.000Z');
    });

    it('falls back to sankey-derived charge split when Tesla values are null', () => {
        const schedule = new Schedule(tariffs, 'UTC');
        const rows: EnergyData[] = [
            // Solar 6000, load 1000 → 1000 solar-home, 5000 solar-battery (merit order).
            row('2026-01-01T12:00:00Z', { solar_power: 6000, load_power: 1000, battery_power: 5000 }),
        ];
        const { endTank } = replayRows(rows, schedule, 'UTC', EMPTY_TANK);
        expect(endTank.solarWh).toBeCloseTo(5000, 3);
        expect(endTank.gridWh).toBeCloseTo(0, 3);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/battery-provenance/replay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import type { EnergyData } from '../db';
import { Schedule } from '../schedule';
import { allocateEdges, energyDataToInstant } from '../sankey/build-flow-model';
import type { EdgeCategory } from '../sankey/flow-model';
import { resolveRates } from './rates';
import { chargeTank, dischargeTank, EMPTY_TANK, type Tank } from './tank';
import { localDateKey } from './local-day';

const WH_PER_KWH = 1000;

export interface PeriodRollup {
    siteId: string;
    localDate: string;
    tariffScheduleId: number;
    loadWh: number;
    solarToHomeWh: number;
    solarToBatteryWh: number;
    solarToGridWh: number;
    gridToHomeWh: number;
    gridToBatteryWh: number;
    batteryToHomeWh: number;
    batteryToGridWh: number;
    buyRate: number;          // resolved rate snapshot for this period
    sellRate: number;
    batterySoc: number | null; // SOC as of tankAsOf (end of period)
    tank: Tank;       // end-of-period snapshot of the continuous tank
    tankAsOf: Date;   // timestamp of the last interval folded into this row
}

function edgeWh(edges: ReturnType<typeof allocateEdges>, category: EdgeCategory): number {
    const e = edges.find(x => x.category === category);
    return e ? e.energy * WH_PER_KWH : 0;
}

function emptyRollup(siteId: string, localDate: string, scheduleId: number): PeriodRollup {
    return {
        siteId, localDate, tariffScheduleId: scheduleId,
        loadWh: 0, solarToHomeWh: 0, solarToBatteryWh: 0, solarToGridWh: 0,
        gridToHomeWh: 0, gridToBatteryWh: 0, batteryToHomeWh: 0, batteryToGridWh: 0,
        buyRate: 0, sellRate: 0, batterySoc: null,
        tank: EMPTY_TANK, tankAsOf: new Date(0),
    };
}

/**
 * Replay EnergyData rows (any span) in timestamp order through one continuous tank.
 * Emits one PeriodRollup per (localDate, tariff_schedule_id); each row snapshots the
 * continuous tank as of its last contributing interval. Returns the final tank.
 */
export function replayRows(
    rows: EnergyData[],
    schedule: Schedule,
    timeZone: string,
    seed: Tank,
): { rollups: PeriodRollup[]; endTank: Tank } {
    const ordered = [...rows].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const byKey = new Map<string, PeriodRollup>();
    let tank = seed;

    for (const row of ordered) {
        const period = schedule.getTariffPeriod(row.timestamp);
        if (!period || row.tariff_schedule_id == null) continue; // unkeyable; skip
        const rates = resolveRates(period);
        const edges = allocateEdges(energyDataToInstant(row), { buyRate: 0, sellRate: 0 });

        const solarToBatteryWh = edgeWh(edges, 'solar-battery');
        const gridToBatteryWh = edgeWh(edges, 'grid-battery');
        const batteryToHomeWh = edgeWh(edges, 'battery-home');
        const batteryToGridWh = edgeWh(edges, 'battery-export'); // allocator names battery→grid 'battery-export'

        // Prefer Tesla's measured charge source; fall back to sankey allocation.
        const chargeSolarWh = row.battery_charge_from_solar ?? solarToBatteryWh;
        const chargeGridWh = row.battery_charge_from_grid ?? gridToBatteryWh;

        tank = chargeTank(tank, chargeSolarWh, chargeGridWh, rates.buyRate, rates.sellRate);
        const dischargeWh = batteryToHomeWh + batteryToGridWh;
        if (dischargeWh > 0) {
            tank = dischargeTank(tank, dischargeWh).tank;
        }

        const localDate = localDateKey(row.timestamp, timeZone);
        const key = `${localDate}|${row.tariff_schedule_id}`;
        let r = byKey.get(key);
        if (!r) {
            r = emptyRollup(row.site_id, localDate, row.tariff_schedule_id);
            byKey.set(key, r);
        }
        r.loadWh += edgeWh(edges, 'solar-home') + edgeWh(edges, 'grid-home') + batteryToHomeWh; // = home load served
        r.solarToHomeWh += edgeWh(edges, 'solar-home');
        r.solarToBatteryWh += solarToBatteryWh;
        r.solarToGridWh += edgeWh(edges, 'solar-export');
        r.gridToHomeWh += edgeWh(edges, 'grid-home');
        r.gridToBatteryWh += gridToBatteryWh;
        r.batteryToHomeWh += batteryToHomeWh;
        r.batteryToGridWh += batteryToGridWh;
        r.buyRate = rates.buyRate;   // constant across the period (one schedule)
        r.sellRate = rates.sellRate;
        r.batterySoc = row.battery_soc; // SOC of the latest interval = end of period
        r.tank = tank;            // continuous tank as of this interval
        r.tankAsOf = row.timestamp;
    }

    return { rollups: [...byKey.values()], endTank: tank };
}
```

Note on `loadWh`: home load served in a period = `solar→home + grid→home + battery→home` (the sankey has no single "load" edge). Confirm the edge category names against `src/lib/sankey/flow-model.ts` (`solar-home`, `grid-home`, `battery-home`, `solar-export`, `solar-battery`, `grid-battery`, `battery-export`) and adjust the `battery-grid`/`battery-export` name to match (the allocator in `build-flow-model.ts` emits `battery-export` for battery→grid).

- [ ] **Step 4: Reconcile edge category names**

Run: `grep -n "battery-export\|battery-grid\|solar-export\|EdgeCategory" src/lib/sankey/flow-model.ts src/lib/sankey/build-flow-model.ts`
If battery→grid is `battery-export` (not `battery-grid`) and solar→grid is `solar-export`, update the `edgeWh(...)` calls in `replay.ts` accordingly. Keep the `PeriodRollup` field names (`batteryToGridWh`, `solarToGridWh`) as-is.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/lib/battery-provenance/replay.test.ts`
Expected: PASS. Fix category-name mismatches surfaced in Step 4 if the test fails on edge energies.

- [ ] **Step 6: Commit**

```bash
git add src/lib/battery-provenance/replay.ts src/lib/battery-provenance/replay.test.ts
git commit -m "feat(provenance): replay EnergyData into per-period rollups"
```

---

## Task 7: Genesis tank seeding

**Files:**
- Create: `src/lib/battery-provenance/genesis.ts`
- Test: `src/lib/battery-provenance/genesis.test.ts`

Anchor on the first interval where `battery_soc ≥ FULL_THRESHOLD`; seed from the contiguous charging run-up that filled it. Returns the seed tank and the anchor index (replay starts there). Returns `null` if no full anchor exists.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { computeGenesisSeed } from './genesis';
import { Schedule } from '../schedule';
import type { EnergyData } from '../db';

const tariffs = [{
    id: 1, name: 't', site_id: 'S1',
    seasons: [{
        id: 1, tariff_id: 1, name: 's', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
        buy_rate: 0.11, sell_rate: 0.04,
        schedules: [{ id: 10, season_id: 1, name: 'flat', buy_rate: 0.11, sell_rate: 0.04,
            from_day_of_week: 0, to_day_of_week: 6, from_hour: null, from_minute: null, to_hour: null, to_minute: null }],
    }],
}] as unknown as ConstructorParameters<typeof Schedule>[0];

function row(ts: string, soc: number | null, fields: Partial<EnergyData>): EnergyData {
    return {
        timestamp: new Date(ts), site_id: 'S1', tariff_id: 1, tariff_schedule_id: 10,
        load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0, battery_soc: soc,
        battery_charge_from_solar: null, battery_charge_from_grid: null, ...fields,
    };
}

describe('computeGenesisSeed', () => {
    it('seeds the tank from the charge run-up that fills the battery', () => {
        const schedule = new Schedule(tariffs, 'UTC');
        const rows: EnergyData[] = [
            row('2026-01-01T00:00:00Z', 50, {}),                                   // pre-charge, not full
            row('2026-01-01T01:00:00Z', 70, { battery_power: 3000, grid_power: 3000, battery_charge_from_grid: 3000, battery_charge_from_solar: 0 }),
            row('2026-01-01T02:00:00Z', 99, { battery_power: 3000, solar_power: 3000, battery_charge_from_solar: 3000, battery_charge_from_grid: 0 }), // full
        ];
        const result = computeGenesisSeed(rows, schedule, 'UTC', 98);
        expect(result).not.toBeNull();
        expect(result!.anchorIndex).toBe(2);
        expect(result!.seed.gridWh).toBeCloseTo(3000, 3);
        expect(result!.seed.solarWh).toBeCloseTo(3000, 3);
        expect(result!.seed.gridCost).toBeCloseTo(0.33, 6);  // 3 kWh * 0.11
        expect(result!.seed.solarCost).toBeCloseTo(0.12, 6); // 3 kWh * 0.04
    });

    it('returns null when the battery never reaches the full threshold', () => {
        const schedule = new Schedule(tariffs, 'UTC');
        const rows: EnergyData[] = [row('2026-01-01T00:00:00Z', 60, {})];
        expect(computeGenesisSeed(rows, schedule, 'UTC', 98)).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/battery-provenance/genesis.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import type { EnergyData } from '../db';
import { Schedule } from '../schedule';
import { resolveRates } from './rates';
import { chargeTank, EMPTY_TANK, type Tank } from './tank';

export interface GenesisSeed {
    seed: Tank;
    anchorIndex: number; // index of the first full-SOC row; replay begins here
}

/**
 * Find the first interval where battery_soc >= fullThreshold and seed the tank
 * from the contiguous run of charging intervals (battery_power > 0) ending at it.
 * The charge split prefers Tesla's measured values, else assumes grid (conservative).
 */
export function computeGenesisSeed(
    rows: EnergyData[],
    schedule: Schedule,
    timeZone: string,
    fullThreshold = 98,
): GenesisSeed | null {
    const ordered = [...rows].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const anchorIndex = ordered.findIndex(r => r.battery_soc != null && r.battery_soc >= fullThreshold);
    if (anchorIndex === -1) return null;

    let tank: Tank = EMPTY_TANK;
    // Walk backward over contiguous charging intervals (inclusive of the anchor).
    let i = anchorIndex;
    while (i >= 0 && ordered[i].battery_power > 0) i--;
    for (let j = i + 1; j <= anchorIndex; j++) {
        const r = ordered[j];
        const period = schedule.getTariffPeriod(r.timestamp);
        if (!period) continue;
        const { buyRate, sellRate } = resolveRates(period);
        const solarWh = r.battery_charge_from_solar ?? 0;
        const gridWh = r.battery_charge_from_grid ?? Math.max(r.battery_power - solarWh, 0);
        tank = chargeTank(tank, solarWh, gridWh, buyRate, sellRate);
    }
    return { seed: tank, anchorIndex };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/battery-provenance/genesis.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/battery-provenance/genesis.ts src/lib/battery-provenance/genesis.test.ts
git commit -m "feat(provenance): genesis tank seeding from full-battery anchor"
```

---

## Task 8: Rollup repository

**Files:**
- Create: `src/lib/battery-provenance/rollup-repo.ts`

This is thin DB I/O over `pool`; verify by build + a smoke query rather than a unit test.

- [ ] **Step 1: Implement the repo**

```typescript
import { pool } from '../db';
import type { PeriodRollup } from './replay';
import type { Tank } from './tank';

export class RollupRepo {
    async upsertRollups(rows: PeriodRollup[]): Promise<void> {
        if (rows.length === 0) return;
        const cols = 19;
        const placeholders: string[] = [];
        const params: unknown[] = [];
        let p = 1;
        for (const r of rows) {
            const ph: string[] = [];
            for (let k = 0; k < cols; k++) ph.push(`$${p++}`);
            placeholders.push(`(${ph.join(', ')})`);
            params.push(
                r.siteId, r.localDate, r.tariffScheduleId,
                r.loadWh, r.solarToHomeWh, r.solarToBatteryWh, r.solarToGridWh,
                r.gridToHomeWh, r.gridToBatteryWh, r.batteryToHomeWh, r.batteryToGridWh,
                r.tank.solarWh, r.tank.gridWh, r.tank.solarCost, r.tank.gridCost, r.tankAsOf,
                r.buyRate, r.sellRate, r.batterySoc,
            );
        }
        await pool.query(`
            INSERT INTO "EnergyRollup"(
                site_id, local_date, tariff_schedule_id,
                load_wh, solar_to_home_wh, solar_to_battery_wh, solar_to_grid_wh,
                grid_to_home_wh, grid_to_battery_wh, battery_to_home_wh, battery_to_grid_wh,
                tank_solar_wh, tank_grid_wh, tank_solar_cost, tank_grid_cost, tank_as_of,
                buy_rate, sell_rate, battery_soc
            ) VALUES ${placeholders.join(', ')}
            ON CONFLICT(site_id, local_date, tariff_schedule_id) DO UPDATE SET
                load_wh = EXCLUDED.load_wh,
                solar_to_home_wh = EXCLUDED.solar_to_home_wh,
                solar_to_battery_wh = EXCLUDED.solar_to_battery_wh,
                solar_to_grid_wh = EXCLUDED.solar_to_grid_wh,
                grid_to_home_wh = EXCLUDED.grid_to_home_wh,
                grid_to_battery_wh = EXCLUDED.grid_to_battery_wh,
                battery_to_home_wh = EXCLUDED.battery_to_home_wh,
                battery_to_grid_wh = EXCLUDED.battery_to_grid_wh,
                tank_solar_wh = EXCLUDED.tank_solar_wh,
                tank_grid_wh = EXCLUDED.tank_grid_wh,
                tank_solar_cost = EXCLUDED.tank_solar_cost,
                tank_grid_cost = EXCLUDED.tank_grid_cost,
                tank_as_of = EXCLUDED.tank_as_of,
                buy_rate = EXCLUDED.buy_rate,
                sell_rate = EXCLUDED.sell_rate,
                battery_soc = EXCLUDED.battery_soc,
                updated_at = now()
        `, params);
    }

    /** Carry-forward seed: the row with the greatest tank_as_of strictly before `beforeTs`. */
    async getSeedTank(siteId: string, beforeTs: Date): Promise<{ tank: Tank; tankAsOf: Date } | null> {
        const res = await pool.query(
            `SELECT tank_solar_wh, tank_grid_wh, tank_solar_cost, tank_grid_cost, tank_as_of
             FROM "EnergyRollup"
             WHERE site_id = $1 AND tank_as_of < $2
             ORDER BY tank_as_of DESC LIMIT 1`,
            [siteId, beforeTs],
        );
        if (res.rows.length === 0) return null;
        const row = res.rows[0];
        return {
            tank: {
                solarWh: Number(row.tank_solar_wh), gridWh: Number(row.tank_grid_wh),
                solarCost: Number(row.tank_solar_cost), gridCost: Number(row.tank_grid_cost),
            },
            tankAsOf: row.tank_as_of,
        };
    }

    async hasAnyRollup(siteId: string): Promise<boolean> {
        const res = await pool.query(`SELECT 1 FROM "EnergyRollup" WHERE site_id = $1 LIMIT 1`, [siteId]);
        return res.rows.length > 0;
    }
}
```

> Implementer note: if you prefer a single INSERT, extend the placeholder list to 16 columns and drop `updateTankCosts`. The two-pass version above is only for readability; either is acceptable as long as all four `tank_*` columns plus `tank_as_of` are written.

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/battery-provenance/rollup-repo.ts
git commit -m "feat(provenance): EnergyRollup repository with carry-forward seed"
```

---

## Task 9: Rollup service (orchestration)

**Files:**
- Create: `src/lib/battery-provenance/rollup-service.ts`
- Test: `src/lib/battery-provenance/rollup-service.test.ts`

The service is constructed with injected dependencies so it can be unit-tested without a DB.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { RollupService, type RollupDeps } from './rollup-service';
import { Schedule } from '../schedule';
import type { EnergyData } from '../db';
import type { PeriodRollup } from './replay';

const tariffs = [{
    id: 1, name: 't', site_id: 'S1',
    seasons: [{ id: 1, tariff_id: 1, name: 's', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
        buy_rate: 0.11, sell_rate: 0.04,
        schedules: [{ id: 10, season_id: 1, name: 'flat', buy_rate: 0.11, sell_rate: 0.04,
            from_day_of_week: 0, to_day_of_week: 6, from_hour: null, from_minute: null, to_hour: null, to_minute: null }] }],
}] as unknown as ConstructorParameters<typeof Schedule>[0];

function row(ts: string, fields: Partial<EnergyData>): EnergyData {
    return { timestamp: new Date(ts), site_id: 'S1', tariff_id: 1, tariff_schedule_id: 10,
        load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0, battery_soc: null,
        battery_charge_from_solar: null, battery_charge_from_grid: null, ...fields };
}

describe('RollupService.rollupDay', () => {
    it('seeds from the prior tank, replays the day, and persists one row', async () => {
        const persisted: PeriodRollup[] = [];
        const deps: RollupDeps = {
            loadSite: async () => ({ id: 'S1', timezone: 'UTC', tariffs }) as never,
            loadEnergyData: async () => [
                row('2026-01-02T13:00:00Z', { battery_power: 5000, solar_power: 5000, battery_charge_from_solar: 5000, battery_charge_from_grid: 0 }),
                row('2026-01-02T19:00:00Z', { battery_power: -3000, load_power: 3000 }),
            ],
            getSeedTank: async () => ({ tank: { solarWh: 0, gridWh: 2000, solarCost: 0, gridCost: 0.22 }, tankAsOf: new Date('2026-01-01T23:55:00Z') }),
            hasAnyRollup: async () => true,
            upsertRollups: async (r) => { persisted.push(...r); },
        };
        const svc = new RollupService(deps);
        const result = await svc.rollupDay('S1', '2026-01-02');

        expect(result.rollupCount).toBe(1);
        expect(persisted).toHaveLength(1);
        // seed 2000 grid + 5000 solar charge = 7000; discharge 3000 leaves 4000.
        expect(persisted[0].tank.solarWh + persisted[0].tank.gridWh).toBeCloseTo(4000, 2);
        expect(persisted[0].localDate).toBe('2026-01-02');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/battery-provenance/rollup-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { Schedule } from '../schedule';
import type { Tariff } from '../db';
import type { EnergyData } from '../db';
import { replayRows, type PeriodRollup } from './replay';
import { computeGenesisSeed } from './genesis';
import { EMPTY_TANK, type Tank } from './tank';
import { localDayBoundsUtc } from './local-day';

export interface RollupSite {
    id: string;
    timezone: string;
    tariffs: Tariff[];
}

export interface RollupDeps {
    loadSite: (siteId: string) => Promise<RollupSite>;
    loadEnergyData: (siteId: string, start: Date, end: Date) => Promise<EnergyData[]>;
    getSeedTank: (siteId: string, beforeTs: Date) => Promise<{ tank: Tank; tankAsOf: Date } | null>;
    hasAnyRollup: (siteId: string) => Promise<boolean>;
    upsertRollups: (rows: PeriodRollup[]) => Promise<void>;
}

export class RollupService {
    constructor(private deps: RollupDeps) {}

    /** Roll up a single local calendar day for one site. Idempotent. */
    async rollupDay(siteId: string, localDate: string): Promise<{ rollupCount: number }> {
        const site = await this.deps.loadSite(siteId);
        const schedule = new Schedule(site.tariffs, site.timezone);
        const { start, end } = localDayBoundsUtc(localDate, site.timezone);

        const rows = await this.deps.loadEnergyData(siteId, start, end);
        if (rows.length === 0) return { rollupCount: 0 };

        const seedRow = await this.deps.getSeedTank(siteId, start);
        let seed: Tank = seedRow?.tank ?? EMPTY_TANK;
        let dayRows = rows;

        // Genesis: no prior rollup anywhere → anchor on a full battery.
        if (!seedRow && !(await this.deps.hasAnyRollup(siteId))) {
            const genesis = computeGenesisSeed(rows, schedule, site.timezone);
            if (genesis) {
                seed = genesis.seed;
                dayRows = rows.slice(genesis.anchorIndex);
            }
        }

        const { rollups } = replayRows(dayRows, schedule, site.timezone, seed);
        const forDate = rollups.filter(r => r.localDate === localDate);
        await this.deps.upsertRollups(forDate);
        return { rollupCount: forDate.length };
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/battery-provenance/rollup-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/battery-provenance/rollup-service.ts src/lib/battery-provenance/rollup-service.test.ts
git commit -m "feat(provenance): rollup orchestration service"
```

---

## Task 10: Wire real dependencies + cron endpoint

**Files:**
- Create: `src/app/api/cron/rollup/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Implement the cron route**

Mirror the auth pattern in `src/app/api/cron/cleanup/route.ts`. Build a `RollupService` with real repos and iterate all sites, rolling up each site's previous local day.

```typescript
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { RollupService } from '@/lib/battery-provenance/rollup-service';
import { RollupRepo } from '@/lib/battery-provenance/rollup-repo';
import { localDateKey } from '@/lib/battery-provenance/local-day';

export async function GET(request: NextRequest) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const siteRepo = new SiteRepo();
    const energyRepo = new EnergyRepo();
    const rollupRepo = new RollupRepo();

    const service = new RollupService({
        loadSite: async (siteId) => {
            const site = await siteRepo.getSite(siteId);
            if (!site) throw new Error(`site ${siteId} not found`);
            return { id: site.id, timezone: site.timezone, tariffs: site.tariffs ?? [] };
        },
        loadEnergyData: (siteId, start, end) => energyRepo.getRawEnergyData(siteId, start, end),
        getSeedTank: (siteId, beforeTs) => rollupRepo.getSeedTank(siteId, beforeTs),
        hasAnyRollup: (siteId) => rollupRepo.hasAnyRollup(siteId),
        upsertRollups: (rows) => rollupRepo.upsertRollups(rows),
    });

    const siteIds = await siteRepo.getSiteIds();
    const results: Array<{ siteId: string; localDate: string; rollupCount: number }> = [];

    for (const siteId of siteIds) {
        try {
            const site = await siteRepo.getSite(siteId);
            if (!site) continue;
            // Previous local day for this site.
            const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const localDate = localDateKey(yesterday, site.timezone);
            const { rollupCount } = await service.rollupDay(siteId, localDate);
            results.push({ siteId, localDate, rollupCount });
        } catch (e) {
            console.error(`[CRON rollup] site ${siteId} failed:`, e);
        }
    }

    return NextResponse.json({ success: true, results });
}
```

> Confirm `SiteRepo.getSite` returns `tariffs` populated (it returns `SiteWithTariffs`). If tariffs need a separate load, use `TariffRepo.getTariffsForSite(siteId)` in `loadSite`.

- [ ] **Step 2: Register the cron in `vercel.json`**

Add to the `crons` array (pick a time comfortably after the latest site midnight in UTC; `cleanup` runs at 09:00 UTC — schedule rollup before it so a day is rolled up before retention prunes it):

```json
{ "path": "/api/cron/rollup", "schedule": "0 8 * * *" }
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: builds; the new route appears in the route list.

- [ ] **Step 4: Smoke-test locally (optional, uses real DATABASE_URL)**

Run: `curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:5173/api/cron/rollup | jq`
Expected: `{ success: true, results: [...] }`. ⚠️ Per project memory, the dev `DATABASE_URL` is PROD — only run against the Harrison test site if you run this at all.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/rollup/route.ts vercel.json
git commit -m "feat(provenance): daily rollup cron endpoint"
```

---

## Task 11: Backfill scripts

**Files:**
- Create: `scripts/backfill-charge-split.ts`
- Create: `scripts/backfill-rollups.ts`

Run via `npx tsx`. Follow the structure of existing files in `scripts/`.

- [ ] **Step 1: Charge-split backfill**

Re-fetch Tesla `calendar_history` for a site/date-range via the existing importer and re-insert, so `battery_charge_from_solar/grid` populate on historical rows (the importer now writes them, and `insertEnergyDataBatch` upserts via `COALESCE`). Reuse `Importer.importRange(siteId, start, end)` (see `src/lib/importer/index.ts`).

```typescript
// Usage: npx tsx scripts/backfill-charge-split.ts <siteId> <startISO> <endISO>
import { Importer } from '../src/lib/importer';

async function main() {
    const [siteId, startISO, endISO] = process.argv.slice(2);
    if (!siteId || !startISO || !endISO) {
        console.error('usage: backfill-charge-split <siteId> <startISO> <endISO>');
        process.exit(1);
    }
    const importer = new Importer();
    const rows = await importer.importRange(siteId, new Date(startISO), new Date(endISO), 'day',
        (d) => console.log('imported', d.toISOString().slice(0, 10)));
    console.log(`done: ${rows.length} rows re-imported with charge split`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

> Confirm the `Importer` constructor + `importRange` signature in `src/lib/importer/index.ts` and adjust the instantiation (it may need a repo or site argument).

- [ ] **Step 2: Rollup backfill (chronological)**

Walk a site's local days from the earliest `EnergyData` date to yesterday, calling `RollupService.rollupDay` in order so the tank carries forward and genesis seeding runs on day one.

```typescript
// Usage: npx tsx scripts/backfill-rollups.ts <siteId>
import { EnergyRepo } from '../src/lib/energy-repo';
import { SiteRepo } from '../src/lib/site-repo';
import { RollupService } from '../src/lib/battery-provenance/rollup-service';
import { RollupRepo } from '../src/lib/battery-provenance/rollup-repo';
import { localDateKey } from '../src/lib/battery-provenance/local-day';

async function main() {
    const siteId = process.argv[2];
    if (!siteId) { console.error('usage: backfill-rollups <siteId>'); process.exit(1); }

    const siteRepo = new SiteRepo();
    const energyRepo = new EnergyRepo();
    const rollupRepo = new RollupRepo();
    const site = await siteRepo.getSite(siteId);
    if (!site) throw new Error(`site ${siteId} not found`);

    const service = new RollupService({
        loadSite: async () => ({ id: site.id, timezone: site.timezone, tariffs: site.tariffs ?? [] }),
        loadEnergyData: (id, start, end) => energyRepo.getRawEnergyData(id, start, end),
        getSeedTank: (id, beforeTs) => rollupRepo.getSeedTank(id, beforeTs),
        hasAnyRollup: (id) => rollupRepo.hasAnyRollup(id),
        upsertRollups: (rows) => rollupRepo.upsertRollups(rows),
    });

    // Earliest local date present.
    const earliest = await energyRepo.getRawEnergyData(siteId, new Date(0), new Date());
    if (earliest.length === 0) { console.log('no data'); return; }
    const first = earliest.reduce((a, b) => a.timestamp < b.timestamp ? a : b).timestamp;

    let cursor = new Date(`${localDateKey(first, site.timezone)}T12:00:00Z`);
    const stop = new Date(Date.now() - 24 * 60 * 60 * 1000);
    while (cursor <= stop) {
        const localDate = localDateKey(cursor, site.timezone);
        const { rollupCount } = await service.rollupDay(siteId, localDate);
        if (rollupCount > 0) console.log(localDate, rollupCount);
        cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
    console.log('backfill complete');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Type-check the scripts**

Run: `npx tsc --noEmit`
Expected: no errors. (Adjust `Importer`/repo constructor calls to match real signatures.)

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-charge-split.ts scripts/backfill-rollups.ts
git commit -m "feat(provenance): backfill scripts for charge split and rollups"
```

---

## Task 12: Final verification

**Files:** none

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all pass, including the new `battery-provenance` and importer tests.

- [ ] **Step 2: Lint + build**

Run: `npm run lint && npm run build`
Expected: both pass (project requires this before finishing).

- [ ] **Step 3: Update cross-session docs**

Add an entry to `TODO.md` noting Phase 2 (ROI report + counterfactuals) is unblocked and references this plan and the spec. Update `CLAUDE.md`'s data-model section to list `EnergyRollup` and the two new `EnergyData` columns (and remove the stale `EnergyUsage` reference if present).

- [ ] **Step 4: Commit**

```bash
git add TODO.md CLAUDE.md
git commit -m "docs: note EnergyRollup data model and Phase 2 ROI readiness"
```

---

## Self-Review Notes (for the implementer)

- **Edge category names are the one place to verify against real code** (Task 6, Step 4): the sankey allocator emits `battery-export` for battery→grid and `solar-export` for solar→grid. The `PeriodRollup` field names intentionally read `batteryToGridWh`/`solarToGridWh`; only the `edgeWh(edges, '<category>')` lookups must match the allocator's category strings.
- **Units:** tank/rollup energy is **Wh**; rates are **$/kWh**; `allocateEdges` returns **kWh** (hence `× 1000`). Costs are dollars.
- **Idempotency:** every persistence path upserts on the primary key; re-running any day or the whole backfill is safe.
- **Retention coupling:** the rollup cron (08:00 UTC) runs before `cleanup` (09:00 UTC) so a day is rolled up before its raw rows can be pruned.
- **Out of this plan (by design):** read-time derivations (discharge source split, discharge cost basis, arbitrage P&L) and any reporting UI. These are simple arithmetic over the self-contained rollup row (stored rates × stored energies; no join); add a thin `derivations.ts` helper when the first consumer (existing reports or Phase 2 ROI) needs it. This plan delivers the durable data foundation only.
