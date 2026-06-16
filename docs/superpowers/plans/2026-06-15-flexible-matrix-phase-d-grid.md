# Flexible Matrix — Phase D (Grid): Extended N-Column Scenario Grid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded 3×2 Fixed/TOU scenario matrix with a flexible **N-column extended grid** (3 system configs × the metered plan + every comparison plan), each column priced **date-resolved** over full history, with a sticky config column + horizontal scroll on desktop and a transpose-to-cards layout on mobile.

**Architecture:** The per-column pricing primitive `priceColumn(timeline, rows)` already exists (C1). This phase adds (1) `comparisonPlanTimeline(plan)` — a date-resolved **flat** timeline built from a `ComparisonPlan`'s versions — and (2) `buildExtendedGrid(rows, columns)`, which maps `priceColumn` over `[meteredTimeline, ...comparisonTimelines]` into a plain-data grid model (rows × columns, with `cheapest`/`here` flags). A new presentational `ExtendedGrid` component renders that model in both layouts. The Savings page builds the columns and swaps `ScenarioMatrix` for `ExtendedGrid`. **The ROI payback math is untouched** — `buildRoiSummary`/`MatrixTotals`/`PaybackHero`/component cards stay on the metered + fixed-baseline two-column model; the extended grid is a parallel display structure.

**Tech Stack:** Next.js (App Router), TypeScript, Tailwind, Vitest (pure-logic tests feed hand-built rows + stub timelines; component tests use `renderToStaticMarkup` + string assertions, mirroring `savings/SavingsView.test.tsx`).

