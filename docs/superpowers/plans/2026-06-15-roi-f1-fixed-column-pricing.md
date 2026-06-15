# ROI F1 — Fixed Comparison Column Per-Period Pricing — Implementation Plan

> **⚠️ SUPERSEDED (2026-06-15) — do not execute.** Folded into the Flexible Plan Comparison Matrix design (`docs/superpowers/specs/2026-06-15-flexible-comparison-matrix-design.md`). This plan reads `EnergyRollup`, which that design retires in favor of the hourly-profile pricing engine. The date-resolution *timeline* concept here carries forward, but the data source changes — implement it via the engine in Phase C, not standalone. Kept for reference only.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price the savings-matrix Fixed column (cells A/C/E) at the fixed comparison rate in effect on each rollup row's date, instead of a single current rate applied to all history.

**Architecture:** Introduce one cohesive, testable unit — a `FixedBaseline` timeline (`rateOn(localDate)`) built from a comparison plan's dated versions. The fold (`computeMatrixTotals` / `monthlyCumulative`) asks the baseline per row instead of holding a scalar. The single-rate behavior becomes the degenerate one-version timeline (`flatBaseline`). Pure read-side arithmetic — the rollup stores rate-agnostic energies, so **no re-rollup, no schema change, no migration**.

**Tech Stack:** Next.js (App Router), TypeScript, Vitest (pure-logic tests import functions directly; no DB), Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-15-roi-f1-fixed-column-pricing-design.md`. Follow-ons F2 / historical-metered-entry / 2b are out of scope.

**Conventions to mirror:**
- Pure-logic ROI tests import the function directly and use a `rolllup(over)` row factory (see `src/lib/roi/roi-service.test.ts`).
- ISO `YYYY-MM-DD` strings compare correctly with `<` / `<=` — no `Date` parsing needed for ordering.
- Run a single test file: `npm test -- src/lib/roi/fixed-baseline-timeline` (Vitest path filter). All commands run from `cmd/next-app`.

---

## File Structure

**Create:**
- `cmd/next-app/src/lib/roi/fixed-baseline-timeline.ts` — `FixedBaseline` interface + `buildFixedBaseline` (date-resolved) + `flatBaseline` (degenerate single-rate).
- `cmd/next-app/src/lib/roi/fixed-baseline-timeline.test.ts`

**Modify:**
- `cmd/next-app/src/lib/roi/roi-service.ts` — `computeMatrixTotals` / `monthlyCumulative` / `buildRoiSummary` accept `FixedBaseline`; resolve rate per row.
- `cmd/next-app/src/lib/roi/roi-service.test.ts` — wrap scalar inputs in `flatBaseline`; add a date-resolved fold test.
- `cmd/next-app/src/lib/roi/resolve-fixed-baseline.ts` — replace `pickCurrentFixedBaseline` with `resolveFixedBaselineTimeline`.
- `cmd/next-app/src/lib/roi/resolve-fixed-baseline.test.ts` — update for the new API.
- `cmd/next-app/src/app/site/[id]/page.tsx:312` — swap `pickCurrentFixedBaseline` → `resolveFixedBaselineTimeline`.
- `cmd/next-app/src/components/site/ComparisonTariffEditor.tsx:53-57` — remove the "not yet applied" note; add the honest per-period line.

---

## Task 1: `FixedBaseline` timeline unit

**Files:**
- Create: `cmd/next-app/src/lib/roi/fixed-baseline-timeline.ts`
- Test: `cmd/next-app/src/lib/roi/fixed-baseline-timeline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/roi/fixed-baseline-timeline.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildFixedBaseline, flatBaseline } from './fixed-baseline-timeline';
import type { ComparisonVersion } from './comparison-tariff-repo';

const v = (over: Partial<ComparisonVersion>): ComparisonVersion => ({
    version: 1, is_current: false, effective_from: null, buy_rate: 0.1, sell_rate: 0.05, ...over,
});

