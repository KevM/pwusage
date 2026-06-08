# Sankey Value-Flow Diagram — Design

**Date:** 2026-06-08
**Status:** Approved (pending spec review)
**Author:** Kevin Miller (with Claude)

## Overview

Add a multi-colored SVG **Sankey value-flow diagram** to the Site **Live detail** page
(`/site/[id]/live`) to help homeowners visualize energy arbitrage — where their home's
power comes from (solar, battery, grid) and where surplus goes (home, battery charge,
grid export), with ribbon color encoding how good or bad each flow is for arbitrage.

The rendering is **modular**: a renderer-agnostic core computes a `FlowModel`, and
swappable renderers turn that model into SVG. v1 ships one renderer (multi-color
"direct allocation"); a 1-bit/TRMNL renderer and an alternate "hub" layout are
explicitly deferred but reuse the entire core.

## Goals

- Visualize live and cumulative energy flows on the Site Live page.
- Encode arbitrage value through color (and dollar labels), with ribbon **width = energy**.
- Keep node positions **fixed** so the diagram is stable as the battery and grid flip
  between source and sink roles.
- Establish a clean seam so future renderers (hub layout, 1-bit TRMNL) and themes
  reuse the same computation and are added as config, not new code paths.

## Non-Goals (deferred)

- **Hub-layout renderer** and **1-bit / TRMNL renderer** — registry entries added later;
  reuse the whole core. Not built in v1.
- **Battery charge provenance / cost-basis** (the "45% grid-fed / 23% solar-fed" prototype).
  This requires new stateful tracking of what charged the battery over time and is **not
  derivable from current data**. Separate future feature.
- Animated/flowing ribbons, drag interactivity, client-side charting libraries.

## Key Decisions (from brainstorming)

| Decision | Choice |
| --- | --- |
| Time basis | **Both** — snapshot (kW) and cumulative (kWh), via a toggle |
| Ribbon metric | **Energy width + value color** (dollar amounts as labels/tooltips) |
| Graph structure | **Direct allocation** (source→sink ribbons), not a central hub |
| Layout stability | **Fixed corners** so battery/grid never teleport on role flips |
| Architecture | **Modular** — `FlowModel` seam + renderer registry; renderers emit SVG strings |
| Preference scope | **Per-site** (mirrors `timezone_display_mode`) |
| Build approach | **Hand-rolled SVG** (no charting lib; pure-string output) |
| Data wiring | **Server page pulls data + renders SVG; component only toggles** |

## Architecture

### Module layout

```
src/lib/sankey/
  flow-model.ts          # types: FlowNode, FlowEdge, FlowModel
  build-flow-model.ts    # buildFlowModel(instant) + cumulative reducer
  build-flow-model.test.ts
  value-color.ts         # edge category -> color/label (theme-aware)
  renderers/
    types.ts             # SankeyRenderer, SankeyTheme
    direct-renderer.ts   # v1: fixed-corner layout -> SVG string
    direct-renderer.test.ts
    registry.ts          # id -> renderer; getRenderer(prefId)
components/site/live/
  SankeyCard.tsx         # thin client: snapshot<->cumulative toggle, injects SVG
```

### The seam: `FlowModel`

The only structure that crosses from computation to presentation. Renderer-agnostic.

```ts
type NodeKey = 'solar' | 'battery' | 'grid' | 'home';

type FlowEdge = {
  from: 'solar' | 'battery' | 'grid';
  to:   'home'  | 'battery' | 'grid';
  energy: number;   // kW (snapshot) or kWh (cumulative)
  value: number;    // $/hr or $  (saved / earned / spent)
  category:
    | 'solar-home' | 'solar-battery' | 'solar-export'
    | 'battery-home' | 'grid-home' | 'grid-battery' | 'battery-export';
};

type FlowNode = {
  key: NodeKey;
  total: number;                 // kW or kWh through this node
  role: 'source' | 'sink' | 'idle';
  soc?: number;                  // battery only
};

type FlowModel = {
  basis: 'snapshot' | 'cumulative';
  nodes: Record<NodeKey, FlowNode>;
  edges: FlowEdge[];
  context: { buyRate: number; sellRate: number; timestamp: Date; rangeStart?: Date };
};
```

## Core: `buildFlowModel`

### Unit of computation = one instant

`buildFlowModel` takes a single moment (four powers + buy/sell rates + SOC) and returns
a `FlowModel`. It resolves the bidirectional nodes by sign, then applies solar-first
merit-order allocation.

**Sign conventions (VERIFY against `tesla-client` / `energy-utils` before trusting):**
consistent with `sumTodayRows` —
- `grid_power > 0` = import, `< 0` = export
- `battery_power > 0` = discharge, `< 0` = charge
- `solar_power` = production (≥ 0), `load_power` = consumption (≥ 0)

Resolve directional quantities:
```
batteryDischarge = max(battery_power, 0);  batteryCharge = max(-battery_power, 0)
gridImport       = max(grid_power, 0);     gridExport    = max(-grid_power, 0)
S = solar_power;  L = load_power
```

### Merit-order allocation

1. `solarToHome     = min(S, L)`
2. `solarToBattery  = min(S - solarToHome, batteryCharge)`
3. `solarToGrid     = min(S - solarToHome - solarToBattery, gridExport)`
4. `batteryToHome   = min(batteryDischarge, L - solarToHome)`
5. `gridToHome      = min(gridImport, L - solarToHome - batteryToHome)`
6. residuals:
   - `gridToBattery   = batteryCharge - solarToBattery`   (grid-charging the battery)
   - `batteryToGrid   = gridExport - solarToGrid`          (battery exporting)

