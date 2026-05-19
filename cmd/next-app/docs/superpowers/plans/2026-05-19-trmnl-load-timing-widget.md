# TRMNL Load Timing Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the site "Load timing this cycle" widget on the TRMNL full-screen markup view, selectable from the TRMNL manage UI, behind a behavior-preserving section-registry refactor of the full-screen renderer.

**Architecture:** A new shared `computeLoadTiming` module is the single source of truth for marginal-cost / next-cheaper orchestration (extracted from the live page, consumed by both the live page and the markup route). The TRMNL full-screen renderer is refactored from hand-concatenated section blocks into an ordered section registry; the existing tuned layout math in `calculateLayoutBudget` is preserved unchanged and sections read the existing `LayoutState`. Load timing is then added as one new registry entry.

**Tech Stack:** TypeScript, Next.js (App Router), Vitest, TRMNL Framework v2 HTML.

**Working directory for all commands:** `cmd/next-app`

**Phasing:** Tasks 1–4 are a behavior-preserving refactor that ships green on its own. Tasks 5–11 add the widget. Run the full suite green at the end of each task.

---

## File Structure

**Create:**
- `src/lib/trmnl/render-full.test.ts` — characterization snapshots of `TrmnlRenderer.renderFull`
- `src/lib/trmnl/sections/types.ts` — `TrmnlSection` interface
- `src/lib/trmnl/sections/registry.ts` — `SECTION_REGISTRY` ordered list + metadata
- `src/lib/trmnl/sections/live.ts`, `energy-chart.ts`, `soc.ts`, `bill.ts`, `load-timing.ts` — one section module each
- `src/lib/trmnl/sections/load-timing.test.ts` — load-timing renderer tests
- `src/lib/load-timing.ts` — shared `computeLoadTiming` + `LoadTimingView`
- `src/lib/load-timing.test.ts` — `computeLoadTiming` unit tests

**Modify:**
- `src/lib/trmnl-renderer.ts` — `renderFull` iterates the registry
- `src/lib/trmnl/types.ts` — add `loadTiming?: LoadTimingView` to `RenderContext`
- `src/lib/trmnl-component-config.ts` — add `showLoadTiming`
- `src/lib/trmnl/layout-engine.ts` — `showLoadTiming` participates in `activeSectionCount`, add `loadTimingMinHeight`
- `src/lib/trmnl/layout-engine.test.ts` — extend for `showLoadTiming`
- `src/app/site/[id]/live/page.tsx` — consume `computeLoadTiming`
- `src/app/api/trmnl/markup/route.ts` — conditional cycle fetch + `computeLoadTiming` + debug header
- `src/app/trmnl/manage/page.tsx` — "Load timing" checkbox

---

## Task 1: Characterization snapshots for `renderFull`

Locks current full-screen output before any refactor.

**Files:**
- Create: `src/lib/trmnl/render-full.test.ts`

- [ ] **Step 1: Write the characterization test**

```ts
import { describe, it, expect } from 'vitest';
import { TrmnlRenderer } from '../trmnl-renderer';
import type { RenderContext } from './types';
import type { TrmnlComponentConfig } from '../trmnl-component-config';
import type { EnergyData } from '../db';

function makeSeries(): EnergyData[] {
    const base = new Date('2026-05-19T07:00:00Z').getTime();
    return Array.from({ length: 6 }, (_, i) => ({
        timestamp: new Date(base + i * 3_600_000),
        site_id: 's1',
        tariff_id: 1,
        load_power: 1000 + i * 100,
        solar_power: 500 * i,
        grid_power: 200 - i * 50,
        battery_power: -100 + i * 20,
        battery_soc: 40 + i * 5,
        tariff_schedule_id: null
    })) as unknown as EnergyData[];
}

function makeCfg(overrides?: Partial<TrmnlComponentConfig>): TrmnlComponentConfig {
    return {
        showLiveGrid: false,
        showLiveSolar: false,
        showLiveBattery: false,
        showEnergyChart: false,
        showBatterySoc: false,
        showEstimatedBill: false,
        batterySocMode: 'glyph',
        ...overrides
    } as TrmnlComponentConfig;
}

function makeCtx(cfg: TrmnlComponentConfig): RenderContext {
    return {
        siteName: 'Test Site',
        dateRange: '5/1 - 6/1',
        tariffGroups: [{
            tariffId: 1,
            tariffName: 'TOU-D',
            periods: [
                { touName: 'OFF_PEAK', label: 'Off-Peak', home: 5000, grid: 2000, solar: 8000, battery: -500, cost: 1.23 },
                { touName: 'ON_PEAK', label: 'On-Peak', home: 3000, grid: -1000, solar: 1000, battery: 400, cost: -0.45 }
            ]
        }],
        totalCost: 0.78,
        currency: '$',
        displayCost: '$0.78',
        costLabel: 'Total Cost',
        currentTouName: 'OFF_PEAK',
        batterySoc: 65,
        batteryStatus: 'charging',
        todayHome: 12.3,
        todayGrid: 4.5,
        todaySolar: 9.8,
        seriesData: makeSeries(),
        componentConfig: cfg
    };
}

const MATRIX: Array<[string, Partial<TrmnlComponentConfig>]> = [
    ['all-off', {}],
    ['live-only', { showLiveGrid: true, showLiveSolar: true, showLiveBattery: true }],
    ['energy-only', { showEnergyChart: true }],
    ['soc-glyph-only', { showBatterySoc: true, batterySocMode: 'glyph' }],
    ['soc-chart-only', { showBatterySoc: true, batterySocMode: 'chart' }],
    ['bill-only', { showEstimatedBill: true }],
    ['live-energy-bill', { showLiveGrid: true, showEnergyChart: true, showEstimatedBill: true }],
    ['very-dense', {
        showLiveGrid: true, showLiveSolar: true, showLiveBattery: true,
        showEnergyChart: true, showBatterySoc: true, showEstimatedBill: true, batterySocMode: 'glyph'
    }]
];

describe('renderFull characterization', () => {
    for (const [name, overrides] of MATRIX) {
        it(`snapshot: ${name}`, () => {
            const cfg = makeCfg(overrides);
            expect(TrmnlRenderer.renderFull(makeCtx(cfg))).toMatchSnapshot();
        });
    }
});
```

- [ ] **Step 2: Run to generate and verify snapshots**

Run: `npm test -- src/lib/trmnl/render-full.test.ts`
Expected: PASS, 8 snapshots written under `src/lib/trmnl/__snapshots__/render-full.test.ts.snap`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/trmnl/render-full.test.ts src/lib/trmnl/__snapshots__/render-full.test.ts.snap
git commit -m "test: characterization snapshots for TrmnlRenderer.renderFull"
```

---

## Task 2: Section interface, registry, and modules (behavior-preserving)

Move each `renderFull` HTML fragment into a section module, dispatched by an ordered registry. `calculateLayoutBudget` is **not** changed; sections read the existing `LayoutState`. Snapshots from Task 1 must stay green.

**Files:**
- Create: `src/lib/trmnl/sections/types.ts`, `src/lib/trmnl/sections/live.ts`, `src/lib/trmnl/sections/energy-chart.ts`, `src/lib/trmnl/sections/soc.ts`, `src/lib/trmnl/sections/bill.ts`, `src/lib/trmnl/sections/registry.ts`
- Modify: `src/lib/trmnl-renderer.ts`

- [ ] **Step 1: Create the section interface**

`src/lib/trmnl/sections/types.ts`:

```ts
import type { RenderContext } from '../types';
import type { LayoutState } from '../layout-engine';

