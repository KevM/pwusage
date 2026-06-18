# Date-Resolved Payback Baseline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price the payback hero's Fixed baseline date-resolved across the baseline plan's version history (instead of flattening its current rate across all time), so the hero and the comparison grid agree by construction.

**Architecture:** Replace the scalar baseline resolver with a pure picker that selects the most-recent **Fixed** comparison plan's full structure; `page.tsx` then builds the baseline timeline with `comparisonStructTimeline(...)` — the same date-resolved builder the grid columns already use. To keep every commit building, the new picker is added additively first, then `page.tsx` is swapped and the dead scalar path removed.

**Tech Stack:** Next.js (App Router) Server Component (`page.tsx`), TypeScript, `pg` Pool, Vitest. Pricing engine in `src/lib/roi/*`.

---

## SESSION STATE (read first)

**Branch:** `feat/roi`. Spec: [docs/superpowers/specs/2026-06-17-payback-baseline-date-resolve-design.md](../specs/2026-06-17-payback-baseline-date-resolve-design.md).

**Pre-existing semantics (unchanged):** The ROI hero is a 2×3 bill matrix; the **Fixed baseline** column (cells A/C/E) is the no-system flat-rate counterfactual, the **metered** column (B/D/F) is what you actually pay. Baseline is **always a Fixed comparison plan**, selected as the most-recent Fixed plan; if none exists the hero stays hidden. This plan changes **only** how that baseline's *history* is priced — date-resolved instead of flattened. Single-version Fixed plan ⇒ identical output.

## Key facts grounding this plan (verified against the code)

- **`listComparisonStructures(siteId): Promise<{ name: string; tariffs: Tariff[] }[]>`** ([comparison-tariff-repo.ts:268](../../cmd/next-app/src/lib/roi/comparison-tariff-repo.ts)) — ordered `name ASC, effective_from DESC NULLS LAST, version DESC`, so **`tariffs[0]` is the current (newest) version** of each plan. Already loaded in `page.tsx` for the grid.
- **`classifyTariff(tariff: Tariff): 'fixed' | 'tou'`** ([classify-tariff.ts:5](../../cmd/next-app/src/lib/roi/classify-tariff.ts)) — Fixed iff all resolved buy rates are equal; empty schedules ⇒ `'fixed'`.
- **`comparisonStructTimeline(tariffs: Tariff[], tz: string): PlanTimeline`** ([plan-timeline.ts:71](../../cmd/next-app/src/lib/roi/plan-timeline.ts)) — date-resolves a plan's versions; a one-window Fixed plan prices flat (regression-tested at [plan-timeline.test.ts:108](../../cmd/next-app/src/lib/roi/plan-timeline.test.ts)).
- **Today's baseline** ([page.tsx:316-321](../../cmd/next-app/src/app/site/[id]/page.tsx)): `pickCurrentFixedBaseline(comparisonPlans)` → scalars → `flatTimeline(buy, sell)` applied across all history.
- **Dead/narrow code:** async `resolveFixedBaseline` has **no callers**; `pickCurrentFixedBaseline` is used only at `page.tsx:316` + its test; `RoiInputs` ([roi-service.ts:8](../../cmd/next-app/src/lib/roi/roi-service.ts)) is used only by the resolver + test. `flatTimeline` stays (used as a test helper in `roi-service.test.ts` and tested in `plan-timeline.test.ts`).
- **`page.tsx` imports:** line 29 `import { flatTimeline, meteredTimeline, comparisonStructTimeline } from '@/lib/roi/plan-timeline';`; line 39 `import { pickCurrentFixedBaseline } from '@/lib/roi/resolve-fixed-baseline';`. `comparisonStructures` and `comparisonPlans` are both in scope at line 316.
- **Test helpers to reuse:** `makeTariff(...)` ([plan-timeline.test.ts:7](../../cmd/next-app/src/lib/roi/plan-timeline.test.ts)) builds a one-season Tariff from `windows`; `hour(...)` + `EnergyHourlyRow` ([roi-service.test.ts:12](../../cmd/next-app/src/lib/roi/roi-service.test.ts)) build energy rows (all flows default 0).

---

## File Structure

