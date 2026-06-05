# Compact Mobile Site Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the global header into a single row at every width by replacing the wrapping live-stats card with a compact, progressively-enhanced metric strip.

**Architecture:** A pure `buildHeaderMetricsModel(stats)` helper produces the display model (formatted Solar/Grid/Load, grid direction, battery). A new presentational `HeaderMetricsStrip` renders icon+value metrics with responsive visibility (battery `sm+`, labels `md+`, sparklines `lg+`). `HeaderLiveStats` keeps polling/loading/error and wraps the strip in the existing tappable shell. `GlobalHeader` stops forcing the nav and stats onto separate rows.

**Tech Stack:** Next.js (App Router), React, TypeScript, Tailwind CSS, Vitest (node env, `renderToStaticMarkup`).

Spec: `docs/superpowers/specs/2026-06-05-mobile-header-compact-design.md`

All commands run from `cmd/next-app`.

---

## File Structure

- Create: `cmd/next-app/src/lib/header-metrics.ts` — pure display-model builder + grid-direction logic.
- Create: `cmd/next-app/src/lib/header-metrics.test.ts` — unit tests for the builder.
- Create: `cmd/next-app/src/components/ui/MetricIcons.tsx` — Solar/Grid/Load SVG glyphs.
- Create: `cmd/next-app/src/components/HeaderMetricsStrip.tsx` — presentational compact strip.
- Create: `cmd/next-app/src/components/HeaderMetricsStrip.test.tsx` — render tests.
- Modify: `cmd/next-app/src/components/HeaderLiveStats.tsx` — use the strip; keep polling/states; responsive LIVE label.
- Modify: `cmd/next-app/src/components/GlobalHeader.tsx` — single-row wrappers.

---

## Task 1: Display-model helper (`header-metrics.ts`)

**Files:**
- Create: `cmd/next-app/src/lib/header-metrics.ts`
- Test: `cmd/next-app/src/lib/header-metrics.test.ts`

**Note on grid sign convention:** Positive `gridPower` = importing from grid, negative = exporting. Values are formatted as absolute kW; direction is carried separately.

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/header-metrics.test.ts`:

```tsx
import { describe, expect, it } from 'vitest';
import { buildHeaderMetricsModel, gridDirection } from './header-metrics';
import type { SiteLiveData } from '@/lib/site-live-data-client';

const base: SiteLiveData = {
    solarPower: 1900,
    loadPower: 2100,
    batteryPower: 0,
    gridPower: 0,
    percentageCharged: 47.6,
};

describe('gridDirection', () => {
    it('returns import for grid draw above the deadband', () => {
        expect(gridDirection(800)).toBe('import');
    });
    it('returns export for grid feed below the negative deadband', () => {
        expect(gridDirection(-800)).toBe('export');
    });
    it('returns none within the deadband', () => {
        expect(gridDirection(20)).toBe('none');
        expect(gridDirection(-20)).toBe('none');
    });
});

