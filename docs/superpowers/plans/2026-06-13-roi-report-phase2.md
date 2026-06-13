# ROI Report (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Savings" tab that shows whole-system payback (solar/battery, vs the real-world no-solar/flat baseline), a 2×3 scenario matrix with plan detection + a flat-plan recommendation, and an estimated battery-arbitrage panel.

**Architecture:** All counterfactuals are read-time arithmetic over the durable `EnergyRollup` rows. The only write-side change is two plan-agnostic columns (`solar_only_import_wh`/`export_wh`) computed during the existing replay. A new `SiteRoiConfig` table holds capital costs + the flat comparison rate. Two read-side services (`roi-service`, `arbitrage-service`) are pure functions over rollup rows. UI is a new tab composed of presentational components.

**Tech Stack:** Next.js App Router (server + client components), PostgreSQL via `pg` `pool`, Vitest, Tailwind (CSS-variable theming).

**Spec:** `docs/superpowers/specs/2026-06-13-roi-report-design.md`

**Milestones (the spec's payback-first / arbitrage-fast-follow split):**
- **M1 — Payback (shippable):** Tasks 1–14. Data column, config table + form, ROI service, Savings tab + dashboard.
- **M2 — Arbitrage panel:** Tasks 15–17. Layered on top; the tab renders without it.

---

## Milestone 1 — Payback

### Task 1: Solar-only counterfactual pure function

The "solar, no battery" scenario, computed per 5-min interval (load vs solar), so within-period netting is exact. Energies are in Wh (same scale as `EnergyData.load_power`/`solar_power`, and as the rollup's existing `*_wh` fields).

**Files:**
- Create: `cmd/next-app/src/lib/battery-provenance/counterfactual.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/counterfactual.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// counterfactual.test.ts
import { describe, it, expect } from 'vitest';
import { solarOnlyNet } from './counterfactual';

describe('solarOnlyNet', () => {
    it('imports when load exceeds solar', () => {
        expect(solarOnlyNet(500, 200)).toEqual({ importWh: 300, exportWh: 0 });
    });
    it('exports the surplus when solar exceeds load', () => {
        expect(solarOnlyNet(200, 500)).toEqual({ importWh: 0, exportWh: 300 });
    });
    it('is zero when balanced', () => {
        expect(solarOnlyNet(300, 300)).toEqual({ importWh: 0, exportWh: 0 });
    });
    it('treats missing/zero solar as full import', () => {
        expect(solarOnlyNet(400, 0)).toEqual({ importWh: 400, exportWh: 0 });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/battery-provenance/counterfactual`
Expected: FAIL — "solarOnlyNet is not a function" / module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// counterfactual.ts
/**
 * The "solar, no battery" scenario for one interval: solar serves load first,
 * surplus exports, deficit imports. Energies in Wh. Plan-agnostic (no rates).
 */
export function solarOnlyNet(loadWh: number, solarWh: number): { importWh: number; exportWh: number } {
    const net = loadWh - solarWh;
    return net >= 0 ? { importWh: net, exportWh: 0 } : { importWh: 0, exportWh: -net };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/lib/battery-provenance/counterfactual`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/battery-provenance/counterfactual.ts cmd/next-app/src/lib/battery-provenance/counterfactual.test.ts
git commit -m "feat(roi): solar-only counterfactual interval helper"
```

---

### Task 2: Accumulate solar-only flows in the replay

Add the two fields to `PeriodRollup` and accumulate them per interval in `replayRows`.

**Files:**
- Modify: `cmd/next-app/src/lib/battery-provenance/replay.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/replay.test.ts` (add a case)

- [ ] **Step 1: Add a failing test** to `replay.test.ts`

Append this test (reuse the file's existing `EnergyData` row helper if present; otherwise this self-contained version):

```typescript
import { replayRows } from './replay';
import { Schedule } from '../schedule';
import { EMPTY_TANK } from './tank';
import type { EnergyData } from '../db';

function row(over: Partial<EnergyData>): EnergyData {
    return {
        timestamp: new Date('2026-01-01T10:00:00Z'),
        site_id: 's1', tariff_id: 1, tariff_schedule_id: 10,
        load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0,
        battery_soc: 50, battery_charge_from_solar: null, battery_charge_from_grid: null,
        ...over,
    } as EnergyData;
}

const flatTariff = [{
    id: 1, site_id: 's1', updated: new Date(), name: 'flat',
    seasons: [{
        id: 1, tariff_id: 1, name: null, from_month: 1, from_day: 1, to_month: 12, to_day: 31,
        buy_rate: 0.20, sell_rate: 0.05,
        schedules: [{ id: 10, season_id: 1, name: null, buy_rate: 0.20, sell_rate: 0.05,
            from_day_of_week: 0, from_hour: 0, from_minute: 0, to_day_of_week: 6, to_hour: 23, to_minute: 59 }],
    }],
}];

describe('replayRows solar-only accumulation', () => {
    it('sums per-interval solar-only import/export across a period', () => {
        const schedule = new Schedule(flatTariff as never, 'UTC');
        const rows = [
            row({ timestamp: new Date('2026-01-01T10:00:00Z'), load_power: 500, solar_power: 200 }), // import 300
            row({ timestamp: new Date('2026-01-01T10:05:00Z'), load_power: 100, solar_power: 400 }), // export 300
        ];
        const { rollups } = replayRows(rows, schedule, 'UTC', EMPTY_TANK);
        expect(rollups).toHaveLength(1);
        expect(rollups[0].solarOnlyImportWh).toBe(300);
        expect(rollups[0].solarOnlyExportWh).toBe(300);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/battery-provenance/replay`
Expected: FAIL — `solarOnlyImportWh` is `undefined`.

- [ ] **Step 3: Implement** — three edits in `replay.ts`:

(a) Add to the `PeriodRollup` interface (after `batteryToGridWh`):
```typescript
    solarOnlyImportWh: number;
    solarOnlyExportWh: number;
```

(b) Import the helper at top:
```typescript
import { solarOnlyNet } from './counterfactual';
```

(c) In `emptyRollup`, add to the returned object:
```typescript
        solarOnlyImportWh: 0, solarOnlyExportWh: 0,
```

(d) In the per-row loop, after the existing `r.batteryToGridWh += batteryToGridWh;` line, add:
```typescript
        const so = solarOnlyNet(row.load_power, row.solar_power);
        r.solarOnlyImportWh += so.importWh;
        r.solarOnlyExportWh += so.exportWh;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/next-app && npm test -- src/lib/battery-provenance/replay`
Expected: PASS (existing tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/battery-provenance/replay.ts cmd/next-app/src/lib/battery-provenance/replay.test.ts
git commit -m "feat(roi): accumulate solar-only flows in replay"
```

---

### Task 3: Migration + repo persistence for the two columns

**Files:**
- Create: `cmd/next-app/db-migrations/<generated>.sql`
- Modify: `cmd/next-app/src/lib/battery-provenance/rollup-repo.ts`
- Modify: `cmd/next-app/src/lib/db.ts` (add `EnergyRollupRow` interface)

- [ ] **Step 1: Generate the migration file**

Run: `cd cmd/next-app && npm run db:migration:create roi_solar_only_columns`
This prints the created path (timestamp-prefixed). Open it and replace its body with:

```sql
-- Migration: roi_solar_only_columns
-- Phase 2 ROI: plan-agnostic solar-only (no-battery) counterfactual flows. Idempotent.
ALTER TABLE "EnergyRollup" ADD COLUMN IF NOT EXISTS solar_only_import_wh DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "EnergyRollup" ADD COLUMN IF NOT EXISTS solar_only_export_wh DOUBLE PRECISION NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Apply the migration locally**

Run (against your local/dev postgres): `cd cmd/next-app && psql "$DATABASE_URL" -f db-migrations/<generated>.sql`
Expected: `ALTER TABLE` ×2, no error. (Safe to re-run — `IF NOT EXISTS`.)

- [ ] **Step 3: Extend `rollup-repo.ts` upsert** — in `upsertRollups`:

Change `const cols = 19;` to `const cols = 21;`

Add the two params at the end of the `params.push(...)` list (after `r.batterySoc,`):
```typescript
                r.solarOnlyImportWh, r.solarOnlyExportWh,
```

Add the two columns to the `INSERT INTO "EnergyRollup"(...)` column list (after `battery_soc`):
```sql
                , solar_only_import_wh, solar_only_export_wh
```

Add to the `ON CONFLICT ... DO UPDATE SET` list (after `battery_soc = EXCLUDED.battery_soc,`):
```sql
                solar_only_import_wh = EXCLUDED.solar_only_import_wh,
                solar_only_export_wh = EXCLUDED.solar_only_export_wh,
```

- [ ] **Step 4: Add the read type + read method.**

In `db.ts`, add (near the other interfaces):
```typescript
export interface EnergyRollupRow {
  site_id: string;
  local_date: string; // 'YYYY-MM-DD'
  tariff_schedule_id: number;
  load_wh: number;
  solar_to_home_wh: number;
  solar_to_battery_wh: number;
  solar_to_grid_wh: number;
  grid_to_home_wh: number;
  grid_to_battery_wh: number;
  battery_to_home_wh: number;
  battery_to_grid_wh: number;
  tank_solar_wh: number;
  tank_grid_wh: number;
  tank_solar_cost: number;
  tank_grid_cost: number;
  tank_as_of: Date;
  buy_rate: number;
  sell_rate: number;
  battery_soc: number | null;
  solar_only_import_wh: number;
  solar_only_export_wh: number;
}
```

In `rollup-repo.ts`, add a method (rows ordered for cumulative series):
```typescript
    async getAllForSite(siteId: string): Promise<import('../db').EnergyRollupRow[]> {
        const res = await pool.query(
            `SELECT site_id, local_date::text AS local_date, tariff_schedule_id,
                    load_wh, solar_to_home_wh, solar_to_battery_wh, solar_to_grid_wh,
                    grid_to_home_wh, grid_to_battery_wh, battery_to_home_wh, battery_to_grid_wh,
                    tank_solar_wh, tank_grid_wh, tank_solar_cost, tank_grid_cost, tank_as_of,
                    buy_rate, sell_rate, battery_soc,
                    solar_only_import_wh, solar_only_export_wh
             FROM "EnergyRollup" WHERE site_id = $1
             ORDER BY local_date ASC, tank_as_of ASC`,
            [siteId],
        );
        return res.rows as import('../db').EnergyRollupRow[];
    }
```

- [ ] **Step 5: Verify build + existing tests**

Run: `cd cmd/next-app && npm test -- src/lib/battery-provenance && npm run build`
Expected: tests PASS, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/db-migrations cmd/next-app/src/lib/battery-provenance/rollup-repo.ts cmd/next-app/src/lib/db.ts
git commit -m "feat(roi): persist solar-only columns + rollup read method"
```

> **Backfill note (run once, not a code step):** after deploy, re-run the existing rollup backfill script so historical rows populate `solar_only_*`. It re-replays (re-fetching 5-min where needed), so historical values are exact. New rows are populated automatically by the daily cron via `replayRows`.

---

### Task 4: `SiteRoiConfig` table + migration

**Files:**
- Create: `cmd/next-app/db-migrations/<generated>.sql`
- Modify: `cmd/next-app/src/lib/db.ts` (add `SiteRoiConfig` interface)

- [ ] **Step 1: Generate + fill the migration**

Run: `cd cmd/next-app && npm run db:migration:create site_roi_config`
Replace the generated file body with:

```sql
-- Migration: site_roi_config
-- Phase 2 ROI: per-site capital costs + the flat comparison plan. Idempotent.
CREATE TABLE IF NOT EXISTS "SiteRoiConfig" (
    site_id              TEXT PRIMARY KEY REFERENCES "Site"(id) ON DELETE CASCADE,
    solar_cost           DOUBLE PRECISION,
    solar_install_date   DATE,
    battery_cost         DOUBLE PRECISION,
    battery_install_date DATE,
    fixed_buy_rate       DOUBLE PRECISION,
    fixed_sell_rate      DOUBLE PRECISION,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Apply locally**

Run: `cd cmd/next-app && psql "$DATABASE_URL" -f db-migrations/<generated>.sql`
Expected: `CREATE TABLE`, no error.

- [ ] **Step 3: Add the type** to `db.ts`:

```typescript
export interface SiteRoiConfig {
  site_id: string;
  solar_cost: number | null;
  solar_install_date: string | null; // 'YYYY-MM-DD'
  battery_cost: number | null;
  battery_install_date: string | null;
  fixed_buy_rate: number | null;
  fixed_sell_rate: number | null;
}
```

- [ ] **Step 4: Verify build**

Run: `cd cmd/next-app && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/db-migrations cmd/next-app/src/lib/db.ts
git commit -m "feat(roi): SiteRoiConfig table + type"
```

---

### Task 5: `SiteRoiConfigRepo` (get/upsert)

**Files:**
- Create: `cmd/next-app/src/lib/roi/roi-config-repo.ts`
- Test: `cmd/next-app/src/lib/roi/roi-config-repo.test.ts` (interface shape only — no DB in unit tests)

- [ ] **Step 1: Write a failing test** (verifies the SQL param mapping via a mocked pool)

```typescript
// roi-config-repo.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
import { pool } from '../db';
import { SiteRoiConfigRepo } from './roi-config-repo';

describe('SiteRoiConfigRepo', () => {
    it('get returns null when no row', async () => {
        (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
        const repo = new SiteRoiConfigRepo();
        expect(await repo.get('s1')).toBeNull();
    });
    it('upsert passes all seven columns as params', async () => {
        const q = pool.query as ReturnType<typeof vi.fn>;
        q.mockResolvedValueOnce({ rows: [] });
        const repo = new SiteRoiConfigRepo();
        await repo.upsert({ site_id: 's1', solar_cost: 6500, solar_install_date: '2022-01-01',
            battery_cost: 5900, battery_install_date: '2022-01-01', fixed_buy_rate: 0.20, fixed_sell_rate: 0.05 });
        const params = q.mock.calls.at(-1)![1];
        expect(params).toEqual(['s1', 6500, '2022-01-01', 5900, '2022-01-01', 0.20, 0.05]);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/roi/roi-config-repo`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// roi-config-repo.ts
import { pool } from '../db';
import type { SiteRoiConfig } from '../db';

export class SiteRoiConfigRepo {
    async get(siteId: string): Promise<SiteRoiConfig | null> {
        const res = await pool.query(
            `SELECT site_id, solar_cost, solar_install_date::text AS solar_install_date,
                    battery_cost, battery_install_date::text AS battery_install_date,
                    fixed_buy_rate, fixed_sell_rate
             FROM "SiteRoiConfig" WHERE site_id = $1`,
            [siteId],
        );
        return (res.rows[0] as SiteRoiConfig) ?? null;
    }

    async upsert(c: SiteRoiConfig): Promise<void> {
        await pool.query(
            `INSERT INTO "SiteRoiConfig"
                (site_id, solar_cost, solar_install_date, battery_cost, battery_install_date, fixed_buy_rate, fixed_sell_rate)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (site_id) DO UPDATE SET
                solar_cost = EXCLUDED.solar_cost,
                solar_install_date = EXCLUDED.solar_install_date,
                battery_cost = EXCLUDED.battery_cost,
                battery_install_date = EXCLUDED.battery_install_date,
                fixed_buy_rate = EXCLUDED.fixed_buy_rate,
                fixed_sell_rate = EXCLUDED.fixed_sell_rate,
                updated_at = now()`,
            [c.site_id, c.solar_cost, c.solar_install_date, c.battery_cost, c.battery_install_date, c.fixed_buy_rate, c.fixed_sell_rate],
        );
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/next-app && npm test -- src/lib/roi/roi-config-repo`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/roi-config-repo.ts cmd/next-app/src/lib/roi/roi-config-repo.test.ts
git commit -m "feat(roi): SiteRoiConfig repo"
```

---

### Task 6: Tariff classification (fixed vs TOU)

**Files:**
- Create: `cmd/next-app/src/lib/roi/classify-tariff.ts`
- Test: `cmd/next-app/src/lib/roi/classify-tariff.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// classify-tariff.test.ts
import { describe, it, expect } from 'vitest';
import { classifyTariff } from './classify-tariff';
import type { Tariff } from '../db';

function tariff(scheduleBuyRates: (number | null)[], seasonBuy = 0.2): Tariff {
    return {
        id: 1, site_id: 's1', updated: new Date(), name: null,
        seasons: [{
            id: 1, tariff_id: 1, name: null, from_month: 1, from_day: 1, to_month: 12, to_day: 31,
            buy_rate: seasonBuy, sell_rate: 0.05,
            schedules: scheduleBuyRates.map((b, i) => ({
                id: i, season_id: 1, name: null, buy_rate: b, sell_rate: 0.05,
                from_day_of_week: 0, from_hour: i, from_minute: 0, to_day_of_week: 6, to_hour: i, to_minute: 59,
            })),
        }],
    } as Tariff;
}

describe('classifyTariff', () => {
    it('is TOU when buy rates vary across schedules', () => {
        expect(classifyTariff(tariff([0.24, 0.11]))).toBe('tou');
    });
    it('is fixed when all resolved buy rates are equal', () => {
        expect(classifyTariff(tariff([0.20, 0.20]))).toBe('fixed');
    });
    it('resolves null schedule rates to the season rate before comparing', () => {
        expect(classifyTariff(tariff([null, null], 0.20))).toBe('fixed');
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/roi/classify-tariff`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// classify-tariff.ts
import type { Tariff } from '../db';

/** A tariff is TOU if its resolved buy rates differ across schedules; otherwise fixed. */
export function classifyTariff(tariff: Tariff): 'fixed' | 'tou' {
    const rates: number[] = [];
    for (const season of tariff.seasons ?? []) {
        for (const s of season.schedules ?? []) {
            rates.push(s.buy_rate ?? season.buy_rate);
        }
    }
    if (rates.length === 0) return 'fixed';
    const first = rates[0];
    return rates.some(r => Math.abs(r - first) > 1e-9) ? 'tou' : 'fixed';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/next-app && npm test -- src/lib/roi/classify-tariff`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/classify-tariff.ts cmd/next-app/src/lib/roi/classify-tariff.test.ts
git commit -m "feat(roi): tariff fixed/TOU classifier"
```

---

### Task 7: ROI service — six matrix cells + decompositions

**Files:**
- Create: `cmd/next-app/src/lib/roi/roi-service.ts`
- Test: `cmd/next-app/src/lib/roi/roi-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// roi-service.test.ts
import { describe, it, expect } from 'vitest';
import { computeMatrixTotals, type RoiInputs } from './roi-service';
import type { EnergyRollupRow } from '../db';

function rolllup(over: Partial<EnergyRollupRow>): EnergyRollupRow {
    return {
        site_id: 's1', local_date: '2026-01-01', tariff_schedule_id: 10,
        load_wh: 0, solar_to_home_wh: 0, solar_to_battery_wh: 0, solar_to_grid_wh: 0,
        grid_to_home_wh: 0, grid_to_battery_wh: 0, battery_to_home_wh: 0, battery_to_grid_wh: 0,
        tank_solar_wh: 0, tank_grid_wh: 0, tank_solar_cost: 0, tank_grid_cost: 0, tank_as_of: new Date(),
        buy_rate: 0.24, sell_rate: 0.04, battery_soc: 50,
        solar_only_import_wh: 0, solar_only_export_wh: 0, ...over,
    };
}

const inputs: RoiInputs = { fixedBuyRate: 0.20, fixedSellRate: 0.05 };

describe('computeMatrixTotals', () => {
    it('prices the six cells from a single row (Wh→kWh at $/kWh)', () => {
        // 10 kWh load, solar-only imports 4 kWh / exports 1 kWh, actual imports 2 kWh / exports 0.5 kWh
        const r = rolllup({
            load_wh: 10000, solar_only_import_wh: 4000, solar_only_export_wh: 1000,
            grid_to_home_wh: 1500, grid_to_battery_wh: 500, solar_to_grid_wh: 300, battery_to_grid_wh: 200,
        });
        const m = computeMatrixTotals([r], inputs);
        expect(m.A).toBeCloseTo((10000 / 1000) * 0.20, 6);                       // load × fixedBuy
        expect(m.B).toBeCloseTo((10000 / 1000) * 0.24, 6);                       // load × TOU buy
        expect(m.C).toBeCloseTo((4000 / 1000) * 0.20 - (1000 / 1000) * 0.05, 6); // solar-only × flat
        expect(m.D).toBeCloseTo((4000 / 1000) * 0.24 - (1000 / 1000) * 0.04, 6); // solar-only × TOU
        expect(m.E).toBeCloseTo((2000 / 1000) * 0.20 - (500 / 1000) * 0.05, 6);  // actual × flat
        expect(m.F).toBeCloseTo((2000 / 1000) * 0.24 - (500 / 1000) * 0.04, 6);  // actual × TOU
    });

    it('decompositions reconcile', () => {
        const r = rolllup({ load_wh: 10000, solar_only_import_wh: 4000, solar_only_export_wh: 1000,
            grid_to_home_wh: 1500, grid_to_battery_wh: 500, solar_to_grid_wh: 300, battery_to_grid_wh: 200 });
        const m = computeMatrixTotals([r], inputs);
        expect(m.solarValue + m.batteryValue).toBeCloseTo(m.totalSaved, 6);
        expect(m.batteryHardwareValue + m.touPlanValue).toBeCloseTo(m.batteryValue, 6);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/roi/roi-service`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (cells + decompositions; projection added in Task 8)

```typescript
// roi-service.ts
import type { EnergyRollupRow } from '../db';

const WH_PER_KWH = 1000;

export interface RoiInputs {
    fixedBuyRate: number;
    fixedSellRate: number;
}

export interface MatrixTotals {
    A: number; B: number; C: number; D: number; E: number; F: number;
    solarValue: number;        // A − C
    batteryValue: number;      // C − F
    totalSaved: number;        // A − F
    batteryHardwareValue: number; // C − E
    touPlanValue: number;         // E − F
}

/** Sum the six scenario-matrix bills across rollup rows. Costs in dollars. */
export function computeMatrixTotals(rows: EnergyRollupRow[], inputs: RoiInputs): MatrixTotals {
    let A = 0, B = 0, C = 0, D = 0, E = 0, F = 0;
    for (const r of rows) {
        const load = r.load_wh / WH_PER_KWH;
        const soImp = r.solar_only_import_wh / WH_PER_KWH;
        const soExp = r.solar_only_export_wh / WH_PER_KWH;
        const actImp = (r.grid_to_home_wh + r.grid_to_battery_wh) / WH_PER_KWH;
        const actExp = (r.solar_to_grid_wh + r.battery_to_grid_wh) / WH_PER_KWH;
        A += load * inputs.fixedBuyRate;
        B += load * r.buy_rate;
        C += soImp * inputs.fixedBuyRate - soExp * inputs.fixedSellRate;
        D += soImp * r.buy_rate - soExp * r.sell_rate;
        E += actImp * inputs.fixedBuyRate - actExp * inputs.fixedSellRate;
        F += actImp * r.buy_rate - actExp * r.sell_rate;
    }
    return {
        A, B, C, D, E, F,
        solarValue: A - C,
        batteryValue: C - F,
        totalSaved: A - F,
        batteryHardwareValue: C - E,
        touPlanValue: E - F,
    };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/next-app && npm test -- src/lib/roi/roi-service`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/roi-service.ts cmd/next-app/src/lib/roi/roi-service.test.ts
git commit -m "feat(roi): scenario-matrix cell + decomposition math"
```

---

### Task 8: ROI summary — projection, recommendation, monthly series

**Files:**
- Modify: `cmd/next-app/src/lib/roi/roi-service.ts`
- Test: `cmd/next-app/src/lib/roi/roi-service.test.ts` (add cases)

- [ ] **Step 1: Add failing tests**

```typescript
import { buildRoiSummary } from './roi-service';

describe('buildRoiSummary', () => {
    const inputs = { fixedBuyRate: 0.20, fixedSellRate: 0.05 };
    const config = { solarCost: 6500, batteryCost: 5900 };
    // 2 rows, 2 days, totalSaved $2/day-ish; use simple numbers
    const rows = [
        rolllup({ local_date: '2026-01-01', load_wh: 10000 }),
        rolllup({ local_date: '2026-01-02', load_wh: 10000 }),
    ];

    it('flags low confidence under a year of data', () => {
        const s = buildRoiSummary(rows, inputs, config, 'tou', new Date('2026-01-03T00:00:00Z'));
        expect(s.lowConfidence).toBe(true);
        expect(s.daysOfData).toBe(2);
    });

    it('recommends flat for a TOU user when E < F', () => {
        // load-only rows: F = load×0.24, E = load×0.20 → E < F → recommend flat
        const s = buildRoiSummary(rows, inputs, config, 'tou', new Date('2026-01-03T00:00:00Z'));
        expect(s.recommendation?.switchTo).toBe('fixed');
        expect(s.recommendation?.annualSaving).toBeGreaterThan(0);
    });

    it('omits a component with no cost', () => {
        const s = buildRoiSummary(rows, inputs, { solarCost: null, batteryCost: 5900 }, 'tou', new Date('2026-01-03T00:00:00Z'));
        expect(s.components.find(c => c.kind === 'solar')).toBeUndefined();
        expect(s.components.find(c => c.kind === 'battery')).toBeDefined();
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/roi/roi-service`
Expected: FAIL — `buildRoiSummary` not exported.

- [ ] **Step 3: Implement** — append to `roi-service.ts`:

```typescript
export interface RoiConfigInputs { solarCost: number | null; batteryCost: number | null; }

export interface RoiComponent {
    kind: 'solar' | 'battery' | 'combined';
    cost: number;
    savedToDate: number;
    pctRecovered: number;
    annualRate: number;
    breakEvenDate: string | null; // ISO date, null if rate <= 0
}

export interface RoiRecommendation { switchTo: 'fixed'; annualSaving: number; }

export interface RoiSummary {
    matrix: MatrixTotals;
    daysOfData: number;
    lowConfidence: boolean;
    actualPlan: 'fixed' | 'tou';
    components: RoiComponent[];
    recommendation: RoiRecommendation | null;
}

function daysBetween(firstDate: string, today: Date): number {
    const first = new Date(`${firstDate}T00:00:00Z`).getTime();
    return Math.max(1, Math.round((today.getTime() - first) / 86_400_000) + 1);
}

function component(kind: RoiComponent['kind'], cost: number, savedToDate: number, days: number): RoiComponent {
    const annualRate = (savedToDate / days) * 365;
    const remaining = cost - savedToDate;
    let breakEvenDate: string | null = null;
    if (annualRate > 0 && remaining > 0) {
        const days2 = (remaining / annualRate) * 365;
        breakEvenDate = new Date(Date.now() + days2 * 86_400_000).toISOString().slice(0, 10);
    } else if (annualRate > 0) {
        breakEvenDate = new Date().toISOString().slice(0, 10); // already recovered
    }
    return { kind, cost, savedToDate, pctRecovered: cost > 0 ? savedToDate / cost : 0, annualRate, breakEvenDate };
}

export function buildRoiSummary(
    rows: EnergyRollupRow[],
    inputs: RoiInputs,
    config: RoiConfigInputs,
    actualPlan: 'fixed' | 'tou',
    today: Date,
): RoiSummary {
    const matrix = computeMatrixTotals(rows, inputs);
    const firstDate = rows.length ? rows.reduce((m, r) => (r.local_date < m ? r.local_date : m), rows[0].local_date) : today.toISOString().slice(0, 10);
    const days = daysBetween(firstDate, today);

    const components: RoiComponent[] = [];
    if (config.solarCost != null) components.push(component('solar', config.solarCost, matrix.solarValue, days));
    if (config.batteryCost != null) components.push(component('battery', config.batteryCost, matrix.batteryValue, days));
    if (config.solarCost != null && config.batteryCost != null) {
        components.push(component('combined', config.solarCost + config.batteryCost, matrix.totalSaved, days));
    }

    // Plan recommendation: only the TOU→flat direction (robust; cell E overstates flat cost).
    let recommendation: RoiRecommendation | null = null;
    if (actualPlan === 'tou' && matrix.E < matrix.F) {
        const annualSaving = ((matrix.F - matrix.E) / days) * 365;
        recommendation = { switchTo: 'fixed', annualSaving };
    }

    return { matrix, daysOfData: days, lowConfidence: days < 365, actualPlan, components, recommendation };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/next-app && npm test -- src/lib/roi/roi-service`
Expected: PASS (all roi-service tests).

- [ ] **Step 5: Add the monthly cumulative series helper + test**

Add test:
```typescript
import { monthlyCumulative } from './roi-service';
it('buckets cumulative savings by month', () => {
    const rows = [ rolllup({ local_date: '2026-01-31', load_wh: 10000 }), rolllup({ local_date: '2026-02-15', load_wh: 10000 }) ];
    const series = monthlyCumulative(rows, { fixedBuyRate: 0.20, fixedSellRate: 0.05 });
    expect(series).toHaveLength(2);
    expect(series[1].cumulativeSaved).toBeGreaterThan(series[0].cumulativeSaved);
});
```

Add implementation to `roi-service.ts`:
```typescript
export interface MonthPoint { month: string; cumulativeSaved: number; }

/** Cumulative totalSaved bucketed by 'YYYY-MM', ascending. */
export function monthlyCumulative(rows: EnergyRollupRow[], inputs: RoiInputs): MonthPoint[] {
    const byMonth = new Map<string, EnergyRollupRow[]>();
    for (const r of rows) {
        const m = r.local_date.slice(0, 7);
        (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(r);
    }
    const months = [...byMonth.keys()].sort();
    let cum = 0;
    return months.map(month => {
        cum += computeMatrixTotals(byMonth.get(month)!, inputs).totalSaved;
        return { month, cumulativeSaved: cum };
    });
}
```

- [ ] **Step 6: Run + commit**

Run: `cd cmd/next-app && npm test -- src/lib/roi/roi-service`
Expected: PASS.

```bash
git add cmd/next-app/src/lib/roi/roi-service.ts cmd/next-app/src/lib/roi/roi-service.test.ts
git commit -m "feat(roi): payback projection, recommendation, monthly series"
```

---

### Task 9: ROI config save API route

Follow the user-auth pattern (`verifySiteAccess`), not the cron bearer pattern.

**Files:**
- Create: `cmd/next-app/src/app/api/site/[id]/roi-config/route.ts`

- [ ] **Step 1: Implement the route**

```typescript
// route.ts
import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { SiteRoiConfigRepo } from '@/lib/roi/roi-config-repo';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const num = (v: unknown) => (v === '' || v == null ? null : Number(v));
    const str = (v: unknown) => (v === '' || v == null ? null : String(v));
    await new SiteRoiConfigRepo().upsert({
        site_id: id,
        solar_cost: num(body.solar_cost),
        solar_install_date: str(body.solar_install_date),
        battery_cost: num(body.battery_cost),
        battery_install_date: str(body.battery_install_date),
        fixed_buy_rate: num(body.fixed_buy_rate),
        fixed_sell_rate: num(body.fixed_sell_rate),
    });
    return NextResponse.json({ success: true });
}
```

- [ ] **Step 2: Verify `verifySiteAccess` signature** matches (read `src/lib/auth-checks.ts`). If it takes a request or differs, adapt the call. Adjust import if the helper name differs.

Run: `cd cmd/next-app && grep -n "export.*verifySiteAccess" src/lib/auth-checks.ts`
Expected: confirms the exported signature; align the call above to it.

- [ ] **Step 3: Build**

Run: `cd cmd/next-app && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/src/app/api/site
git commit -m "feat(roi): config save API route"
```

---

### Task 10: ROI config form (Settings tab)

**Files:**
- Create: `cmd/next-app/src/components/site/RoiConfigForm.tsx`
- Modify: `cmd/next-app/src/components/site/SettingsView.tsx` (render the form)

- [ ] **Step 1: Implement the form** (client component; uses existing Form primitives + Toast)

```tsx
// RoiConfigForm.tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card';
import { Label } from '@/components/ui/Form';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import type { SiteRoiConfig } from '@/lib/db';

export function RoiConfigForm({ siteId, initial }: { siteId: string; initial: SiteRoiConfig | null }) {
    const router = useRouter();
    const { toast } = useToast();
    const [form, setForm] = useState({
        solar_cost: initial?.solar_cost ?? '', solar_install_date: initial?.solar_install_date ?? '',
        battery_cost: initial?.battery_cost ?? '', battery_install_date: initial?.battery_install_date ?? '',
        fixed_buy_rate: initial?.fixed_buy_rate ?? '', fixed_sell_rate: initial?.fixed_sell_rate ?? '',
    });
    const [saving, setSaving] = useState(false);
    const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

    async function save() {
        setSaving(true);
        try {
            const res = await fetch(`/api/site/${siteId}/roi-config`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
            });
            if (!res.ok) throw new Error('save failed');
            toast({ title: 'Saved', description: 'ROI settings updated.' });
            router.refresh();
        } catch {
            toast({ title: 'Error', description: 'Could not save ROI settings.', variant: 'destructive' });
        } finally { setSaving(false); }
    }

    const field = (label: string, k: keyof typeof form, type = 'number', step?: string) => (
        <div className="flex flex-col gap-1">
            <Label>{label}</Label>
            <input type={type} step={step} value={String(form[k])} onChange={set(k)}
                className="rounded-md border border-border bg-bg-base text-foreground px-3 py-2" />
        </div>
    );

    return (
        <Card>
            <CardHeader>
                <CardTitle>ROI / Savings</CardTitle>
                <CardDescription>System costs and the flat rate plan to compare against.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {field('Solar net cost ($)', 'solar_cost')}
                {field('Solar install date', 'solar_install_date', 'date')}
                {field('Battery net cost ($)', 'battery_cost')}
                {field('Battery install date', 'battery_install_date', 'date')}
                {field('Flat plan buy rate ($/kWh)', 'fixed_buy_rate', 'number', '0.001')}
                {field('Flat plan sell rate ($/kWh)', 'fixed_sell_rate', 'number', '0.001')}
                <div className="sm:col-span-2">
                    <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save ROI settings'}</Button>
                </div>
            </CardContent>
        </Card>
    );
}
```

- [ ] **Step 2: Wire into `SettingsView`.** It currently receives `site` and `installation`. Add an optional `roiConfig` prop and render `<RoiConfigForm siteId={site.id} initial={roiConfig ?? null} />` in the settings layout.

Edit `SettingsViewProps`:
```typescript
import type { SiteRoiConfig } from '@/lib/db';
interface SettingsViewProps {
    site: SiteWithTariffs;
    installation: TrmnlInstallation | undefined;
    roiConfig?: SiteRoiConfig | null;
}
```
Add `roiConfig` to the destructured props and render `<RoiConfigForm siteId={site.id} initial={roiConfig ?? null} />` alongside the other setting cards (e.g. near `TariffList`).

- [ ] **Step 3: Build + lint**

Run: `cd cmd/next-app && npm run lint && npm run build`
Expected: pass. (Confirm `Button`'s `variant`/`toast` API matches usage; adjust to the real `useToast` signature if it differs.)

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/src/components/site/RoiConfigForm.tsx cmd/next-app/src/components/site/SettingsView.tsx
git commit -m "feat(roi): config form in Settings"
```

---

### Task 11: Savings tab in `SiteTabs`

**Files:**
- Modify: `cmd/next-app/src/components/site/SiteTabs.tsx`

- [ ] **Step 1: Add the tab.** Edit `SiteTabs.tsx`:

(a) `type TabId = 'history' | 'bill' | 'savings' | 'settings';`

(b) Add `savingsSlot: ReactNode;` to `SiteTabsProps` and destructuring.

(c) In the `localStorage` allow-list check, change `['history', 'bill', 'settings']` to `['history', 'bill', 'savings', 'settings']`.

(d) Add a `<TabsTrigger value="savings">` (between bill and settings) with a label "Savings" and an inline SVG icon (reuse the bill icon markup or a simple currency glyph):
```tsx
<TabsTrigger value="savings" className="flex items-center gap-2">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
    Savings
</TabsTrigger>
```

(e) Add the content panel:
```tsx
<TabsContent value="savings">
    {savingsSlot}
</TabsContent>
```

- [ ] **Step 2: Build**

Run: `cd cmd/next-app && npm run build`
Expected: build fails only where `page.tsx` doesn't yet pass `savingsSlot` — that's fixed in Task 13. Confirm the SiteTabs file itself type-checks by reviewing; proceed.

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/components/site/SiteTabs.tsx
git commit -m "feat(roi): add Savings tab to SiteTabs"
```

---

### Task 12: Savings dashboard components

Presentational client components for the payback dashboard. No unit tests (repo has no component-test pattern); verified via build/lint + manual check in Task 14.

**Files:**
- Create: `cmd/next-app/src/components/site/savings/SavingsView.tsx`
- Create: `cmd/next-app/src/components/site/savings/PaybackHero.tsx`
- Create: `cmd/next-app/src/components/site/savings/ScenarioMatrix.tsx`
- Create: `cmd/next-app/src/components/site/savings/SavingsEmptyState.tsx`

- [ ] **Step 1: Empty state**

```tsx
// SavingsEmptyState.tsx
import { Card, CardContent } from '@/components/ui/Card';
export function SavingsEmptyState() {
    return (
        <Card><CardContent className="py-12 text-center text-foreground">
            <p className="text-lg font-semibold mb-2">Add your system costs to see payback</p>
            <p className="opacity-70">Set solar/battery costs and a flat comparison rate in the Settings tab →</p>
        </CardContent></Card>
    );
}
```

- [ ] **Step 2: Payback hero + matrix + view** (consume the `RoiSummary` shape from Task 8)

```tsx
// PaybackHero.tsx
import type { RoiSummary } from '@/lib/roi/roi-service';
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function PaybackHero({ summary }: { summary: RoiSummary }) {
    const combined = summary.components.find(c => c.kind === 'combined') ?? summary.components[0];
    if (!combined) return null;
    return (
        <div className="rounded-xl border border-border bg-bg-base p-5">
            <div className="text-xs uppercase opacity-60">System payback</div>
            <div className="text-3xl font-extrabold">{pct(combined.pctRecovered)} recovered</div>
            <div className="text-sm opacity-80 mt-1">
                {usd(combined.savedToDate)} saved of {usd(combined.cost)}
                {combined.breakEvenDate && ` · break-even ~ ${combined.breakEvenDate}`}
            </div>
            <div className="h-3 rounded-full bg-border mt-3 overflow-hidden">
                <div className="h-full bg-accent" style={{ width: pct(Math.min(1, combined.pctRecovered)) }} />
            </div>
            {summary.lowConfidence && (
                <p className="text-xs opacity-70 mt-2">⚠ Under a year of data — the projected break-even is a rough estimate.</p>
            )}
        </div>
    );
}
```

```tsx
// ScenarioMatrix.tsx
import type { RoiSummary } from '@/lib/roi/roi-service';
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function ScenarioMatrix({ summary }: { summary: RoiSummary }) {
    const m = summary.matrix;
    const hereFixed = summary.actualPlan === 'fixed'; // actual cell is E (fixed) else F (tou)
    const cell = (label: string, value: number, here: boolean, cheaper: boolean) => (
        <div className={`rounded-lg border p-3 ${here ? 'border-accent bg-accent/10' : cheaper ? 'border-green-600 bg-green-600/10' : 'border-border'}`}>
            <div className="text-xs opacity-70">{label}{here && ' · you are here'}</div>
            <div className="font-semibold">{usd(value)}</div>
        </div>
    );
    return (
        <div className="grid grid-cols-3 gap-2 text-sm">
            <div />
            <div className="text-center text-xs font-semibold opacity-70">Fixed</div>
            <div className="text-center text-xs font-semibold opacity-70">TOU</div>

            <div className="flex items-center text-xs font-semibold">No Solar</div>
            {cell('A', m.A, false, false)}{cell('B', m.B, false, false)}

            <div className="flex items-center text-xs font-semibold">Solar</div>
            {cell('C', m.C, false, false)}{cell('D', m.D, false, false)}

            <div className="flex items-center text-xs font-semibold">Solar+Batt</div>
            {cell('E · Fixed', m.E, hereFixed, !hereFixed && m.E < m.F)}
            {cell('F · TOU', m.F, !hereFixed, hereFixed && m.F < m.E)}
        </div>
    );
}
```

```tsx
// SavingsView.tsx
import type { RoiSummary } from '@/lib/roi/roi-service';
import { PaybackHero } from './PaybackHero';
import { ScenarioMatrix } from './ScenarioMatrix';
import { SavingsEmptyState } from './SavingsEmptyState';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function SavingsView({ summary, arbitrageSlot }: { summary: RoiSummary | null; arbitrageSlot?: React.ReactNode }) {
    if (!summary) return <SavingsEmptyState />;
    return (
        <div className="space-y-6 max-w-5xl mx-auto">
            <PaybackHero summary={summary} />
            {summary.recommendation && (
                <div className="rounded-lg border border-green-600 bg-green-600/10 p-3 text-sm">
                    💡 You're on TOU, but a flat plan looks ~{usd(summary.recommendation.annualSaving)}/yr cheaper for your usage.
                    <span className="opacity-70"> (Estimate holds your behavior fixed; the real flat saving is likely a bit larger.)</span>
                </div>
            )}
            <ScenarioMatrix summary={summary} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {summary.components.filter(c => c.kind !== 'combined').map(c => (
                    <div key={c.kind} className="rounded-lg border border-border p-4">
                        <div className="font-semibold capitalize">{c.kind === 'solar' ? '☀️ Solar' : '🔋 Battery'}</div>
                        <div className="h-2 rounded-full bg-border my-2 overflow-hidden">
                            <div className="h-full bg-accent" style={{ width: `${Math.round(Math.min(1, c.pctRecovered) * 100)}%` }} />
                        </div>
                        <div className="text-xs opacity-80">{usd(c.savedToDate)} / {usd(c.cost)}{c.breakEvenDate && ` · ${c.breakEvenDate.slice(0, 4)}`}</div>
                    </div>
                ))}
            </div>
            {arbitrageSlot}
        </div>
    );
}
```

- [ ] **Step 3: Build + lint**

Run: `cd cmd/next-app && npm run lint && npm run build`
Expected: `SavingsView`/children type-check. (`bg-accent`, `border-border`, `bg-bg-base`, `text-foreground` are the project's theme tokens — confirm they exist in `app.css`/Tailwind config; substitute the correct token names if different.)

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/src/components/site/savings
git commit -m "feat(roi): savings dashboard components"
```

---

### Task 13: Wire the Savings page into the site route

**Files:**
- Modify: `cmd/next-app/src/app/site/[id]/page.tsx`

- [ ] **Step 1: Fetch + compute in the server component.** Near the existing `installation` fetch, add:

```typescript
import { RollupRepo } from '@/lib/battery-provenance/rollup-repo';
import { SiteRoiConfigRepo } from '@/lib/roi/roi-config-repo';
import { buildRoiSummary } from '@/lib/roi/roi-service';
import { classifyTariff } from '@/lib/roi/classify-tariff';
import { SavingsView } from '@/components/site/savings/SavingsView';

const roiConfig = await new SiteRoiConfigRepo().get(finalSite.id);
let roiSummary = null;
if (roiConfig && roiConfig.fixed_buy_rate != null && roiConfig.fixed_sell_rate != null
    && (roiConfig.solar_cost != null || roiConfig.battery_cost != null)) {
    const rollups = await new RollupRepo().getAllForSite(finalSite.id);
    const activeTariff = (finalSite.tariffs ?? [])[0];
    const plan = activeTariff ? classifyTariff(activeTariff) : 'tou';
    roiSummary = buildRoiSummary(
        rollups,
        { fixedBuyRate: roiConfig.fixed_buy_rate, fixedSellRate: roiConfig.fixed_sell_rate },
        { solarCost: roiConfig.solar_cost, batteryCost: roiConfig.battery_cost },
        plan,
        new Date(),
    );
}
```

> If `finalSite.tariffs` isn't loaded with seasons/schedules here, use the same tariff source the bill view uses (the page already resolves an active tariff for billing — reuse it). Confirm by checking how `activeTariffId` is derived earlier in `page.tsx`.

- [ ] **Step 2: Pass the slots.** Add to the `<SiteTabs>` element:

```tsx
savingsSlot={<SavingsView summary={roiSummary} />}
```

And pass `roiConfig` into settings:
```tsx
settingsSlot={<SettingsView site={finalSite} installation={installation} roiConfig={roiConfig} />}
```

- [ ] **Step 3: Build + lint**

Run: `cd cmd/next-app && npm run lint && npm run build`
Expected: build succeeds (the Task 11 `savingsSlot` requirement is now satisfied).

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/src/app/site/[id]/page.tsx
git commit -m "feat(roi): wire Savings tab into site page"
```

---

### Task 14: Manual verification (M1)

- [ ] **Step 1: Run the app** against a dev DB that has rollups (or run the rollup cron/backfill first).

Run: `cd cmd/next-app && npm run dev` (port 5173).

- [ ] **Step 2: Verify the empty state** — open a site's Savings tab with no `SiteRoiConfig` → see "Add your system costs…".

- [ ] **Step 3: Configure** — in Settings, fill ROI fields (solar + battery cost, flat buy/sell rate), save → toast, page refreshes.

- [ ] **Step 4: Verify the dashboard** — Savings tab shows hero %, the 2×3 matrix with "you are here" on F (TOU site), twin component cards, and (if E<F) the flat-plan recommendation banner. Sanity-check: `A` (no-solar/flat) is the largest bill; `F` (your actual) is among the smallest.

- [ ] **Step 5: Commit any fixes**, then M1 is shippable.

---

## Milestone 2 — Arbitrage panel

### Task 15: Arbitrage service

Per-period arbitrage P&L from the Phase 1 tank. Uses the **entry tank** (prior row's stored tank) for the source split and cost basis, per the Phase 1 derivation rules. Rows must be processed in `(local_date, tank_as_of)` order so the prior row is the entry state.

**Files:**
- Create: `cmd/next-app/src/lib/roi/arbitrage-service.ts`
- Test: `cmd/next-app/src/lib/roi/arbitrage-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// arbitrage-service.test.ts
import { describe, it, expect } from 'vitest';
import { computeArbitrage } from './arbitrage-service';
import type { EnergyRollupRow } from '../db';

function r(over: Partial<EnergyRollupRow>): EnergyRollupRow {
    return {
        site_id: 's1', local_date: '2026-01-01', tariff_schedule_id: 10,
        load_wh: 0, solar_to_home_wh: 0, solar_to_battery_wh: 0, solar_to_grid_wh: 0,
        grid_to_home_wh: 0, grid_to_battery_wh: 0, battery_to_home_wh: 0, battery_to_grid_wh: 0,
        tank_solar_wh: 0, tank_grid_wh: 0, tank_solar_cost: 0, tank_grid_cost: 0, tank_as_of: new Date('2026-01-01T00:00:00Z'),
        buy_rate: 0.24, sell_rate: 0.04, battery_soc: 50,
        solar_only_import_wh: 0, solar_only_export_wh: 0, ...over,
    };
}

describe('computeArbitrage', () => {
    it('scores a discharge against the entry tank blend', () => {
        // period 1: ends with tank 10kWh grid @ $1.10 (cost basis $0.11/kWh)
        // period 2: discharges 9kWh to home at buy 0.24 → benefit 9*0.24=2.16, cost basis 9*0.11=0.99
        const rows = [
            r({ tank_as_of: new Date('2026-01-01T06:00:00Z'), tank_grid_wh: 10000, tank_grid_cost: 1.10 }),
            r({ tank_as_of: new Date('2026-01-01T18:00:00Z'), battery_to_home_wh: 9000, buy_rate: 0.24,
                tank_grid_wh: 1000, tank_grid_cost: 0.11 }),
        ];
        const a = computeArbitrage(rows);
        expect(a.netPnl).toBeCloseTo(2.16 - 0.99, 2);
        expect(a.solarFraction).toBe(0); // all grid-origin
    });

    it('flags a losing cycle when cost basis per kWh exceeds benefit per kWh', () => {
        // entry tank expensive grid ($0.30/kWh), discharged into cheap period (buy 0.11)
        const rows = [
            r({ tank_as_of: new Date('2026-01-01T06:00:00Z'), tank_grid_wh: 1000, tank_grid_cost: 0.30 }),
            r({ tank_as_of: new Date('2026-01-01T07:00:00Z'), battery_to_home_wh: 1000, buy_rate: 0.11,
                tank_grid_wh: 0, tank_grid_cost: 0 }),
        ];
        const a = computeArbitrage(rows);
        expect(a.losingCycleCount).toBe(1);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/roi/arbitrage-service`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// arbitrage-service.ts
import type { EnergyRollupRow } from '../db';

const WH_PER_KWH = 1000;

export interface ArbitrageSummary {
    netPnl: number;          // dollars
    solarFraction: number;   // 0..1 of discharged energy that was solar-origin
    losingCycleCount: number;
    dischargedKwh: number;
}

/** Rows MUST be ordered by (local_date, tank_as_of). The prior row's tank is the entry tank. */
export function computeArbitrage(rows: EnergyRollupRow[]): ArbitrageSummary {
    let netPnl = 0, solarDischargeWh = 0, totalDischargeWh = 0, losing = 0;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const dischargeWh = row.battery_to_home_wh + row.battery_to_grid_wh;
        if (dischargeWh <= 0) continue;
        const entry = i > 0 ? rows[i - 1] : null;
        const entryWh = entry ? entry.tank_solar_wh + entry.tank_grid_wh : 0;
        const entryCost = entry ? entry.tank_solar_cost + entry.tank_grid_cost : 0;
        if (!entry || entryWh <= 0) continue; // can't attribute (genesis); skip
        const solarFrac = entry.tank_solar_wh / entryWh;
        const costPerKwh = entryCost / (entryWh / WH_PER_KWH); // $/kWh blended
        const dischargeKwh = dischargeWh / WH_PER_KWH;
        const benefit = (row.battery_to_home_wh / WH_PER_KWH) * row.buy_rate
                      + (row.battery_to_grid_wh / WH_PER_KWH) * row.sell_rate;
        const costBasis = dischargeKwh * costPerKwh;
        const benefitPerKwh = dischargeKwh > 0 ? benefit / dischargeKwh : 0;
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

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/next-app && npm test -- src/lib/roi/arbitrage-service`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/arbitrage-service.ts cmd/next-app/src/lib/roi/arbitrage-service.test.ts
git commit -m "feat(roi): battery arbitrage estimate service"
```

---

### Task 16: Arbitrage panel component

**Files:**
- Create: `cmd/next-app/src/components/site/savings/ArbitragePanel.tsx`

- [ ] **Step 1: Implement** (framed as an estimate, per the EstimatedBill convention)

```tsx
// ArbitragePanel.tsx
import type { ArbitrageSummary } from '@/lib/roi/arbitrage-service';
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function ArbitragePanel({ summary }: { summary: ArbitrageSummary }) {
    const solarPct = Math.round(summary.solarFraction * 100);
    return (
        <div className="rounded-xl border border-border bg-bg-base p-5">
            <div className="text-xs uppercase opacity-60">Estimated battery arbitrage</div>
            <div className="text-2xl font-bold">{summary.netPnl >= 0 ? '+' : ''}{usd(summary.netPnl)} net from battery trades</div>
            <div className="text-xs opacity-70 mb-3">Estimate — where your battery's value came from.</div>
            <div className="flex h-4 rounded-full overflow-hidden mb-2">
                <div className="bg-yellow-500" style={{ width: `${solarPct}%` }} />
                <div className="bg-blue-500" style={{ width: `${100 - solarPct}%` }} />
            </div>
            <div className="text-xs opacity-80">{solarPct}% banked solar · {100 - solarPct}% cheap grid · {summary.dischargedKwh.toFixed(0)} kWh discharged</div>
            {summary.losingCycleCount > 0 && (
                <div className="mt-3 rounded-lg bg-red-500/10 border border-red-500/40 p-2 text-xs">
                    ⚠ {summary.losingCycleCount} losing cycle(s) detected — likely expensive grid charging (e.g. Storm Watch).
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 2: Build + lint**

Run: `cd cmd/next-app && npm run lint && npm run build`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/components/site/savings/ArbitragePanel.tsx
git commit -m "feat(roi): estimated arbitrage panel"
```

---

### Task 17: Wire the arbitrage panel into the page

**Files:**
- Modify: `cmd/next-app/src/app/site/[id]/page.tsx`

- [ ] **Step 1: Compute + pass the slot.** Where `roiSummary` is built (Task 13), also compute arbitrage from the same rollup rows and pass it as `arbitrageSlot`:

```typescript
import { computeArbitrage } from '@/lib/roi/arbitrage-service';
import { ArbitragePanel } from '@/components/site/savings/ArbitragePanel';
// ...inside the same `if (roiConfig && ...)` block, after fetching `rollups`:
const arbitrage = computeArbitrage(rollups);
```

Update the slot:
```tsx
savingsSlot={<SavingsView summary={roiSummary} arbitrageSlot={roiSummary ? <ArbitragePanel summary={arbitrage} /> : null} />}
```

(Move the `rollups` fetch so it's available for both `buildRoiSummary` and `computeArbitrage`; both already need it.)

- [ ] **Step 2: Build + lint + manual check**

Run: `cd cmd/next-app && npm run lint && npm run build`
Then `npm run dev` and confirm the arbitrage panel renders under the dashboard with a net P&L, source-split bar, and (if any) a losing-cycle flag.

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/app/site/[id]/page.tsx
git commit -m "feat(roi): wire arbitrage panel into Savings tab"
```

---

## Self-Review

**Spec coverage:**
- Solar-only 5-min sim + durable columns → Tasks 1–3. ✓
- `SiteRoiConfig` (costs + flat rates) → Tasks 4–5, form Task 10. ✓
- Six matrix cells + both decompositions → Task 7. ✓
- Projection (whole-history avg) + lowConfidence + plan detection + TOU→flat recommendation → Tasks 6, 8. ✓
- Savings tab + dashboard + empty state + matrix "you are here" → Tasks 11–13. ✓
- Estimated arbitrage panel (source split, net P&L, losing-cycle flag) → Tasks 15–17. ✓
- EnergyRollup stays keyed by active schedule (no comparison FK) → honored; no schema change beyond two plan-agnostic columns. ✓
- Deferred to 2b (hourly profile, TOU-to-TOU what-ifs, fixed→TOU) → intentionally absent. ✓

**Type consistency:** `EnergyRollupRow` (Task 3) is consumed unchanged by Tasks 7/8/15. `RoiSummary`/`MatrixTotals`/`RoiComponent` (Tasks 7–8) match `SavingsView`/`PaybackHero`/`ScenarioMatrix` usage (Task 12). `ArbitrageSummary` (Task 15) matches `ArbitragePanel` (Task 16). `solarOnlyNet` (Task 1) used in Task 2. `classifyTariff` (Task 6) used in Task 13.

**Known adapt-points (verify against real code during execution):** `verifySiteAccess` signature (Task 9); `useToast`/`Button` variant API (Task 10); Tailwind theme token names `bg-bg-base`/`text-foreground`/`bg-accent`/`border-border` (Tasks 10/12/16 — see [[project_tailwind_theming_vars]]); how `page.tsx` resolves the active tariff with seasons/schedules loaded (Task 13).