**Modify:**
- `cmd/next-app/src/lib/roi/comparison-tariff-repo.ts` — export a named `ComparisonStructure` type; use it as the `listComparisonStructures` return element.
- `cmd/next-app/src/lib/roi/resolve-fixed-baseline.ts` — add `pickFixedBaselineStructure` (Task 1); remove the scalar `pickCurrentFixedBaseline` + dead async `resolveFixedBaseline` (Task 3).
- `cmd/next-app/src/lib/roi/resolve-fixed-baseline.test.ts` — add new-picker tests (Task 1); remove old-picker tests (Task 3).
- `cmd/next-app/src/lib/roi/roi-service.ts` — remove the now-unused `RoiInputs` interface (Task 3).
- `cmd/next-app/src/lib/roi/roi-service.test.ts` — add a date-resolution regression guard (Task 2).
- `cmd/next-app/src/app/site/[id]/page.tsx` — build the baseline from the date-resolved structure; drop the `flatTimeline` baseline path (Task 3).

**Untouched (explicitly):** `plan-timeline.ts` (already provides `comparisonStructTimeline`), `roi-service.ts` pricing functions, `ExtendedGrid`/`PaybackHero` components.

---

## Task 1: Add the date-resolved baseline picker (additive)

**Files:**
- Modify: `cmd/next-app/src/lib/roi/comparison-tariff-repo.ts`, `cmd/next-app/src/lib/roi/resolve-fixed-baseline.ts`
- Test: `cmd/next-app/src/lib/roi/resolve-fixed-baseline.test.ts`

- [ ] **Step 1: Export a named `ComparisonStructure` type**

In `src/lib/roi/comparison-tariff-repo.ts`, add this exported type near the other exported interfaces (e.g. just after the `ComparisonPlan` interface around line 14):

```ts
/** One comparison plan's full version history (newest version first), as returned by
 *  listComparisonStructures. Used to build a date-resolved timeline for the plan. */
export type ComparisonStructure = { name: string; tariffs: Tariff[] };
```

Then change the `listComparisonStructures` return type to use it (signature only — the body already builds `{ name, tariffs }`):

```ts
    async listComparisonStructures(siteId: string): Promise<ComparisonStructure[]> {
```

- [ ] **Step 2: Write the failing test**

Replace the entire contents of `src/lib/roi/resolve-fixed-baseline.test.ts` with the following. (It keeps the existing `pickCurrentFixedBaseline` coverage so the build/tests stay green while both pickers coexist, and adds the new-picker coverage.)

```ts
import { describe, it, expect } from 'vitest';
import { pickCurrentFixedBaseline, pickFixedBaselineStructure } from './resolve-fixed-baseline';
import type { ComparisonPlan, ComparisonStructure } from './comparison-tariff-repo';
import type { Tariff } from '../db';

describe('pickCurrentFixedBaseline (legacy scalar resolver)', () => {
    it('returns the current version of the (latest) plan as RoiInputs', () => {
        const plans: ComparisonPlan[] = [{
            name: 'PG&E flat',
            versions: [
                { version: 2, is_current: true, effective_from: '2026-01-01', buy_rate: 0.19342, sell_rate: 0.08, kind: 'fixed' },
                { version: 1, is_current: false, effective_from: '2024-01-01', buy_rate: 0.16580, sell_rate: 0.08, kind: 'fixed' },
            ],
        }];
        expect(pickCurrentFixedBaseline(plans)).toEqual({ fixedBuyRate: 0.19342, fixedSellRate: 0.08 });
    });

    it('ignores a TOU comparison plan when choosing the fixed baseline', () => {
        const plans: ComparisonPlan[] = [
            { name: 'EV', versions: [{ version: 1, is_current: true, effective_from: '2025-01-01', buy_rate: 0.18, sell_rate: 0.06, kind: 'tou' }] },
            { name: 'Flat', versions: [{ version: 1, is_current: true, effective_from: '2024-01-01', buy_rate: 0.20, sell_rate: 0.05, kind: 'fixed' }] },
        ];
        expect(pickCurrentFixedBaseline(plans)).toEqual({ fixedBuyRate: 0.20, fixedSellRate: 0.05 });
    });

    it('returns null when there is no comparison plan', () => {
        expect(pickCurrentFixedBaseline([])).toBeNull();
    });
});

// Build a one-season Tariff. `windows` (buy rates) become TariffSchedules; differing buy rates ⇒ TOU.
function makeStructTariff(over: {
    id?: number; effective_from?: string | null; windows: number[];
}): Tariff {
    const id = over.id ?? 1;
    return {
        id, site_id: 's1', updated: new Date('2026-01-01T00:00:00Z'), name: 'T',
        reporting_only: true, effective_from: over.effective_from ?? null,
        seasons: [{
            id, tariff_id: id, name: 'All Year',
            from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: over.windows[0], sell_rate: 0.05,
            schedules: over.windows.map((buy, i) => ({
                id: 100 + i, season_id: id, name: `W${i}`, buy_rate: buy, sell_rate: 0.05,
                from_day_of_week: 0, to_day_of_week: 6, from_hour: null, from_minute: 0, to_hour: null, to_minute: 0,
            })),
        }],
    } as Tariff;
}
const fixedStruct = (name: string, eff: string | null, buy: number, id = 1): ComparisonStructure =>
    ({ name, tariffs: [makeStructTariff({ id, effective_from: eff, windows: [buy] })] });
const touStruct = (name: string, eff: string | null): ComparisonStructure =>
    ({ name, tariffs: [makeStructTariff({ effective_from: eff, windows: [0.10, 0.40] })] });

describe('pickFixedBaselineStructure', () => {
    it('picks the latest Fixed plan by current effective_from', () => {
        const structures = [fixedStruct('Old', '2024-01-01', 0.16), fixedStruct('New', '2026-01-01', 0.19)];
        expect(pickFixedBaselineStructure(structures)?.name).toBe('New');
    });

    it('skips TOU plans and chooses the Fixed one', () => {
        const structures = [touStruct('EV', '2025-01-01'), fixedStruct('Flat', '2024-01-01', 0.20)];
        expect(pickFixedBaselineStructure(structures)?.name).toBe('Flat');
    });

    it('returns null when no plan is Fixed', () => {
        expect(pickFixedBaselineStructure([touStruct('EV', '2025-01-01')])).toBeNull();
        expect(pickFixedBaselineStructure([])).toBeNull();
    });

    it('returns the full version history (enables date-resolution)', () => {
        // newest version first, mirroring listComparisonStructures ordering
        const multi: ComparisonStructure = { name: 'Flat', tariffs: [
            makeStructTariff({ id: 2, effective_from: '2026-01-01', windows: [0.19] }),
            makeStructTariff({ id: 1, effective_from: '2024-01-01', windows: [0.16] }),
        ] };
        expect(pickFixedBaselineStructure([multi])?.tariffs).toHaveLength(2);
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/roi/resolve-fixed-baseline`
Expected: FAIL — `pickFixedBaselineStructure` is not exported (import error).

