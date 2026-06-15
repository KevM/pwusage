# ROI F1 — Fixed comparison column priced per-period (date-resolved baseline)

**Date:** 2026-06-15
**Status:** Design approved, pending spec review
**Branch context:** `feat/roi` — builds directly on the comparison-tariff foundation (`2026-06-13-roi-comparison-tariffs-design.md`), which shipped the `Tariff.reporting_only` + `effective_from` columns and the `ComparisonTariffEditor` that already captures multiple dated Fixed versions ("rate timeline"). This phase delivers the F1 follow-on documented in `TODO.md`.

## Problem

The foundation captures a Fixed comparison plan as a `reporting_only` tariff with one or more dated versions, but **prices the whole savings matrix at a single rate**: `pickCurrentFixedBaseline` picks the most-recent current version and applies it to every rollup row. The dated history is displayed but explicitly "not yet applied," with a note saying so.

For a real site whose alternative flat rate changed over time (e.g. $0.16580 → $0.19342), this overstates/understates the Fixed column (cells A/C/E) on every period that doesn't fall under the current rate. The user has **two fixed rates** they would have been on had they not gone solar; both should price the Fixed row at the rate in effect on each historical period.

## Goal

Price the Fixed comparison column **per rollup row at the fixed rate in effect on that row's `local_date`**, drawn from the selected Fixed comparison plan's dated version timeline. Pure read-side arithmetic — **no re-rollup, no schema change, no migration**. Remove the "not yet applied" note (it becomes false).

## Why this is exact read-side arithmetic (no re-rollup)

`computeMatrixTotals` (`roi-service.ts`) computes the Fixed column from **rate-agnostic energies** stored on each `EnergyRollupRow`, multiplied by the fixed rate:

- `A += load * fixedBuyRate`
- `C += solar_only_import * fixedBuyRate − solar_only_export * fixedSellRate`
- `E += actual_import * fixedBuyRate − actual_export * fixedSellRate`

The metered columns (B/D/F) use the snapshotted `r.buy_rate` / `r.sell_rate` and are **untouched** by this phase. Because the Fixed column never reads a stored rate — only stored energies — substituting a per-row fixed rate is exact and requires no re-replay of history.

## Scope

- **In:** a `FixedBaseline` timeline abstraction (`rateOn(localDate)`); per-row date resolution inside `computeMatrixTotals` and `monthlyCumulative`; `resolve-fixed-baseline.ts` building a timeline from the selected plan's full version history; removal of the "not yet applied" note.
- **Out (separate sub-projects, ranked second by the user):** metered/TOU column date-resolution + re-rollup (F2); a UI for new users to enter historical *metered* tariff schedules before reindex; arbitrary TOU *comparison* plans (2b). None are touched here.
- **No schema change, no migration, no re-rollup.** `effective_from` already exists from the foundation.
- **Future-dated rates:** out of scope (unknowable forward); the latest version carries forward flat, exactly as today.

## Data model

Unchanged. `Tariff.effective_from` (from the foundation) is the per-version effective date. A version's effective **range is derived** — it runs until the next version's `effective_from`; the latest carries to "present."

## The unit: `FixedBaseline` timeline

New module `src/lib/roi/fixed-baseline-timeline.ts`:

```ts
import type { RoiInputs } from './roi-service';
import type { ComparisonVersion } from './comparison-tariff-repo';

export interface FixedBaseline {
  /** The fixed buy/sell rate in effect on the given 'YYYY-MM-DD'. */
  rateOn(localDate: string): RoiInputs;
}

/** Build a date-resolved baseline from a plan's versions. */
export function buildFixedBaseline(versions: ComparisonVersion[]): FixedBaseline;

/** Degenerate single-rate baseline — rateOn returns the same rate for any date.
 *  Used for the flat/one-version case and to keep scalar call sites ergonomic. */
export function flatBaseline(inputs: RoiInputs): FixedBaseline;
```