export interface TrmnlSection {
    /** Stable id (also used as the manage-UI ordering anchor). */
    id: string;
    /** Human label for the manage UI. */
    label: string;
    /** Config key gating this section, or null for always-considered sections. */
    configKey: 'showLiveGrid' | 'showLiveSolar' | 'showLiveBattery'
        | 'showEnergyChart' | 'showBatterySoc' | 'showEstimatedBill'
        | 'showLoadTiming' | null;
    /** Whether this section renders for the given computed layout. */
    isEnabled(layout: LayoutState): boolean;
    /** Returns the section's TRMNL HTML (empty string if it renders nothing). */
    render(ctx: RenderContext, layout: LayoutState): string;
}
```

- [ ] **Step 2: Create the four existing-section modules**

These wrap the **exact** template strings currently in `trmnl-renderer.ts:54-119` (live `54-81`, chart `83-91`, standalone soc `93-107`, bill `109-119`). Copy each fragment verbatim into the matching `render`.

`src/lib/trmnl/sections/live.ts`:

```ts
import type { TrmnlSection } from './types';
import { escapeHtml } from '../trmnl-renderer';
import { getSunIcon, getGridIcon } from '../trmnl/icons';
import * as components from '../trmnl/components';

export const liveSection: TrmnlSection = {
    id: 'live',
    label: 'Live stats',
    configKey: null,
    isEnabled: (l) => l.hasLiveRow,
    render: (ctx, l) => `
            <div class="w--full" style="position: relative; height: ${l.liveRowHeight}px; min-height: ${l.liveRowHeight}px;">
                ${l.showSiteNameInLiveRow ? `
                <span class="label label--small" style="position: absolute; top: 2px; left: 2px; line-height: 1; z-index: 2;">${escapeHtml(ctx.siteName)}</span>
                ` : ''}
                <div class="flex flex--row flex--center-y flex--center-x ${l.liveGap}" style="height: 100%;">
                    ${l.showLiveGridStat ? `
                    <div class="flex flex--row flex--center-y flex--center-x gap--small">
                        <span class="title title--xxlarge" style="font-size: ${l.liveValueFontPx}px; line-height: 1;">${(ctx.todayGrid as number).toFixed(1)}</span>
                        ${getGridIcon(l.liveIconSize)}
                    </div>
                    ` : ''}

                    ${l.showLiveSolarStat ? `
                    <div class="flex flex--row flex--center-y flex--center-x gap--small">
                        <span class="title title--xxlarge" style="font-size: ${l.liveValueFontPx}px; line-height: 1;">${(ctx.todaySolar as number).toFixed(1)}</span>
                        ${getSunIcon(l.liveIconSize)}
                    </div>
                    ` : ''}

                    ${l.showLiveBatteryStat ? `
                    <div class="flex flex--col flex--center-x">
                        ${components.renderBatteryStatusLarge(ctx.batterySoc, ctx.batteryStatus, { scale: l.liveBatteryScale })}
                    </div>
                    ` : ''}
                </div>
            </div>
        `
};
```

`src/lib/trmnl/sections/energy-chart.ts`:

```ts
import type { TrmnlSection } from './types';
import { renderEnergyChart } from '../trmnl/charts';

export const energyChartSection: TrmnlSection = {
    id: 'energyChart',
    label: 'Energy Usage Chart',
    configKey: 'showEnergyChart',
    isEnabled: (l) => l.showEnergyChart,
    render: (ctx, l) => `
            <div class="flex flex--row flex--center-y flex--center-x w--full" style="flex: 1 1 auto; height: ${l.chartMinHeight}px; min-height: ${l.chartMinHeight}px;">
                ${ctx.seriesData ? renderEnergyChart(ctx.seriesData, {
        chartHeight: l.chartMinHeight,
        denseLegend: l.isDenseLayout || l.isVeryDenseLayout,
        veryDenseLegend: l.isVeryDenseLayout
    }) : ''}
            </div>
        `
};
```

`src/lib/trmnl/sections/soc.ts`:

```ts
import type { TrmnlSection } from './types';
import { renderSocChart, renderBatterySocGlyphStrip } from '../trmnl/charts';
import * as components from '../trmnl/components';

export const socSection: TrmnlSection = {
    id: 'soc',
    label: 'Battery Level',
    configKey: 'showBatterySoc',
    isEnabled: (l) => l.hasStandaloneSocChart || l.hasStandaloneSocGlyph,
    render: (ctx, l) => l.hasStandaloneSocChart ? `
            <div class="flex flex--row flex--center-x w--full" style="flex: 1 1 auto; height: ${l.socChartMinHeight}px; min-height: ${l.socChartMinHeight}px; align-items: stretch;">
                ${ctx.seriesData ? renderSocChart(ctx.seriesData, ctx.batterySoc, l.socChartMinHeight, {
        showXAxis: !l.showEnergyChart
    }) : '<span class="label">Battery SoC unavailable</span>'}
            </div>
        ` : `
            <div class="flex flex--row flex--center-x w--full" style="height: ${l.socGlyphSectionHeight}px; min-height: ${l.socGlyphSectionHeight}px; align-items: center;">
                <div class="flex flex--col w--full">
                    ${ctx.seriesData
            ? renderBatterySocGlyphStrip(ctx.seriesData, ctx.batterySoc, { showXAxis: !l.showEnergyChart })
            : components.renderBatterySocStandalone(ctx.batterySoc)}
                </div>
            </div>
        `
};
```

`src/lib/trmnl/sections/bill.ts`:

```ts
import type { TrmnlSection } from './types';
import { escapeHtml } from '../trmnl-renderer';
import * as components from '../trmnl/components';

export const billSection: TrmnlSection = {
    id: 'bill',
    label: 'Estimated Monthly Bill',
    configKey: 'showEstimatedBill',
    isEnabled: (l) => l.showEstimatedBill,
    render: (ctx, l) => {
        const tariffTables = components.renderTariffTables(ctx, l.billRowsTarget, l.billCompactLevel);
        return `
            <div class="flex flex--col w--full">
                ${l.showBillMetaHeader ? `
                <div class="flex flex--row flex--center-y w--full" style="justify-content: space-between; margin-bottom: 4px;">
                    <span class="title title--small" style="font-size: ${l.compactBillMode ? 15 : 17}px; line-height: 1;">${escapeHtml(ctx.siteName)}</span>
                    <span class="value value--small" style="font-size: ${l.compactBillMode ? 13 : 15}px; font-weight: 700; line-height: 1;">${escapeHtml(ctx.dateRange)}</span>
                </div>
                ` : ''}
                ${tariffTables}
            </div>
        `;
    }
};
```

- [ ] **Step 3: Create the registry**

`src/lib/trmnl/sections/registry.ts`:

```ts
import type { TrmnlSection } from './types';
import { liveSection } from './live';
import { energyChartSection } from './energy-chart';
import { socSection } from './soc';
import { billSection } from './bill';