- [ ] **Step 4: Implement the picker (additive — keep the existing exports)**

In `src/lib/roi/resolve-fixed-baseline.ts`, add the import and the new function. Leave `pickCurrentFixedBaseline` and `resolveFixedBaseline` in place for now (removed in Task 3). The file's top imports become:

```ts
import type { RoiInputs } from './roi-service';
import { ComparisonTariffRepo, type ComparisonPlan, type ComparisonStructure } from './comparison-tariff-repo';
import { classifyTariff } from './classify-tariff';
```

Append the new picker at the end of the file:

```ts
/** Pick the date-resolvable Fixed baseline: the comparison plan whose CURRENT version
 *  (tariffs[0], newest-first per listComparisonStructures) classifies as Fixed, choosing
 *  the most-recent current effective_from. Returns the FULL structure (all versions) so the
 *  caller can date-resolve it via comparisonStructTimeline. Null ⇒ no Fixed plan (hero hidden). */
export function pickFixedBaselineStructure(structures: ComparisonStructure[]): ComparisonStructure | null {
    let best: { eff: string; s: ComparisonStructure } | null = null;
    for (const s of structures) {
        const current = s.tariffs[0];
        if (!current || classifyTariff(current) !== 'fixed') continue;
        const eff = current.effective_from ?? '0000-01-01';
        if (!best || eff > best.eff) best = { eff, s };
    }
    return best?.s ?? null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/lib/roi/resolve-fixed-baseline`
