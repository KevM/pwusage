# TRMNL "Load timing this cycle" Widget — Design

**Date:** 2026-05-19
**Status:** Approved (pending spec review)

## Goal

Make the site live-detail "Load timing this cycle" widget available as a
selectable component on the TRMNL e-ink markup view, configurable from the
TRMNL manage UI. As part of the work, refactor the TRMNL full-screen layout
system into a section registry so future widgets can be added with minimal,
localized changes.

## Scope decisions (from brainstorming)

- **Fidelity:** full parity with the site widget — every TOU period with
  marginal cost, surplus/deficit, active marker, plus the next-cheaper banner.
  Color is replaced with monochrome cues (e-ink is grayscale).
- **Layouts:** full-screen only. Half-vertical / half-horizontal / quadrant are
  **out of scope** — they are effectively unused. The shared computation is
  structured so half rendering could be added later without rework.
- **Full-screen coexistence:** Load timing is a budgeted section (like the
  estimated bill) that adapts/compresses when shown with other sections, and
  is designed to be best used on its own carousel screen.
- **Default:** `showLoadTiming` defaults to **true** in
  `DEFAULT_TRMNL_COMPONENT_CONFIG`. Consequence: existing saved screens that
  predate the flag (no key stored) will begin showing Load timing on their
  next render. This is accepted.
- **Computation approach:** reuse the live page's existing helpers
  (`computeMarginalCost`, `findNextCheaperPeriod`, `findNextStartsByKey`,
  `formatRelativeStart`) via a new shared, cohesive, unit-tested module —
  single source of truth, web and e-ink differ only in presentation.
- **Layout refactor depth:** introduce a section/widget registry that
  **preserves the existing tuned budget math** (no generic allocator rewrite).
  Characterization snapshot tests lock current `renderFull` output before the
  refactor so it is provably behavior-preserving.

## Architecture

### A. Shared computation module — `src/lib/load-timing.ts`

A cohesive, serializable boundary that both the live page and the markup route
consume. Extracts the orchestration currently inlined in
`src/app/site/[id]/live/page.tsx` (~lines 118–151).

```ts
function computeLoadTiming(
  schedule: Schedule,
  cycle: UsageData[],
  now: Date,
  timezone: string,
  activePeriod: ActivePeriod | null
): LoadTimingView

interface LoadTimingView {
  hasTariff: boolean;
  hasCycleData: boolean;
  activeIsCheapest: boolean;
  periods: {
    name: string;
    marginalCost: number | null;
    basis: 'sell' | 'buy' | 'neutral';
    cycleNetExportKwh: number;
    isActive: boolean;
    nextStartPhrase: string | null;
  }[];
  nextCheaper: { name: string; marginalCost: number; phrase: string } | null;
}
```

Internally uses `computeMarginalCost`, `findNextCheaperPeriod`,
`findNextStartsByKey`, `formatRelativeStart`, and the same cycle-marginal
comparison the live page uses for `activeIsCheapest`. Co-located
`load-timing.test.ts`.

**Consumers:**

- **Live page** (`src/app/site/[id]/live/page.tsx`): refactored to call
  `computeLoadTiming` and pass results into `LiveDetailView`. This replaces the
  inline `nextCheaper` / `nextCheaperPhrase` / `nextStartPhraseByKey` /
  `activeIsCheapest` orchestration. `PeriodCardRow` / `PeriodCard` keep their
  existing web presentation (`getPeriodCardDisplay`), now fed from the shared
  view. Pure refactor, no behavior change.
- **Markup route** (`src/app/api/trmnl/markup/route.ts`): gated by
  `componentConfig.showLoadTiming`. When enabled, fetch the cycle via
  `repo.getCycleAndTodayTotals(site.id, start, todayStart, now)` as an
  additional parallel promise in the existing DB `Promise.all` block (skipped
  entirely when the flag is off — zero added cost when unused). Reuse the
  `Schedule` the route already builds and the active period it already
  computes. Attach `loadTiming: LoadTimingView` to `RenderContext`.

`RenderContext` gains one new optional field: `loadTiming?: LoadTimingView`.

### B. Config & manage UI

- Add `showLoadTiming: boolean` to `TrmnlComponentConfig`.
- `DEFAULT_TRMNL_COMPONENT_CONFIG.showLoadTiming = true`.
- `normalizeTrmnlComponentConfig` reads `showLoadTiming` / `show_load_timing`,
  default `true`.
- Manage UI (`src/app/trmnl/manage/page.tsx`): add a "Load timing" checkbox in
  the existing **Charts and Tables** group, wired through `updateEditingConfig`.
