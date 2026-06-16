# Flexible Matrix — Phase C1: Pricing Engine on the Hourly Profile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `EnergyRollup`-sourced scenario-matrix math with an **on-read pricing engine** that prices the `EnergyHourly` profile (Phase B) against **date-resolved plan timelines** — reproducing today's six-cell matrix + cumulative chart exactly, while laying the N-column Phase D foundation.

**Architecture:** A pure `priceColumn(timeline, hourlyRows)` produces the three system-config bills (No Solar / Solar / Solar+Battery) for one plan. A `PlanTimeline.rateAt(localDate, hour)` resolves a `{buy, sell}` rate, date-resolved across effective-dated versions; `flatTimeline` is the degenerate Fixed case, `scheduleTimeline` wraps parsed `Schedule`s. The existing 6-cell `MatrixTotals` becomes two `priceColumn` calls — a flat **Fixed** timeline (→ A, C, E) and the date-resolved **metered** timeline (→ B, D, F) — so `RoiSummary`/`MonthPoint` output shapes are unchanged and the Savings UI is untouched.

**Tech Stack:** Next.js (App Router), TypeScript, PostgreSQL (`pg` pool), Vitest (pure-logic tests import directly; feed hand-built rows).

**Spec:** `docs/superpowers/specs/2026-06-15-flexible-comparison-matrix-design.md` (Phase C). This plan is **C1** of a two-plan split: C1 = pricing engine + repoint matrix & chart to `EnergyHourly`. **Arbitrage and `EnergyRollup` retirement are out of scope here — deferred to C2** (re-grain tank replay to hourly, repoint arbitrage, drop `EnergyRollup`/`RollupRepo`). In C1, arbitrage continues to read `EnergyRollup` unchanged.

**Conventions to mirror:**
- Pure-logic tests import the function and feed hand-built rows (see `roi/roi-service.test.ts`, `battery-provenance/interval-flows.test.ts`).
- Schedule rate resolution: `Schedule.getTariffPeriodByComponents(...)` + `resolveRates(period)` (see `battery-provenance/rates.ts`).
- Flat plan shape: full-year season + all-day/all-week schedule with day-of-week `0..6` (see `roi/fixed-comparison.ts` — the `0..6` gotcha).
- All commands run from `cmd/next-app`. Single test file: `npm test -- src/lib/roi/plan-timeline`.

---

## Background: what reconciles, and why

Today (`roi/roi-service.ts`) the six cells are priced from `EnergyRollupRow`, which snapshots a single `buy_rate`/`sell_rate` per period row:

| Cell | Config | Plan | Formula (per row) |
|------|--------|------|-------------------|
| A | No Solar | Fixed | `load × fixedBuy` |
| B | No Solar | Metered | `load × meteredBuy` |
| C | Solar | Fixed | `solarOnlyImport × fixedBuy − solarOnlyExport × fixedSell` |
| D | Solar | Metered | `solarOnlyImport × meteredBuy − solarOnlyExport × meteredSell` |
| E | Solar+Battery | Fixed | `actualImport × fixedBuy − actualExport × fixedSell` |
| F | Solar+Battery | Metered | `actualImport × meteredBuy − actualExport × meteredSell` |

where `actualImport = grid_to_home + grid_to_battery`, `actualExport = solar_to_grid + battery_to_grid`.

