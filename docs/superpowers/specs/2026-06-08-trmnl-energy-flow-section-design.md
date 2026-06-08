# Sankey Energy-Flow Section for TRMNL — Design

**Date:** 2026-06-08
**Status:** Approved design, pending implementation plan
**Branch:** feat/trmnl-viz2

## Summary

Add the Sankey energy value-flow diagram (shipped on `/site/[id]/live` in #77) to
the TRMNL device as a new **composable full-view section**, gated by a per-screen
config toggle with a **Now/Today basis** selector. This delivers the work the
original Sankey spec (`docs/superpowers/specs/2026-06-08-sankey-value-flow-diagram-design.md`,
commit `e95a8aa`) explicitly deferred:

> 1-bit `mono` theme + TRMNL renderer + wiring into the TRMNL markup endpoint.

The seam for this already exists: `SankeyRenderer` takes a `SankeyTheme`
(`'color' | 'mono'`), `value-color.ts` already returns mono styles, and
`directRenderer` already has a `theme === 'mono'` code path.

## Goals

- A TRMNL screen can display the energy-flow diagram, rendered server-side as a
  1-bit SVG, reusing the existing `FlowModel` core unchanged.
- The flow basis (instantaneous "Now" snapshot vs. cumulative "Today") is
  configurable **per carousel screen**.
- The section composes cleanly with the other full-view sections (live row,
  energy chart, SoC, bill, load-timing) across every combination — it
  participates in the existing layout budget like the other flexible sections.
- No new database or Tesla Fleet API calls: every input is already fetched by the
  markup route.

## Non-Goals (deferred to a follow-up)

- **A purpose-built 1-bit / e-ink renderer** (hatch/pattern fills to distinguish
  all 7 flow categories, larger glyph-distance type, fully reflowed layout). v1
  reuses `directRenderer` with `theme='mono'`. The renderer registry already
  supports adding a `mono-trmnl` entry later with zero changes to consumers.
- Half-screen / quadrant variants. Like the other rich sections (chart, SoC,
  bill, load-timing), flow is **full-view only**; `renderHalfVertical` /
  `renderHalfHorizontal` / `renderQuadrant` are untouched.
- Battery cost-basis or any new analytics — out of scope, as in the parent spec.

## Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| Flow basis on device | **Configurable per screen** (`flowBasis`: snapshot or cumulative) |
| Renderer | **Reuse `directRenderer` mono path now**, dedicated e-ink renderer later |
| Screen layout | **Composable section** participating in the layout budget |
| Emoji node labels in mono | **Drop to text** in the `mono` theme only (small renderer tweak) |
| Co-display behavior | **Full composability tuning** — flow looks good in every section combination |

## Architecture

The change is a vertical slice across the existing TRMNL section pipeline. Each
unit keeps its current responsibility; nothing new is invented in the core flow
model or renderer registry.

```
markup/route.ts ── builds FlowModel (mirrors live/page.tsx) ──► renderCtx.flowSvg
        │
trmnl-component-config.ts ── showEnergyFlow + flowBasis (per-screen) ──► componentConfig
        │
layout-engine.ts ── hasFlowSection + flowMinHeight + density tiers ──► LayoutState
        │
sections/flow.ts ── height-bounded, scale-to-fit wrapper around flowSvg ──► markup
        │
trmnl/manage/page.tsx ── "Energy Flow Diagram" checkbox + Now/Today select
```

### 1. Config surface — `lib/trmnl-component-config.ts`

Add two fields to `TrmnlComponentConfig`, following the exact precedent of
`showBatterySoc` + `batterySocMode`:

```ts
showEnergyFlow: boolean;     // default false (off, like bill / load-timing)
flowBasis: FlowBasis;        // 'snapshot' | 'cumulative' (reuse existing type
                             // from lib/sankey/flow-model), default 'cumulative'
```

- `DEFAULT_TRMNL_COMPONENT_CONFIG`: `showEnergyFlow: false`, `flowBasis: 'cumulative'`.
- `normalizeTrmnlComponentConfig`: read with snake_case aliases
  (`show_energy_flow`, `flow_basis`), validating `flowBasis` to the two allowed
  values via a small `asFlowBasis` helper (mirrors `asBatterySocMode`).
- `buildDefaultTrmnlComponentScreens`: existing screens keep `showEnergyFlow: false`;
  no new default screen is added.

Default basis is `'cumulative'` ("Today") because it is stable across the 15-minute
e-ink poll cadence and tells the ToU-arbitrage story the app is about.

### 2. The section — `lib/trmnl/sections/flow.ts` + registry

A new `flowSection: TrmnlSection`:

- `id: 'flow'`, `label: 'Energy Flow'`, `configKey: 'showEnergyFlow'`.
- `isEnabled: (l) => l.hasFlowSection`.
- `render`: wraps the pre-rendered `ctx.flowSvg` in a **fixed-height, centered
  flex container** sized to `l.flowMinHeight`, scaled to fit (see Layout below).
  When `ctx.flowSvg` is absent (no tariff/period → no rates), the section emits
  an empty string so the screen degrades gracefully, consistent with how
  `energyChartSection` no-ops when `seriesData` is missing.

`sections/types.ts`: extend the `configKey` union with `'showEnergyFlow'`.

`sections/registry.ts`: append `flowSection` to `SECTION_REGISTRY`.

`trmnl-renderer.ts` `renderFull`: add the `${html.flow ?? ''}` slot in the
column template, positioned so it reads naturally with the other sections
(below the live row; exact order finalized in the plan against the snapshot).

### 3. Layout budget — `lib/trmnl/layout-engine.ts`

The flow section is a **flexible section** like the energy chart and load-timing.
Add to `LayoutState`:

- `hasFlowSection: boolean`
- `flowMinHeight: number`

And integrate it into the existing budget math (no new density model):

- `hasFlowSection` adds 1 to `activeSectionCount`, so `isDenseLayout` /
  `isVeryDenseLayout` recompute correctly when flow is on.
- `flowMinHeight`: fills the available height when flow is the only/dominant
  flexible section; drops to a compact floor when co-displayed — modeled on the
  `loadTimingMinHeight` / `chartMinHeight` ladders.
- Because **full composability** is a goal, the height ladders and any
  bill/chart "reducible height" interplay are extended to account for the flow
  section, so each combination (live+flow, chart+flow, bill+flow, SoC+flow, and
  three-/four-section mixes) yields a sensible, non-clipped budget. These cases
  are enumerated as layout-engine unit tests.

**Fixed-aspect wrinkle:** `directRenderer` emits a fixed-aspect SVG
(`viewBox 760×340`). To compose at arbitrary heights it must scale-to-fit its
budgeted box. The section renders it inside a `height: ${flowMinHeight}px`
flex container, and the SVG uses `preserveAspectRatio="xMidYMid meet"` with
`width:100%; height:100%` so it scales centered within the box, preserving
aspect (horizontal letterboxing accepted in short/dense layouts). This is the
one cosmetic compromise of reusing the existing renderer; the deferred e-ink
renderer can reflow to remove it.

### 4. Markup route — `app/api/trmnl/markup/route.ts`

When `componentConfig.showEnergyFlow` and a current tariff period exists (rates
available), build the model **mirroring `live/page.tsx:142-163` exactly**:

- Rates from the already-computed `currentPeriod` (`buy_rate` / `sell_rate`),
  the same source `loadTimingActive` uses.
- `snapshot` basis: `buildSnapshotModel` from the cached `liveStatus`
  (W→kW ÷ 1000), with `soc` from `percentage_charged`.
- `cumulative` basis: `buildCumulativeModel` from the `todayRaw` rows already
  fetched for the cycle aggregation — **no extra DB read**.
- Select the model by `componentConfig.flowBasis`, render via
  `getRenderer(site.sankey_renderer)` at **`theme='mono'`**, assign to
  `renderCtx.flowSvg`.

`renderCtx` (in `lib/trmnl/types.ts`) gains `flowSvg?: string`. The model is
built once and reused across the 4 markup variants (only `renderFull` consumes
it). Add a `flow:${showEnergyFlow ? 1 : 0}` (and basis) entry to the
`X-Component-Config` debug header.

If no tariff/period (no rates), `flowSvg` is left undefined and the section
no-ops — same guard as the live page (`hasTariff && activePeriod`).

### 5. Renderer mono tweak — `lib/sankey/renderers/direct-renderer.ts`

Mono-only, so the color path (live page) is **unchanged**:

- When `theme === 'mono'`, render node labels as plain text
  (`SOLAR`, `HOME`, `BATTERY`, `GRID`) instead of the emoji-prefixed labels,
  which frequently fail to display on 1-bit e-ink.
- Emit `preserveAspectRatio="xMidYMid meet"` and sizing that lets the section
  scale the SVG to its budgeted height (see Layout).

Existing color-theme renderer tests stay green; new assertions cover the mono
text labels.

### 6. Settings UI — `app/trmnl/manage/page.tsx`

Add to the per-screen editor, copying the `showBatterySoc` + `batterySocMode`
block:

- A `Checkbox` "Energy Flow Diagram" bound to `showEnergyFlow`.
- A `Select` (Now / Today) bound to `flowBasis`, shown when the checkbox is on.

The live preview (`components/trmnl/TrmnlLivePreview.tsx`) already round-trips
`component_config` through the markup endpoint, so it reflects the new section
with no change.

## Data Flow

1. Device (or preview) requests `/api/trmnl/markup` → route resolves the screen's
   `componentConfig` (carousel-aware) as today.
2. If `showEnergyFlow`, route builds the `FlowModel` for the chosen `flowBasis`
   from data already in hand and renders `flowSvg` with `theme='mono'`.
3. `renderFull` runs the section registry; `flowSection` emits the height-bounded
   SVG wrapper into its slot.
4. `calculateLayoutBudget` has already sized every section, flow included, so the
   column fits the 480px viewport without clipping.

## Error Handling & Edge Cases

- **No tariff / no active period:** `flowSvg` undefined → section no-ops (matches
  live page).
- **No energy flow (all edges zero):** `directRenderer` already returns its
  "No energy flow" placeholder SVG.
- **Stale/absent live status (snapshot basis):** snapshot model built from
  whatever `liveStatus` is cached; zeros render the placeholder. Same tolerance
  as the live page.
- **Dense layouts:** layout-engine floors keep flow legible; worst case is
  horizontal letterboxing, never clipping.

## Testing (TDD)

Failing-test-first, per project convention:

- `trmnl-component-config.test.ts`: `showEnergyFlow` / `flowBasis` defaults,
  snake_case aliases, invalid `flowBasis` falls back to `'cumulative'`.
- `layout-engine.test.ts`: `hasFlowSection` toggles `activeSectionCount` and
  density tiers; `flowMinHeight` for solo and each co-display combination.
- `sections/flow.test.ts` (new): enabled predicate; renders the wrapper around
  `flowSvg`; no-ops when `flowSvg` absent.
- `direct-renderer.test.ts`: mono theme emits text (not emoji) node labels;
  color theme unchanged.
- `markup/route.test.ts`: builds `flowSvg` for both bases; omits when no tariff;
  no extra DB/Tesla calls.
- `render-full.test.ts`: update the characterization snapshot to include the
  flow slot (off by default → empty slot; plus an on case).

## Files Touched

| File | Change |
| --- | --- |
| `lib/trmnl-component-config.ts` | `showEnergyFlow`, `flowBasis` + normalize/defaults |
| `lib/trmnl/sections/types.ts` | `configKey` union += `'showEnergyFlow'` |
| `lib/trmnl/sections/flow.ts` | **new** section |
| `lib/trmnl/sections/registry.ts` | register `flowSection` |
| `lib/trmnl/layout-engine.ts` | `hasFlowSection`, `flowMinHeight`, density/budget tuning |
| `lib/trmnl/types.ts` | `RenderContext.flowSvg?` |
| `lib/trmnl-renderer.ts` | `flow` slot in `renderFull` |
| `app/api/trmnl/markup/route.ts` | build model + render `flowSvg`; debug header |
| `lib/sankey/renderers/direct-renderer.ts` | mono text labels + scale-to-fit |
| `app/trmnl/manage/page.tsx` | checkbox + basis select |
| (tests for each of the above) | per Testing section |

## Follow-up (not in this slice)

- Purpose-built `mono-trmnl` renderer registry entry: hatch/pattern fills to
  distinguish all 7 categories in 1-bit, e-ink-distance typography, reflowed
  layout that removes the letterboxing compromise. Config-only to adopt
  (`getRenderer` selection in the markup route).