describe('buildFixedBaseline.rateOn', () => {
    const versions = [
        v({ version: 2, is_current: true, effective_from: '2025-06-01', buy_rate: 0.19342, sell_rate: 0.08 }),
        v({ version: 1, effective_from: '2023-01-01', buy_rate: 0.16580, sell_rate: 0.08 }),
    ];

    it('uses the version covering the date (between two versions)', () => {
        const b = buildFixedBaseline(versions);
        expect(b.rateOn('2024-03-15')).toEqual({ fixedBuyRate: 0.16580, fixedSellRate: 0.08 });
        expect(b.rateOn('2025-12-31')).toEqual({ fixedBuyRate: 0.19342, fixedSellRate: 0.08 });
    });

    it('is inclusive on the effective_from boundary', () => {
        expect(buildFixedBaseline(versions).rateOn('2025-06-01'))
            .toEqual({ fixedBuyRate: 0.19342, fixedSellRate: 0.08 });
    });

    it('carries the earliest rate backward before the first effective_from', () => {
        expect(buildFixedBaseline(versions).rateOn('2020-01-01'))
            .toEqual({ fixedBuyRate: 0.16580, fixedSellRate: 0.08 });
    });

    it('carries the latest rate forward after the last effective_from', () => {
        expect(buildFixedBaseline(versions).rateOn('2030-01-01'))
            .toEqual({ fixedBuyRate: 0.19342, fixedSellRate: 0.08 });
    });

    it('treats an undated (null) version as the catch-all earliest', () => {
        const withNull = [
            v({ version: 2, is_current: true, effective_from: '2024-01-01', buy_rate: 0.20, sell_rate: 0.05 }),
            v({ version: 1, effective_from: null, buy_rate: 0.15, sell_rate: 0.05 }),
        ];
        const b = buildFixedBaseline(withNull);
        expect(b.rateOn('2020-01-01')).toEqual({ fixedBuyRate: 0.15, fixedSellRate: 0.05 });
        expect(b.rateOn('2024-06-01')).toEqual({ fixedBuyRate: 0.20, fixedSellRate: 0.05 });
    });

    it('returns the one rate for any date when there is a single version', () => {
        const b = buildFixedBaseline([v({ effective_from: '2025-01-01', buy_rate: 0.21, sell_rate: 0.06 })]);
        expect(b.rateOn('2000-01-01')).toEqual({ fixedBuyRate: 0.21, fixedSellRate: 0.06 });
        expect(b.rateOn('2099-01-01')).toEqual({ fixedBuyRate: 0.21, fixedSellRate: 0.06 });
    });
});