After C1, the same six cells come from `EnergyHourly` (24 buckets/day, no stored rate) by re-resolving the metered rate **per local hour** from the metered `Schedule`. For **hour-aligned** TOU windows (spec caveat #9 — essentially all utility plans) the per-hour metered rate equals the per-period rate that `EnergyRollup` stored, so F (and B, D) reconcile. The Fixed column is rate-flat, so A/C/E are unchanged by construction.

The `EnergyHourly` read method already exists: `HourlyRepo.getAllForSite(siteId)` (Phase B), returning `EnergyHourlyRow[]` ordered by `(local_date, hour)`.

---

## File Structure

**Create:**
- `cmd/next-app/src/lib/roi/plan-timeline.ts` — `PlanTimeline`, `Rate`, `flatTimeline`, `scheduleTimeline`, `meteredTimeline`.
- `cmd/next-app/src/lib/roi/plan-timeline.test.ts`

**Modify:**
- `cmd/next-app/src/lib/roi/roi-service.ts` — `priceColumn`; re-base `computeMatrixTotals`/`buildRoiSummary`/`monthlyCumulative` on `EnergyHourlyRow` + two `PlanTimeline`s.
- `cmd/next-app/src/lib/roi/roi-service.test.ts` — rewrite fixtures to hourly rows + flat timelines.
- `cmd/next-app/src/app/site/[id]/page.tsx` — read `EnergyHourly` for matrix + chart; build timelines; keep `EnergyRollup` read **only** for arbitrage.

**Untouched (explicitly):** `roi/arbitrage-service.ts`, `battery-provenance/rollup-*` (repo/service), both cron routes, `EnergyRollup` table. Those change in C2.

---

## Task 1: `PlanTimeline` — date-resolved rate resolution

A `PlanTimeline` answers one question: what `{buy, sell}` rate is in effect for a given site-local date + clock hour? `flatTimeline` is the Fixed/baseline degenerate case; `scheduleTimeline` resolves the latest effective-dated version's parsed `Schedule`. `meteredTimeline` is the convenience builder from the site's metered `Tariff` versions.

**Files:**
- Create: `cmd/next-app/src/lib/roi/plan-timeline.ts`
- Test: `cmd/next-app/src/lib/roi/plan-timeline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/roi/plan-timeline.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { flatTimeline, scheduleTimeline, meteredTimeline } from './plan-timeline';
import { Schedule } from '../schedule';
import type { Tariff } from '../db';

/** Build a one-season Tariff. `windows` become TariffSchedules (day 0..6, hour-aligned). */
function makeTariff(over: {
    id?: number;
    effective_from?: string | null;
    reporting_only?: boolean;
    seasonBuy?: number;
    seasonSell?: number;
    windows: Array<{ buy: number; sell: number; fromHour: number | null; toHour: number | null }>;
}): Tariff {
    return {
        id: over.id ?? 1,
        site_id: 's1',
        updated: new Date('2026-01-01T00:00:00Z'),
        name: 'T',
        reporting_only: over.reporting_only ?? false,
        effective_from: over.effective_from ?? null,
        seasons: [{
            id: 1, tariff_id: over.id ?? 1, name: 'All Year',
            from_month: 1, from_day: 1, to_month: 12, to_day: 31,
            buy_rate: over.seasonBuy ?? 0, sell_rate: over.seasonSell ?? 0,
            schedules: over.windows.map((w, i) => ({
                id: 100 + i, season_id: 1, name: `W${i}`,
                buy_rate: w.buy, sell_rate: w.sell,
                from_day_of_week: 0, to_day_of_week: 6,
                from_hour: w.fromHour, from_minute: 0, to_hour: w.toHour, to_minute: 0,
            })),
        }],
    } as Tariff;
}

const sched = (t: Tariff) => new Schedule([t], 'America/Los_Angeles');

describe('flatTimeline', () => {
    it('returns the same rate for any date and hour', () => {
        const tl = flatTimeline(0.2, 0.05);
        expect(tl.rateAt('2026-01-01', 0)).toEqual({ buy: 0.2, sell: 0.05 });
        expect(tl.rateAt('2030-12-31', 23)).toEqual({ buy: 0.2, sell: 0.05 });
    });
});

describe('scheduleTimeline — TOU bucketing', () => {
    it('prices peak vs off-peak by the hour-aligned window', () => {
        // Peak 16:00–21:00 @ buy 0.40; off-peak (all day) @ buy 0.10. Narrower window wins (Schedule sorts).
        const t = makeTariff({ windows: [
            { buy: 0.10, sell: 0.02, fromHour: null, toHour: null },   // all-day off-peak
            { buy: 0.40, sell: 0.06, fromHour: 16, toHour: 21 },        // peak
        ]});
        const tl = scheduleTimeline([{ effectiveFrom: null, schedule: sched(t) }]);
        expect(tl.rateAt('2026-07-15', 17)).toEqual({ buy: 0.40, sell: 0.06 }); // inside peak
        expect(tl.rateAt('2026-07-15', 3)).toEqual({ buy: 0.10, sell: 0.02 });  // off-peak
        expect(tl.rateAt('2026-07-15', 21)).toEqual({ buy: 0.10, sell: 0.02 }); // exclusive end
    });
});

describe('scheduleTimeline — date resolution', () => {
    const v1 = makeTariff({ id: 1, effective_from: null, windows: [{ buy: 0.10, sell: 0.01, fromHour: null, toHour: null }] });
    const v2 = makeTariff({ id: 2, effective_from: '2026-06-01', windows: [{ buy: 0.20, sell: 0.02, fromHour: null, toHour: null }] });
    const tl = scheduleTimeline([
        { effectiveFrom: null, schedule: sched(v1) },
        { effectiveFrom: '2026-06-01', schedule: sched(v2) },
    ]);

    it('uses the earliest (undated) version before the next version starts', () => {
        expect(tl.rateAt('2026-05-31', 0).buy).toBeCloseTo(0.10, 6);
    });
    it('is inclusive on effective_from', () => {
        expect(tl.rateAt('2026-06-01', 0).buy).toBeCloseTo(0.20, 6);
    });
    it('carries the latest version forward', () => {
        expect(tl.rateAt('2027-01-01', 0).buy).toBeCloseTo(0.20, 6);
    });
    it('carries the earliest version backward', () => {
        expect(tl.rateAt('2000-01-01', 0).buy).toBeCloseTo(0.10, 6);
    });
});

describe('meteredTimeline', () => {
    it('builds a timeline from non-reporting tariff versions', () => {
        const metered = makeTariff({ id: 1, reporting_only: false, windows: [{ buy: 0.33, sell: 0.03, fromHour: null, toHour: null }] });
        const reporting = makeTariff({ id: 2, reporting_only: true, windows: [{ buy: 0.99, sell: 0.09, fromHour: null, toHour: null }] });
        const tl = meteredTimeline([metered, reporting], 'America/Los_Angeles');
        expect(tl.rateAt('2026-01-01', 0)).toEqual({ buy: 0.33, sell: 0.03 }); // reporting-only excluded
    });

    it('returns zero rates when no metered tariff exists', () => {
        const tl = meteredTimeline([], 'America/Los_Angeles');
        expect(tl.rateAt('2026-01-01', 0)).toEqual({ buy: 0, sell: 0 });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/plan-timeline`
Expected: FAIL — `flatTimeline`/`scheduleTimeline`/`meteredTimeline` are not defined.

- [ ] **Step 3: Implement `plan-timeline.ts`**

Create `src/lib/roi/plan-timeline.ts`:

```ts
import { Schedule } from '../schedule';
import { resolveRates } from '../battery-provenance/rates';
import type { Tariff } from '../db';

export interface Rate { buy: number; sell: number; }

export interface PlanTimeline {
    /** Buy/sell rate ($/kWh) in effect for the given site-local date + clock hour (0..23). */
    rateAt(localDate: string, hour: number): Rate;
}

const ZERO: Rate = { buy: 0, sell: 0 };

/** A timeline whose rate is identical for every date/hour — the Fixed plan / flat baseline. */
export function flatTimeline(buy: number, sell: number): PlanTimeline {
    const rate: Rate = { buy, sell };
    return { rateAt: () => rate };
}

export interface TimelineVersion {
    effectiveFrom: string | null; // 'YYYY-MM-DD'; null = "since the beginning"
    schedule: Schedule;           // parsed schedule for this version
}

/** Pick the version in effect on `localDate`: the latest whose effectiveFrom <= date.
 *  Undated sorts earliest; the earliest carries backward, the latest forward. */
function pickVersion(sortedAsc: TimelineVersion[], localDate: string): TimelineVersion | null {
    if (sortedAsc.length === 0) return null;
    let chosen = sortedAsc[0]; // earliest — carries backward when date precedes all
    for (const v of sortedAsc) {
        const eff = v.effectiveFrom ?? '0000-01-01';
        if (eff <= localDate) chosen = v;
        else break;
    }
    return chosen;
}

/** A date-resolved timeline of parsed Schedules. Hour-aligned TOU windows price exactly. */
export function scheduleTimeline(versions: TimelineVersion[]): PlanTimeline {
    const sortedAsc = [...versions].sort((a, b) =>
        (a.effectiveFrom ?? '0000-01-01').localeCompare(b.effectiveFrom ?? '0000-01-01'));
    return {
        rateAt(localDate: string, hour: number): Rate {
            const v = pickVersion(sortedAsc, localDate);
            if (!v) return ZERO;
            const [y, m, d] = localDate.split('-').map(Number);
            const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat, calendar-only
            const period = v.schedule.getTariffPeriodByComponents(m, d, hour, weekday, undefined, y);
            if (!period) return ZERO;
            const { buyRate, sellRate } = resolveRates(period);
            return { buy: buyRate, sell: sellRate };
        },
    };
}

/** Build a metered timeline from the site's non-reporting Tariff versions. */
export function meteredTimeline(tariffs: Tariff[], timeZone: string): PlanTimeline {
    const versions: TimelineVersion[] = tariffs
        .filter(t => !t.reporting_only)
        .map(t => ({ effectiveFrom: t.effective_from ?? null, schedule: new Schedule([t], timeZone) }));
    return scheduleTimeline(versions);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/plan-timeline`
Expected: PASS (all describes).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/plan-timeline.ts cmd/next-app/src/lib/roi/plan-timeline.test.ts
git commit -m "feat(roi): PlanTimeline — date-resolved rate resolution (flat + schedule + metered)"
```

---

## Task 2: `priceColumn` + re-base the matrix on `EnergyHourly`

Rewrite `roi-service.ts` so the matrix prices `EnergyHourlyRow[]` against two `PlanTimeline`s. `priceColumn` is the per-column engine (Phase D reuses it for N columns); `computeMatrixTotals` is the Fixed×Metered specialization. `RoiSummary`/`MatrixTotals`/`MonthPoint` shapes stay identical.

**Files:**
- Modify: `cmd/next-app/src/lib/roi/roi-service.ts`
- Test: `cmd/next-app/src/lib/roi/roi-service.test.ts`

- [ ] **Step 1: Rewrite the test (fixtures → hourly rows + flat timelines)**

Replace the entire contents of `src/lib/roi/roi-service.test.ts` with:

```ts
// roi-service.test.ts
import { describe, it, expect } from 'vitest';
import {
    priceColumn,
    computeMatrixTotals,
    buildRoiSummary,
    monthlyCumulative,
} from './roi-service';
import { flatTimeline } from './plan-timeline';
import type { EnergyHourlyRow } from '../db';

function hour(over: Partial<EnergyHourlyRow>): EnergyHourlyRow {
    return {
        site_id: 's1', local_date: '2026-01-01', hour: 0,
        load_wh: 0, solar_to_home_wh: 0, solar_to_battery_wh: 0, solar_to_grid_wh: 0,
        grid_to_home_wh: 0, grid_to_battery_wh: 0, battery_to_home_wh: 0, battery_to_grid_wh: 0,
        solar_only_import_wh: 0, solar_only_export_wh: 0, ...over,
    };
}

const fixed = flatTimeline(0.20, 0.05);
const metered = flatTimeline(0.24, 0.04);

describe('priceColumn', () => {
    it('prices the three configs for one column (Wh→kWh at $/kWh)', () => {
        const r = hour({
            load_wh: 10000, solar_only_import_wh: 4000, solar_only_export_wh: 1000,
            grid_to_home_wh: 1500, grid_to_battery_wh: 500, solar_to_grid_wh: 300, battery_to_grid_wh: 200,
        });
        const bills = priceColumn(metered, [r]);
        expect(bills.noSolar).toBeCloseTo((10000 / 1000) * 0.24, 6);
        expect(bills.solar).toBeCloseTo((4000 / 1000) * 0.24 - (1000 / 1000) * 0.04, 6);
        // actual import = grid_to_home + grid_to_battery = 2000; export = solar_to_grid + battery_to_grid = 500
        expect(bills.solarBattery).toBeCloseTo((2000 / 1000) * 0.24 - (500 / 1000) * 0.04, 6);
    });
});

describe('computeMatrixTotals', () => {
    it('maps Fixed→A,C,E and Metered→B,D,F', () => {
        const r = hour({
            load_wh: 10000, solar_only_import_wh: 4000, solar_only_export_wh: 1000,
            grid_to_home_wh: 1500, grid_to_battery_wh: 500, solar_to_grid_wh: 300, battery_to_grid_wh: 200,
        });
        const m = computeMatrixTotals([r], fixed, metered);
        expect(m.A).toBeCloseTo((10000 / 1000) * 0.20, 6);
        expect(m.B).toBeCloseTo((10000 / 1000) * 0.24, 6);
        expect(m.C).toBeCloseTo((4000 / 1000) * 0.20 - (1000 / 1000) * 0.05, 6);
        expect(m.D).toBeCloseTo((4000 / 1000) * 0.24 - (1000 / 1000) * 0.04, 6);
        expect(m.E).toBeCloseTo((2000 / 1000) * 0.20 - (500 / 1000) * 0.05, 6);
        expect(m.F).toBeCloseTo((2000 / 1000) * 0.24 - (500 / 1000) * 0.04, 6);
    });

    it('decompositions reconcile', () => {
        const r = hour({ load_wh: 10000, solar_only_import_wh: 4000, solar_only_export_wh: 1000,
            grid_to_home_wh: 1500, grid_to_battery_wh: 500, solar_to_grid_wh: 300, battery_to_grid_wh: 200 });
        const m = computeMatrixTotals([r], fixed, metered);
        expect(m.solarValue + m.batteryValue).toBeCloseTo(m.totalSaved, 6);
        expect(m.batteryHardwareValue + m.touPlanValue).toBeCloseTo(m.batteryValue, 6);
    });
});

describe('buildRoiSummary', () => {
    const config = { solarCost: 6500, batteryCost: 5900 };
    const rows = [
        hour({ local_date: '2026-01-01', load_wh: 10000, grid_to_home_wh: 10000 }),
        hour({ local_date: '2026-01-02', load_wh: 10000, grid_to_home_wh: 10000 }),
    ];

    it('flags low confidence under a year of data', () => {
        const s = buildRoiSummary(rows, fixed, metered, config, 'tou', new Date('2026-01-02T00:00:00Z'));
        expect(s.lowConfidence).toBe(true);
        expect(s.daysOfData).toBe(2);
    });

    it('recommends flat for a TOU user when E < F', () => {
        // load-only rows: F = load×0.24, E = load×0.20 → E < F → recommend flat
        const s = buildRoiSummary(rows, fixed, metered, config, 'tou', new Date('2026-01-02T00:00:00Z'));
        expect(s.recommendation?.switchTo).toBe('fixed');
        expect(s.recommendation?.annualSaving).toBeGreaterThan(0);
    });

    it('omits a component with no cost', () => {
        const s = buildRoiSummary(rows, fixed, metered, { solarCost: null, batteryCost: 5900 }, 'tou', new Date('2026-01-02T00:00:00Z'));
        expect(s.components.find(c => c.kind === 'solar')).toBeUndefined();
        expect(s.components.find(c => c.kind === 'battery')).toBeDefined();
    });
});

describe('monthlyCumulative', () => {
    it('buckets cumulative savings by month', () => {
        const rows = [ hour({ local_date: '2026-01-31', load_wh: 10000 }), hour({ local_date: '2026-02-15', load_wh: 10000 }) ];
        const series = monthlyCumulative(rows, fixed, metered);
        expect(series).toHaveLength(2);
        expect(series[1].cumulativeSaved).toBeGreaterThan(series[0].cumulativeSaved);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/roi-service`
Expected: FAIL — `priceColumn` not exported; `computeMatrixTotals`/`buildRoiSummary`/`monthlyCumulative` have the old `EnergyRollupRow`/`RoiInputs` signatures (type errors / wrong results).

- [ ] **Step 3: Rewrite `roi-service.ts`**

Replace the entire contents of `src/lib/roi/roi-service.ts` with:

```ts
// roi-service.ts
import type { EnergyHourlyRow } from '../db';
import type { PlanTimeline } from './plan-timeline';

const WH_PER_KWH = 1000;

/** Retained for resolve-fixed-baseline.ts (the current Fixed baseline as flat scalars). */
export interface RoiInputs {
    fixedBuyRate: number;
    fixedSellRate: number;
}

export interface ColumnBills {
    noSolar: number;       // load priced at this plan
    solar: number;         // solar-only counterfactual priced at this plan
    solarBattery: number;  // actual import/export priced at this plan
}

/** Price the three system configs against ONE plan timeline, summed over hourly rows.
 *  The N-column matrix (Phase D) maps this over many timelines; C1 uses Fixed + Metered. */
export function priceColumn(timeline: PlanTimeline, rows: EnergyHourlyRow[]): ColumnBills {
    let noSolar = 0, solar = 0, solarBattery = 0;
    for (const r of rows) {
        const { buy, sell } = timeline.rateAt(r.local_date, r.hour);
        const load = Number(r.load_wh) / WH_PER_KWH;
        const soImp = Number(r.solar_only_import_wh) / WH_PER_KWH;
        const soExp = Number(r.solar_only_export_wh) / WH_PER_KWH;
        const actImp = (Number(r.grid_to_home_wh) + Number(r.grid_to_battery_wh)) / WH_PER_KWH;
        const actExp = (Number(r.solar_to_grid_wh) + Number(r.battery_to_grid_wh)) / WH_PER_KWH;
        noSolar += load * buy;
        solar += soImp * buy - soExp * sell;
        solarBattery += actImp * buy - actExp * sell;
    }
    return { noSolar, solar, solarBattery };
}

export interface MatrixTotals {
    A: number; B: number; C: number; D: number; E: number; F: number;
    solarValue: number;           // A − C
    batteryValue: number;         // C − F
    totalSaved: number;           // A − F
    batteryHardwareValue: number; // C − E
    touPlanValue: number;         // E − F
}

/** Six scenario-matrix bills: Fixed column → A,C,E; Metered column → B,D,F. Dollars. */
export function computeMatrixTotals(
    rows: EnergyHourlyRow[],
    fixed: PlanTimeline,
    metered: PlanTimeline,
): MatrixTotals {
    const fx = priceColumn(fixed, rows);
    const me = priceColumn(metered, rows);
    const A = fx.noSolar, C = fx.solar, E = fx.solarBattery;
    const B = me.noSolar, D = me.solar, F = me.solarBattery;
    return {
        A, B, C, D, E, F,
        solarValue: A - C,
        batteryValue: C - F,
        totalSaved: A - F,
        batteryHardwareValue: C - E,
        touPlanValue: E - F,
    };
}

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
    rows: EnergyHourlyRow[],
    fixed: PlanTimeline,
    metered: PlanTimeline,
    config: RoiConfigInputs,
    actualPlan: 'fixed' | 'tou',
    today: Date,
): RoiSummary {
    const matrix = computeMatrixTotals(rows, fixed, metered);
    const firstDate = rows.length
        ? rows.reduce((m, r) => (r.local_date < m ? r.local_date : m), rows[0].local_date)
        : today.toISOString().slice(0, 10);
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

export interface MonthPoint { month: string; cumulativeSaved: number; }

/** Cumulative totalSaved bucketed by 'YYYY-MM', ascending. */
export function monthlyCumulative(
    rows: EnergyHourlyRow[],
    fixed: PlanTimeline,
    metered: PlanTimeline,
): MonthPoint[] {
    const byMonth = new Map<string, EnergyHourlyRow[]>();
    for (const r of rows) {
        const m = r.local_date.slice(0, 7);
        (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(r);
    }
    const months = [...byMonth.keys()].sort();
    let cum = 0;
    return months.map(month => {
        cum += computeMatrixTotals(byMonth.get(month)!, fixed, metered).totalSaved;
        return { month, cumulativeSaved: cum };
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/roi-service`
Expected: PASS (all describes).

- [ ] **Step 5: Typecheck (catches stale callers)**

Run: `npx tsc --noEmit`
Expected: ONE class of errors — `src/app/site/[id]/page.tsx` still calls the old signatures (`buildRoiSummary(rollups, configInputs, …)`, `monthlyCumulative(rollups, configInputs)`). That is fixed in Task 3. No other files should error (only `page.tsx` and the now-updated tests import these). If any **other** file errors, stop and reconcile before continuing.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/roi/roi-service.ts cmd/next-app/src/lib/roi/roi-service.test.ts
git commit -m "feat(roi): priceColumn engine; matrix prices EnergyHourly via plan timelines"
```

---

## Task 3: Repoint the Savings page to the hourly profile

Read `EnergyHourly` for the matrix + cumulative chart, priced through a flat **Fixed** timeline and the date-resolved **metered** timeline. Arbitrage still reads `EnergyRollup` (C2 moves it on-read).

**Files:**
- Modify: `cmd/next-app/src/app/site/[id]/page.tsx`

- [ ] **Step 1: Update imports**

In `src/app/site/[id]/page.tsx`, add after the existing `import { buildRoiSummary, monthlyCumulative } from '@/lib/roi/roi-service';` line (currently line 28):

```ts
import { HourlyRepo } from '@/lib/battery-provenance/hourly-repo';
import { flatTimeline, meteredTimeline } from '@/lib/roi/plan-timeline';
```

Leave the existing `import { RollupRepo } from '@/lib/battery-provenance/rollup-repo';` (line 26) in place — arbitrage still uses it.

- [ ] **Step 2: Repoint the ROI computation block**

Replace this block (currently lines 312–327):

```ts
    const fixedBaseline = pickCurrentFixedBaseline(comparisonPlans);
    if (fixedBaseline && roiConfig && (roiConfig.solar_cost != null || roiConfig.battery_cost != null)) {
        const rollups = await new RollupRepo().getAllForSite(finalSite.id);
        const activeTariff = finalSite.tariffs.find(t => t.id === activeTariffId) || (finalSite.tariffs ?? [])[0];
        const plan = activeTariff ? classifyTariff(activeTariff) : 'tou';
        const configInputs = fixedBaseline;
        roiSummary = buildRoiSummary(
            rollups,
            configInputs,
            { solarCost: roiConfig.solar_cost, batteryCost: roiConfig.battery_cost },
            plan,
            new Date(),
        );
        arbitrage = computeArbitrage(rollups);
        savingsSeries = monthlyCumulative(rollups, configInputs);
    }
```

with:

```ts
    const fixedBaseline = pickCurrentFixedBaseline(comparisonPlans);
    if (fixedBaseline && roiConfig && (roiConfig.solar_cost != null || roiConfig.battery_cost != null)) {
        const hourly = await new HourlyRepo().getAllForSite(finalSite.id);
        const activeTariff = finalSite.tariffs.find(t => t.id === activeTariffId) || (finalSite.tariffs ?? [])[0];
        const plan = activeTariff ? classifyTariff(activeTariff) : 'tou';
        const fixedTl = flatTimeline(fixedBaseline.fixedBuyRate, fixedBaseline.fixedSellRate);
        const meteredTl = meteredTimeline(finalSite.tariffs, finalSite.timezone);
        roiSummary = buildRoiSummary(
            hourly,
            fixedTl,
            meteredTl,
            { solarCost: roiConfig.solar_cost, batteryCost: roiConfig.battery_cost },
            plan,
            new Date(),
        );
        savingsSeries = monthlyCumulative(hourly, fixedTl, meteredTl);

        // Arbitrage still reads EnergyRollup (Phase C2 re-grains tank replay to hourly on read).
        const rollups = await new RollupRepo().getAllForSite(finalSite.id);
        arbitrage = computeArbitrage(rollups);
    }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (page now matches the new signatures; `RollupRepo`/`computeArbitrage` still imported and used).

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: both pass. (`page.tsx` has no unit test; the build is the integration guard. The matrix/chart now render from `EnergyHourly` while arbitrage renders from `EnergyRollup`.)

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/app/site/[id]/page.tsx
git commit -m "feat(roi): Savings matrix + chart read EnergyHourly via priceColumn (arbitrage on rollup until C2)"
```

---

## Task 4: Final verification

- [ ] **Step 1: Full test suite**

Run: `cd cmd/next-app && npm test`
Expected: all pass, including the new `plan-timeline` and rewritten `roi-service` tests. `arbitrage-service` tests are unchanged and still green.

- [ ] **Step 2: Build + lint**

Run: `cd cmd/next-app && npm run build && npm run lint`
Expected: both pass.

- [ ] **Step 3: Confirm no stale rollup-based pricing remains**

Run: `cd cmd/next-app && grep -rn "EnergyRollupRow\|RollupRepo" src/lib/roi src/app/site`
Expected: the only match under `src/app/site` is the `RollupRepo` arbitrage read (intentional, C2 removes it); **no** `EnergyRollupRow` import remains under `src/lib/roi`.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "test(roi): Phase C1 pricing-engine green"
```

---

## Self-review notes (for the implementer)

- **Output shapes are frozen.** `MatrixTotals`, `RoiSummary`, `MonthPoint`, `RoiComponent`, `RoiRecommendation` are byte-for-byte the same as before — `SavingsView`, `ScenarioMatrix`, `SavingsChart`, `PaybackHero` need **zero** changes. Only the *inputs* (hourly rows + timelines) changed.
- **Reconciliation depends on hour-aligned windows.** F/B/D match the old rollup numbers because the metered plan's TOU windows are hour-aligned (spec caveat #9). Sub-hour windows are documented-unsupported; don't engineer for them.
- **Metered timeline is one version today.** `loadSitesFromDB` only loads the current metered tariff (`is_current AND NOT reporting_only`), so `meteredTimeline` builds a single-version timeline. That is correct for current data. Historical metered versions (which exercise multi-version date resolution end-to-end) are authored in Phase D; the engine already resolves them — proven by the `plan-timeline` date-resolution tests.
- **Arbitrage is deliberately left on `EnergyRollup`.** C1 does not touch `arbitrage-service.ts`, `rollup-*`, the crons, or the `EnergyRollup` table. C2 re-grains the tank replay to hourly (with genesis handling), repoints arbitrage, then drops `EnergyRollup`/`RollupRepo` and the rollup write path.
- **`RoiInputs` survives** only as the return type of `resolve-fixed-baseline.ts`; the page converts it to a `flatTimeline`. Don't delete it.
- **`priceColumn` is the Phase D seam.** Phase D maps it over `[meteredTimeline, ...comparisonTimelines]` for the N-column grid — keep it pure and timeline-only.
```
