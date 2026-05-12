# Site Live Detail Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/site/[id]/live` page with the existing live power-flow tile at top, today's totals (overall row + per-TOU mini-table), and a row of TOU period cards showing cycle-to-date marginal cost as a load-timing recommendation.

**Architecture:** Server component for the page (cycle/today aggregates fetched via a new `EnergyRepo.getCycleAndTodayTotals`); existing `SiteLiveStats` client component handles the polled live row. A new pure function `computeMarginalCost` derives per-period marginal cost from cycle `gridUsage`. The dashboard live tile retargets its `<Link>` to the new route.

**Tech Stack:** Next.js 15 App Router, React server components, TypeScript, Tailwind, Vitest (node environment).

**Spec:** `docs/superpowers/specs/2026-05-10-site-live-detail-design.md`

**Sign convention** (from `energy-repo.ts:204-209`): `UsageData.gridUsage` is positive when the site is *importing* from the grid, negative when *exporting*. The unit is the same convention used by the existing cost calc — `wattsToKilowatts(usage.gridUsage)` produces kWh. Therefore `cycleNetExportKwh = -wattsToKilowatts(usage.gridUsage)`.

**Deviation from spec:** Spec called for `PeriodCard.test.tsx`. Vitest is configured with `environment: 'node'` and the project has no component tests. Rather than add jsdom + React Testing Library, the card's display logic is extracted into a pure `getPeriodCardDisplay` helper in `src/lib/period-card-display.ts`, and that is unit-tested. The JSX itself is visually verified.

**Repo note:** Working tree may have unstaged in-progress changes (energy-repo decomposition). The plan targets `EnergyRepo` and `SiteRepo` as they exist in the working tree at the time of writing. If the repo APIs have shifted by the time this plan runs, adapt method locations accordingly — the public method names referenced here (`getUsageByTOU`, `getSiteMidnight`, `siteRepo.getSite`, `getLockedRefreshHandler`) should remain stable.

---

## File Structure

**New files:**
- `cmd/next-app/src/lib/billing-cycle.ts` — `getCurrentCycleStart`
- `cmd/next-app/src/lib/billing-cycle.test.ts`
- `cmd/next-app/src/lib/marginal-cost.ts` — `computeMarginalCost`
- `cmd/next-app/src/lib/marginal-cost.test.ts`
- `cmd/next-app/src/lib/period-card-display.ts` — `getPeriodCardDisplay`
- `cmd/next-app/src/lib/period-card-display.test.ts`
- `cmd/next-app/src/components/site/live/PeriodCard.tsx`
- `cmd/next-app/src/components/site/live/PeriodCardRow.tsx`
- `cmd/next-app/src/components/site/live/DailyTotalsRow.tsx`
- `cmd/next-app/src/components/site/live/DailyByPeriodTable.tsx`
- `cmd/next-app/src/components/site/live/LiveDetailView.tsx`
- `cmd/next-app/src/app/site/[id]/live/page.tsx`

**Modified files:**
- `cmd/next-app/src/lib/energy-repo.ts` — add `getCycleAndTodayTotals` method on `EnergyRepo`
- `cmd/next-app/src/lib/energy-repo.test.ts` — extend with `getCycleAndTodayTotals` tests
- `cmd/next-app/src/app/site/[id]/usage/page.tsx` — replace inline cycle-start logic with `getCurrentCycleStart`
- `cmd/next-app/src/components/DashboardCards.tsx` — retarget live tile `<Link>` to `/site/[id]/live`

---

### Task 1: Extract billing cycle helper (test-first)

**Files:**
- Create: `cmd/next-app/src/lib/billing-cycle.ts`
- Create: `cmd/next-app/src/lib/billing-cycle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/billing-cycle.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { getCurrentCycleStart } from './billing-cycle';

describe('getCurrentCycleStart', () => {
    it('returns this month when now is on the billing day', () => {
        // March 15, billingStartDay 15 → March 15
        const now = new Date(2026, 2, 15, 12, 0, 0);
        const start = getCurrentCycleStart(15, now);
        expect(start).toEqual(new Date(2026, 2, 15));
    });

    it('returns this month when now is after the billing day', () => {
        // March 20, billingStartDay 15 → March 15
        const now = new Date(2026, 2, 20, 8, 0, 0);
        const start = getCurrentCycleStart(15, now);
        expect(start).toEqual(new Date(2026, 2, 15));
    });

    it('returns previous month when now is before the billing day', () => {
        // March 10, billingStartDay 15 → February 15
        const now = new Date(2026, 2, 10, 8, 0, 0);
        const start = getCurrentCycleStart(15, now);
        expect(start).toEqual(new Date(2026, 1, 15));
    });

    it('handles billing day rollover from January (previous year)', () => {
        // January 5, billingStartDay 15 → December 15 of previous year
        const now = new Date(2026, 0, 5, 8, 0, 0);
        const start = getCurrentCycleStart(15, now);
        expect(start).toEqual(new Date(2025, 11, 15));
    });

    it('treats falsy billingStartDay as 1', () => {
        // March 10, billingStartDay 0 → defaults to day 1 → March 1
        const now = new Date(2026, 2, 10, 8, 0, 0);
        const start = getCurrentCycleStart(0, now);
        expect(start).toEqual(new Date(2026, 2, 1));
    });

    it('preserves short-month behavior: billingStartDay 31 in February rolls into March', () => {
        // Feb 10, billingStartDay 31. now.getDate() (10) < 31 → cycle starts in January 31.
        // Captures the existing usage/page.tsx behavior — no special clamping.
        const now = new Date(2026, 1, 10, 8, 0, 0);
        const start = getCurrentCycleStart(31, now);
        // new Date(2026, 0, 31) — January 31, 2026
        expect(start).toEqual(new Date(2026, 0, 31));
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/billing-cycle.test.ts`
Expected: FAIL — module `./billing-cycle` not found.