describe('flatBaseline', () => {
    it('returns the same rate for any date', () => {
        const b = flatBaseline({ fixedBuyRate: 0.2, fixedSellRate: 0.05 });
        expect(b.rateOn('1999-01-01')).toEqual({ fixedBuyRate: 0.2, fixedSellRate: 0.05 });
        expect(b.rateOn('2099-01-01')).toEqual({ fixedBuyRate: 0.2, fixedSellRate: 0.05 });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/fixed-baseline-timeline`
Expected: FAIL — `buildFixedBaseline` / `flatBaseline` not defined.

- [ ] **Step 3: Implement the unit**

Create `src/lib/roi/fixed-baseline-timeline.ts`:

```ts
import type { RoiInputs } from './roi-service';
import type { ComparisonVersion } from './comparison-tariff-repo';

export interface FixedBaseline {
    /** The fixed buy/sell rate in effect on the given 'YYYY-MM-DD' local date. */
    rateOn(localDate: string): RoiInputs;
}

/** Degenerate single-rate baseline: rateOn returns the same rate for any date. */
export function flatBaseline(inputs: RoiInputs): FixedBaseline {
    return { rateOn: () => inputs };
}

/** Build a date-resolved baseline from a comparison plan's versions.
 *  - Versions are sorted ascending by effective_from; an undated (null) version
 *    sorts earliest (catch-all "since the beginning").
 *  - rateOn picks the latest version whose effective_from <= localDate.
 *  - Before the earliest version: carry the earliest rate backward.
 *  - After the latest version: carry the latest rate forward (projection-safe). */
export function buildFixedBaseline(versions: ComparisonVersion[]): FixedBaseline {
    // Ascending by effective_from; null is treated as the lowest key.
    const key = (v: ComparisonVersion) => v.effective_from ?? '';
    const sorted = [...versions].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

    const ratesOf = (v: ComparisonVersion): RoiInputs => ({ fixedBuyRate: v.buy_rate, fixedSellRate: v.sell_rate });

    return {
        rateOn(localDate: string): RoiInputs {
            let chosen = sorted[0];
            for (const v of sorted) {
                if ((v.effective_from ?? '') <= localDate) chosen = v;
                else break;
            }
            return ratesOf(chosen);
        },
    };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/fixed-baseline-timeline`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/fixed-baseline-timeline.ts cmd/next-app/src/lib/roi/fixed-baseline-timeline.test.ts
git commit -m "feat(roi): FixedBaseline timeline — date-resolved fixed comparison rate"
```

---

## Task 2: Fold resolves the fixed rate per row

`computeMatrixTotals`, `monthlyCumulative`, and `buildRoiSummary` change their `inputs: RoiInputs` parameter to `baseline: FixedBaseline` and call `baseline.rateOn(r.local_date)` inside the row loop. `RoiInputs` stays exported (it's the `rateOn` return type and the `flatBaseline` input).

**Files:**
- Modify: `cmd/next-app/src/lib/roi/roi-service.ts`
- Test: `cmd/next-app/src/lib/roi/roi-service.test.ts`

- [ ] **Step 1: Update existing tests to wrap scalars in `flatBaseline`, and add a date-resolved fold test**

In `src/lib/roi/roi-service.test.ts`:

Add `flatBaseline` / `buildFixedBaseline` imports below the existing import block (after line 9):

```ts
import { flatBaseline, buildFixedBaseline } from './fixed-baseline-timeline';
```

Change the shared scalar constant (line 22) from:

```ts
const inputs: RoiInputs = { fixedBuyRate: 0.20, fixedSellRate: 0.05 };
```

to:

```ts
const inputs = flatBaseline({ fixedBuyRate: 0.20, fixedSellRate: 0.05 });
```

Change the inline scalar in the `monthlyCumulative` test (line 81) from:

```ts
        const series = monthlyCumulative(rows, { fixedBuyRate: 0.20, fixedSellRate: 0.05 });
```

to:

```ts
        const series = monthlyCumulative(rows, flatBaseline({ fixedBuyRate: 0.20, fixedSellRate: 0.05 }));
```

Then append a new describe block at the end of the file:

```ts
describe('computeMatrixTotals with a date-resolved baseline', () => {
    it('prices each row at the fixed rate in effect on its date', () => {
        const baseline = buildFixedBaseline([
            { version: 2, is_current: true, effective_from: '2025-01-01', buy_rate: 0.30, sell_rate: 0.05 },
            { version: 1, is_current: false, effective_from: '2024-01-01', buy_rate: 0.10, sell_rate: 0.05 },
        ]);
        const rows = [
            rolllup({ local_date: '2024-06-01', load_wh: 10000 }), // → 0.10
            rolllup({ local_date: '2025-06-01', load_wh: 10000 }), // → 0.30
        ];
        const m = computeMatrixTotals(rows, baseline);
        // A = 10 kWh × 0.10 + 10 kWh × 0.30
        expect(m.A).toBeCloseTo(10 * 0.10 + 10 * 0.30, 6);
    });

    it('matches the flat baseline when all rows fall in one version window', () => {
        const rows = [
            rolllup({ local_date: '2025-03-01', load_wh: 10000, solar_only_import_wh: 4000, solar_only_export_wh: 1000 }),
            rolllup({ local_date: '2025-04-01', load_wh: 8000, solar_only_import_wh: 3000, solar_only_export_wh: 500 }),
        ];
        const flat = computeMatrixTotals(rows, flatBaseline({ fixedBuyRate: 0.30, fixedSellRate: 0.05 }));
        const timeline = computeMatrixTotals(rows, buildFixedBaseline([
            { version: 1, is_current: true, effective_from: '2024-01-01', buy_rate: 0.30, sell_rate: 0.05 },
        ]));
        expect(timeline).toEqual(flat);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/roi-service`
Expected: FAIL — `computeMatrixTotals`/`monthlyCumulative` still type/treat the arg as a scalar (`baseline.rateOn` not a function), and `flatBaseline` import resolves but the fold doesn't call it.

- [ ] **Step 3: Change the fold to resolve per row**

In `src/lib/roi/roi-service.ts`:

Add the import at the top (after the existing `EnergyRollupRow` import, line 2):

```ts
import type { FixedBaseline } from './fixed-baseline-timeline';
```

Change `computeMatrixTotals` (lines 21-47). Replace its signature and the rate reads:

```ts
/** Sum the six scenario-matrix bills across rollup rows. Costs in dollars.
 *  The Fixed column (A/C/E) is priced per row at the fixed rate in effect on
 *  that row's date; the metered columns (B/D/F) use the row's snapshotted rate. */
export function computeMatrixTotals(rows: EnergyRollupRow[], baseline: FixedBaseline): MatrixTotals {
    let A = 0, B = 0, C = 0, D = 0, E = 0, F = 0;
    for (const r of rows) {
        const load = Number(r.load_wh) / WH_PER_KWH;
        const soImp = Number(r.solar_only_import_wh) / WH_PER_KWH;
        const soExp = Number(r.solar_only_export_wh) / WH_PER_KWH;
        const actImp = (Number(r.grid_to_home_wh) + Number(r.grid_to_battery_wh)) / WH_PER_KWH;
        const actExp = (Number(r.solar_to_grid_wh) + Number(r.battery_to_grid_wh)) / WH_PER_KWH;
        const buy = Number(r.buy_rate);
        const sell = Number(r.sell_rate);
        const { fixedBuyRate, fixedSellRate } = baseline.rateOn(r.local_date);

        A += load * fixedBuyRate;
        B += load * buy;
        C += soImp * fixedBuyRate - soExp * fixedSellRate;
        D += soImp * buy - soExp * sell;
        E += actImp * fixedBuyRate - actExp * fixedSellRate;
        F += actImp * buy - actExp * sell;
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

Change `buildRoiSummary`'s second parameter (line 91) from `inputs: RoiInputs,` to `baseline: FixedBaseline,` and its first internal call (line 96) from `computeMatrixTotals(rows, inputs)` to `computeMatrixTotals(rows, baseline)`.

Change `monthlyCumulative` (line 120) signature from `inputs: RoiInputs` to `baseline: FixedBaseline`, and its internal call (line 129) from `computeMatrixTotals(byMonth.get(month)!, inputs)` to `computeMatrixTotals(byMonth.get(month)!, baseline)`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/roi-service`
Expected: PASS (existing cases + the two new ones).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/roi-service.ts cmd/next-app/src/lib/roi/roi-service.test.ts
git commit -m "feat(roi): fold prices the Fixed column per row via FixedBaseline"
```

---

## Task 3: `resolveFixedBaselineTimeline` — select plan, build timeline

Replace the scalar `pickCurrentFixedBaseline` with `resolveFixedBaselineTimeline`, which selects one plan (existing tiebreak: the plan whose current version has the most-recent `effective_from`) and builds a `FixedBaseline` from **all** that plan's versions.

**Files:**
- Modify: `cmd/next-app/src/lib/roi/resolve-fixed-baseline.ts`
- Test: `cmd/next-app/src/lib/roi/resolve-fixed-baseline.test.ts`

- [ ] **Step 1: Rewrite the test for the new API**

Replace the entire contents of `src/lib/roi/resolve-fixed-baseline.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveFixedBaselineTimeline } from './resolve-fixed-baseline';
import type { ComparisonPlan } from './comparison-tariff-repo';

describe('resolveFixedBaselineTimeline', () => {
    it('builds a date-resolved timeline from all versions of the selected plan', () => {
        const plans: ComparisonPlan[] = [{
            name: 'PG&E flat',
            versions: [
                { version: 2, is_current: true, effective_from: '2025-01-01', buy_rate: 0.19342, sell_rate: 0.08 },
                { version: 1, is_current: false, effective_from: '2023-01-01', buy_rate: 0.16580, sell_rate: 0.08 },
            ],
        }];
        const baseline = resolveFixedBaselineTimeline(plans)!;
        expect(baseline.rateOn('2024-06-01')).toEqual({ fixedBuyRate: 0.16580, fixedSellRate: 0.08 });
        expect(baseline.rateOn('2025-06-01')).toEqual({ fixedBuyRate: 0.19342, fixedSellRate: 0.08 });
    });

    it('selects the plan whose current version has the most-recent effective_from', () => {
        const plans: ComparisonPlan[] = [
            { name: 'Old', versions: [{ version: 1, is_current: true, effective_from: '2022-01-01', buy_rate: 0.10, sell_rate: 0.05 }] },
            { name: 'New', versions: [{ version: 1, is_current: true, effective_from: '2025-01-01', buy_rate: 0.30, sell_rate: 0.05 }] },
        ];
        const baseline = resolveFixedBaselineTimeline(plans)!;
        expect(baseline.rateOn('2026-01-01')).toEqual({ fixedBuyRate: 0.30, fixedSellRate: 0.05 });
    });

    it('returns null when there is no comparison plan', () => {
        expect(resolveFixedBaselineTimeline([])).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/resolve-fixed-baseline`
Expected: FAIL — `resolveFixedBaselineTimeline` not defined.

- [ ] **Step 3: Rewrite the resolver**

Replace the entire contents of `src/lib/roi/resolve-fixed-baseline.ts`:

```ts
import { ComparisonTariffRepo, type ComparisonPlan } from './comparison-tariff-repo';
import { buildFixedBaseline, type FixedBaseline } from './fixed-baseline-timeline';

/** Pick the active Fixed comparison plan: the plan whose current version has the
 *  most-recent effective_from. Multiple distinctly-named plans are NOT merged —
 *  one plan is selected and its full version history forms the timeline. */
export function selectFixedComparisonPlan(plans: ComparisonPlan[]): ComparisonPlan | null {
    let best: { eff: string; plan: ComparisonPlan } | null = null;
    for (const plan of plans) {
        const current = plan.versions.find(v => v.is_current);
        if (!current) continue;
        const eff = current.effective_from ?? '0000-01-01';
        if (!best || eff > best.eff) best = { eff, plan };
    }
    return best?.plan ?? null;
}

/** Pure: build a date-resolved FixedBaseline from the selected plan's versions. */
export function resolveFixedBaselineTimeline(plans: ComparisonPlan[]): FixedBaseline | null {
    const plan = selectFixedComparisonPlan(plans);
    return plan ? buildFixedBaseline(plan.versions) : null;
}

export async function resolveFixedBaseline(siteId: string): Promise<FixedBaseline | null> {
    const plans = await new ComparisonTariffRepo().listFixedComparisons(siteId);
    return resolveFixedBaselineTimeline(plans);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/resolve-fixed-baseline`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/resolve-fixed-baseline.ts cmd/next-app/src/lib/roi/resolve-fixed-baseline.test.ts
git commit -m "feat(roi): resolveFixedBaselineTimeline builds timeline from plan versions"
```

---

## Task 4: Read-side swap in `page.tsx`

**Files:**
- Modify: `cmd/next-app/src/app/site/[id]/page.tsx`

- [ ] **Step 1: Update the import**

Change line 36 from:

```ts
import { pickCurrentFixedBaseline } from '@/lib/roi/resolve-fixed-baseline';
```

to:

```ts
import { resolveFixedBaselineTimeline } from '@/lib/roi/resolve-fixed-baseline';
```

- [ ] **Step 2: Swap the call**

Change line 312 from:

```ts
    const fixedBaseline = pickCurrentFixedBaseline(comparisonPlans);
```

to:

```ts
    const fixedBaseline = resolveFixedBaselineTimeline(comparisonPlans);
```

Everything downstream is unchanged: `fixedBaseline` is still truthy-gated, and `configInputs = fixedBaseline` is now a `FixedBaseline` passed straight into `buildRoiSummary` and `monthlyCumulative` (both updated in Task 2). The local name `configInputs` (lines 317, 326) may stay as-is.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: build succeeds. Sites without a comparison plan still get `fixedBaseline === null` → existing empty state.

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/src/app/site/\[id\]/page.tsx
git commit -m "feat(roi): price Fixed column from the date-resolved baseline timeline"
```

---

## Task 5: Replace the "not yet applied" note in the editor

The foundation showed an amber "captured for ordering only — not yet priced" note when a plan had >1 version. That is now false; replace it with an honest per-period statement.

**Files:**
- Modify: `cmd/next-app/src/components/site/ComparisonTariffEditor.tsx`

- [ ] **Step 1: Replace the note**

In `ComparisonTariffEditor.tsx`, replace the block (lines 53-57):

```tsx
                        {plan.versions.length > 1 && (
                            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                                Past rates are captured for ordering only — savings still use the current rate. Date-based pricing arrives in a later update.
                            </p>
                        )}
```

with:

```tsx
                        {plan.versions.length > 1 && (
                            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                                Each period is priced at the rate in effect on its date.
                            </p>
                        )}
```

- [ ] **Step 2: Verify build + lint**

Run: `npm run build && npm run lint`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/components/site/ComparisonTariffEditor.tsx
git commit -m "feat(roi): editor states Fixed plans are now priced per period"
```

---

## Task 6: Final verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all pass — including the new `fixed-baseline-timeline` tests and the updated `roi-service` / `resolve-fixed-baseline` tests.

- [ ] **Step 2: Build + lint**

Run: `npm run build && npm run lint`
Expected: both pass.

- [ ] **Step 3: Manual smoke (optional, dev server)**

Run: `npm run dev:agent` (port 5174). On the Savings tab of a site with a Fixed comparison plan that has two dated rates and ROI costs configured: confirm the matrix renders, the editor shows "Each period is priced at the rate in effect on its date" under the multi-version plan, and (sanity) the Fixed column totals shift versus the old single-rate behavior when history spans both rate windows.

- [ ] **Step 4: Commit any final fixups**

```bash
git add -A && git commit -m "test(roi): F1 fixed-column per-period pricing green"
```

---

## Self-review notes (for the implementer)

- **The unit is the win:** `buildFixedBaseline` is the only place date resolution lives. The fold just calls `rateOn(r.local_date)`; the resolver just selects a plan and hands its versions over. Don't inline date logic into the fold or the resolver.
- **Degenerate parity is the regression guard:** Task 2's "matches the flat baseline when all rows fall in one window" and Task 1's single-version case together prove the refactor is behavior-neutral for existing single-rate sites.
- **Read-side only:** no migration, no `EnergyRollup` change, no metered `Schedule` change. The metered columns (B/D/F) still read `r.buy_rate`/`r.sell_rate` untouched.
- **Boundary is inclusive on `effective_from`** (`<=`), null sorts earliest, earliest carries backward, latest carries forward — pinned by Task 1's tests. Don't weaken them to a single date.
```