### Resolution rules (`rateOn`)

- Sort versions ascending by `effective_from`; an **undated (`null`) version sorts earliest** (catch-all "since the beginning").
- For `localDate`, pick the **latest** version whose `effective_from ≤ localDate`.
- **Before the earliest dated version:** carry the earliest version's rate backward (no earlier information exists).
- **After the latest version:** carry the latest forward (projection-safe; matches today).
- A **single-version** timeline returns that one rate for every date — bit-for-bit identical to the current single-rate behavior (regression guard).

String comparison on ISO `YYYY-MM-DD` is correct ordering, so no `Date` parsing is needed.

## Fold change

`computeMatrixTotals(rows, baseline: FixedBaseline)` and `monthlyCumulative(rows, baseline: FixedBaseline)` call `baseline.rateOn(r.local_date)` inside the loop, replacing the single `inputs.fixedBuyRate/SellRate`. `buildRoiSummary` takes `FixedBaseline` and threads it through. The metered-rate arithmetic (B/D/F, recommendation, components) is unchanged.

Existing `roi-service` tests that pass a scalar `RoiInputs` are updated to wrap with `flatBaseline(...)` — a mechanical change that also exercises the degenerate path.

## Plan selection (`resolve-fixed-baseline.ts`)

Replace `pickCurrentFixedBaseline(plans): RoiInputs | null` with:

```ts
export function resolveFixedBaselineTimeline(plans: ComparisonPlan[]): FixedBaseline | null;
```

- **Select the plan** using the existing tiebreak (the plan whose current version has the most-recent `effective_from`). The user's case is a single plan, so selection is unambiguous; multiple *distinct named* fixed plans keep this selection and we do **not** merge across names.
- **Build the timeline** from *all* of the selected plan's versions (not just the current one).
- Returns `null` when no Fixed comparison plan exists (unchanged empty-state behavior).

## Read side (`page.tsx`)

Swap the one call: `pickCurrentFixedBaseline(comparisonPlans)` → `resolveFixedBaselineTimeline(comparisonPlans)`. The gate (`baseline && roiConfig && (solar_cost || battery_cost)`) and all downstream calls are unchanged — `buildRoiSummary` and `monthlyCumulative` now receive a `FixedBaseline` instead of a scalar.

## UI

- **Remove the "not yet applied" note** in `ComparisonTariffEditor` (it is now false). Replace with a brief, honest line: each period is priced at the fixed rate in effect then.
- Matrix column labels (Fixed · `<plan name>`) are unchanged.

## Testing

- **Timeline resolution (`fixed-baseline-timeline.test.ts`):**
  - Two dated versions: a date before the first → earliest rate; a date between → the version covering it; a date after the last → latest rate; exact boundary date → that version (inclusive `≤`).
  - An undated (`null`) version acts as the catch-all earliest.
  - Single-version timeline returns the same rate for any date.
- **Degenerate parity:** `buildFixedBaseline([oneVersion])` priced over rows equals `flatBaseline({that rate})` over the same rows (regression guard on the fold).
- **Date-resolved fold:** rows spanning two version windows produce Fixed-column totals equal to summing each window at its own rate (the originating $0.16580→$0.19342 correction).
- **Selection:** `resolveFixedBaselineTimeline` returns `null` for no plans; picks the expected plan via the existing tiebreak; builds a timeline from all of the selected plan's versions.
- **Metered columns unaffected:** B/D/F totals are unchanged by switching from scalar to timeline when all rows fall in one window (guards that only the Fixed column is date-resolved).

## Follow-ons (unchanged, not built here)

- **F2** — metered/TOU column date-resolution + re-rollup (`TODO.md`).
- **Historical metered tariff entry** — a UI for new users to introduce older metered schedules before reindex (couples with F2).
- **2b** — arbitrary TOU *comparison* plans via a plan-agnostic hourly profile.