- [ ] **Step 3: Write minimal implementation**

Create `cmd/next-app/src/lib/billing-cycle.ts`:

```typescript
/**
 * Returns the start of the current billing cycle for a site, given the
 * configured day-of-month the cycle resets and the current time.
 *
 * Behavior is preserved verbatim from the inline logic that previously lived
 * in src/app/site/[id]/usage/page.tsx so existing bills continue to render
 * the same period.
 */
export function getCurrentCycleStart(billingStartDay: number, now: Date): Date {
    const day = billingStartDay || 1;
    let startMonth = now.getMonth();
    const startYear = now.getFullYear();

    if (now.getDate() < day) {
        startMonth--;
    }
    return new Date(startYear, startMonth, day);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/lib/billing-cycle.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/billing-cycle.ts cmd/next-app/src/lib/billing-cycle.test.ts
git commit -m "feat: extract getCurrentCycleStart helper from usage/page"
```

---

### Task 2: Update usage/page.tsx to use the shared helper

**Files:**
- Modify: `cmd/next-app/src/app/site/[id]/usage/page.tsx:67-79`

- [ ] **Step 1: Run existing test suite to capture baseline**

Run: `cd cmd/next-app && npm test`
Expected: Existing suite passes (note any pre-existing failures so they're not blamed on this change).

- [ ] **Step 2: Replace the inline default-cycle logic**

In `cmd/next-app/src/app/site/[id]/usage/page.tsx`, find the `else` branch around lines 67-79 (the "Default to Current Billing Cycle" block) and replace it.

Add this import near the other `@/lib` imports at the top of the file:

```typescript
import { getCurrentCycleStart } from '@/lib/billing-cycle';
```

Replace the block:

```typescript
    } else {
        // Default to Current Billing Cycle
        const now = new Date();
        const billingDay = site.billing_start_day || 1;
        let startMonth = now.getMonth();
        const startYear = now.getFullYear();

        if (now.getDate() < billingDay) {
            startMonth--;
        }
        start = new Date(startYear, startMonth, billingDay);
        end = new Date(start.getFullYear(), start.getMonth() + 1, start.getDate());
    }
```

with:

```typescript
    } else {
        // Default to Current Billing Cycle
        const now = new Date();
        start = getCurrentCycleStart(site.billing_start_day, now);
        end = new Date(start.getFullYear(), start.getMonth() + 1, start.getDate());
    }
```

- [ ] **Step 3: Run lint and full test suite**

Run: `cd cmd/next-app && npm run lint && npm test`
Expected: Both pass — behavior unchanged.

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/src/app/site/[id]/usage/page.tsx
git commit -m "refactor: use getCurrentCycleStart in usage page"
```

---

### Task 3: Marginal cost pure function (test-first)

**Files:**
- Create: `cmd/next-app/src/lib/marginal-cost.ts`
- Create: `cmd/next-app/src/lib/marginal-cost.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/marginal-cost.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { computeMarginalCost } from './marginal-cost';
import type { UsageData } from './energy-repo';

function fixture(overrides: Partial<UsageData>): UsageData {
    return {
        start: new Date(2026, 2, 1),
        homeUsage: 0,
        gridUsage: 0,
        solarProduction: 0,
        batteryChange: 0,
        // Tariff is required by the type but unused by computeMarginalCost.
        // Cast through unknown to avoid pulling in db types here.
        tariff: { id: 1, site_id: 's', updated: new Date(), name: 'On-Peak' } as unknown as UsageData['tariff'],
        buyRate: 0.30,
        sellRate: 0.03,
        ...overrides
    };
}

describe('computeMarginalCost', () => {
    it('returns sell basis when cycle is net exporting (gridUsage negative = export)', () => {
        // gridUsage = -290000 → wattsToKilowatts → -290 kWh → cycleNetExportKwh = +290 kWh
        const result = computeMarginalCost(fixture({ gridUsage: -290_000 }));
        expect(result.basis).toBe('sell');
        expect(result.marginalCost).toBeCloseTo(0.03);
        expect(result.cycleNetExportKwh).toBeCloseTo(290);
    });

    it('returns buy basis when cycle is net importing (gridUsage positive = import)', () => {
        // gridUsage = 95000 → wattsToKilowatts → 95 kWh → cycleNetExportKwh = -95 kWh
        const result = computeMarginalCost(fixture({ gridUsage: 95_000 }));
        expect(result.basis).toBe('buy');
        expect(result.marginalCost).toBeCloseTo(0.30);
        expect(result.cycleNetExportKwh).toBeCloseTo(-95);
    });

    it('returns neutral within epsilon of zero', () => {
        // gridUsage = 100 → 0.1 kWh → |0.1| < 0.5 (default epsilon) → neutral
        const result = computeMarginalCost(fixture({ gridUsage: 100 }));
        expect(result.basis).toBe('neutral');
        expect(result.marginalCost).toBeNull();
    });

    it('treats |cycleNetExport| exactly equal to epsilon as non-neutral', () => {
        // gridUsage = -500 → exactly -0.5 kWh → cycleNetExport = +0.5; |0.5| < 0.5 is false → sell
        const result = computeMarginalCost(fixture({ gridUsage: -500 }), 0.5);
        expect(result.basis).toBe('sell');
    });

    it('treats |cycleNetExport| just below epsilon as neutral', () => {
        // gridUsage = -499 → -0.499 kWh → cycleNetExport = +0.499 < 0.5 → neutral
        const result = computeMarginalCost(fixture({ gridUsage: -499 }), 0.5);
        expect(result.basis).toBe('neutral');
    });

    it('falls back to 0 for missing rates', () => {
        const result = computeMarginalCost(fixture({ gridUsage: -100_000, sellRate: undefined }));
        expect(result.basis).toBe('sell');
        expect(result.marginalCost).toBe(0);
    });

    it('honors a custom epsilon', () => {
        // gridUsage = -2000 → -2 kWh → cycleNetExport = +2; with epsilon=5 → neutral
        const result = computeMarginalCost(fixture({ gridUsage: -2_000 }), 5);
        expect(result.basis).toBe('neutral');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/marginal-cost.test.ts`
Expected: FAIL — module `./marginal-cost` not found.

- [ ] **Step 3: Write minimal implementation**

Create `cmd/next-app/src/lib/marginal-cost.ts`:

```typescript
import type { UsageData } from './energy-repo';
import { wattsToKilowatts } from './energy-utils';

export type MarginalCostBasis = 'sell' | 'buy' | 'neutral';

export interface MarginalCostResult {
    cycleNetExportKwh: number;
    marginalCost: number | null;
    basis: MarginalCostBasis;
}

const DEFAULT_EPSILON_KWH = 0.5;

export function computeMarginalCost(
    usage: UsageData,
    epsilonKwh: number = DEFAULT_EPSILON_KWH
): MarginalCostResult {
    // UsageData.gridUsage is positive when importing, negative when exporting
    // (see EnergyRepo cost calc). Negate to get an export-positive value.
    const cycleNetExportKwh = -wattsToKilowatts(usage.gridUsage);
    const buyRate = usage.buyRate ?? 0;
    const sellRate = usage.sellRate ?? 0;

    if (Math.abs(cycleNetExportKwh) < epsilonKwh) {
        return { cycleNetExportKwh, marginalCost: null, basis: 'neutral' };
    }
    if (cycleNetExportKwh > 0) {
        return { cycleNetExportKwh, marginalCost: sellRate, basis: 'sell' };
    }
    return { cycleNetExportKwh, marginalCost: buyRate, basis: 'buy' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/lib/marginal-cost.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/marginal-cost.ts cmd/next-app/src/lib/marginal-cost.test.ts
git commit -m "feat: add computeMarginalCost helper for load-timing recommendation"
```

---

### Task 4: EnergyRepo.getCycleAndTodayTotals (test-first)

**Files:**
- Modify: `cmd/next-app/src/lib/energy-repo.ts`
- Modify: `cmd/next-app/src/lib/energy-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Open `cmd/next-app/src/lib/energy-repo.test.ts` and append a new `describe` block at the end of the file:

```typescript
describe('EnergyRepo.getCycleAndTodayTotals', () => {
    it('calls getUsageByTOU once for the cycle window and once for today', async () => {
        const repo = new EnergyRepo();
        const cycleResult = [
            { start: new Date(), homeUsage: 100, gridUsage: -50, solarProduction: 200, batteryChange: 0,
              tariff: { id: 1, site_id: 's', updated: new Date(), name: 'On-Peak' }, touName: 'On-Peak',
              buyRate: 0.3, sellRate: 0.03, cost: 0 } as UsageData
        ];
        const todayResult = [
            { start: new Date(), homeUsage: 10, gridUsage: -5, solarProduction: 20, batteryChange: 0,
              tariff: { id: 1, site_id: 's', updated: new Date(), name: 'On-Peak' }, touName: 'On-Peak',
              buyRate: 0.3, sellRate: 0.03, cost: 0 } as UsageData
        ];

        const spy = vi.spyOn(repo, 'getUsageByTOU')
            .mockResolvedValueOnce(cycleResult)
            .mockResolvedValueOnce(todayResult);

        const cycleStart = new Date(2026, 2, 1);
        const todayStart = new Date(2026, 2, 10);
        const end = new Date(2026, 2, 10, 18, 0, 0);

        const result = await repo.getCycleAndTodayTotals('site-1', cycleStart, todayStart, end);

        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy).toHaveBeenNthCalledWith(1, 'site-1', cycleStart, end);
        expect(spy).toHaveBeenNthCalledWith(2, 'site-1', todayStart, end);
        expect(result.cycle).toEqual(cycleResult);
        expect(result.today).toEqual(todayResult);
    });

    it('returns empty arrays when the site has no data', async () => {
        const repo = new EnergyRepo();
        vi.spyOn(repo, 'getUsageByTOU').mockResolvedValue([]);

        const result = await repo.getCycleAndTodayTotals(
            'site-1',
            new Date(2026, 2, 1),
            new Date(2026, 2, 10),
            new Date(2026, 2, 10, 18, 0, 0)
        );

        expect(result.cycle).toEqual([]);
        expect(result.today).toEqual([]);
    });
});
```

If the file doesn't already import `UsageData`, add it to the existing `EnergyRepo` import line:

```typescript
import { EnergyRepo, type UsageData } from './energy-repo';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/energy-repo.test.ts -t "getCycleAndTodayTotals"`
Expected: FAIL — `repo.getCycleAndTodayTotals is not a function`.

- [ ] **Step 3: Add the method to EnergyRepo**

In `cmd/next-app/src/lib/energy-repo.ts`, add this method to the `EnergyRepo` class (place it adjacent to `getUsageByTOU`):

```typescript
    /**
     * Returns both billing-cycle totals and today's totals in a single call,
     * keyed by TOU period name (via getUsageByTOU). Used by the live detail
     * page to compute marginal cost per period and show today's contribution.
     */
    async getCycleAndTodayTotals(
        siteId: string,
        cycleStart: Date,
        todayStart: Date,
        end: Date
    ): Promise<{ cycle: UsageData[]; today: UsageData[] }> {
        const [cycle, today] = await Promise.all([
            this.getUsageByTOU(siteId, cycleStart, end),
            this.getUsageByTOU(siteId, todayStart, end)
        ]);
        return { cycle, today };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cmd/next-app && npm test -- src/lib/energy-repo.test.ts -t "getCycleAndTodayTotals"`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/energy-repo.ts cmd/next-app/src/lib/energy-repo.test.ts
git commit -m "feat: add EnergyRepo.getCycleAndTodayTotals"
```

---

### Task 5: PeriodCard display logic (test-first)

**Files:**
- Create: `cmd/next-app/src/lib/period-card-display.ts`
- Create: `cmd/next-app/src/lib/period-card-display.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/period-card-display.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { getPeriodCardDisplay } from './period-card-display';

describe('getPeriodCardDisplay', () => {
    it('formats a sell (surplus) card with up arrow and rounded kWh', () => {
        const d = getPeriodCardDisplay({
            cycleNetExportKwh: 290.4,
            marginalCost: 0.03,
            basis: 'sell',
            isActive: false
        });
        expect(d.costLabel).toBe('$0.030/kWh');
        expect(d.netLabel).toBe('↑ 290 kWh');
        expect(d.colorClass).toContain('green');
        expect(d.ringClass).toBe('');
    });

    it('formats a buy (deficit) card with down arrow', () => {
        const d = getPeriodCardDisplay({
            cycleNetExportKwh: -95.2,
            marginalCost: 0.30,
            basis: 'buy',
            isActive: false
        });
        expect(d.costLabel).toBe('$0.300/kWh');
        expect(d.netLabel).toBe('↓ 95 kWh');
        expect(d.colorClass).toContain('red');
    });

    it('formats a neutral card with em dashes and gray color', () => {
        const d = getPeriodCardDisplay({
            cycleNetExportKwh: 0.1,
            marginalCost: null,
            basis: 'neutral',
            isActive: false
        });
        expect(d.costLabel).toBe('—');
        expect(d.netLabel).toBe('—');
        expect(d.colorClass).toContain('gray');
    });

    it('adds a highlight ring when active', () => {
        const d = getPeriodCardDisplay({
            cycleNetExportKwh: 290,
            marginalCost: 0.03,
            basis: 'sell',
            isActive: true
        });
        expect(d.ringClass).toContain('ring');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/period-card-display.test.ts`
Expected: FAIL — module `./period-card-display` not found.

- [ ] **Step 3: Write minimal implementation**

Create `cmd/next-app/src/lib/period-card-display.ts`:

```typescript
import type { MarginalCostBasis } from './marginal-cost';

export interface PeriodCardDisplayInput {
    cycleNetExportKwh: number;
    marginalCost: number | null;
    basis: MarginalCostBasis;
    isActive: boolean;
}

export interface PeriodCardDisplay {
    costLabel: string;
    netLabel: string;
    colorClass: string;
    ringClass: string;
}

export function getPeriodCardDisplay(input: PeriodCardDisplayInput): PeriodCardDisplay {
    const { cycleNetExportKwh, marginalCost, basis, isActive } = input;

    const costLabel = marginalCost === null ? '—' : `$${marginalCost.toFixed(3)}/kWh`;

    let netLabel: string;
    if (basis === 'neutral') {
        netLabel = '—';
    } else {
        const arrow = cycleNetExportKwh > 0 ? '↑' : '↓';
        netLabel = `${arrow} ${Math.round(Math.abs(cycleNetExportKwh))} kWh`;
    }

    const colorClass =
        basis === 'sell' ? 'text-green-700 dark:text-green-400' :
        basis === 'buy' ? 'text-red-700 dark:text-red-400' :
        'text-gray-500 dark:text-gray-400';

    const ringClass = isActive ? 'ring-2 ring-blue-500' : '';

    return { costLabel, netLabel, colorClass, ringClass };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/lib/period-card-display.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/period-card-display.ts cmd/next-app/src/lib/period-card-display.test.ts
git commit -m "feat: add period-card-display label/color helper"
```

---

### Task 6: PeriodCard component

**Files:**
- Create: `cmd/next-app/src/components/site/live/PeriodCard.tsx`

- [ ] **Step 1: Create the component directory if needed**

```bash
mkdir -p cmd/next-app/src/components/site/live
```

- [ ] **Step 2: Write the component**

Create `cmd/next-app/src/components/site/live/PeriodCard.tsx`:

```tsx
import { formatTouName } from '@/lib/format-utils';
import type { MarginalCostBasis } from '@/lib/marginal-cost';
import { getPeriodCardDisplay } from '@/lib/period-card-display';

export interface PeriodCardProps {
    name: string;
    cycleNetExportKwh: number;
    marginalCost: number | null;
    basis: MarginalCostBasis;
    isActive: boolean;
}

export function PeriodCard({ name, cycleNetExportKwh, marginalCost, basis, isActive }: PeriodCardProps) {
    const { costLabel, netLabel, colorClass, ringClass } = getPeriodCardDisplay({
        cycleNetExportKwh, marginalCost, basis, isActive
    });

    return (
        <div className={`rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800 ${ringClass}`}>
            <p className="text-sm text-gray-500 dark:text-gray-400">{formatTouName(name)}</p>
            <p className={`text-2xl font-semibold ${colorClass}`}>{costLabel}</p>
            <p className={`text-sm ${colorClass}`}>{netLabel}</p>
            {isActive && (
                <p className="mt-1 text-xs uppercase tracking-wide text-blue-600 dark:text-blue-400">Active now</p>
            )}
        </div>
    );
}
```

- [ ] **Step 3: Run lint**

Run: `cd cmd/next-app && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/src/components/site/live/PeriodCard.tsx
git commit -m "feat: add PeriodCard component"
```

---

### Task 7: PeriodCardRow component

**Files:**
- Create: `cmd/next-app/src/components/site/live/PeriodCardRow.tsx`

- [ ] **Step 1: Write the component**

Create `cmd/next-app/src/components/site/live/PeriodCardRow.tsx`:

```tsx
import Link from 'next/link';
import type { UsageData } from '@/lib/energy-repo';
import { computeMarginalCost } from '@/lib/marginal-cost';
import { PeriodCard } from './PeriodCard';

export interface PeriodCardRowProps {
    siteId: string;
    cycle: UsageData[];
    activePeriodName: string | null;
    hasTariff: boolean;
}

export function PeriodCardRow({ siteId, cycle, activePeriodName, hasTariff }: PeriodCardRowProps) {
    if (!hasTariff) {
        return (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-gray-600 dark:border-slate-700 dark:bg-slate-800 dark:text-gray-300">
                Configure a tariff to see load-timing recommendations.{' '}
                <Link href={`/site/${siteId}/settings`} className="underline">Open site settings →</Link>
            </div>
        );
    }

    if (cycle.length === 0) {
        return (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-gray-600 dark:border-slate-700 dark:bg-slate-800 dark:text-gray-300">
                No cycle data yet — recommendations will appear once the site reports usage.
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {cycle.map((usage) => {
                const { cycleNetExportKwh, marginalCost, basis } = computeMarginalCost(usage);
                const name = usage.touName ?? 'Unknown';
                return (
                    <PeriodCard
                        key={`${usage.tariff.id}|${name}`}
                        name={name}
                        cycleNetExportKwh={cycleNetExportKwh}
                        marginalCost={marginalCost}
                        basis={basis}
                        isActive={activePeriodName !== null && name === activePeriodName}
                    />
                );
            })}
        </div>
    );
}
```

- [ ] **Step 2: Run lint**

Run: `cd cmd/next-app && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/components/site/live/PeriodCardRow.tsx
git commit -m "feat: add PeriodCardRow component"
```

---

### Task 8: DailyTotalsRow component

**Files:**
- Create: `cmd/next-app/src/components/site/live/DailyTotalsRow.tsx`

- [ ] **Step 1: Write the component**

Create `cmd/next-app/src/components/site/live/DailyTotalsRow.tsx`:

```tsx
import type { UsageData } from '@/lib/energy-repo';
import { wattsToKilowatts } from '@/lib/energy-utils';

export interface DailyTotalsRowProps {
    today: UsageData[];
}

interface Totals {
    homeKwh: number;
    solarKwh: number;
    importKwh: number;
    exportKwh: number;
}

function summarize(today: UsageData[]): Totals {
    const totals: Totals = { homeKwh: 0, solarKwh: 0, importKwh: 0, exportKwh: 0 };
    for (const u of today) {
        totals.homeKwh += wattsToKilowatts(u.homeUsage);
        totals.solarKwh += wattsToKilowatts(u.solarProduction);
        const gridKwh = wattsToKilowatts(u.gridUsage);
        // gridUsage > 0 means importing; < 0 means exporting.
        if (gridKwh > 0) totals.importKwh += gridKwh;
        else totals.exportKwh += -gridKwh;
    }
    return totals;
}

export function DailyTotalsRow({ today }: DailyTotalsRowProps) {
    const t = summarize(today);
    const fmt = (n: number) => n.toFixed(1);

    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded border-l-4 border-orange-500 bg-orange-50 p-3 dark:bg-slate-800">
                <p className="text-xs text-gray-600 dark:text-gray-400">Today: From grid</p>
                <p className="text-lg font-semibold text-orange-700 dark:text-orange-400">↓ {fmt(t.importKwh)} kWh</p>
            </div>
            <div className="rounded border-l-4 border-orange-300 bg-orange-50 p-3 dark:bg-slate-800">
                <p className="text-xs text-gray-600 dark:text-gray-400">Today: To grid</p>
                <p className="text-lg font-semibold text-orange-700 dark:text-orange-400">↑ {fmt(t.exportKwh)} kWh</p>
            </div>
            <div className="rounded border-l-4 border-amber-500 bg-amber-50 p-3 dark:bg-slate-800">
                <p className="text-xs text-gray-600 dark:text-gray-400">Today: Solar</p>
                <p className="text-lg font-semibold text-amber-700 dark:text-amber-400">{fmt(t.solarKwh)} kWh</p>
            </div>
            <div className="rounded border-l-4 border-blue-500 bg-blue-50 p-3 dark:bg-slate-800">
                <p className="text-xs text-gray-600 dark:text-gray-400">Today: Used</p>
                <p className="text-lg font-semibold text-blue-700 dark:text-blue-400">{fmt(t.homeKwh)} kWh</p>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Run lint**

Run: `cd cmd/next-app && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/components/site/live/DailyTotalsRow.tsx
git commit -m "feat: add DailyTotalsRow component"
```

---

### Task 9: DailyByPeriodTable component

**Files:**
- Create: `cmd/next-app/src/components/site/live/DailyByPeriodTable.tsx`

- [ ] **Step 1: Write the component**

Create `cmd/next-app/src/components/site/live/DailyByPeriodTable.tsx`:

```tsx
import { formatTouName } from '@/lib/format-utils';
import type { UsageData } from '@/lib/energy-repo';
import { wattsToKilowatts } from '@/lib/energy-utils';

export interface DailyByPeriodTableProps {
    today: UsageData[];
}

export function DailyByPeriodTable({ today }: DailyByPeriodTableProps) {
    if (today.length === 0) {
        return (
            <p className="text-sm text-gray-500 dark:text-gray-400">No usage recorded yet today.</p>
        );
    }

    const fmtSigned = (kwh: number) => `${kwh >= 0 ? '+' : '−'}${Math.abs(kwh).toFixed(1)}`;

    return (
        <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
                <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-slate-700 dark:text-gray-400">
                        <th className="py-2 pr-4">Period</th>
                        <th className="py-2 pr-4 text-right">Solar</th>
                        <th className="py-2 pr-4 text-right">Used</th>
                        <th className="py-2 pr-4 text-right">Net export</th>
                    </tr>
                </thead>
                <tbody>
                    {today.map((u) => {
                        const name = u.touName ?? 'Unknown';
                        const solarKwh = wattsToKilowatts(u.solarProduction);
                        const homeKwh = wattsToKilowatts(u.homeUsage);
                        // gridUsage positive = import; net export = -gridUsage.
                        const netExportKwh = -wattsToKilowatts(u.gridUsage);
                        return (
                            <tr key={`${u.tariff.id}|${name}`} className="border-b border-slate-100 dark:border-slate-800">
                                <td className="py-2 pr-4">{formatTouName(name)}</td>
                                <td className="py-2 pr-4 text-right">{solarKwh.toFixed(1)} kWh</td>
                                <td className="py-2 pr-4 text-right">{homeKwh.toFixed(1)} kWh</td>
                                <td className={`py-2 pr-4 text-right ${netExportKwh >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                                    {fmtSigned(netExportKwh)} kWh
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
```

- [ ] **Step 2: Run lint**

Run: `cd cmd/next-app && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/components/site/live/DailyByPeriodTable.tsx
git commit -m "feat: add DailyByPeriodTable component"
```

---

### Task 10: LiveDetailView composition

**Files:**
- Create: `cmd/next-app/src/components/site/live/LiveDetailView.tsx`

- [ ] **Step 1: Write the component**

Create `cmd/next-app/src/components/site/live/LiveDetailView.tsx`:

```tsx
import { SiteLiveStats } from '@/components/SiteLiveStats';
import { SectionCard } from '@/components/ui/SectionCard';
import type { UsageData } from '@/lib/energy-repo';
import { DailyTotalsRow } from './DailyTotalsRow';
import { DailyByPeriodTable } from './DailyByPeriodTable';
import { PeriodCardRow } from './PeriodCardRow';

export interface LiveDetailViewProps {
    siteId: string;
    siteName: string;
    cycle: UsageData[];
    today: UsageData[];
    activePeriodName: string | null;
    hasTariff: boolean;
}

const ZERO_LIVE_STATS = {
    solarPower: 0,
    loadPower: 0,
    batteryPower: 0,
    gridPower: 0,
    percentageCharged: 0,
    currentTariff: 'Loading…'
};

export function LiveDetailView({ siteId, siteName, cycle, today, activePeriodName, hasTariff }: LiveDetailViewProps) {
    return (
        <div className="space-y-6">
            <SectionCard title={`${siteName} — Live`} density="compact">
                {/* SiteLiveStats fetches fresh data on mount and polls every 60s. */}
                <SiteLiveStats siteId={siteId} initialStats={ZERO_LIVE_STATS} />
            </SectionCard>

            <SectionCard title="Today so far" density="compact" bodyClassName="space-y-4">
                <DailyTotalsRow today={today} />
                <DailyByPeriodTable today={today} />
            </SectionCard>

            <SectionCard title="Load timing this cycle" density="compact">
                <PeriodCardRow
                    siteId={siteId}
                    cycle={cycle}
                    activePeriodName={activePeriodName}
                    hasTariff={hasTariff}
                />
            </SectionCard>
        </div>
    );
}
```

- [ ] **Step 2: Run lint**

Run: `cd cmd/next-app && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/components/site/live/LiveDetailView.tsx
git commit -m "feat: add LiveDetailView composition"
```

---

### Task 11: /site/[id]/live page route

**Files:**
- Create: `cmd/next-app/src/app/site/[id]/live/page.tsx`

- [ ] **Step 1: Write the page**

Create `cmd/next-app/src/app/site/[id]/live/page.tsx`:

```tsx
import Link from 'next/link';
import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { Schedule } from '@/lib/schedule';
import { verifySiteAccess } from '@/lib/auth-checks';
import { getCurrentCycleStart } from '@/lib/billing-cycle';
import { LiveDetailView } from '@/components/site/live/LiveDetailView';
import { PageBreadcrumbs } from '@/components/PageBreadcrumbs';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';

export const dynamic = 'force-dynamic';

export default async function SiteLivePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const hasAccess = await verifySiteAccess(id);
    if (!hasAccess) {
        return (
            <PageShell maxWidth="xl" className="flex items-center justify-center">
                <SectionCard className="w-full" title="Unauthorized" description="You do not have permission to view this site.">
                    <div className="space-y-4">
                        <Alert variant="danger">
                            <AlertTitle>Access denied</AlertTitle>
                            <AlertDescription>Your account is not authorized for this site.</AlertDescription>
                        </Alert>
                        <Link href="/products"><Button variant="outline">Return to My Products</Button></Link>
                    </div>
                </SectionCard>
            </PageShell>
        );
    }

    const siteRepo = new SiteRepo();
    const repo = new EnergyRepo();
    const site = await siteRepo.getSite(id);

    if (!site) {
        return (
            <PageShell maxWidth="xl">
                <SectionCard title="Site not found"><p className="text-sm">No site exists for the given id.</p></SectionCard>
            </PageShell>
        );
    }

    const now = new Date();
    const cycleStart = getCurrentCycleStart(site.billing_start_day, now);
    const todayStart = EnergyRepo.getSiteMidnight(now, site.timezone);

    const hasTariff = (site.tariffs?.length ?? 0) > 0;
    let activePeriodName: string | null = null;
    if (hasTariff) {
        const schedule = new Schedule(site.tariffs, site.timezone);
        const tp = schedule.getTariffPeriod(now);
        if (tp) {
            activePeriodName = tp.schedule.name ?? null;
        } else {
            console.warn(`[SiteLivePage] Schedule.getTariffPeriod returned null for site ${id} at ${now.toISOString()}`);
        }
    }

    const { cycle, today } = await repo.getCycleAndTodayTotals(id, cycleStart, todayStart, now);

    return (
        <PageShell maxWidth="2xl" padding="none" className="px-4 py-4 md:px-8 md:pt-2 md:pb-6 lg:px-24 lg:pt-2 lg:pb-6">
            <div className="space-y-6">
                <PageBreadcrumbs items={[{ label: site.name, href: `/site/${id}` }, { label: 'Live' }]} />
                <PageHeader title="Live detail" density="compact" />
                <LiveDetailView
                    siteId={id}
                    siteName={site.name}
                    cycle={cycle}
                    today={today}
                    activePeriodName={activePeriodName}
                    hasTariff={hasTariff}
                />
            </div>
        </PageShell>
    );
}
```

- [ ] **Step 2: Run lint and build**

Run: `cd cmd/next-app && npm run lint && npm run build`
Expected: Both pass.

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/app/site/[id]/live/page.tsx
git commit -m "feat: add /site/[id]/live page route"
```

---

### Task 12: Retarget DashboardCards live tile

**Files:**
- Modify: `cmd/next-app/src/components/DashboardCards.tsx:162`

- [ ] **Step 1: Update the Link target**

In `cmd/next-app/src/components/DashboardCards.tsx`, locate the `<Link>` around line 160-164:

```tsx
                        <Link
                            key={product.id}
                            href={`/site/${product.energy_site_id}`}
                            className="block"
                        >
```

Change `href` to:

```tsx
                            href={`/site/${product.energy_site_id}/live`}
```

- [ ] **Step 2: Run lint and tests**

Run: `cd cmd/next-app && npm run lint && npm test`
Expected: Both pass.

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/components/DashboardCards.tsx
git commit -m "feat: retarget dashboard live tile to /site/[id]/live"
```

---

### Task 13: Manual verification & final build

- [ ] **Step 1: Start the dev server (agent port)**

Per CLAUDE.md, agents use port 5174 to avoid colliding with the user's dev server.

Run: `cd cmd/next-app && npm run dev:agent`
Expected: Server starts on http://localhost:5174.

- [ ] **Step 2: Navigate through the flow**

Open http://localhost:5174 in a browser. Sign in if needed. From the dashboard:

1. Tap a site's live tile → should land at `/site/<id>/live`.
2. Verify the page renders three sections: live stats (top, polling), today's totals + per-period table, period cards.
3. Verify the active period card has a blue ring.
4. Verify period cards show colored marginal cost and signed kWh net.
5. Verify the "Today so far" totals look reasonable for current data.

- [ ] **Step 3: Verify edge cases**

Use a site without a configured tariff (or temporarily comment out `site.tariffs` resolution) → period card row should show the "Configure a tariff…" callout.

If no test site is available without a tariff, mark this verified by inspecting the conditional in `PeriodCardRow.tsx`.

- [ ] **Step 4: Final lint and build**

Run: `cd cmd/next-app && npm run lint && npm run build`
Expected: Both pass.

- [ ] **Step 5: Stop the dev server**

Stop the `npm run dev:agent` process.

- [ ] **Step 6: Final commit (only if any tweaks were needed during verification)**

```bash
git status
# If there are uncommitted tweaks from verification, commit them with a message describing the fix.
```

---

## Self-review checklist (run at end of execution)

- [ ] Spec section "Recommendation Logic" → covered by Tasks 3 and 7.
- [ ] Spec section "New route" → covered by Tasks 11 and 12.
- [ ] Spec section "New shared helpers" → `billing-cycle.ts` (Task 1) and `marginal-cost.ts` (Task 3).
- [ ] Spec section "New repo method" → covered by Task 4.
- [ ] Spec section "New components" → Tasks 6-10.
- [ ] Spec section "Reused" → `SiteLiveStats` integrated in Task 10.
- [ ] Spec section "Data Flow" → page implementation in Task 11.
- [ ] Spec section "Error Handling" → no-tariff callout (Task 7), no-cycle-data callout (Task 7), schedule null warning (Task 11).
- [ ] Spec section "Testing" → unit tests in Tasks 1, 3, 4, 5; component test deviation documented at top of plan.
- [ ] All `getCurrentCycleStart` callers updated (Task 2).
- [ ] No new code paths bypass `verifySiteAccess` (Task 11 wires it in).