- Add `lt:${showLoadTiming ? 1 : 0}` to the `X-Component-Config` debug header in
  the markup route.

The set of config keys / UI checkboxes is sourced from a single section
metadata list (see C) so a future widget adds one entry, not edits in many
files.

### C. Extensibility refactor — section registry (behavior-preserving)

**New `src/lib/trmnl/sections/`.**

```ts
interface TrmnlSection {
  id: string;
  configKey: keyof TrmnlComponentConfig;
  isEnabled(cfg: TrmnlComponentConfig, ctx: RenderContext): boolean;
  measure(ctx: RenderContext, cfg: TrmnlComponentConfig, layout: LayoutState): SectionMeasure;
  render(ctx: RenderContext, layout: LayoutState, alloc: SectionMeasure): string;
}
```

- `SECTION_REGISTRY: TrmnlSection[]` in render order:
  `live → energyChart → soc → bill → loadTiming`.
- Existing sections (live / energy chart / soc / bill) are moved into section
  modules that **wrap their current template and height code verbatim**. No
  number changes, no intended visual change.
- `calculateLayoutBudget` keeps its exact math, reorganized so cross-section
  interactions (`activeSectionCount`, density tiers, bill-row math) compute
  once into the shared `LayoutState`; per-section height reads delegate to that
  section's `measure()`. `LayoutState` remains the shared context sections read.
- `renderFull` collapses to: enabled sections in registry order →
  `measure` → `render` → join. Hand-concatenated section blocks are removed.
- `loadTiming` is then added as a new registry entry — the first widget to
  exercise the new path. It is a budgeted section: renders as many period rows
  as fit, stepping cell font/spacing down via the existing
  `billCompactLevel`-style density; compresses (and may cap visible periods
  with a "+N more" indicator) when co-displayed; expands to fill when solo.

**Out of registry scope:** half/quadrant renderers (separate fixed renderers,
unused, untouched this round).

### D. Load timing renderer — `src/lib/trmnl/sections/load-timing.ts`

Renders `LoadTimingView` to TRMNL-framework HTML. Monochrome treatment:

- Each period = a bordered cell in a responsive flex grid mirroring the web
  card grid: TOU label, large marginal `¢/kWh`, and the net line as text —
  `↑ Surplus N kWh` / `↓ Deficit N kWh` / `—` for neutral. No color.
- Active period: `> ` prefix + bold (same convention as the existing bill
  table current-period marker) instead of the web blue ring.
- Non-active with a known next start: `Next <phrase>` label.
- Next-cheaper banner: full-width bordered strip above the grid —
  `Cheaper: <name> <phrase> (<¢>)`. Suppressed when not applicable;
  `activeIsCheapest` → `Cheapest period now`.

All money / kWh / phrase formatting reuses `format-utils` so figures match the
site widget exactly.

## Testing & verification

1. **Characterization snapshots** of `renderFull` across the existing config
   matrix — committed *before* the registry refactor, asserted unchanged after.
2. **`load-timing.test.ts`** (written failing first, per TDD): marginal cost
   per basis (sell/buy/neutral), active detection, `activeIsCheapest`,
   next-cheaper banner, next-start phrases, empty-cycle, no-tariff.
3. **Live-page parity test**: refactored live page produces the same
   `nextCheaper` / `activeIsCheapest` / per-period values as before.
4. **Load timing renderer test**: monochrome cues — active `>` + bold,
   surplus/deficit text, banner present/suppressed.
5. **Layout-engine tests** extended: `showLoadTiming` participates in
   `activeSectionCount` / density tiers.
6. `npm run lint`, `npm run build`, `npm test` green.
7. Manual e-ink verification via the manage UI `component_config` preview at
   the dense tiers (the part automated tests cannot cover).

## Sequencing

1. Characterization snapshot tests for `renderFull` (lock current output).
2. Extract `computeLoadTiming` + tests; refactor live page onto it; parity test.
3. Section registry refactor (move existing sections, behavior-preserving);
   snapshots still green.
4. `TrmnlComponentConfig.showLoadTiming` + normalizer + manage UI + debug header.
5. Markup route: conditional cycle fetch + `computeLoadTiming` + `RenderContext`.
6. `load-timing` section module + registry entry + renderer tests.
7. Layout-engine test extension; lint/build/test; manual e-ink preview check.

## Out of scope

- Half-vertical, half-horizontal, quadrant rendering of Load timing.
- Generic priority/flex budget allocator (kept the tuned math).
- Unrelated live-page or layout-engine cleanup beyond the extracted boundary.