**Spec:** `docs/superpowers/specs/2026-06-15-flexible-comparison-matrix-design.md` — Phase D. This is the **grid half** (decisions 1, 7, 8). The **plan manager + clone-and-tweak** half (decisions 10, the `ComparisonTariffRepo` CRUD, TOU authoring, historical-metered entry) is deliberately **deferred to a follow-on Phase D plan** and is NOT in scope here. This grid renders whatever comparison plans already exist (Fixed-only, creatable via today's minimal editor).

**Conventions to mirror:**
- Pure-logic tests import the function and feed hand-built rows; stub a `PlanTimeline` inline as `{ rateAt: () => ({ buy, sell }) }`.
- Component tests render with `renderToStaticMarkup` and assert on the HTML string (see `src/components/site/savings/SavingsView.test.tsx`).
- Grid model passed page→view must be **plain serializable data** (no functions) — timelines live only server-side in `page.tsx`.
- All commands run from `cmd/next-app`.

---

## Key facts grounding this plan (verified against the code)

- `priceColumn(timeline, rows) → { noSolar, solar, solarBattery }` exists in [roi-service.ts:21](../../cmd/next-app/src/lib/roi/roi-service.ts). Reuse it as the per-column engine; do **not** reimplement pricing.
- `comparisonPlans` are loaded in [page.tsx:295](../../cmd/next-app/src/app/site/[id]/page.tsx) via `new ComparisonTariffRepo().listFixedComparisons(...)` → `ComparisonPlan[]` (`{ name, versions: { version, is_current, effective_from, buy_rate, sell_rate }[] }`). They are **Fixed-only** today, so a date-resolved *flat* timeline per plan is exactly right (no `Schedule` loading needed).
- `site-repo` only loads `is_current AND NOT reporting_only` tariffs ([site-repo.ts:111](../../cmd/next-app/src/lib/site-repo.ts)), so `finalSite.tariffs` is the current metered version(s) only — `meteredTimeline(finalSite.tariffs, tz)` ([page.tsx:320](../../cmd/next-app/src/app/site/[id]/page.tsx)) is the metered column; comparison columns come from `comparisonPlans`.
- The matrix renders only inside the **configured** Savings state (the `fixedBaseline && roiConfig && costs` block, [page.tsx:315](../../cmd/next-app/src/app/site/[id]/page.tsx)). When that block runs, `hourly`, `meteredTl`, and ≥1 comparison plan all already exist — so the grid always has ≥2 columns.
- `ScenarioMatrix` is imported **only** by `SavingsView`. Replacing it is safe; `SavingsView.test.tsx` renders with `summary={null}` and asserts no matrix cells, so it stays green.

---

## File Structure

**Create:**
- `cmd/next-app/src/lib/roi/extended-grid.ts` — `buildExtendedGrid(rows, columns)` + grid model types.
- `cmd/next-app/src/lib/roi/extended-grid.test.ts`
- `cmd/next-app/src/components/site/savings/ExtendedGrid.tsx` — desktop scroll-grid + mobile cards.
- `cmd/next-app/src/components/site/savings/ExtendedGrid.test.tsx`

**Modify:**
- `cmd/next-app/src/lib/roi/plan-timeline.ts` — extract a generic `pickByDate` version-picker; add `comparisonPlanTimeline(plan)`.
- `cmd/next-app/src/lib/roi/plan-timeline.test.ts` — cover `comparisonPlanTimeline`.
- `cmd/next-app/src/app/site/[id]/page.tsx` — build grid columns + `extendedGrid`; pass it down; drop `fixedPlanName` plumbing.
- `cmd/next-app/src/components/site/savings/SavingsView.tsx` — render `ExtendedGrid`; drop `fixedPlanName`; reword the fixed-plan note.

**Delete:**
- `cmd/next-app/src/components/site/savings/ScenarioMatrix.tsx`

**Untouched (explicitly):** `roi-service.ts` (`MatrixTotals`/`buildRoiSummary`/`priceColumn` all stay), `PaybackHero.tsx`, the ROI component cards in `SavingsView`, `comparison-tariff-repo.ts` (CRUD is the deferred manager phase), `resolve-fixed-baseline.ts`.

---

## Task 1: `pickByDate` + `comparisonPlanTimeline`

Extract the date-resolution rule (currently the private `pickVersion` in `plan-timeline.ts`) into a generic, tested helper, then reuse it for a flat comparison-plan timeline. This keeps one source of the "latest `effective_from ≤ date`, earliest carries backward" rule.

**Files:**
- Modify: `cmd/next-app/src/lib/roi/plan-timeline.ts`
- Test: `cmd/next-app/src/lib/roi/plan-timeline.test.ts`

- [ ] **Step 1: Write the failing test**

Append this `describe` block to `src/lib/roi/plan-timeline.test.ts`:

```ts
import { comparisonPlanTimeline } from './plan-timeline';
import type { ComparisonPlan } from './comparison-tariff-repo';

describe('comparisonPlanTimeline', () => {
    const plan: ComparisonPlan = {
        name: 'EV Plan',
        versions: [
            // newest first (as listFixedComparisons returns), unsorted on purpose
            { version: 2, is_current: true, effective_from: '2025-06-01', buy_rate: 0.30, sell_rate: 0.05 },
            { version: 1, is_current: false, effective_from: '2024-01-01', buy_rate: 0.20, sell_rate: 0.04 },
        ],
    };

    it('flat: rate is independent of hour', () => {
        const tl = comparisonPlanTimeline(plan);
        expect(tl.rateAt('2025-07-01', 0)).toEqual(tl.rateAt('2025-07-01', 18));
    });

    it('resolves the version in effect on the date', () => {
        const tl = comparisonPlanTimeline(plan);
        expect(tl.rateAt('2024-06-01', 9)).toEqual({ buy: 0.20, sell: 0.04 }); // v1 window
        expect(tl.rateAt('2025-07-01', 9)).toEqual({ buy: 0.30, sell: 0.05 }); // v2 window
        expect(tl.rateAt('2025-06-01', 9)).toEqual({ buy: 0.30, sell: 0.05 }); // inclusive on effective_from
    });

    it('carries the earliest version backward before its effective_from', () => {
        const tl = comparisonPlanTimeline(plan);
        expect(tl.rateAt('2023-01-01', 9)).toEqual({ buy: 0.20, sell: 0.04 });
    });

    it('treats a null effective_from as "since the beginning"', () => {
        const tl = comparisonPlanTimeline({
            name: 'Old', versions: [{ version: 1, is_current: true, effective_from: null, buy_rate: 0.15, sell_rate: 0.03 }],
        });
        expect(tl.rateAt('1999-01-01', 0)).toEqual({ buy: 0.15, sell: 0.03 });
    });

    it('returns zero when the plan has no versions', () => {
        const tl = comparisonPlanTimeline({ name: 'Empty', versions: [] });
        expect(tl.rateAt('2025-01-01', 0)).toEqual({ buy: 0, sell: 0 });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/plan-timeline`
Expected: FAIL — `comparisonPlanTimeline` is not exported.

- [ ] **Step 3: Refactor `pickVersion` into `pickByDate` and add `comparisonPlanTimeline`**

In `src/lib/roi/plan-timeline.ts`, **replace** the private `pickVersion` function (currently lines 27–36) with a generic, exported helper:

```ts
/** The item in effect on `localDate`: the latest whose effective date <= localDate.
 *  `sortedAsc` MUST be ascending by effective date; a null effective date sorts earliest
 *  and carries backward (covers dates before any version). Returns null only when empty. */
export function pickByDate<T>(
    sortedAsc: T[],
    effOf: (item: T) => string | null,
    localDate: string,
): T | null {
    if (sortedAsc.length === 0) return null;
    let chosen = sortedAsc[0]; // earliest — carries backward when date precedes all
    for (const v of sortedAsc) {
        const eff = effOf(v) ?? '0000-01-01';
        if (eff <= localDate) chosen = v;
        else break;
    }
    return chosen;
}
```

Then update `scheduleTimeline` to call it. Replace the body of `scheduleTimeline` (currently lines 39–54) with:

```ts
export function scheduleTimeline(versions: TimelineVersion[]): PlanTimeline {
    const sortedAsc = [...versions].sort((a, b) =>
        (a.effectiveFrom ?? '0000-01-01').localeCompare(b.effectiveFrom ?? '0000-01-01'));
    return {
        rateAt(localDate: string, hour: number): Rate {
            const v = pickByDate(sortedAsc, x => x.effectiveFrom, localDate);
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
```

Add the type import at the top of the file (after the existing imports):

```ts
import type { ComparisonPlan } from './comparison-tariff-repo';
```

Add `comparisonPlanTimeline` at the end of the file:

```ts
/** A date-resolved FLAT timeline from a Fixed comparison plan's versions.
 *  Comparison plans are Fixed-only today (one buy/sell pair per version), so the rate is
 *  hour-independent; date resolution reuses the shared `pickByDate` rule. */
export function comparisonPlanTimeline(plan: ComparisonPlan): PlanTimeline {
    const sortedAsc = [...plan.versions].sort((a, b) =>
        (a.effective_from ?? '0000-01-01').localeCompare(b.effective_from ?? '0000-01-01'));
    return {
        rateAt(localDate: string): Rate {
            const v = pickByDate(sortedAsc, x => x.effective_from, localDate);
            return v ? { buy: v.buy_rate, sell: v.sell_rate } : ZERO;
        },
    };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/plan-timeline`
Expected: PASS — the new `comparisonPlanTimeline` cases AND the pre-existing `scheduleTimeline`/`flatTimeline` cases (the refactor preserved behavior).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/plan-timeline.ts cmd/next-app/src/lib/roi/plan-timeline.test.ts
git commit -m "feat(roi): comparisonPlanTimeline + shared pickByDate version resolver"
```

---

## Task 2: `buildExtendedGrid` data layer

A pure function that maps `priceColumn` over labeled columns into a plain-data grid model: 3 config rows × N plan columns, each cell flagged `cheapest` (row-min) and `here` (metered × Solar+Batt).

**Files:**
- Create: `cmd/next-app/src/lib/roi/extended-grid.ts`
- Test: `cmd/next-app/src/lib/roi/extended-grid.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/roi/extended-grid.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildExtendedGrid, type GridColumnInput } from './extended-grid';
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
const flat = (buy: number, sell: number): PlanTimeline => ({ rateAt: () => ({ buy, sell }) });