/** Render order, top to bottom, for the full-screen view. */
export const SECTION_REGISTRY: TrmnlSection[] = [
    liveSection,
    energyChartSection,
    socSection,
    billSection
];
```

- [ ] **Step 4: Rewrite `renderFull` to iterate the registry**

In `src/lib/trmnl-renderer.ts`, replace the body of `renderFull` (currently lines `20-148`) with the version below. Keep `escapeHtml` and the other static methods unchanged. Keep the existing `import` lines and add the registry import.

```ts
import { SECTION_REGISTRY } from './trmnl/sections/registry';
// (keep existing imports: DEFAULT_TRMNL_COMPONENT_CONFIG, icons, calculateLayoutBudget,
//  charts, RenderContext, components)

    static renderFull(ctx: RenderContext): string {
        const start = Date.now();
        const cfg = ctx.componentConfig ?? DEFAULT_TRMNL_COMPONENT_CONFIG;
        const layout = calculateLayoutBudget(ctx, cfg);

        const sectionsHtml = SECTION_REGISTRY
            .filter((s) => s.isEnabled(layout))
            .map((s) => s.render(ctx, layout))
            .join('\n');

        const anyEnabled = SECTION_REGISTRY.some((s) => s.isEnabled(layout));
        const emptySection = !anyEnabled ? `
            <div class="flex flex--row flex--center-x flex--center-y h--full">
                <span class="title title--medium">No components selected</span>
            </div>
        ` : '';

        const markup = `
            <div class="view view--full">
                <div class="layout layout--col gap--small h--full">
                    ${sectionsHtml}
                    ${emptySection}

                     ${!layout.showEstimatedBill ? `
                     <div class="flex flex--row flex--center-x flex--center-y gap--medium">
                         <span class="title title--small">${escapeHtml(ctx.siteName)}</span>
                         <span class="label label--small">${escapeHtml(ctx.dateRange)}</span>
                     </div>
                     ` : ''}
                </div>
            </div>
        `;
        console.log(`[TrmnlRenderer] renderFull completed in ${Date.now() - start}ms`);
        return markup;
    }
```

Note: previously the empty-state condition was `!hasLiveRow && !showEnergyChart && !showBatterySoc && !showEstimatedBill`. `anyEnabled` over the current 4-section registry is equivalent (soc section's `isEnabled` already covers `showBatterySoc`). The footer condition is unchanged (`!showEstimatedBill`).

- [ ] **Step 5: Run characterization snapshots**

Run: `npm test -- src/lib/trmnl/render-full.test.ts`
Expected: PASS with **no snapshot changes** (8 passed, 0 obsolete, 0 written). If any snapshot differs, the extraction was not verbatim — fix the section module, do not update the snapshot.

- [ ] **Step 6: Lint and full test**

Run: `npm run lint && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/trmnl/sections src/lib/trmnl-renderer.ts
git commit -m "refactor: dispatch TRMNL full-screen sections via registry (behavior-preserving)"
```

---

## Task 3: Add `showLoadTiming` to component config

**Files:**
- Modify: `src/lib/trmnl-component-config.ts`
- Modify: `src/lib/trmnl/render-full.test.ts` (extend `makeCfg`)
- Modify: `src/lib/trmnl/layout-engine.test.ts` (extend `makeCfg`)

- [ ] **Step 1: Add the field, default, and normalizer**

In `src/lib/trmnl-component-config.ts`:

Add to the `TrmnlComponentConfig` interface (after `showEstimatedBill: boolean;`):

```ts
    showLoadTiming: boolean;
```

Add to `DEFAULT_TRMNL_COMPONENT_CONFIG` (after `showEstimatedBill: true,`):

```ts
    showLoadTiming: true,
```

In `normalizeTrmnlComponentConfig`'s returned object (after the `showEstimatedBill:` line):

```ts
        showLoadTiming: asBoolean(fromKeys(record, ['showLoadTiming', 'show_load_timing']), DEFAULT_TRMNL_COMPONENT_CONFIG.showLoadTiming),
```

- [ ] **Step 2: Keep test fixtures explicit**

In **both** `src/lib/trmnl/render-full.test.ts` and `src/lib/trmnl/layout-engine.test.ts`, add `showLoadTiming: false,` to the `makeCfg` defaults object (so existing snapshots/cases stay deterministic and unaffected until the section is wired).

- [ ] **Step 3: Run tests**

Run: `npm test -- src/lib/trmnl/render-full.test.ts src/lib/trmnl/layout-engine.test.ts`
Expected: PASS, no snapshot changes (loadTiming not yet rendered).

- [ ] **Step 4: Commit**

```bash
git add src/lib/trmnl-component-config.ts src/lib/trmnl/render-full.test.ts src/lib/trmnl/layout-engine.test.ts
git commit -m "feat: add showLoadTiming to TRMNL component config (default on)"
```

---

## Task 4: Shared `computeLoadTiming` module

**Files:**
- Create: `src/lib/load-timing.ts`, `src/lib/load-timing.test.ts`

- [ ] **Step 1: Write failing tests**

`src/lib/load-timing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeLoadTiming } from './load-timing';
import { Schedule } from './schedule';
import type { UsageData } from './energy-repo';
import type { Tariff } from './db';

const TZ = 'America/Los_Angeles';

function tariff(): Tariff {
    return {
        id: 1, name: 'TOU-D', site_id: 's1',
        seasons: [{
            id: 1, tariff_id: 1, name: 'All', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
            buy_rate: 0.30, sell_rate: 0.05,
            schedules: [
                { id: 10, tariff_season_id: 1, name: 'OFF_PEAK', days: '0,1,2,3,4,5,6',
                  from_hour: 0, from_minute: 0, to_hour: 16, to_minute: 0, buy_rate: 0.20, sell_rate: 0.05 },
                { id: 11, tariff_season_id: 1, name: 'ON_PEAK', days: '0,1,2,3,4,5,6',
                  from_hour: 16, from_minute: 0, to_hour: 21, to_minute: 0, buy_rate: 0.50, sell_rate: 0.08 },
                { id: 12, tariff_season_id: 1, name: 'OFF_PEAK_LATE', days: '0,1,2,3,4,5,6',
                  from_hour: 21, from_minute: 0, to_hour: 24, to_minute: 0, buy_rate: 0.20, sell_rate: 0.05 }
            ]
        }]
    } as unknown as Tariff;
}