Emit a `FlowEdge` for each nonzero quantity. At any instant only a self-consistent
subset is nonzero. Invariant to assert in tests: **Σ source outflow = Σ sink inflow**
(energy conservation, within float tolerance).

### Value & color per edge

`value = energy × rate`, where rate is what the flow saves, earns, or spends:

| category | rate basis | meaning | color (draft) |
| --- | --- | --- | --- |
| `solar-home` | buyRate | free energy offsetting a purchase | green |
| `solar-battery` | buyRate | stored free energy | teal |
| `solar-export` | sellRate | exported solar earns sell rate | amber |
| `battery-home` | buyRate | stored energy avoids a purchase | blue |
| `grid-home` | buyRate | energy you pay for | red |
| `grid-battery` | buyRate | costly charge (good only if arbitraging) | dark red |
| `battery-export` | sellRate | battery energy earns sell rate | amber |

Color mapping lives in `value-color.ts`, parameterized by `SankeyTheme` so the future
`mono` theme can map every category to a 1-bit fill/pattern.

### Cumulative = sum of per-interval snapshots

Daily **net** battery/grid totals erase the day's charge-then-discharge story, so we do
**not** allocate on daily nets. Instead the cumulative model is a reducer that runs
`buildFlowModel` on each 5-minute `EnergyData` row (already fetched as `todayChartRows`
via `getBucketedEnergyData`) and sums edges by `category`. The single-instant function
stays the pure, tested core; cumulative is a thin reducer over it.

## Renderers

```ts
type SankeyTheme = 'color' | 'mono';                  // mono reserved for TRMNL
type SankeyRenderer = (model: FlowModel, theme: SankeyTheme) => string;  // SVG markup
```

### v1: `direct-renderer.ts` (fixed-corner layout)

- **Fixed node corners:** Solar top-left (always source), Home top-right (always sink),
  Battery bottom-left, Grid bottom-right (the two reversible nodes own the bottom row).
- Each `FlowEdge` becomes a proportional-width bezier ribbon anchored at its
  `from`/`to` corners; width scales to `energy`, fill from `value-color.ts`.
- A node that flips role keeps its corner; only the ribbon it owns reverses and recolors,
  so nothing teleports between refreshes.
- Node boxes show the node total and (battery) SOC.
- Output is a **pure SVG string** → snapshot-testable, and the identical string drops into
  the TRMNL markup endpoint later.

### `registry.ts`

Maps a preference id to a renderer; v1 registers `'direct'` only. `getRenderer(id)` falls
back to `'direct'` for unknown/null ids.

## Data Wiring & Placement

**The server page owns all data and rendering; the client component only toggles.**

- Lives on the **Live detail page** (`/site/[id]/live/page.tsx`) as a new `SankeyCard`
  section. That page already fetches `liveStatus` (snapshot powers + SOC),
  `todayChartRows` (`getBucketedEnergyData`), and resolves the active buy/sell rates —
  **no new query, no new endpoint.**
- The page builds **both** FlowModels server-side:
  - **snapshot** ← live-status numbers
  - **cumulative** ← reduce `todayChartRows` through `buildFlowModel`
- Because renderers are pure string functions, the page **renders both to SVG
  server-side** using the site's `sankey_renderer` preference — the same render path the
  future TRMNL markup endpoint reuses.
- It passes the two ready SVG strings (plus minimal summary numbers for the card chrome)
  as props to a thin client `SankeyCard`, whose only job is the **snapshot ⟷ cumulative
  toggle** (swap which string it injects). No client fetching, no chart lib, no registry
  in the client bundle.
- Freshness follows the page's existing model (`dynamic = 'force-dynamic'` + current
  refresh component).

Data path: **repos → page (build models + render SVG) → props → `SankeyCard` (toggle only)**.

### Interactivity (v1)

Static SVG with native `<title>` tooltips per ribbon
(e.g. `"Solar → Home · 2.1 kW · $1.01/hr saved"`). Re-render on toggle only. No hover
state management, no animation.

## Per-Site Preference

Mirrors the existing `timezone_display_mode` precedent end-to-end:

- **Migration** (idempotent): `ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS sankey_renderer TEXT;`
  Null is treated as `'direct'`.
- **Repo:** add `sankey_renderer` to `SITE_BASE_COLUMNS`, the `Site` interface, and a
  `setSankeyRenderer(siteId, id)` setter alongside `setTimezoneDisplayMode`.
- **UI:** a selector in the **Settings tab** (`SettingsView`). With one renderer in v1 it
  is effectively a single/disabled option, but the column, setter, and `getRenderer`
  lookup are wired through so adding Hub or 1-bit later is config-only.

## Testing

- **`build-flow-model.test.ts`** (the heart): table-driven across scenarios — pure solar
  surplus, evening discharge + import, midday charge + export, grid-charging the battery,
  zero/idle — plus a conservation assertion `Σ sources = Σ sinks` for every case.
- **`direct-renderer.test.ts`**: SVG snapshot for representative models; assert ribbon
  count and width ordering.
- **Cumulative reducer**: sum of two instants equals the expected combined edges.

## Build / Lint Gate

`npm run build` and `npm run lint` must pass before completion (per project conventions).

## Future Work (out of scope here)

- Hub-layout renderer (registry entry; reuses core).
- 1-bit `mono` theme + TRMNL renderer + wiring into the TRMNL markup endpoint.
- Battery charge provenance & cost-basis (needs new stateful charge-source tracking).
- Animated ribbons / richer interactivity.
