# Date-Resolved Payback Baseline — Design

**Date:** 2026-06-17
**Branch:** `feat/roi`
**Status:** Approved (brainstorm) — ready for implementation plan

## Problem

The Savings **payback hero** (`PaybackHero` / `RoiSummary`) and the **N-column comparison grid** (`ExtendedGrid`) price energy from the same hourly substrate, but through **two different baseline pricers**:

- The **grid** prices every column with `comparisonStructTimeline(...)` — fully **date-resolved** across each plan's version history (early dates priced at the rate in effect then).
- The **hero's Fixed baseline** (matrix cells A/C/E) is built from `pickCurrentFixedBaseline(...)`, which collapses the chosen Fixed plan's **current version** into two flat scalars (`fixedBuyRate`, `fixedSellRate`) and applies them across **all** history via `flatTimeline(...)`.

Whenever the Fixed baseline plan has **more than one version** (a recorded flat-rate change over time), the hero prices historical energy at today's rate, so the headline payback figure and break-even disagree with the grid.

## Goal

Re-point the payback hero (and the savings chart, which shares the same baseline) at a **date-resolved** Fixed baseline, so the hero is consistent with the grid by construction. No change to baseline *concept*, *selection*, or *gating* — only the history is no longer flattened.

## What is NOT changing (pre-existing semantics, preserved)

The ROI model is a 2×3 matrix of bills:

| | Fixed **baseline** column | Metered column (actual) |
|---|---|---|
| No system | A = load at baseline | B |
| Solar only | C | D |
| Solar + battery | E | F |

- **A** = no-system bill at a flat reference rate. **F** = what you actually pay (solar+battery on the metered plan). **Total saved = A − F** → drives "% recovered" + break-even.
- Decomposition: solar value = A − C; battery-hardware value = C − E; **TOU-plan value = E − F**.
- **The baseline is always a Fixed comparison plan**, independent of the metered plan's type. Selection = the most-recent Fixed plan (by current `effective_from`). The metered plan is always the "actual" column, never the baseline.
- The metered plan's type only affects the **recommendation** ("you're on TOU; a flat plan looks cheaper"), which is unchanged.
- If **no Fixed comparison plan exists**, there is no anchor and the hero stays hidden — unchanged. (A TOU-fallback baseline was considered and **declined**; it would double-count TOU shifting that requires a battery and corrupt the decomposition.)
- **Single-version Fixed plan ⇒ output is identical** to today. The delta only appears for multi-version Fixed baselines.

## What IS changing

The chosen Fixed plan is priced **date-resolved across its versions** instead of flattened to its current rate. Concretely:

> Flat rate $0.18/kWh in 2023, then a version at $0.24 effective 2024-01-01.
> - Before: all of 2023 and 2024 priced at $0.24 → 2023 baseline cost overstated → payback wrong.
> - After: 2023 priced at $0.18, 2024 at $0.24 → baseline matches reality and matches the grid column.

## Design

### Approach: refactor the resolver to a structure picker (Approach A)

Make hero/grid consistency **structural** by sourcing the baseline from the same `comparisonStructTimeline` the grid already uses.

### 1. The cohesive unit — `src/lib/roi/resolve-fixed-baseline.ts`

Replace the scalar resolver with a pure structure picker:

```ts
export function pickFixedBaselineStructure(
  structures: ComparisonStructure[],   // { name, tariffs: Tariff[] } per plan — as page.tsx loads for the grid
): ComparisonStructure | null
```

- Selects the plan whose **current** version classifies as `fixed` (via `classifyTariff`), breaking ties by most-recent current `effective_from` — preserving today's "latest Fixed plan wins" semantics.
- Returns the **whole structure** (all versions), not scalars, so the caller can date-resolve it.
- Returns `null` when no Fixed plan exists (hero stays hidden — same gate).
- **Retire** the scalar `RoiInputs` type (used only here) and the dead async `resolveFixedBaseline`. `flatTimeline` stays — it remains a primitive and a test helper; it's just no longer used for the baseline.

> The exact type name for `ComparisonStructure` is whatever `listComparisonStructures` already returns (`{ name, tariffs }`); reuse it rather than introducing a new shape. Confirm the field carrying version ordering during planning (page.tsx comments note `g.tariffs` is newest-first).

### 2. Wiring — `src/app/site/[id]/page.tsx`

```ts
// before
const fixedBaseline = pickCurrentFixedBaseline(comparisonPlans);            // scalars
if (fixedBaseline && roiConfig && (...)) {
  const fixedTl = flatTimeline(fixedBaseline.fixedBuyRate, fixedBaseline.fixedSellRate);
  ...
}

// after
const baseline = pickFixedBaselineStructure(comparisonStructures);          // {name, tariffs} | null
if (baseline && roiConfig && (...)) {
  const fixedTl = comparisonStructTimeline(baseline.tariffs, finalSite.timezone);  // date-resolved
  ...
}
```

- Same gate (`baseline && roiConfig && cost present`), same call sites. The single timeline swap feeds **both** `buildRoiSummary` (hero) and `monthlyCumulative` (savings chart). `arbitrage` is metered-only and untouched.
- `comparisonStructures` is already loaded for the grid → no new query.
- `comparisonPlans` (from `listFixedComparisons`) stays — still feeds the `ComparisonTariffEditor` UI.

### Data flow

```
comparisonStructures ──pickFixedBaselineStructure──> baseline {name, tariffs}
                                                          │
                                  comparisonStructTimeline(tariffs, tz)
                                                          │ (date-resolved)
                                                       fixedTl
                                                          ├──> buildRoiSummary  ──> PaybackHero
                                                          └──> monthlyCumulative ──> SavingsChart
(same comparisonStructTimeline already builds every grid column ⇒ hero == grid)
```

## Testing (TDD)

- **`resolve-fixed-baseline.test.ts`** — rewrite around `pickFixedBaselineStructure`:
  - picks the latest Fixed-kind plan by current `effective_from`;
  - skips TOU plans; returns `null` when none are Fixed;
  - returns the **full** structure (all versions) — assert a multi-version plan returns >1 tariff.
- **`roi-service.test.ts`** — regression proving date-resolution: a 2-version Fixed baseline (rate change mid-history) yields a **different** `totalSaved` than flattening to the current rate would (early rows priced at the old rate). Fails before the swap, passes after.
- Full suite + `npm run build` + `npm run lint` + `npx tsc --noEmit` green (`verification-before-completion`).

## Out of scope (deferred follow-ons)

- **User-selectable / multiple baselines** — letting the user choose which plan anchors the hero, or compare payback under several baselines. The hero is a single headline (one `A`), so it needs exactly one baseline; multi-baseline is a separate feature (flag on a plan, or a baseline dropdown). Nothing here blocks it.
- **TOU-fallback baseline** when no Fixed plan exists — declined (corrupts the decomposition).
- Historical metered-tariff entry; sub-hour TOU windows — unrelated backlog items.