function usage(touName: string, buyRate: number, sellRate: number, gridUsage: number): UsageData {
    return {
        start: new Date('2026-05-01T00:00:00Z'),
        homeUsage: 0, gridUsage, solarProduction: 0, batteryChange: 0,
        tariff: tariff(), touName, buyRate, sellRate
    };
}

describe('computeLoadTiming', () => {
    it('reports no tariff when schedule has no periods', () => {
        const schedule = new Schedule([], TZ);
        const view = computeLoadTiming(schedule, [], new Date(), TZ, null);
        expect(view.hasTariff).toBe(false);
        expect(view.hasCycleData).toBe(false);
        expect(view.periods).toEqual([]);
    });

    it('marks the active period and computes marginal cost per basis', () => {
        const schedule = new Schedule([tariff()], TZ);
        // Noon PT on a weekday → OFF_PEAK active.
        const now = new Date('2026-05-19T19:00:00Z');
        const cycle: UsageData[] = [
            usage('OFF_PEAK', 0.20, 0.05, 5000),     // importing → buy basis
            usage('ON_PEAK', 0.50, 0.08, -9000),     // exporting → sell basis
            usage('OFF_PEAK_LATE', 0.20, 0.05, 0)    // ~neutral
        ];
        const active = { name: 'OFF_PEAK', buyRate: 0.20, sellRate: 0.05 };
        const view = computeLoadTiming(schedule, cycle, now, TZ, active);

        expect(view.hasTariff).toBe(true);
        expect(view.hasCycleData).toBe(true);
        const off = view.periods.find((p) => p.name === 'OFF_PEAK')!;
        expect(off.isActive).toBe(true);
        expect(off.basis).toBe('buy');
        expect(off.marginalCost).toBeCloseTo(0.20);
        const on = view.periods.find((p) => p.name === 'ON_PEAK')!;
        expect(on.basis).toBe('sell');
        expect(on.marginalCost).toBeCloseTo(0.08);
        expect(on.isActive).toBe(false);
    });

    it('finds the next cheaper period with a relative phrase', () => {
        const schedule = new Schedule([tariff()], TZ);
        const now = new Date('2026-05-19T20:00:00Z'); // ~1 PM PT, OFF_PEAK
        const cycle: UsageData[] = [
            usage('OFF_PEAK', 0.20, 0.05, 5000),
            usage('ON_PEAK', 0.50, 0.08, 5000),
            usage('OFF_PEAK_LATE', 0.20, 0.05, -9000) // cheaper (sell basis 0.05)
        ];
        const active = { name: 'OFF_PEAK', buyRate: 0.20, sellRate: 0.05 };
        const view = computeLoadTiming(schedule, cycle, now, TZ, active);
        expect(view.nextCheaper).not.toBeNull();
        expect(typeof view.nextCheaper!.phrase).toBe('string');
        expect(view.nextCheaper!.phrase.length).toBeGreaterThan(0);
    });

    it('computes activeIsCheapest only when active is the cycle minimum', () => {
        const schedule = new Schedule([tariff()], TZ);
        const now = new Date('2026-05-19T19:00:00Z');
        const active = { name: 'OFF_PEAK', buyRate: 0.20, sellRate: 0.05 };
        const cheapestActive: UsageData[] = [
            usage('OFF_PEAK', 0.20, 0.05, 5000),
            usage('ON_PEAK', 0.50, 0.08, 5000)
        ];
        expect(computeLoadTiming(schedule, cheapestActive, now, TZ, active).activeIsCheapest).toBe(true);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/load-timing.test.ts`
Expected: FAIL — `computeLoadTiming` is not defined.

- [ ] **Step 3: Implement the module**

`src/lib/load-timing.ts`:

```ts
import type { Schedule } from './schedule';
import type { UsageData } from './energy-repo';
import { computeMarginalCost, type MarginalCostBasis } from './marginal-cost';
import {
    findNextCheaperPeriod,
    findNextStartsByKey,
    formatRelativeStart,
    periodKey
} from './next-cheaper-period';

export interface LoadTimingActivePeriod {
    name: string;
    buyRate: number;
    sellRate: number;
}

export interface LoadTimingPeriod {
    name: string;
    marginalCost: number | null;
    basis: MarginalCostBasis;
    cycleNetExportKwh: number;
    isActive: boolean;
    nextStartPhrase: string | null;
}

export interface LoadTimingView {
    hasTariff: boolean;
    hasCycleData: boolean;
    activeIsCheapest: boolean;
    periods: LoadTimingPeriod[];
    nextCheaper: { name: string; marginalCost: number; phrase: string } | null;
    /** Convenience: same string as nextCheaper?.phrase, or null. */
    nextCheaperPhrase: string | null;
    /** Per-period next-start phrase, keyed by periodKey(name, buy, sell). */
    nextStartPhraseByKey: Record<string, string>;
}

/**
 * Single source of truth for the "Load timing this cycle" computation.
 * Consumed by the live page and the TRMNL markup route so web and e-ink
 * never disagree. Pure: no IO, deterministic given its inputs.
 */
export function computeLoadTiming(
    schedule: Schedule,
    cycle: UsageData[],
    now: Date,
    timezone: string,
    activePeriod: LoadTimingActivePeriod | null
): LoadTimingView {
    const hasTariff = schedule.getTariffPeriod(now) !== null || cycle.length > 0;
    const hasCycleData = cycle.length > 0;

    let nextCheaper: LoadTimingView['nextCheaper'] = null;
    let nextCheaperPhrase: string | null = null;
    let nextStartPhraseByKey: Record<string, string> = {};
    let activeIsCheapest = false;

    if (activePeriod && hasCycleData) {
        const cheaper = findNextCheaperPeriod(schedule, now, cycle, timezone);
        if (cheaper) {
            const phrase = formatRelativeStart(cheaper.startsAt, now, timezone);
            nextCheaper = { name: cheaper.name, marginalCost: cheaper.marginalCost, phrase };
            nextCheaperPhrase = phrase;
        }

        const nextStarts = findNextStartsByKey(schedule, now, cycle, timezone);
        nextStartPhraseByKey = Object.fromEntries(
            Array.from(nextStarts.entries()).map(([key, start]) => [
                key,
                formatRelativeStart(start, now, timezone)
            ])
        );

        const activeEntry = cycle.find((u) =>
            (u.touName ?? 'Unknown') === activePeriod.name
            && (u.buyRate ?? 0) === activePeriod.buyRate
            && (u.sellRate ?? 0) === activePeriod.sellRate
        );
        const activeMarginal = activeEntry ? computeMarginalCost(activeEntry).marginalCost : null;
        if (activeMarginal !== null && activeEntry) {
            activeIsCheapest = cycle.every((u) => {
                if (u === activeEntry) return true;
                const m = computeMarginalCost(u).marginalCost;
                return m === null || m >= activeMarginal;
            });
        }
    }

    const periods: LoadTimingPeriod[] = cycle.map((u) => {
        const name = u.touName ?? 'Unknown';
        const { cycleNetExportKwh, marginalCost, basis } = computeMarginalCost(u);
        const isActive = activePeriod !== null
            && name === activePeriod.name
            && (u.buyRate ?? 0) === activePeriod.buyRate
            && (u.sellRate ?? 0) === activePeriod.sellRate;
        const key = periodKey(name, u.buyRate ?? 0, u.sellRate ?? 0);
        const nextStartPhrase = isActive ? null : (nextStartPhraseByKey[key] ?? null);
        return { name, marginalCost, basis, cycleNetExportKwh, isActive, nextStartPhrase };
    });

    return {
        hasTariff,
        hasCycleData,
        activeIsCheapest,
        periods,
        nextCheaper,
        nextCheaperPhrase,
        nextStartPhraseByKey
    };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- src/lib/load-timing.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/load-timing.ts src/lib/load-timing.test.ts
git commit -m "feat: add shared computeLoadTiming module"
```

---

## Task 5: Refactor the live page onto `computeLoadTiming`

Behavior-preserving: the live page must pass the same `nextCheaper` / `nextCheaperPhrase` / `nextStartPhraseByKey` / `activeIsCheapest` values to `LiveDetailView` as before.

**Files:**
- Modify: `src/app/site/[id]/live/page.tsx:118-151`

- [ ] **Step 1: Replace the inline orchestration block**

In `src/app/site/[id]/live/page.tsx`, replace lines `118-151` (the `let nextCheaper … }` block, from `let nextCheaper: CheaperPeriod | null = null;` through the closing of the `if (schedule && activePeriod) { … }`) with:

```ts
    const loadTiming = schedule
        ? computeLoadTiming(schedule, cycle, now, site.timezone, activePeriod)
        : null;
    const nextCheaper: CheaperPeriod | null = loadTiming?.nextCheaper
        ? findNextCheaperPeriod(schedule!, now, cycle, site.timezone)
        : null;
    const nextCheaperPhrase: string | null = loadTiming?.nextCheaperPhrase ?? null;
    const nextStartPhraseByKey: Record<string, string> = loadTiming?.nextStartPhraseByKey ?? {};
    const activeIsCheapest = loadTiming?.activeIsCheapest ?? false;
```

Update the import block (lines `10-16`) to drop the now-unused `findNextStartsByKey` / `formatRelativeStart` if they are no longer referenced, keep `findNextCheaperPeriod` and `type CheaperPeriod`, and add:

```ts
import { computeLoadTiming } from '@/lib/load-timing';
```

(`findNextCheaperPeriod` is still imported because `LiveDetailView` consumes the full `CheaperPeriod` object for its banner; `loadTiming.nextCheaper` only carries name/cost/phrase. Calling it again is cheap and keeps the props identical.)

- [ ] **Step 2: Verify build and existing tests**

Run: `npm run build && npm test`
Expected: PASS. No live-page test should change behavior.

- [ ] **Step 3: Add a live-page parity test**

**Files:** Create `src/app/site/[id]/live/load-timing-parity.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { computeLoadTiming } from '@/lib/load-timing';
import { findNextCheaperPeriod, findNextStartsByKey, formatRelativeStart } from '@/lib/next-cheaper-period';
import { computeMarginalCost } from '@/lib/marginal-cost';
import { Schedule } from '@/lib/schedule';
import type { UsageData } from '@/lib/energy-repo';
import type { Tariff } from '@/lib/db';

const TZ = 'America/Los_Angeles';

function fixture(): { schedule: Schedule; cycle: UsageData[]; active: { name: string; buyRate: number; sellRate: number } } {
    const t = {
        id: 1, name: 'TOU-D', site_id: 's1',
        seasons: [{
            id: 1, tariff_id: 1, name: 'All', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
            buy_rate: 0.30, sell_rate: 0.05,
            schedules: [
                { id: 10, tariff_season_id: 1, name: 'OFF_PEAK', days: '0,1,2,3,4,5,6', from_hour: 0, from_minute: 0, to_hour: 16, to_minute: 0, buy_rate: 0.20, sell_rate: 0.05 },
                { id: 11, tariff_season_id: 1, name: 'ON_PEAK', days: '0,1,2,3,4,5,6', from_hour: 16, from_minute: 0, to_hour: 21, to_minute: 0, buy_rate: 0.50, sell_rate: 0.08 }
            ]
        }]
    } as unknown as Tariff;
    const mk = (touName: string, buyRate: number, sellRate: number, gridUsage: number): UsageData => ({
        start: new Date('2026-05-01T00:00:00Z'), homeUsage: 0, gridUsage, solarProduction: 0, batteryChange: 0,
        tariff: t, touName, buyRate, sellRate
    });
    return {
        schedule: new Schedule([t], TZ),
        cycle: [mk('OFF_PEAK', 0.20, 0.05, 5000), mk('ON_PEAK', 0.50, 0.08, -9000)],
        active: { name: 'OFF_PEAK', buyRate: 0.20, sellRate: 0.05 }
    };
}

describe('live page parity: computeLoadTiming vs former inline logic', () => {
    it('produces identical nextCheaper / activeIsCheapest / nextStarts', () => {
        const { schedule, cycle, active } = fixture();
        const now = new Date('2026-05-19T20:00:00Z');

        // Former inline computation, reproduced verbatim:
        const inlineNextCheaper = findNextCheaperPeriod(schedule, now, cycle, TZ);
        const inlineNextCheaperPhrase = inlineNextCheaper ? formatRelativeStart(inlineNextCheaper.startsAt, now, TZ) : null;
        const inlineStarts = findNextStartsByKey(schedule, now, cycle, TZ);
        const inlineByKey = Object.fromEntries(
            Array.from(inlineStarts.entries()).map(([k, s]) => [k, formatRelativeStart(s, now, TZ)])
        );
        const activeEntry = cycle.find((u) => (u.touName ?? 'Unknown') === active.name && (u.buyRate ?? 0) === active.buyRate && (u.sellRate ?? 0) === active.sellRate);
        const am = activeEntry ? computeMarginalCost(activeEntry).marginalCost : null;
        const inlineActiveIsCheapest = am !== null && activeEntry
            ? cycle.every((u) => u === activeEntry || (computeMarginalCost(u).marginalCost ?? Infinity) >= am)
            : false;

        const view = computeLoadTiming(schedule, cycle, now, TZ, active);

        expect(view.nextCheaperPhrase).toEqual(inlineNextCheaperPhrase);
        expect(view.nextCheaper?.name ?? null).toEqual(inlineNextCheaper?.name ?? null);
        expect(view.nextStartPhraseByKey).toEqual(inlineByKey);
        expect(view.activeIsCheapest).toEqual(inlineActiveIsCheapest);
    });
});
```

- [ ] **Step 4: Run the parity test**

Run: `npm test -- src/app/site/[id]/live/load-timing-parity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/site/[id]/live/page.tsx" "src/app/site/[id]/live/load-timing-parity.test.ts"
git commit -m "refactor: live page consumes shared computeLoadTiming"
```

---

## Task 6: Add `loadTiming` to `RenderContext`

**Files:**
- Modify: `src/lib/trmnl/types.ts`

- [ ] **Step 1: Extend `RenderContext`**

In `src/lib/trmnl/types.ts`, add the import and the optional field:

```ts
import type { LoadTimingView } from '../load-timing';
```

Add to the `RenderContext` interface (after `componentConfig?: TrmnlComponentConfig;`):

```ts
    loadTiming?: LoadTimingView;
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS (no consumers yet; purely additive optional field).

- [ ] **Step 3: Commit**

```bash
git add src/lib/trmnl/types.ts
git commit -m "feat: add optional loadTiming to RenderContext"
```

---

## Task 7: Load-timing layout budget

Add `showLoadTiming` to the layout math, mirroring how the bill participates. Additive — configs with `showLoadTiming:false` are unaffected (snapshots stay green).

**Files:**
- Modify: `src/lib/trmnl/layout-engine.ts`

- [ ] **Step 1: Add config read and section flag**

In `calculateLayoutBudget` (`src/lib/trmnl/layout-engine.ts`), after `const showEstimatedBill = config.showEstimatedBill;` add:

```ts
    const showLoadTiming = config.showLoadTiming;
```

After `const hasStandaloneSocSection = hasStandaloneSocChart || hasStandaloneSocGlyph;` add:

```ts
    const hasLoadTimingSection = showLoadTiming;
```

Change `activeSectionCount` to include it:

```ts
    const activeSectionCount = (hasLiveRow ? 1 : 0)
        + (showEnergyChart ? 1 : 0)
        + (hasStandaloneSocSection ? 1 : 0)
        + (showEstimatedBill ? 1 : 0)
        + (hasLoadTimingSection ? 1 : 0);
```

- [ ] **Step 2: Add a load-timing height budget**

Just before the `return {` of `calculateLayoutBudget`, add:

```ts
    // Load timing renders a flex grid of period cells. It is a flexible
    // section: when solo it fills available height; co-displayed it gets a
    // compact floor and steps font/spacing down via loadTimingCompactLevel.
    const loadTimingCompactLevel = isVeryDenseLayout ? 2 : (isDenseLayout ? 1 : 0);
    const loadTimingMinHeight = !hasLoadTimingSection
        ? 0
        : (activeSectionCount <= 1
            ? Math.max(180, TRMNL_HEIGHT - FOOTER_HEIGHT - ESTIMATED_GAP)
            : (isVeryDenseLayout ? 96 : (isDenseLayout ? 132 : 168)));
```

Add to the `LayoutState` interface (after `showBatterySoc: boolean;`):

```ts
    hasLoadTimingSection: boolean;
    loadTimingMinHeight: number;
    loadTimingCompactLevel: number;
```

Add the three keys to the returned object:

```ts
        hasLoadTimingSection,
        loadTimingMinHeight,
        loadTimingCompactLevel,
```

- [ ] **Step 2b: Keep the empty-state condition correct**

`hasLoadTimingSection` now counts toward `activeSectionCount`, but the empty
state in `renderFull` is driven by `SECTION_REGISTRY.some(isEnabled)`. After
Task 8 adds the load-timing section to the registry this stays correct. No
change needed here; this note exists so the implementer does not also try to
special-case the footer/empty logic.

- [ ] **Step 3: Run snapshots and layout tests**

Run: `npm test -- src/lib/trmnl/render-full.test.ts src/lib/trmnl/layout-engine.test.ts`
Expected: PASS, **no snapshot changes** (matrix configs all have `showLoadTiming:false`).

- [ ] **Step 4: Commit**

```bash
git add src/lib/trmnl/layout-engine.ts
git commit -m "feat: load-timing participates in TRMNL layout budget"
```

---

## Task 8: Load-timing section renderer + registry entry

**Files:**
- Create: `src/lib/trmnl/sections/load-timing.ts`, `src/lib/trmnl/sections/load-timing.test.ts`
- Modify: `src/lib/trmnl/sections/registry.ts`

- [ ] **Step 1: Write failing renderer tests**

`src/lib/trmnl/sections/load-timing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadTimingSection } from './load-timing';
import type { RenderContext } from '../types';
import type { LayoutState } from '../layout-engine';
import type { LoadTimingView } from '../../load-timing';

function layout(overrides?: Partial<LayoutState>): LayoutState {
    return {
        hasLoadTimingSection: true,
        loadTimingMinHeight: 168,
        loadTimingCompactLevel: 0,
        showEstimatedBill: false
    } as unknown as LayoutState & Record<string, unknown> as LayoutState;
}

function view(overrides?: Partial<LoadTimingView>): LoadTimingView {
    return {
        hasTariff: true,
        hasCycleData: true,
        activeIsCheapest: false,
        periods: [
            { name: 'OFF_PEAK', marginalCost: 0.20, basis: 'buy', cycleNetExportKwh: -12, isActive: true, nextStartPhrase: null },
            { name: 'ON_PEAK', marginalCost: 0.08, basis: 'sell', cycleNetExportKwh: 9, isActive: false, nextStartPhrase: 'today at 4 PM' }
        ],
        nextCheaper: { name: 'ON_PEAK', marginalCost: 0.08, phrase: 'today at 4 PM' },
        nextCheaperPhrase: 'today at 4 PM',
        nextStartPhraseByKey: {},
        ...overrides
    };
}

function ctx(v: LoadTimingView | undefined): RenderContext {
    return { siteName: 'S', dateRange: 'r', tariffGroups: [], totalCost: 0, currency: '$', displayCost: '$0', costLabel: 'C', loadTiming: v } as RenderContext;
}

describe('loadTimingSection', () => {
    it('is disabled when layout has no load-timing section', () => {
        expect(loadTimingSection.isEnabled({ hasLoadTimingSection: false } as unknown as LayoutState)).toBe(false);
    });

    it('is enabled when layout has load-timing section', () => {
        expect(loadTimingSection.isEnabled(layout())).toBe(true);
    });

    it('marks the active period with a bold ">" prefix and no color', () => {
        const html = loadTimingSection.render(ctx(view()), layout());
        expect(html).toContain('&gt; OFF_PEAK'.replace('OFF_PEAK', 'Off-Peak'));
        expect(html).not.toMatch(/text-(green|red)/);
    });

    it('renders surplus/deficit as words', () => {
        const html = loadTimingSection.render(ctx(view()), layout());
        expect(html).toContain('Surplus');
        expect(html).toContain('Deficit');
    });

    it('renders the next-cheaper banner', () => {
        const html = loadTimingSection.render(ctx(view()), layout());
        expect(html).toContain('Cheaper');
        expect(html).toContain('today at 4 PM');
    });

    it('shows "Cheapest period now" when active is cheapest and no cheaper ahead', () => {
        const html = loadTimingSection.render(
            ctx(view({ nextCheaper: null, nextCheaperPhrase: null, activeIsCheapest: true })),
            layout()
        );
        expect(html).toContain('Cheapest period now');
    });

    it('renders a no-data message when cycle is empty', () => {
        const html = loadTimingSection.render(ctx(view({ hasCycleData: false, periods: [] })), layout());
        expect(html).toContain('No cycle data');
    });

    it('renders a configure-tariff message when no tariff', () => {
        const html = loadTimingSection.render(ctx(view({ hasTariff: false, hasCycleData: false, periods: [] })), layout());
        expect(html).toContain('Configure a tariff');
    });

    it('renders nothing when loadTiming is absent from context', () => {
        expect(loadTimingSection.render(ctx(undefined), layout())).toBe('');
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/trmnl/sections/load-timing.test.ts`
Expected: FAIL — `loadTimingSection` not defined.

- [ ] **Step 3: Implement the renderer**

`src/lib/trmnl/sections/load-timing.ts`:

```ts
import type { TrmnlSection } from './types';
import { escapeHtml } from '../trmnl-renderer';
import { formatTouName, formatCentsPerKwhShort } from '../../format-utils';

function netLabel(basis: string, netExportKwh: number): string {
    if (basis === 'neutral') return '—';
    const word = netExportKwh > 0 ? 'Surplus' : 'Deficit';
    return `${word} ${Math.round(Math.abs(netExportKwh))} kWh`;
}

export const loadTimingSection: TrmnlSection = {
    id: 'loadTiming',
    label: 'Load timing',
    configKey: 'showLoadTiming',
    isEnabled: (l) => Boolean(l.hasLoadTimingSection),
    render: (ctx, l) => {
        const view = ctx.loadTiming;
        if (!view) return '';

        if (!view.hasTariff) {
            return `
            <div class="flex flex--row flex--center-x flex--center-y w--full" style="min-height: ${l.loadTimingMinHeight}px;">
                <span class="label">Configure a tariff to see load timing</span>
            </div>`;
        }
        if (!view.hasCycleData || view.periods.length === 0) {
            return `
            <div class="flex flex--row flex--center-x flex--center-y w--full" style="min-height: ${l.loadTimingMinHeight}px;">
                <span class="label">No cycle data yet</span>
            </div>`;
        }

        const compact = l.loadTimingCompactLevel ?? 0;
        const nameClass = compact >= 2 ? 'label label--small' : 'label';
        const costClass = compact >= 2 ? 'title title--small' : (compact === 1 ? 'title title--medium' : 'title title--large');
        const metaClass = 'label label--small';

        let banner = '';
        if (view.nextCheaper) {
            banner = `
            <div class="w--full" style="border: 1px solid black; padding: 4px 6px; margin-bottom: 4px;">
                <span class="${metaClass}"><strong>Cheaper</strong>: ${escapeHtml(formatTouName(view.nextCheaper.name))} ${escapeHtml(view.nextCheaper.phrase)} (${escapeHtml(formatCentsPerKwhShort(view.nextCheaper.marginalCost))})</span>
            </div>`;
        } else if (view.activeIsCheapest) {
            banner = `
            <div class="w--full" style="border: 1px solid black; padding: 4px 6px; margin-bottom: 4px;">
                <span class="${metaClass}">Cheapest period now</span>
            </div>`;
        }

        const cells = view.periods.map((p) => {
            const prefix = p.isActive ? '&gt; ' : '';
            const nameHtml = p.isActive
                ? `<strong>${prefix}${escapeHtml(formatTouName(p.name))}</strong>`
                : `${escapeHtml(formatTouName(p.name))}`;
            const cost = p.marginalCost === null ? '—' : escapeHtml(formatCentsPerKwhShort(p.marginalCost));
            const meta = p.isActive
                ? 'Active now'
                : (p.nextStartPhrase ? `Next ${escapeHtml(p.nextStartPhrase)}` : '&nbsp;');
            return `
                <div class="flex flex--col" style="flex: 1 1 30%; min-width: 30%; border: 1px solid black; padding: 4px 6px;">
                    <span class="${nameClass}">${nameHtml}</span>
                    <span class="${costClass}">${cost}</span>
                    <span class="${metaClass}">${escapeHtml(netLabel(p.basis, p.cycleNetExportKwh))}</span>
                    <span class="${metaClass}">${meta}</span>
                </div>`;
        }).join('');

        return `
            <div class="flex flex--col w--full" style="min-height: ${l.loadTimingMinHeight}px;">
                ${banner}
                <div class="flex flex--row" style="flex-wrap: wrap; gap: 4px; align-content: flex-start;">
                    ${cells}
                </div>
            </div>`;
    }
};
```

- [ ] **Step 4: Register the section**

In `src/lib/trmnl/sections/registry.ts`, import and append it last:

```ts
import { loadTimingSection } from './load-timing';
```

```ts
export const SECTION_REGISTRY: TrmnlSection[] = [
    liveSection,
    energyChartSection,
    socSection,
    billSection,
    loadTimingSection
];
```

- [ ] **Step 5: Run renderer tests**

Run: `npm test -- src/lib/trmnl/sections/load-timing.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Run characterization snapshots**

Run: `npm test -- src/lib/trmnl/render-full.test.ts`
Expected: PASS, **no snapshot changes** (matrix configs all set `showLoadTiming:false`, so `hasLoadTimingSection` is false and the section renders nothing).

- [ ] **Step 7: Add one snapshot WITH load timing on**

Append to `src/lib/trmnl/render-full.test.ts` `MATRIX`:

```ts
    ['load-timing-only', { showLoadTiming: true }],
    ['bill-plus-load-timing', { showEstimatedBill: true, showLoadTiming: true }],
```

To make these render content, extend `makeCtx` to attach a `loadTiming` view when `cfg.showLoadTiming`:

```ts
// inside makeCtx, before the return:
const loadTiming = cfg.showLoadTiming ? {
    hasTariff: true, hasCycleData: true, activeIsCheapest: false,
    periods: [
        { name: 'OFF_PEAK', marginalCost: 0.2, basis: 'buy' as const, cycleNetExportKwh: -12, isActive: true, nextStartPhrase: null },
        { name: 'ON_PEAK', marginalCost: 0.08, basis: 'sell' as const, cycleNetExportKwh: 9, isActive: false, nextStartPhrase: 'today at 4 PM' }
    ],
    nextCheaper: { name: 'ON_PEAK', marginalCost: 0.08, phrase: 'today at 4 PM' },
    nextCheaperPhrase: 'today at 4 PM', nextStartPhraseByKey: {}
} : undefined;
```

and add `loadTiming,` to the returned `RenderContext` object.

Run: `npm test -- src/lib/trmnl/render-full.test.ts`
Expected: PASS, 2 new snapshots written, the original 8 unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/lib/trmnl/sections/load-timing.ts src/lib/trmnl/sections/load-timing.test.ts src/lib/trmnl/sections/registry.ts src/lib/trmnl/render-full.test.ts src/lib/trmnl/__snapshots__/render-full.test.ts.snap
git commit -m "feat: render Load timing section on TRMNL full-screen view"
```

---

## Task 9: Wire `computeLoadTiming` into the markup route

**Files:**
- Modify: `src/app/api/trmnl/markup/route.ts`

- [ ] **Step 1: Add the imports**

At the top of `src/app/api/trmnl/markup/route.ts`, add:

```ts
import { computeLoadTiming } from '@/lib/load-timing';
```

- [ ] **Step 2: Conditionally fetch the cycle UsageData**

The route already builds `start` (billing-cycle start) and `todayStart`. The existing parallel block is `const [latestData, priorAggregates, todayRaw] = await Promise.all([...])` (around line 289). Immediately after that line add a flag-gated cycle fetch (separate await so it's skipped entirely when off):

```ts
        const loadTimingCycle = componentConfig.showLoadTiming
            ? (await repo.getCycleAndTodayTotals(site.id, start, todayStart, now)).cycle
            : [];
```

- [ ] **Step 3: Compute the active period and the view**

The route already computes `const currentPeriod = schedule.getTariffPeriod(new Date());` (around line 639) and `const currentTouName = currentPeriod?.schedule.name;`. After that, add:

```ts
        const loadTimingActive = currentPeriod
            ? {
                name: currentPeriod.schedule.name ?? 'Unknown',
                buyRate: currentPeriod.schedule.buy_rate ?? 0,
                sellRate: currentPeriod.schedule.sell_rate ?? 0
            }
            : null;
        const loadTimingView = componentConfig.showLoadTiming
            ? computeLoadTiming(schedule, loadTimingCycle, now, tz, loadTimingActive)
            : undefined;
```

(`schedule`, `now`, and `tz` already exist in scope — `schedule` is built around line 401, `now` around line 205, `tz` around line 262.)

- [ ] **Step 4: Attach to the render context**

In the `renderCtx` object literal (around line 684), add the field after `componentConfig`:

```ts
            loadTiming: loadTimingView,
```

- [ ] **Step 5: Add the debug header flag**

In the `componentDebug` array (around line 720), add to the joined list:

```ts
            `lt:${componentConfig.showLoadTiming ? 1 : 0}`,
```

- [ ] **Step 6: Build and test**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/trmnl/markup/route.ts
git commit -m "feat: compute load timing in TRMNL markup route"
```

---

## Task 10: Manage UI checkbox

**Files:**
- Modify: `src/app/trmnl/manage/page.tsx`

- [ ] **Step 1: Add the checkbox**

In `src/app/trmnl/manage/page.tsx`, in the **Charts and Tables** group, immediately after the "Estimated Monthly Bill" `<Label>…</Label>` block (the one binding `showEstimatedBill`, around lines 676-683), add a sibling:

```tsx
                                            <Label className="flex items-start gap-2 text-sm font-normal text-gray-700 dark:text-gray-200 cursor-pointer">
                                                <Checkbox
                                                    className="mt-0.5"
                                                    checked={editingScreen?.componentConfig.showLoadTiming ?? false}
                                                    onChange={(e) => updateEditingConfig((prev) => ({ ...prev, showLoadTiming: e.target.checked }))}
                                                />
                                                <span className="leading-tight">Load timing</span>
                                            </Label>
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS (the `TrmnlComponentConfig` type already has `showLoadTiming` from Task 3, so the field access typechecks).

- [ ] **Step 3: Commit**

```bash
git add "src/app/trmnl/manage/page.tsx"
git commit -m "feat: add Load timing checkbox to TRMNL manage UI"
```

---

## Task 11: Extend layout-engine tests + final verification

**Files:**
- Modify: `src/lib/trmnl/layout-engine.test.ts`

- [ ] **Step 1: Add load-timing layout cases**

Append inside the `describe('calculateLayoutBudget', …)` block in `src/lib/trmnl/layout-engine.test.ts`:

```ts
        it('counts load timing toward active sections', () => {
            const withLt = calculateLayoutBudget(makeCtx(), makeCfg({ showLoadTiming: true }));
            const withoutLt = calculateLayoutBudget(makeCtx(), makeCfg({ showLoadTiming: false }));
            expect(withLt.hasLoadTimingSection).toBe(true);
            expect(withLt.activeSectionCount).toBe(withoutLt.activeSectionCount + 1);
        });

        it('gives solo load timing a tall budget', () => {
            const layout = calculateLayoutBudget(makeCtx(), makeCfg({ showLoadTiming: true }));
            expect(layout.loadTimingMinHeight).toBeGreaterThanOrEqual(180);
        });

        it('compacts load timing in very dense layouts', () => {
            const layout = calculateLayoutBudget(
                makeCtx({ todayGrid: 5, todaySolar: 3, batterySoc: 80 }),
                makeCfg({
                    showLiveGrid: true, showLiveSolar: true, showLiveBattery: true,
                    showEnergyChart: true, showEstimatedBill: true, showLoadTiming: true
                })
            );
            expect(layout.loadTimingCompactLevel).toBe(2);
            expect(layout.loadTimingMinHeight).toBeLessThan(180);
        });
```

- [ ] **Step 2: Run layout tests**

Run: `npm test -- src/lib/trmnl/layout-engine.test.ts`
Expected: PASS.

- [ ] **Step 3: Full verification**

Run: `npm run lint && npm run build && npm test`
Expected: ALL PASS, no obsolete/changed snapshots beyond the two intentionally-added load-timing snapshots.

- [ ] **Step 4: Manual e-ink preview check**

Start dev: `npm run dev:agent` (port 5174). In a browser, open the TRMNL manage page for a linked site, enable only **Load timing** on a screen, and confirm the preview renders the period grid + banner legibly. Then enable Load timing alongside Energy chart + Bill and confirm it compacts without clipping the footer. Report findings; tests cannot cover on-device legibility.

- [ ] **Step 5: Commit**

```bash
git add src/lib/trmnl/layout-engine.test.ts
git commit -m "test: layout-engine coverage for load timing"
```

---

## Self-Review Notes

- **Spec coverage:** config+default+normalizer (T3), manage UI (T10), debug header (T9 S5), shared `computeLoadTiming` (T4), live-page refactor + parity (T5), markup wiring (T9), full-screen render with monochrome cues (T8), budgeted/solo behavior (T7), section registry behavior-preserving refactor + characterization snapshots (T1–T2), layout-engine test extension (T11). Half/quadrant correctly excluded per spec.
- **Type consistency:** `LoadTimingView` / `LoadTimingPeriod` defined in T4 and consumed unchanged in T6/T8/T9. `TrmnlSection` defined T2, used T2/T8. `LayoutState` additions defined T7, consumed T8/T11.
- **Default-on caveat:** matrix snapshots fix `showLoadTiming:false` explicitly (T3 S2) so the behavior-preserving claim holds; default-on behavior is exercised by the dedicated load-timing snapshots (T8 S7).