describe('buildHeaderMetricsModel', () => {
    it('formats power to one-decimal kW using absolute values', () => {
        const model = buildHeaderMetricsModel({ ...base, solarPower: 1900, loadPower: 2100, gridPower: -440 });
        expect(model.solar).toBe('1.9');
        expect(model.load).toBe('2.1');
        expect(model.grid).toBe('0.4');
    });
    it('rounds the battery percentage', () => {
        expect(buildHeaderMetricsModel({ ...base, percentageCharged: 47.6 }).batteryPercent).toBe(48);
    });
    it('maps battery power to activity', () => {
        expect(buildHeaderMetricsModel({ ...base, batteryPower: -500 }).batteryActivity).toBe('charging');
        expect(buildHeaderMetricsModel({ ...base, batteryPower: 500 }).batteryActivity).toBe('discharging');
        expect(buildHeaderMetricsModel({ ...base, batteryPower: 0 }).batteryActivity).toBe('idle');
    });
    it('derives grid direction from grid power', () => {
        expect(buildHeaderMetricsModel({ ...base, gridPower: 800 }).gridDirection).toBe('import');
        expect(buildHeaderMetricsModel({ ...base, gridPower: -800 }).gridDirection).toBe('export');
        expect(buildHeaderMetricsModel({ ...base, gridPower: 0 }).gridDirection).toBe('none');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/header-metrics`
Expected: FAIL — cannot resolve `./header-metrics`.

- [ ] **Step 3: Write minimal implementation**

Create `cmd/next-app/src/lib/header-metrics.ts`:

```ts
import type { SiteLiveData } from '@/lib/site-live-data-client';
import { getBatteryActivity, type BatteryActivity } from '@/lib/live-indicators';

export type GridDirection = 'import' | 'export' | 'none';

export interface HeaderMetricsModel {
    solar: string;
    grid: string;
    load: string;
    gridDirection: GridDirection;
    batteryPercent: number;
    batteryActivity: BatteryActivity;
}

/** Below this magnitude (watts) the grid flow reads as ~zero, so no direction. */
const GRID_DIRECTION_DEADBAND_W = 50;

function fmtKw(watts: number): string {
    return (Math.abs(watts) / 1000).toFixed(1);
}

export function gridDirection(gridPowerWatts: number): GridDirection {
    if (gridPowerWatts > GRID_DIRECTION_DEADBAND_W) return 'import';
    if (gridPowerWatts < -GRID_DIRECTION_DEADBAND_W) return 'export';
    return 'none';
}

export function buildHeaderMetricsModel(stats: SiteLiveData): HeaderMetricsModel {
    return {
        solar: fmtKw(stats.solarPower),
        grid: fmtKw(stats.gridPower),
        load: fmtKw(stats.loadPower),
        gridDirection: gridDirection(stats.gridPower),
        batteryPercent: Math.round(stats.percentageCharged),
        batteryActivity: getBatteryActivity(stats.batteryPower),
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/header-metrics`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/header-metrics.ts src/lib/header-metrics.test.ts
git commit -m "feat(header): add header metrics display model"
```

---

## Task 2: Metric icons (`MetricIcons.tsx`)

**Files:**
- Create: `cmd/next-app/src/components/ui/MetricIcons.tsx`

These are pure SVG glyphs (Heroicons outline paths) using `currentColor`, so color is set by the parent's text-color class. No dedicated test — they're exercised by the strip render test in Task 3.

- [ ] **Step 1: Create the icons**

Create `cmd/next-app/src/components/ui/MetricIcons.tsx`:

```tsx
import React from 'react';

type IconProps = { className?: string };

function baseProps(className?: string) {
    return {
        viewBox: '0 0 24 24',
        className,
        'aria-hidden': true as const,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
    };
}

export function SolarIcon({ className }: IconProps) {
    return (
        <svg {...baseProps(className)}>
            <path d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
        </svg>
    );
}

export function GridIcon({ className }: IconProps) {
    return (
        <svg {...baseProps(className)}>
            <path d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
        </svg>
    );
}

export function LoadIcon({ className }: IconProps) {
    return (
        <svg {...baseProps(className)}>
            <path d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75" />
        </svg>
    );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors referencing `MetricIcons.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/MetricIcons.tsx
git commit -m "feat(header): add solar/grid/load metric icons"
```

---

## Task 3: Compact strip component (`HeaderMetricsStrip.tsx`)

**Files:**
- Create: `cmd/next-app/src/components/HeaderMetricsStrip.tsx`
- Test: `cmd/next-app/src/components/HeaderMetricsStrip.test.tsx`

The strip renders the battery glyph (`sm+`), then the three metrics (icon always; label `md+`; sparkline `lg+`), then a single shared `kW`. It does NOT render the LIVE indicator or the tappable shell — those stay in `HeaderLiveStats` so they're shared across loading/error/success.

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/components/HeaderMetricsStrip.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HeaderMetricsStrip } from './HeaderMetricsStrip';
import type { SiteLiveData } from '@/lib/site-live-data-client';

const stats: SiteLiveData = {
    solarPower: 1900,
    loadPower: 2100,
    batteryPower: -300,
    gridPower: 800,
    percentageCharged: 48,
};

describe('HeaderMetricsStrip', () => {
    it('renders the three metric values and a single shared unit', () => {
        const html = renderToStaticMarkup(<HeaderMetricsStrip stats={stats} />);
        expect(html).toContain('1.9');
        expect(html).toContain('2.1');
        expect(html).toContain('0.8');
        expect(html).toContain('kW');
    });
    it('shows the grid import arrow when importing', () => {
        const html = renderToStaticMarkup(<HeaderMetricsStrip stats={stats} />);
        expect(html).toContain('aria-label="Importing from grid"');
    });
    it('shows the grid export arrow when exporting', () => {
        const html = renderToStaticMarkup(<HeaderMetricsStrip stats={{ ...stats, gridPower: -800 }} />);
        expect(html).toContain('aria-label="Exporting to grid"');
    });
    it('omits the grid arrow within the deadband', () => {
        const html = renderToStaticMarkup(<HeaderMetricsStrip stats={{ ...stats, gridPower: 0 }} />);
        expect(html).not.toContain('aria-label="Importing from grid"');
        expect(html).not.toContain('aria-label="Exporting to grid"');
    });
    it('gates battery to sm+, labels to md+, and sparklines to lg+', () => {
        const html = renderToStaticMarkup(<HeaderMetricsStrip stats={stats} />);
        expect(html).toContain('sm:inline-flex');
        expect(html).toContain('md:inline');
        expect(html).toContain('lg:block');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/HeaderMetricsStrip`
Expected: FAIL — cannot resolve `./HeaderMetricsStrip`.

- [ ] **Step 3: Write the implementation**

Create `cmd/next-app/src/components/HeaderMetricsStrip.tsx`:

```tsx
import React from 'react';

import type { SiteLiveData, SiteLiveSparklinePoint } from '@/lib/site-live-data-client';
import { MiniSparkline } from '@/components/ui/MiniSparkline';
import { BatteryStatusGlyph } from '@/components/ui/BatteryStatusGlyph';
import { SolarIcon, GridIcon, LoadIcon } from '@/components/ui/MetricIcons';
import { buildHeaderMetricsModel, type GridDirection } from '@/lib/header-metrics';
import type { BatteryActivity } from '@/lib/live-indicators';

function batteryColorClass(percent: number): string {
    if (percent >= 80) return 'text-green-500 dark:text-green-300';
    if (percent >= 60) return 'text-green-600 dark:text-green-400';
    if (percent >= 40) return 'text-green-700 dark:text-green-500';
    if (percent >= 20) return 'text-green-800 dark:text-green-600';
    return 'text-green-900 dark:text-green-700';
}

function BatteryActivityGlyph({ status }: { status: Exclude<BatteryActivity, 'idle'> }) {
    if (status === 'charging') {
        return (
            <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5 text-gray-700 dark:text-gray-300"
                aria-hidden="true"
                fill="currentColor"
            >
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" transform="rotate(-90 12 12)" />
            </svg>
        );
    }
    return (
        <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5 text-gray-700 dark:text-gray-300"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M12 2v10M3 12h18M7 16h10M10 20h4" transform="rotate(-90 12 12)" />
        </svg>
    );
}

function GridArrow({ direction }: { direction: GridDirection }) {
    if (direction === 'none') return null;
    const importing = direction === 'import';
    return (
        <span
            className="text-[10px] leading-none text-gray-500 dark:text-gray-400"
            aria-label={importing ? 'Importing from grid' : 'Exporting to grid'}
        >
            {importing ? '↓' : '↑'}
        </span>
    );
}

function Metric({
    icon,
    label,
    value,
    valueClassName,
    sparkline,
    trailing,
}: {
    icon: React.ReactNode;
    label: string;
    value: string;
    valueClassName: string;
    sparkline: React.ReactNode;
    trailing?: React.ReactNode;
}) {
    return (
        <span className="inline-flex items-center gap-1 leading-none" title={label}>
            {icon}
            <span className="hidden text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 md:inline">
                {label}
            </span>
            <span className={`text-sm font-semibold tabular-nums ${valueClassName}`}>{value}</span>
            {trailing}
            <span className="hidden lg:block">{sparkline}</span>
        </span>
    );
}

export function HeaderMetricsStrip({ stats }: { stats: SiteLiveData }) {
    const model = buildHeaderMetricsModel(stats);
    const toPoints = (points?: SiteLiveSparklinePoint[]) =>
        (points ?? []).map((point) => ({ watts: point.watts }));
    const solarPoints = toPoints(stats.sparklines?.solar);
    const gridPoints = toPoints(stats.sparklines?.grid);
    const loadPoints = toPoints(stats.sparklines?.load);
    const scales = stats.sparklineScales;

    return (
        <span className="inline-flex min-w-0 items-center gap-2">
            <span
                className={`hidden items-center self-center gap-0.5 leading-none sm:inline-flex ${batteryColorClass(model.batteryPercent)}`}
                title={`Battery (${model.batteryPercent}%)`}
            >
                <BatteryStatusGlyph percentage={model.batteryPercent} className="block h-3.5 w-[1.55rem]" />
                {model.batteryActivity !== 'idle' ? <BatteryActivityGlyph status={model.batteryActivity} /> : null}
            </span>

            <Metric
                icon={<SolarIcon className="h-3.5 w-3.5 text-amber-600 dark:text-amber-300" />}
                label="Solar"
                value={model.solar}
                valueClassName="text-amber-700 dark:text-amber-300"
                sparkline={(
                    <MiniSparkline
                        series={solarPoints}
                        yMin={scales?.solar.minWatts}
                        yMax={scales?.solar.maxWatts}
                        className="h-3 w-8"
                        strokeClassName="text-amber-600 dark:text-amber-300"
                    />
                )}
            />
            <Metric
                icon={<GridIcon className="h-3.5 w-3.5 text-gray-700 dark:text-gray-300" />}
                label="Grid"
                value={model.grid}
                valueClassName="text-gray-900 dark:text-gray-100"
                trailing={<GridArrow direction={model.gridDirection} />}
                sparkline={(
                    <MiniSparkline
                        series={gridPoints}
                        includeZero
                        yMin={scales?.grid.minWatts}
                        yMax={scales?.grid.maxWatts}
                        className="h-3 w-8"
                        strokeClassName="text-gray-900 dark:text-gray-100"
                        positiveStrokeClassName="text-gray-900 dark:text-gray-100"
                        negativeStrokeClassName="text-gray-400 dark:text-gray-500"
                    />
                )}
            />
            <Metric
                icon={<LoadIcon className="h-3.5 w-3.5 text-blue-600 dark:text-blue-300" />}
                label="Load"
                value={model.load}
                valueClassName="text-blue-700 dark:text-blue-300"
                sparkline={(
                    <MiniSparkline
                        series={loadPoints}
                        yMin={scales?.load.minWatts}
                        yMax={scales?.load.maxWatts}
                        className="h-3 w-8"
                        strokeClassName="text-blue-600 dark:text-blue-300"
                    />
                )}
            />
            <span className="text-sm font-semibold tabular-nums text-gray-500 dark:text-gray-400">kW</span>
        </span>
    );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/HeaderMetricsStrip`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/components/HeaderMetricsStrip.tsx src/components/HeaderMetricsStrip.test.tsx
git commit -m "feat(header): add compact responsive metrics strip"
```

---

## Task 4: Rewire `HeaderLiveStats.tsx`

**Files:**
- Modify: `cmd/next-app/src/components/HeaderLiveStats.tsx`

Replace the inline `LiveMetricChip`/sparkline rendering with `HeaderMetricsStrip`. Keep polling, loading, and error states. Make the LIVE label hide below `sm` (dot stays). The shell drops its border/fill on mobile, restoring them at `md`.

- [ ] **Step 1: Replace the whole file**

Overwrite `cmd/next-app/src/components/HeaderLiveStats.tsx` with:

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { fetchSiteLiveData, isValidSiteId, SiteLiveDataFetchError } from '@/lib/site-live-data-client';
import type { SiteLiveData } from '@/lib/site-live-data-client';
import { Spinner } from '@/components/ui/Spinner';
import { HeaderMetricsStrip } from '@/components/HeaderMetricsStrip';
import { useVisiblePolling } from '@/lib/use-visible-polling';

function LiveStatsShell({ children, href }: { children: React.ReactNode; href?: string }) {
    const baseClass = "inline-flex min-w-0 max-w-full items-center justify-center gap-1.5 rounded-lg bg-bg-muted/30 px-1.5 py-1 md:justify-start md:border md:border-gray-200 md:bg-bg-muted/60 md:px-2.5 md:py-1.5 md:shadow-sm dark:md:border-slate-800 dark:md:bg-slate-900/70";
    if (href) {
        return (
            <Link href={href} className={`${baseClass} cursor-pointer transition-shadow hover:shadow-md`}>
                {children}
            </Link>
        );
    }
    return <div className={baseClass}>{children}</div>;
}

function LiveStateIndicator({
    tone,
    label
}: {
    tone: 'live' | 'loading' | 'error';
    label: string;
}) {
    const toneClass =
        tone === 'live'
            ? 'bg-green-500 dark:bg-green-400'
            : tone === 'loading'
                ? 'bg-blue-500 dark:bg-blue-400'
                : 'bg-red-500 dark:bg-red-400';

    return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-600 sm:px-2 dark:bg-slate-800/80 dark:text-gray-300">
            <span className={`h-1.5 w-1.5 rounded-full ${toneClass}`} aria-hidden="true" />
            <span className="hidden sm:inline">{label}</span>
        </span>
    );
}

export function HeaderLiveStats({ siteId }: { siteId: string }) {
    const [stats, setStats] = useState<SiteLiveData | null>(null);
    const [loading, setLoading] = useState(isValidSiteId(siteId));
    const [redirectedToLogin, setRedirectedToLogin] = useState(false);

    useVisiblePolling(async () => {
        if (!isValidSiteId(siteId)) return;
        try {
            const data = await fetchSiteLiveData(siteId);
            setStats(data);
            setLoading(false);
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            if (error instanceof SiteLiveDataFetchError && error.status === 401) {
                if (!redirectedToLogin) {
                    setRedirectedToLogin(true);
                    console.warn('[HeaderLiveStats] Unauthorized. Redirecting to login...');
                    window.location.href = '/login';
                }
                return;
            }
            // Network/transient failures should not crash client rendering.
            console.warn('Failed to refresh header stats:', error);
            setLoading(false);
        }
    }, 300000);

    const detailHref = isValidSiteId(siteId) ? `/site/${siteId}/live` : undefined;

    if (loading) {
        return (
            <LiveStatsShell href={detailHref}>
                <LiveStateIndicator tone="loading" label="Live" />
                <div className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                    <Spinner size="sm" className="text-blue-500 dark:text-blue-400" />
                    <span className="font-medium">Syncing…</span>
                </div>
            </LiveStatsShell>
        );
    }

    if (!stats) {
        return (
            <LiveStatsShell href={detailHref}>
                <LiveStateIndicator tone="error" label="Live" />
                <span className="text-sm font-medium text-red-700 dark:text-red-300">
                    Status unavailable
                </span>
            </LiveStatsShell>
        );
    }

    return (
        <LiveStatsShell href={detailHref}>
            <LiveStateIndicator tone="live" label="Live" />
            <HeaderMetricsStrip stats={stats} />
        </LiveStatsShell>
    );
}
```

- [ ] **Step 2: Verify the build typechecks and tests pass**

Run: `npm test -- src/components/HeaderMetricsStrip src/lib/header-metrics`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (Confirms the removed imports — `MiniSparkline`, `BatteryStatusGlyph`, `getBatteryActivity`, `LiveMetricChip`, `SiteLiveSparklinePoint` — left no dangling references.)

- [ ] **Step 3: Commit**

```bash
git add src/components/HeaderLiveStats.tsx
git commit -m "refactor(header): render compact strip from HeaderLiveStats"
```

---

## Task 5: Single-row header wrappers (`GlobalHeader.tsx`)

**Files:**
- Modify: `cmd/next-app/src/components/GlobalHeader.tsx`

Stop wrapping onto multiple rows: the flex row becomes `flex-nowrap` at all widths, the nav block no longer goes `w-full` on mobile, and the stats wrapper shrinks instead of centering full-width.

- [ ] **Step 1: Make the row never wrap**

In `cmd/next-app/src/components/GlobalHeader.tsx`, change the row container (around line 26):

```tsx
                <div className="flex flex-nowrap items-center gap-x-3 md:gap-x-4 justify-between">
```

(was `flex flex-wrap md:flex-nowrap items-start md:items-center gap-x-4 gap-y-3 justify-between`)

- [ ] **Step 2: Stop the nav from taking a full row**

Change the nav icons wrapper (around line 46) from:

```tsx
                    <div className={`flex justify-center gap-3 items-center order-3 md:order-3 md:w-auto shrink-0 ${showLiveStats ? 'w-full' : 'w-auto'}`}>
```

to:

```tsx
                    <div className="flex w-auto justify-end gap-3 items-center order-3 shrink-0">
```

- [ ] **Step 3: Let the stats wrapper shrink instead of filling**

Change the live-stats wrapper (around line 90) from:

```tsx
                        <div className="order-2 md:order-2 flex flex-1 min-w-0 justify-center md:px-4 mt-1 md:mt-0">
```

to:

```tsx
                        <div className="order-2 flex min-w-0 flex-1 justify-center md:px-4">
```

- [ ] **Step 4: Verify build and lint**

Run: `npm run lint`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/GlobalHeader.tsx
git commit -m "fix(header): keep logo, stats, and nav on one row on mobile"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the new `header-metrics` and `HeaderMetricsStrip` suites and the existing `MiniSparkline` suite.

- [ ] **Step 2: Lint and build**

Run: `npm run lint && npm run build`
Expected: both succeed.

- [ ] **Step 3: Manual visual check**

Run: `npm run dev` and open a site dashboard (not the `/live` detail page) at:
- **393px wide (iPhone portrait):** logo + LIVE dot + Solar/Grid/Load values + `kW` + the three nav glyphs all sit on **one row**; no battery glyph, no labels, no sparklines. If anything overflows at 393px, reduce the nav glyph size on mobile (`className="w-5 h-5 ..."` on the three nav `svg`s, restoring `md:w-6 md:h-6`).
- **852px wide (iPhone landscape):** battery glyph and SOLAR/GRID/LOAD labels appear; still no sparklines.
- **≥1024px (desktop):** sparklines reappear; the strip shows its bordered card background.
- Confirm tapping the strip navigates to `/site/[id]/live`, and that the `/live` page itself still hides the header stats.

- [ ] **Step 4: Final commit (if mobile glyph fallback was needed)**

```bash
git add -A
git commit -m "fix(header): shrink nav glyphs on mobile to fit one row"
```

(Skip if no overflow adjustment was required.)