// One hour: 10 kWh load, 4 kWh solar-only import, 6 kWh actual import (grid_to_home).
const rows = [hour({ load_wh: 10000, solar_only_import_wh: 4000, grid_to_home_wh: 6000 })];

const cols: GridColumnInput[] = [
    { name: 'Your TOU', type: 'metered', isMetered: true, timeline: flat(0.20, 0) },
    { name: 'Cheap Flat', type: 'fixed', isMetered: false, timeline: flat(0.10, 0) },
];

describe('buildExtendedGrid', () => {
    it('prices each config row against each column', () => {
        const g = buildExtendedGrid(rows, cols);
        expect(g.columns).toEqual([{ name: 'Your TOU', type: 'metered' }, { name: 'Cheap Flat', type: 'fixed' }]);
        const noSolar = g.rows.find(r => r.config === 'noSolar')!;
        expect(noSolar.cells[0].value).toBeCloseTo(10 * 0.20, 6); // metered
        expect(noSolar.cells[1].value).toBeCloseTo(10 * 0.10, 6); // flat
        const solar = g.rows.find(r => r.config === 'solar')!;
        expect(solar.cells[0].value).toBeCloseTo(4 * 0.20, 6);
        const solarBattery = g.rows.find(r => r.config === 'solarBattery')!;
        expect(solarBattery.cells[0].value).toBeCloseTo(6 * 0.20, 6);
    });

    it('flags the cheapest cell per row', () => {
        const g = buildExtendedGrid(rows, cols);
        const noSolar = g.rows.find(r => r.config === 'noSolar')!;
        expect(noSolar.cells[0].cheapest).toBe(false); // metered 2.00
        expect(noSolar.cells[1].cheapest).toBe(true);  // flat 1.00 is cheaper
    });

    it('flags "here" only on the metered column × Solar+Batt', () => {
        const g = buildExtendedGrid(rows, cols);
        for (const r of g.rows) {
            for (let i = 0; i < r.cells.length; i++) {
                const expected = r.config === 'solarBattery' && cols[i].isMetered;
                expect(r.cells[i].here).toBe(expected);
            }
        }
    });

    it('never flags cheapest with a single column', () => {
        const g = buildExtendedGrid(rows, [cols[0]]);
        expect(g.rows.every(r => r.cells.every(c => !c.cheapest))).toBe(true);
    });

    it('returns three config rows with stable labels', () => {
        const g = buildExtendedGrid(rows, cols);
        expect(g.rows.map(r => r.config)).toEqual(['noSolar', 'solar', 'solarBattery']);
        expect(g.rows.map(r => r.label)).toEqual(['No Solar', 'Solar', 'Solar+Batt']);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/extended-grid`
Expected: FAIL — `./extended-grid` does not exist.

- [ ] **Step 3: Implement `extended-grid.ts`**

Create `src/lib/roi/extended-grid.ts`:

```ts
// extended-grid.ts — pure data model for the N-column scenario grid (Phase D).
import type { EnergyHourlyRow } from '../db';
import type { PlanTimeline } from './plan-timeline';
import { priceColumn } from './roi-service';

export type ColumnType = 'metered' | 'fixed' | 'tou';

/** A plan column to price. `timeline` is server-only (a function) and never serialized. */
export interface GridColumnInput {
    name: string;
    type: ColumnType;
    isMetered: boolean; // the single "you are here" column
    timeline: PlanTimeline;
}

export interface GridCell {
    value: number;    // cumulative dollars over all history
    cheapest: boolean; // row-min (only when >1 column)
    here: boolean;     // metered × Solar+Batt
}

export type ConfigKey = 'noSolar' | 'solar' | 'solarBattery';

export interface GridRow {
    config: ConfigKey;
    label: string;
    cells: GridCell[]; // index-aligned with columns
}

/** Plain, serializable model handed page → view (no timelines/functions). */
export interface ExtendedGridModel {
    columns: { name: string; type: ColumnType }[];
    rows: GridRow[];
}

const CONFIGS: { key: ConfigKey; label: string }[] = [
    { key: 'noSolar', label: 'No Solar' },
    { key: 'solar', label: 'Solar' },
    { key: 'solarBattery', label: 'Solar+Batt' },
];

/** Map priceColumn over the columns and assemble the 3×N grid with cheapest/here flags. */
export function buildExtendedGrid(rows: EnergyHourlyRow[], columns: GridColumnInput[]): ExtendedGridModel {
    const bills = columns.map(c => priceColumn(c.timeline, rows));
    const gridRows: GridRow[] = CONFIGS.map(({ key, label }) => {
        const values = bills.map(b => b[key]);
        const min = values.length ? Math.min(...values) : 0;
        const cells: GridCell[] = values.map((value, i) => ({
            value,
            cheapest: columns.length > 1 && value === min,
            here: key === 'solarBattery' && columns[i].isMetered,
        }));
        return { config: key, label, cells };
    });
    return { columns: columns.map(c => ({ name: c.name, type: c.type })), rows: gridRows };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/extended-grid`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/extended-grid.ts cmd/next-app/src/lib/roi/extended-grid.test.ts
git commit -m "feat(roi): buildExtendedGrid — N-column scenario grid data model"
```

---

## Task 3: `ExtendedGrid` component (desktop grid + mobile cards)

A pure presentational component rendering `ExtendedGridModel`: desktop = sticky config column + horizontal scroll; mobile = one card per plan with its three config rows.

**Files:**
- Create: `cmd/next-app/src/components/site/savings/ExtendedGrid.tsx`
- Test: `cmd/next-app/src/components/site/savings/ExtendedGrid.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/site/savings/ExtendedGrid.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { ExtendedGrid } from './ExtendedGrid';
import type { ExtendedGridModel } from '@/lib/roi/extended-grid';

const grid: ExtendedGridModel = {
    columns: [{ name: 'Your TOU', type: 'metered' }, { name: 'Cheap Flat', type: 'fixed' }],
    rows: [
        { config: 'noSolar', label: 'No Solar', cells: [
            { value: 2000, cheapest: false, here: false }, { value: 1000, cheapest: true, here: false }] },
        { config: 'solar', label: 'Solar', cells: [
            { value: 800, cheapest: false, here: false }, { value: 400, cheapest: true, here: false }] },
        { config: 'solarBattery', label: 'Solar+Batt', cells: [
            { value: 1200, cheapest: false, here: true }, { value: 600, cheapest: true, here: false }] },
    ],
};

describe('ExtendedGrid', () => {
    it('renders every plan name and config label', () => {
        const html = renderToStaticMarkup(<ExtendedGrid grid={grid} />);
        expect(html).toContain('Your TOU');
        expect(html).toContain('Cheap Flat');
        expect(html).toContain('No Solar');
        expect(html).toContain('Solar+Batt');
    });

    it('formats cell values as whole-dollar USD', () => {
        const html = renderToStaticMarkup(<ExtendedGrid grid={grid} />);
        expect(html).toContain('$2,000');
        expect(html).toContain('$600');
    });

    it('marks the metered column as "you are here" and shows type labels', () => {
        const html = renderToStaticMarkup(<ExtendedGrid grid={grid} />);
        expect(html).toMatch(/you are here/i);
        expect(html).toContain('metered');
        expect(html).toContain('Fixed');
    });

    it('renders both a desktop grid and mobile cards (responsive blocks)', () => {
        const html = renderToStaticMarkup(<ExtendedGrid grid={grid} />);
        expect(html).toContain('md:hidden');     // mobile cards block
        expect(html).toContain('hidden md:block'); // desktop grid block
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/site/savings/ExtendedGrid`
Expected: FAIL — `./ExtendedGrid` does not exist.

- [ ] **Step 3: Implement `ExtendedGrid.tsx`**

Create `src/components/site/savings/ExtendedGrid.tsx`:

```tsx
import { Fragment } from 'react';
import type { ColumnType, ExtendedGridModel, GridCell } from '@/lib/roi/extended-grid';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const typeLabel = (t: ColumnType) => (t === 'metered' ? 'metered' : t === 'fixed' ? 'Fixed' : 'TOU');

function cellClasses(cell: GridCell): string {
    if (cell.here) return 'border-primary bg-primary/10 font-medium';
    if (cell.cheapest) return 'border-green-600 bg-green-600/10 dark:border-green-500 dark:bg-green-950/20';
    return 'border-gray-200 dark:border-slate-800';
}

export function ExtendedGrid({ grid }: { grid: ExtendedGridModel }) {
    const cols = grid.columns;
    return (
        <>
            {/* Desktop: sticky config column + horizontal scroll on overflow */}
            <div className="hidden md:block overflow-x-auto">
                <div
                    className="grid gap-2 text-sm min-w-max"
                    style={{ gridTemplateColumns: `auto repeat(${cols.length}, minmax(7rem, 1fr))` }}
                >
                    <div className="sticky left-0 z-10 bg-bg-base" />
                    {cols.map((c, i) => (
                        <div key={i} className="text-center text-xs font-semibold opacity-70 flex flex-col items-center justify-center">
                            <span>{c.name}</span>
                            <span className="font-normal opacity-80">
                                {typeLabel(c.type)}{c.type === 'metered' && ' · you are here'}
                            </span>
                        </div>
                    ))}
                    {grid.rows.map(row => (
                        <Fragment key={row.config}>
                            <div className="sticky left-0 z-10 bg-bg-base flex items-center text-xs font-semibold pr-2">
                                {row.label}
                            </div>
                            {row.cells.map((cell, i) => (
                                <div key={i} className={`rounded-lg border p-3 ${cellClasses(cell)}`}>
                                    <div className="font-semibold">{usd(cell.value)}</div>
                                </div>
                            ))}
                        </Fragment>
                    ))}
                </div>
            </div>

            {/* Mobile: transpose to one card per plan */}
            <div className="md:hidden space-y-3">
                {cols.map((c, ci) => (
                    <div key={ci} className={`rounded-lg border p-3 ${c.type === 'metered' ? 'border-primary bg-primary/10' : 'border-gray-200 dark:border-slate-800'}`}>
                        <div className="text-xs font-semibold opacity-70 mb-2">
                            {c.name} · {typeLabel(c.type)}{c.type === 'metered' && ' · you are here'}
                        </div>
                        <div className="space-y-1">
                            {grid.rows.map(row => {
                                const cell = row.cells[ci];
                                return (
                                    <div key={row.config} className="flex justify-between text-sm">
                                        <span className="opacity-70">{row.label}</span>
                                        <span className={`font-semibold ${cell.cheapest ? 'text-green-600 dark:text-green-500' : ''}`}>
                                            {usd(cell.value)}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        </>
    );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/components/site/savings/ExtendedGrid`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/components/site/savings/ExtendedGrid.tsx cmd/next-app/src/components/site/savings/ExtendedGrid.test.tsx
git commit -m "feat(savings): ExtendedGrid component — desktop scroll-grid + mobile cards"
```

---

## Task 4: Wire the grid into the Savings page and view; retire `ScenarioMatrix`

Build the column list (metered + each comparison plan) in `page.tsx`, compute the grid, and render `ExtendedGrid` in `SavingsView` in place of `ScenarioMatrix`.

**Files:**
- Modify: `cmd/next-app/src/app/site/[id]/page.tsx`
- Modify: `cmd/next-app/src/components/site/savings/SavingsView.tsx`
- Delete: `cmd/next-app/src/components/site/savings/ScenarioMatrix.tsx`

- [ ] **Step 1: Build the grid in `page.tsx`**

In `src/app/site/[id]/page.tsx`, add these imports near the other roi imports (the `meteredTimeline`/`flatTimeline` import line and the `computeArbitrage` import already exist — add alongside them):

```ts
import { comparisonPlanTimeline } from '@/lib/roi/plan-timeline';
import { buildExtendedGrid, type GridColumnInput } from '@/lib/roi/extended-grid';
```

Declare an `extendedGrid` holder next to the existing `let arbitrage = null;` / `let savingsSeries = null;` (currently [page.tsx:300-301](../../cmd/next-app/src/app/site/[id]/page.tsx)):

```ts
    let extendedGrid = null;
```

Inside the configured block (after `arbitrage = computeArbitrage(hourly, meteredTl);`, currently [page.tsx:331](../../cmd/next-app/src/app/site/[id]/page.tsx)), build the columns and grid:

```ts
        const meteredPlanName = finalSite.tariffs?.[0]?.name ?? 'Your plan';
        const gridColumns: GridColumnInput[] = [
            { name: meteredPlanName, type: 'metered', isMetered: true, timeline: meteredTl },
            ...comparisonPlans.map(p => ({
                name: p.name, type: 'fixed' as const, isMetered: false, timeline: comparisonPlanTimeline(p),
            })),
        ];
        extendedGrid = buildExtendedGrid(hourly, gridColumns);
```

- [ ] **Step 2: Pass `extendedGrid` to `SavingsView`; drop `fixedPlanName`**

Find the `<SavingsView ... />` render (around [page.tsx:386-390](../../cmd/next-app/src/app/site/[id]/page.tsx)). Add the `extendedGrid` prop and **remove** the `fixedPlanName` prop. The `meteredPlanName={finalSite.tariffs?.[0]?.name ?? 'Your plan'}` prop stays. Result (illustrative — match the surrounding prop list):

```tsx
                        comparisonPlans={comparisonPlans}
                        extendedGrid={extendedGrid}
                        meteredPlanName={finalSite.tariffs?.[0]?.name ?? 'Your plan'}
```

If `fixedPlanName` (declared at [page.tsx:296](../../cmd/next-app/src/app/site/[id]/page.tsx) as `const fixedPlanName = comparisonPlans[0]?.name;`) is now unused, delete that declaration too. (Verify with the grep in Task 5 Step 1.)

- [ ] **Step 3: Render `ExtendedGrid` in `SavingsView`**

In `src/components/site/savings/SavingsView.tsx`:

Replace the import:

```ts
import { ScenarioMatrix } from './ScenarioMatrix';
```

with:

```ts
import { ExtendedGrid } from './ExtendedGrid';
import type { ExtendedGridModel } from '@/lib/roi/extended-grid';
```

In the props type, **remove** `fixedPlanName?: string;` and **add** `extendedGrid: ExtendedGridModel | null;`. Destructure `extendedGrid` in the function signature and remove `fixedPlanName`.

Replace the matrix render line (currently [SavingsView.tsx:76](../../cmd/next-app/src/components/site/savings/SavingsView.tsx)):

```tsx
            <ScenarioMatrix summary={summary!} fixedPlanName={fixedPlanName} meteredPlanName={meteredPlanName} />
```

with:

```tsx
            {extendedGrid && <ExtendedGrid grid={extendedGrid} />}
```

Reword the fixed-plan note just below it (currently [SavingsView.tsx:77-81](../../cmd/next-app/src/components/site/savings/SavingsView.tsx)) so it no longer claims TOU columns are missing — replace its inner text with:

```tsx
                    ℹ️ You are on a fixed-rate plan. Add comparison plans in settings to see more columns; custom TOU comparison plans are coming soon.
```

(Keep the surrounding `{summary!.actualPlan === 'fixed' && (...)}` wrapper and styling.)

- [ ] **Step 4: Delete `ScenarioMatrix.tsx`**

```bash
cd cmd/next-app && git rm src/components/site/savings/ScenarioMatrix.tsx
```

- [ ] **Step 5: Typecheck + build + lint**

Run: `cd cmd/next-app && npx tsc --noEmit && npm run build && npm run lint`
Expected: all pass. No file imports `ScenarioMatrix` or `fixedPlanName` anymore.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/app/site/[id]/page.tsx cmd/next-app/src/components/site/savings/SavingsView.tsx
git commit -m "feat(savings): N-column extended grid replaces the 3×2 scenario matrix"
```

---

## Task 5: Final verification

- [ ] **Step 1: Confirm `ScenarioMatrix`/`fixedPlanName` are fully retired**

Run: `cd cmd/next-app && grep -rn "ScenarioMatrix\|fixedPlanName" src`
Expected: **no matches.**

- [ ] **Step 2: Full test suite**

Run: `cd cmd/next-app && npm test`
Expected: all pass — including the new `extended-grid`, `ExtendedGrid`, and `plan-timeline` (comparison) tests; `SavingsView.test.tsx` unchanged and green.

- [ ] **Step 3: Build + lint + typecheck**

Run: `cd cmd/next-app && npm run build && npm run lint && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "test(savings): Phase D extended grid green" || echo "nothing to commit"
```

---

## Self-review notes (for the implementer)

- **ROI math is deliberately untouched.** `PaybackHero`, the solar/battery component cards, the plan recommendation, and `monthlyCumulative` all still read `summary.matrix` (the Fixed-baseline-vs-metered `MatrixTotals`). The extended grid is a **parallel display structure** built from `priceColumn`; do not try to derive the payback components from the N-column grid in this phase.
- **Comparison plans are Fixed-only here.** All grid comparison columns are `type: 'fixed'`. The `'tou'` `ColumnType` exists for the deferred manager phase but is never produced yet — that's expected, not a gap.
- **The plan manager is out of scope.** Creating/editing/cloning comparison plans (and historical metered versions, and TOU clone-and-tweak) is the **second Phase D plan**. This grid only *renders* plans that already exist.
- **Serialization boundary:** `GridColumnInput.timeline` is a function and stays server-side in `page.tsx`. Only `ExtendedGridModel` (plain numbers/strings/booleans) crosses into `SavingsView`. Do not pass timelines into the component.
- **Single-column degenerate case** can't occur in the rendered path (the block requires a fixed baseline ⇒ ≥1 comparison plan ⇒ ≥2 columns), but `buildExtendedGrid` handles it (no cheapest highlight) and is unit-tested for robustness.
- **`pickByDate` refactor must keep `scheduleTimeline` green** — the existing `plan-timeline.test.ts` date-resolution cases are the regression guard; run them in Task 1 Step 4 before moving on.
```