Expected: PASS (all legacy + new picker tests).

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/roi/comparison-tariff-repo.ts cmd/next-app/src/lib/roi/resolve-fixed-baseline.ts cmd/next-app/src/lib/roi/resolve-fixed-baseline.test.ts
git commit -m "feat(roi): add pickFixedBaselineStructure (date-resolvable Fixed baseline)"
```

---

## Task 2: Date-resolution regression guard in roi-service

**Files:**
- Test: `cmd/next-app/src/lib/roi/roi-service.test.ts`

> This is a characterization/guard test: the pricing engine already date-resolves any `PlanTimeline`, so it passes on arrival. It locks in the contract that a multi-version Fixed baseline is priced per-date (not flattened), guarding against a future regression that reintroduces a flat collapse.

- [ ] **Step 1: Write the regression guard test**

Append to `src/lib/roi/roi-service.test.ts`. First update two existing import lines at the top of the file.

Change:

```ts
import { flatTimeline } from './plan-timeline';
import type { EnergyHourlyRow } from '../db';
```

to:

```ts
import { flatTimeline, comparisonStructTimeline } from './plan-timeline';
import type { EnergyHourlyRow, Tariff } from '../db';
```

Then append this block:

```ts
describe('computeMatrixTotals — date-resolved Fixed baseline', () => {
    // A Fixed baseline with a rate change: $0.10/kWh before 2026-06-01, $0.20/kWh after.
    function flatVersion(id: number, eff: string | null, buy: number): Tariff {
        return {
            id, site_id: 's1', updated: new Date('2026-01-01T00:00:00Z'), name: 'Flat',
            reporting_only: true, effective_from: eff,
            seasons: [{
                id, tariff_id: id, name: 'All Year',
                from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: buy, sell_rate: 0.05,
                schedules: [{
                    id: 100 + id, season_id: id, name: 'W', buy_rate: buy, sell_rate: 0.05,
                    from_day_of_week: 0, to_day_of_week: 6, from_hour: null, from_minute: 0, to_hour: null, to_minute: 0,
                }],
            }],
        } as Tariff;
    }

    it('prices each date at the version in effect, not the flattened current rate', () => {
        const baselineTariffs = [flatVersion(2, '2026-06-01', 0.20), flatVersion(1, null, 0.10)]; // newest first
        const dateResolved = comparisonStructTimeline(baselineTariffs, 'America/Los_Angeles');
        const flatCurrent = flatTimeline(0.20, 0.05); // what the old flatten-to-current path produced
        const meteredTl = flatTimeline(0.24, 0.04);

        // load-only rows: one in the old period, one in the new. totalSaved = A − F, and F = 0 (no system flows),
        // so totalSaved equals the no-solar load bill priced at the baseline.
        const rows = [
            hour({ local_date: '2026-01-01', load_wh: 10000 }), // old period → date-resolved @ 0.10
            hour({ local_date: '2026-07-01', load_wh: 10000 }), // new period → 0.20
        ];

        const dr = computeMatrixTotals(rows, dateResolved, meteredTl).totalSaved;
        const flat = computeMatrixTotals(rows, flatCurrent, meteredTl).totalSaved;

        expect(dr).toBeCloseTo(10 * 0.10 + 10 * 0.20, 6);   // 3.0 — honours the historical rate
        expect(flat).toBeCloseTo(10 * 0.20 + 10 * 0.20, 6); // 4.0 — flattened overstates the old period
        expect(flat - dr).toBeCloseTo(1.0, 6);
    });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/lib/roi/roi-service`
Expected: PASS (guard documents the engine already date-resolves).

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/lib/roi/roi-service.test.ts
git commit -m "test(roi): guard date-resolved Fixed baseline pricing in matrix totals"
```

---

## Task 3: Wire page.tsx to the date-resolved baseline; remove the dead scalar path

**Files:**
- Modify: `cmd/next-app/src/app/site/[id]/page.tsx`, `cmd/next-app/src/lib/roi/resolve-fixed-baseline.ts`, `cmd/next-app/src/lib/roi/roi-service.ts`
- Test: `cmd/next-app/src/lib/roi/resolve-fixed-baseline.test.ts`

- [ ] **Step 1: Swap the baseline in `page.tsx`**

Edit the import at line 29 to drop `flatTimeline` (no longer used here):

```ts
import { meteredTimeline, comparisonStructTimeline } from '@/lib/roi/plan-timeline';
```

Edit the import at line 39:

```ts
import { pickFixedBaselineStructure } from '@/lib/roi/resolve-fixed-baseline';
```

Replace line 316:

```ts
    const baseline = pickFixedBaselineStructure(comparisonStructures);
```

Replace the guard at line 317:

```ts
    if (baseline && roiConfig && (roiConfig.solar_cost != null || roiConfig.battery_cost != null)) {
```

Replace line 321 (the baseline timeline):

```ts
        const fixedTl = comparisonStructTimeline(baseline.tariffs, finalSite.timezone);
```

(`fixedTl` flows unchanged into `buildRoiSummary` and `monthlyCumulative`. No other line in the block references `fixedBaseline`.)

- [ ] **Step 2: Remove the dead scalar resolver**

Replace the entire contents of `src/lib/roi/resolve-fixed-baseline.ts` with just the new picker:

```ts
import { type ComparisonStructure } from './comparison-tariff-repo';
import { classifyTariff } from './classify-tariff';

/** Pick the date-resolvable Fixed baseline: the comparison plan whose CURRENT version
 *  (tariffs[0], newest-first per listComparisonStructures) classifies as Fixed, choosing
 *  the most-recent current effective_from. Returns the FULL structure (all versions) so the
 *  caller can date-resolve it via comparisonStructTimeline. Null ⇒ no Fixed plan (hero hidden). */
export function pickFixedBaselineStructure(structures: ComparisonStructure[]): ComparisonStructure | null {
    let best: { eff: string; s: ComparisonStructure } | null = null;
    for (const s of structures) {
        const current = s.tariffs[0];
        if (!current || classifyTariff(current) !== 'fixed') continue;
        const eff = current.effective_from ?? '0000-01-01';
        if (!best || eff > best.eff) best = { eff, s };
    }
    return best?.s ?? null;
}
```

- [ ] **Step 3: Remove the now-unused `RoiInputs` interface**

In `src/lib/roi/roi-service.ts`, delete the `RoiInputs` interface (lines 7-11) and its preceding comment:

```ts
/** Retained for resolve-fixed-baseline.ts (the current Fixed baseline as flat scalars). */
export interface RoiInputs {
    fixedBuyRate: number;
    fixedSellRate: number;
}
```

- [ ] **Step 4: Remove the legacy picker tests**

In `src/lib/roi/resolve-fixed-baseline.test.ts`, delete the `describe('pickCurrentFixedBaseline (legacy scalar resolver)', ...)` block and remove `pickCurrentFixedBaseline` from the import and `ComparisonPlan` from the type import. The import lines become:

```ts
import { pickFixedBaselineStructure } from './resolve-fixed-baseline';
import type { ComparisonStructure } from './comparison-tariff-repo';
import type { Tariff } from '../db';
```

- [ ] **Step 5: Verify the suite, types, and build**

Run: `cd cmd/next-app && npm test -- src/lib/roi/resolve-fixed-baseline src/lib/roi/roi-service`
Expected: PASS.

Run: `cd cmd/next-app && npx tsc --noEmit`
Expected: no output (no dangling references to `pickCurrentFixedBaseline`, `resolveFixedBaseline`, `RoiInputs`, or `flatTimeline` in `page.tsx`).

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/app/site/\[id\]/page.tsx cmd/next-app/src/lib/roi/resolve-fixed-baseline.ts cmd/next-app/src/lib/roi/roi-service.ts cmd/next-app/src/lib/roi/resolve-fixed-baseline.test.ts
git commit -m "feat(roi): date-resolve the payback baseline; retire flat scalar resolver"
```

---

## Task 4: Final verification

- [ ] **Step 1:** `cd cmd/next-app && npm test` — all pass.
- [ ] **Step 2:** `cd cmd/next-app && npm run build && npm run lint && npx tsc --noEmit` — all pass.
- [ ] **Step 3: Confirm the flat baseline path is gone.** `cd cmd/next-app && grep -rn "pickCurrentFixedBaseline\|resolveFixedBaseline\|RoiInputs" src` → expected: **no matches**. And `grep -n "flatTimeline" src/app/site/\[id\]/page.tsx` → expected: **no matches** (still present only in test files, which is fine).
- [ ] **Step 4 (optional, live):** open the app on a site whose Fixed comparison plan has ≥2 versions with different rates; the PaybackHero "% recovered" / saved-to-date should now reconcile with the Fixed column the grid shows (no longer priced flat at the current rate).
- [ ] **Step 5:** `git push origin feat/roi`.

---

## Self-review notes (for the implementer)

- **Every commit builds.** Task 1 adds the new picker without removing the old one; `page.tsx` keeps compiling against `pickCurrentFixedBaseline` until Task 3 swaps it. Don't remove the legacy exports before Task 3.
- **Why the baseline stays Fixed-only:** the matrix decomposition (solar/battery-hardware/TOU-plan value) is anchored on a flat no-system counterfactual; a TOU baseline would double-count battery-enabled shifting. Selection deliberately ignores the metered plan's type — see the spec.
- **`flatTimeline` is intentionally kept** — it's still a primitive and a test helper. Only its use as the *baseline* in `page.tsx` is removed.
- **Tie-break parity:** `pickFixedBaselineStructure` uses strict `>` on `effective_from`, so the first-encountered plan wins ties — and `listComparisonStructures` orders by `name ASC`, matching the legacy resolver's first-wins behavior.
- **No new query:** `comparisonStructures` is already fetched for the grid; the picker just reads it.
