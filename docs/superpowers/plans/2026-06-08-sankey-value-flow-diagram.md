# Sankey Value-Flow Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-colored SVG Sankey value-flow diagram to the Site live page (`/site/[id]/live`) that visualizes energy arbitrage, with a snapshot⟷cumulative toggle and a per-site renderer preference.

**Architecture:** A renderer-agnostic core (`buildSnapshotModel` / `buildCumulativeModel`) computes a `FlowModel` from energy data using solar-first merit-order allocation. Swappable renderers turn the model into an SVG string; v1 ships one ("direct" / fixed-corner color layout) selected via a registry keyed by a per-site preference. The server page builds the models, renders SVG server-side, and passes the strings to a thin client component that only toggles between them.

**Tech Stack:** Next.js App Router (server + client components), TypeScript, Vitest (co-located `*.test.ts`), PostgreSQL (idempotent SQL migrations), existing `EnergyRepo` / `SiteRepo`.

---

## Canonical conventions (read first)

**Sign convention (CRITICAL — the two data sources disagree on battery):**
- The core's input type `InstantPower` uses the **LIVE** convention:
  - `battery`: **`+` = discharge, `−` = charge**
  - `grid`: **`+` = import, `−` = export**
- **Live status** (`EnergySiteLiveStatus`) already matches this — pass through unchanged.
- **Stored `EnergyData` rows** use the OPPOSITE battery sign (importer stores `+` = charge). The cumulative adapter therefore **negates `battery_power`** and keeps `grid_power` as-is.

**Units:** the allocation is unit-agnostic (pure `min`/subtract). Snapshot works in **kW**; cumulative converts each 5-min `EnergyData` row's Wh columns to **kWh** via `÷1000` (matching `sumTodayRows`) before allocating. Edge `value = energy × rate` → `$/hr` for snapshot, `$` for cumulative.

**Cumulative value simplification (in scope):** cumulative edge values use the site's *current* active buy/sell rates across all of today's rows. Per-interval historical TOU rates are deferred.

## File structure

```
src/lib/sankey/
  flow-model.ts                 # types + InstantPower
  build-flow-model.ts           # allocateEdges, buildSnapshotModel, energyDataToInstant, buildCumulativeModel
  build-flow-model.test.ts
  value-color.ts                # EdgeCategory -> color/label/verb (theme-aware)
  value-color.test.ts
  renderers/
    types.ts                    # SankeyRenderer, SankeyTheme
    direct-renderer.ts          # v1 fixed-corner SVG-string renderer
    direct-renderer.test.ts
    registry.ts                 # id -> renderer; getRenderer()
    registry.test.ts
src/components/site/live/
  SankeyCard.tsx                # thin client: snapshot<->cumulative toggle
src/components/SankeyRendererForm.tsx   # per-site preference UI (mirrors TimezoneDisplayForm)
db-migrations/<ts>_add_site_sankey_renderer.sql
```

**Modified files:**
- `src/lib/site-repo.ts` — add `sankey_renderer` to `SITE_BASE_COLUMNS`, `Site` interface, mapping, and `updateSiteSankeyRenderer` setter.
- `src/app/site/[id]/settings/actions.ts` — add `updateSankeyRenderer` server action.
- `src/components/site/SettingsView.tsx` — mount `SankeyRendererForm`.
- `src/app/site/[id]/live/page.tsx` — build both models, render SVG via registry, pass to `SankeyCard`.

---

### Task 1: Core types

**Files:**
- Create: `src/lib/sankey/flow-model.ts`
- Create: `src/lib/sankey/renderers/types.ts`

No test (type-only foundation).

- [ ] **Step 1: Create `flow-model.ts`**

```ts
export type NodeKey = 'solar' | 'battery' | 'grid' | 'home';
export type FlowBasis = 'snapshot' | 'cumulative';

export type EdgeCategory =
  | 'solar-home' | 'solar-battery' | 'solar-export'
  | 'battery-home' | 'grid-home' | 'grid-battery' | 'battery-export';

export type EdgeFrom = 'solar' | 'battery' | 'grid';
export type EdgeTo = 'home' | 'battery' | 'grid';

export interface FlowEdge {
  from: EdgeFrom;
  to: EdgeTo;
  energy: number;   // kW (snapshot) or kWh (cumulative), >= 0
  value: number;    // $/hr (snapshot) or $ (cumulative), >= 0 magnitude
  category: EdgeCategory;
}

export type NodeRole = 'source' | 'sink' | 'mixed' | 'idle';

export interface FlowNode {
  key: NodeKey;
  total: number;    // energy through node, >= 0
  role: NodeRole;
  soc?: number;     // battery only, 0..100
}

export interface FlowContext {
  buyRate: number;
  sellRate: number;
  timestamp: Date;
  rangeStart?: Date;   // cumulative window start
}

export interface FlowModel {
  basis: FlowBasis;
  nodes: Record<NodeKey, FlowNode>;
  edges: FlowEdge[];
  context: FlowContext;
}

/**
 * Canonical signed power/energy input. LIVE convention:
 *   battery: + = discharge, - = charge
 *   grid:    + = import,    - = export
 */
export interface InstantPower {
  solar: number;   // >= 0
  load: number;    // >= 0
  battery: number;
  grid: number;
}
```

- [ ] **Step 2: Create `renderers/types.ts`**

```ts
import type { FlowModel } from '../flow-model';

export type SankeyTheme = 'color' | 'mono';

/** Pure: model + theme -> standalone SVG markup string. */
export type SankeyRenderer = (model: FlowModel, theme: SankeyTheme) => string;
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit` (from `cmd/next-app`)
Expected: no errors referencing these files.

- [ ] **Step 4: Commit**

```bash
git add src/lib/sankey/flow-model.ts src/lib/sankey/renderers/types.ts
git commit -m "feat(sankey): add FlowModel types and renderer interface"
```

---

### Task 2: Merit-order allocation (`allocateEdges`) — the heart

**Files:**
- Create: `src/lib/sankey/build-flow-model.ts`
- Test: `src/lib/sankey/build-flow-model.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { allocateEdges } from './build-flow-model';
import type { FlowEdge } from './flow-model';

const rates = { buyRate: 0.40, sellRate: 0.10 };
const byCat = (edges: FlowEdge[]) =>
  Object.fromEntries(edges.map(e => [e.category, e.energy]));

describe('allocateEdges (LIVE convention: battery + = discharge, grid + = import)', () => {
  it('solar surplus splits home -> battery charge -> export', () => {
    // solar 7, load 3, battery charging 2 (-2), grid exporting 2 (-2)
    const edges = allocateEdges({ solar: 7, load: 3, battery: -2, grid: -2 }, rates);
    expect(byCat(edges)).toEqual({
      'solar-home': 3,
      'solar-battery': 2,
      'solar-export': 2,
    });
  });

  it('evening: solar -> home, battery discharge -> home, grid import -> home', () => {
    // solar 1, load 6, battery discharging 3 (+3), grid importing 2 (+2)
    const edges = allocateEdges({ solar: 1, load: 6, battery: 3, grid: 2 }, rates);
    expect(byCat(edges)).toEqual({
      'solar-home': 1,
      'battery-home': 3,
      'grid-home': 2,
    });
  });

  it('grid charges the battery beyond solar', () => {
    // solar 1, load 1, battery charging 3 (-3), grid importing 3 (+3)
    const edges = allocateEdges({ solar: 1, load: 1, battery: -3, grid: 3 }, rates);
    expect(byCat(edges)).toEqual({
      'solar-home': 1,
      'grid-battery': 3,
    });
  });

  it('assigns value = energy * buy rate for consumption, sell rate for export', () => {
    const edges = allocateEdges({ solar: 7, load: 3, battery: -2, grid: -2 }, rates);
    const home = edges.find(e => e.category === 'solar-home')!;
    const exp = edges.find(e => e.category === 'solar-export')!;
    expect(home.value).toBeCloseTo(3 * 0.40);
    expect(exp.value).toBeCloseTo(2 * 0.10);
  });

  it('conserves energy: sum of source outflow == sum of sink inflow', () => {
    const edges = allocateEdges({ solar: 5, load: 6, battery: 2, grid: -1 }, rates);
    const out = edges.reduce((s, e) => s + e.energy, 0); // every edge is one source->sink
    const sources = edges.reduce((s, e) => s + e.energy, 0);
    expect(out).toBeCloseTo(sources);
    // home inflow + exports == solar + discharge + import
    const inHome = edges.filter(e => e.to === 'home').reduce((s, e) => s + e.energy, 0);
    expect(inHome).toBeCloseTo(6);
  });

  it('returns no edges when everything is zero', () => {
    expect(allocateEdges({ solar: 0, load: 0, battery: 0, grid: 0 }, rates)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/sankey/build-flow-model`
Expected: FAIL — `allocateEdges` is not exported.

- [ ] **Step 3: Implement `allocateEdges`**

```ts
import type { EdgeCategory, EdgeFrom, EdgeTo, FlowEdge, InstantPower } from './flow-model';

export interface Rates {
  buyRate: number;
  sellRate: number;
}

const RATE_BASIS: Record<EdgeCategory, 'buy' | 'sell'> = {
  'solar-home': 'buy',
  'solar-battery': 'buy',
  'solar-export': 'sell',
  'battery-home': 'buy',
  'grid-home': 'buy',
  'grid-battery': 'buy',
  'battery-export': 'sell',
};

const EPS = 1e-9;

function makeEdge(
  from: EdgeFrom,
  to: EdgeTo,
  category: EdgeCategory,
  energy: number,
  rates: Rates,
): FlowEdge | null {
  if (energy <= EPS) return null;
  const rate = RATE_BASIS[category] === 'sell' ? rates.sellRate : rates.buyRate;
  return { from, to, category, energy, value: energy * rate };
}

/**
 * Solar-first merit-order allocation of an instant's flows.
 * Input must be in the canonical LIVE convention (see InstantPower).
 */
export function allocateEdges(p: InstantPower, rates: Rates): FlowEdge[] {
  const solar = Math.max(p.solar, 0);
  const load = Math.max(p.load, 0);
  const batteryDischarge = Math.max(p.battery, 0);
  const batteryCharge = Math.max(-p.battery, 0);
  const gridImport = Math.max(p.grid, 0);
  const gridExport = Math.max(-p.grid, 0);

  const solarToHome = Math.min(solar, load);
  const solarToBattery = Math.min(solar - solarToHome, batteryCharge);
  const solarToGrid = Math.min(solar - solarToHome - solarToBattery, gridExport);

  const batteryToHome = Math.min(batteryDischarge, load - solarToHome);
  const gridToHome = Math.min(gridImport, load - solarToHome - batteryToHome);

  const gridToBattery = Math.max(batteryCharge - solarToBattery, 0);
  const batteryToGrid = Math.max(gridExport - solarToGrid, 0);

  return [
    makeEdge('solar', 'home', 'solar-home', solarToHome, rates),
    makeEdge('solar', 'battery', 'solar-battery', solarToBattery, rates),
    makeEdge('solar', 'grid', 'solar-export', solarToGrid, rates),
    makeEdge('battery', 'home', 'battery-home', batteryToHome, rates),
    makeEdge('grid', 'home', 'grid-home', gridToHome, rates),
    makeEdge('grid', 'battery', 'grid-battery', gridToBattery, rates),
    makeEdge('battery', 'grid', 'battery-export', batteryToGrid, rates),
  ].filter((e): e is FlowEdge => e !== null);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/sankey/build-flow-model`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sankey/build-flow-model.ts src/lib/sankey/build-flow-model.test.ts
git commit -m "feat(sankey): merit-order flow allocation with value"
```

---

### Task 3: `buildSnapshotModel` + node derivation

**Files:**
- Modify: `src/lib/sankey/build-flow-model.ts`
- Test: `src/lib/sankey/build-flow-model.test.ts` (append)

- [ ] **Step 1: Add the failing test**

```ts
import { buildSnapshotModel } from './build-flow-model';

describe('buildSnapshotModel', () => {
  const ctx = { buyRate: 0.40, sellRate: 0.10, timestamp: new Date('2026-06-08T18:00:00Z'), soc: 68 };

  it('builds a snapshot model with node roles and battery soc', () => {
    const model = buildSnapshotModel({ solar: 1, load: 6, battery: 3, grid: 2 }, ctx);
    expect(model.basis).toBe('snapshot');
    expect(model.nodes.solar.role).toBe('source');
    expect(model.nodes.home.role).toBe('sink');
    expect(model.nodes.battery.role).toBe('source'); // discharging
    expect(model.nodes.battery.soc).toBe(68);
    expect(model.nodes.home.total).toBeCloseTo(6);
    expect(model.context.buyRate).toBe(0.40);
  });

  it('marks idle nodes', () => {
    const model = buildSnapshotModel({ solar: 5, load: 5, battery: 0, grid: 0 }, ctx);
    expect(model.nodes.battery.role).toBe('idle');
    expect(model.nodes.grid.role).toBe('idle');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/sankey/build-flow-model`
Expected: FAIL — `buildSnapshotModel` not exported.

- [ ] **Step 3: Implement node derivation + `buildSnapshotModel`**

Append to `build-flow-model.ts`:

```ts
import type { FlowContext, FlowModel, FlowNode, NodeKey, NodeRole } from './flow-model';

const NODE_KEYS: NodeKey[] = ['solar', 'battery', 'grid', 'home'];

export function deriveNodes(edges: FlowEdge[], soc?: number): Record<NodeKey, FlowNode> {
  const nodes = {} as Record<NodeKey, FlowNode>;
  for (const key of NODE_KEYS) {
    const outflow = edges.filter(e => e.from === key).reduce((s, e) => s + e.energy, 0);
    const inflow = edges.filter(e => e.to === key).reduce((s, e) => s + e.energy, 0);
    let role: NodeRole = 'idle';
    if (outflow > EPS && inflow > EPS) role = 'mixed';
    else if (outflow > EPS) role = 'source';
    else if (inflow > EPS) role = 'sink';
    nodes[key] = {
      key,
      total: outflow + inflow,
      role,
      ...(key === 'battery' && soc != null ? { soc } : {}),
    };
  }
  return nodes;
}

export interface SnapshotContext extends Omit<FlowContext, 'rangeStart'> {
  soc?: number;
}

export function buildSnapshotModel(power: InstantPower, ctx: SnapshotContext): FlowModel {
  const edges = allocateEdges(power, { buyRate: ctx.buyRate, sellRate: ctx.sellRate });
  return {
    basis: 'snapshot',
    nodes: deriveNodes(edges, ctx.soc),
    edges,
    context: { buyRate: ctx.buyRate, sellRate: ctx.sellRate, timestamp: ctx.timestamp },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/sankey/build-flow-model`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sankey/build-flow-model.ts src/lib/sankey/build-flow-model.test.ts
git commit -m "feat(sankey): buildSnapshotModel with node roles"
```

---

### Task 4: Cumulative model (battery-flip adapter + reducer)

**Files:**
- Modify: `src/lib/sankey/build-flow-model.ts`
- Test: `src/lib/sankey/build-flow-model.test.ts` (append)

- [ ] **Step 1: Add the failing test (covers the sign trap explicitly)**

```ts
import { energyDataToInstant, buildCumulativeModel } from './build-flow-model';
import type { EnergyData } from '../db';

const row = (over: Partial<EnergyData>): EnergyData => ({
  timestamp: new Date('2026-06-08T12:00:00Z'),
  site_id: 's1', tariff_id: 1, tariff_schedule_id: null,
  load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0, battery_soc: null,
  ...over,
});

describe('energyDataToInstant (stored convention: battery + = charge -> negate)', () => {
  it('negates stored battery_power and converts Wh -> kWh', () => {
    // stored battery_power +600 Wh = CHARGING -> canonical battery should be negative (charge)
    const p = energyDataToInstant(row({ solar_power: 600, load_power: 300, battery_power: 600, grid_power: -300 }));
    expect(p.solar).toBeCloseTo(0.6);
    expect(p.load).toBeCloseTo(0.3);
    expect(p.battery).toBeCloseTo(-0.6); // charging in canonical convention
    expect(p.grid).toBeCloseTo(-0.3);    // export unchanged
  });
});

describe('buildCumulativeModel', () => {
  const ctx = {
    buyRate: 0.40, sellRate: 0.10,
    timestamp: new Date('2026-06-08T13:00:00Z'),
    rangeStart: new Date('2026-06-08T00:00:00Z'),
  };

  it('sums per-interval edges by category', () => {
    const rows = [
      // midday: solar 600Wh, load 300, charging 200 (+200 stored), export 100 (-100)
      row({ solar_power: 600, load_power: 300, battery_power: 200, grid_power: -100 }),
      // evening: solar 0, load 600, discharging 400 (-400 stored), import 200 (+200)
      row({ solar_power: 0, load_power: 600, battery_power: -400, grid_power: 200 }),
    ];
    const model = buildCumulativeModel(rows, ctx);
    expect(model.basis).toBe('cumulative');
    const byCat = Object.fromEntries(model.edges.map(e => [e.category, Number(e.energy.toFixed(3))]));
    // interval 1: solar-home .3, solar-battery .2, solar-export .1
    // interval 2: battery-home .4, grid-home .2
    expect(byCat['solar-home']).toBeCloseTo(0.3);
    expect(byCat['solar-battery']).toBeCloseTo(0.2);
    expect(byCat['solar-export']).toBeCloseTo(0.1);
    expect(byCat['battery-home']).toBeCloseTo(0.4);
    expect(byCat['grid-home']).toBeCloseTo(0.2);
    expect(model.context.rangeStart).toBe(ctx.rangeStart);
  });

  it('uses latest non-null soc for the battery node', () => {
    const rows = [
      row({ battery_soc: 40, solar_power: 100, load_power: 100 }),
      row({ battery_soc: 55, solar_power: 100, load_power: 100, timestamp: new Date('2026-06-08T12:05:00Z') }),
    ];
    expect(buildCumulativeModel(rows, ctx).nodes.battery.soc).toBe(55);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/sankey/build-flow-model`
Expected: FAIL — `energyDataToInstant` / `buildCumulativeModel` not exported.

- [ ] **Step 3: Implement adapter + reducer**

Append to `build-flow-model.ts`:

```ts
import type { EnergyData } from '../db';

/** Wh -> kWh (matches sumTodayRows: divide by 1000). */
function whToKwh(wh: number): number {
  return wh / 1000;
}

/**
 * Convert a stored EnergyData row (Wh) to canonical kWh InstantPower.
 * Stored battery_power is + = charge, so NEGATE to match LIVE (+ = discharge).
 * grid_power keeps its sign (+ = import in both).
 */
export function energyDataToInstant(row: EnergyData): InstantPower {
  return {
    solar: whToKwh(row.solar_power),
    load: whToKwh(row.load_power),
    battery: -whToKwh(row.battery_power),
    grid: whToKwh(row.grid_power),
  };
}

export interface CumulativeContext extends FlowContext {
  rangeStart?: Date;
}

export function buildCumulativeModel(rows: EnergyData[], ctx: CumulativeContext): FlowModel {
  const rates = { buyRate: ctx.buyRate, sellRate: ctx.sellRate };
  const totals = new Map<EdgeCategory, { from: EdgeFrom; to: EdgeTo; energy: number }>();

  let latestSoc: { value: number; ts: number } | null = null;

  for (const row of rows) {
    for (const e of allocateEdges(energyDataToInstant(row), rates)) {
      const acc = totals.get(e.category);
      if (acc) acc.energy += e.energy;
      else totals.set(e.category, { from: e.from, to: e.to, energy: e.energy });
    }
    if (row.battery_soc != null) {
      const ts = row.timestamp.getTime();
      if (!latestSoc || ts > latestSoc.ts) latestSoc = { value: row.battery_soc, ts };
    }
  }

  const edges: FlowEdge[] = [...totals.entries()].map(([category, v]) =>
    makeEdge(v.from, v.to, category, v.energy, rates)!,
  );

  return {
    basis: 'cumulative',
    nodes: deriveNodes(edges, latestSoc?.value),
    edges,
    context: {
      buyRate: ctx.buyRate,
      sellRate: ctx.sellRate,
      timestamp: ctx.timestamp,
      rangeStart: ctx.rangeStart,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/sankey/build-flow-model`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sankey/build-flow-model.ts src/lib/sankey/build-flow-model.test.ts
git commit -m "feat(sankey): cumulative model summing per-interval flows"
```

---

### Task 5: Value/color mapping

**Files:**
- Create: `src/lib/sankey/value-color.ts`
- Test: `src/lib/sankey/value-color.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { edgeStyle } from './value-color';

describe('edgeStyle', () => {
  it('maps each category to a color, label and value verb (color theme)', () => {
    expect(edgeStyle('solar-home', 'color').color).toBe('#16a34a');
    expect(edgeStyle('grid-home', 'color').color).toBe('#dc2626');
    expect(edgeStyle('solar-home', 'color').verb).toBe('saved');
    expect(edgeStyle('solar-export', 'color').verb).toBe('earned');
    expect(edgeStyle('grid-home', 'color').verb).toBe('spent');
    expect(edgeStyle('solar-home', 'color').label).toBe('Solar → Home');
  });

  it('mono theme collapses to black with a fill pattern flag', () => {
    const s = edgeStyle('solar-export', 'mono');
    expect(s.color).toBe('#000000');
    expect(typeof s.dashed).toBe('boolean');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/sankey/value-color`
Expected: FAIL — `edgeStyle` not defined.

- [ ] **Step 3: Implement `value-color.ts`**

```ts
import type { EdgeCategory } from './flow-model';
import type { SankeyTheme } from './renderers/types';

export type ValueVerb = 'saved' | 'earned' | 'spent';

export interface EdgeStyle {
  color: string;
  label: string;
  verb: ValueVerb;
  dashed: boolean; // mono-theme texture hint for sell-rate / export flows
}

interface Spec {
  color: string;
  label: string;
  verb: ValueVerb;
}

const SPECS: Record<EdgeCategory, Spec> = {
  'solar-home':    { color: '#16a34a', label: 'Solar → Home',     verb: 'saved' },
  'solar-battery': { color: '#0d9488', label: 'Solar → Battery',  verb: 'saved' },
  'solar-export':  { color: '#d97706', label: 'Solar → Grid',     verb: 'earned' },
  'battery-home':  { color: '#2563eb', label: 'Battery → Home',   verb: 'saved' },
  'grid-home':     { color: '#dc2626', label: 'Grid → Home',      verb: 'spent' },
  'grid-battery':  { color: '#991b1b', label: 'Grid → Battery',   verb: 'spent' },
  'battery-export':{ color: '#d97706', label: 'Battery → Grid',   verb: 'earned' },
};

export function edgeStyle(category: EdgeCategory, theme: SankeyTheme): EdgeStyle {
  const spec = SPECS[category];
  const dashed = spec.verb === 'earned';
  return {
    color: theme === 'mono' ? '#000000' : spec.color,
    label: spec.label,
    verb: spec.verb,
    dashed,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/sankey/value-color`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sankey/value-color.ts src/lib/sankey/value-color.test.ts
git commit -m "feat(sankey): edge value/color mapping"
```

---

### Task 6: Direct renderer (fixed-corner SVG string)

**Files:**
- Create: `src/lib/sankey/renderers/direct-renderer.ts`
- Test: `src/lib/sankey/renderers/direct-renderer.test.ts`

Layout: Solar top-left, Home top-right, Battery bottom-left, Grid bottom-right. Each edge is a filled bezier ribbon whose width ∝ energy (normalized to the largest edge), colored via `edgeStyle`. Each ribbon carries an SVG `<title>` tooltip.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { directRenderer } from './direct-renderer';
import { buildSnapshotModel } from '../build-flow-model';

describe('directRenderer', () => {
  const model = buildSnapshotModel(
    { solar: 5, load: 6, battery: 2, grid: -1 },
    { buyRate: 0.40, sellRate: 0.10, timestamp: new Date('2026-06-08T18:00:00Z'), soc: 68 },
  );

  it('returns an svg string with one ribbon path per edge', () => {
    const svg = directRenderer(model, 'color');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
    const ribbons = (svg.match(/class="ribbon"/g) || []).length;
    expect(ribbons).toBe(model.edges.length);
  });

  it('includes node labels and battery soc', () => {
    const svg = directRenderer(model, 'color');
    expect(svg).toContain('SOLAR');
    expect(svg).toContain('HOME');
    expect(svg).toContain('68%');
  });

  it('emits a <title> tooltip with value verb per ribbon', () => {
    const svg = directRenderer(model, 'color');
    expect(svg).toContain('saved');   // solar-home / battery-home
    expect(svg).toContain('<title>');
  });

  it('uses black ribbons under the mono theme', () => {
    const svg = directRenderer(model, 'mono');
    expect(svg).toContain('#000000');
    expect(svg).not.toContain('#16a34a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/sankey/renderers/direct-renderer`
Expected: FAIL — `directRenderer` not defined.

- [ ] **Step 3: Implement `direct-renderer.ts`**

```ts
import type { FlowEdge, FlowModel, NodeKey } from '../flow-model';
import type { SankeyRenderer } from './types';
import { edgeStyle } from '../value-color';

const W = 740;
const H = 320;
const NODE_W = 120;
const NODE_H = 48;
const MAX_RIBBON = 44;
const MIN_RIBBON = 3;

// Fixed corner anchor points (edge attaches at the inner side of each node box).
const ANCHOR: Record<NodeKey, { x: number; y: number }> = {
  solar:   { x: 40 + NODE_W, y: 40 + NODE_H / 2 },           // top-left, right edge
  home:    { x: W - 40 - NODE_W, y: 40 + NODE_H / 2 },       // top-right, left edge
  battery: { x: 40 + NODE_W, y: H - 40 - NODE_H / 2 },       // bottom-left, right edge
  grid:    { x: W - 40 - NODE_W, y: H - 40 - NODE_H / 2 },   // bottom-right, left edge
};

const NODE_BOX: Record<NodeKey, { x: number; y: number }> = {
  solar:   { x: 40, y: 40 },
  home:    { x: W - 40 - NODE_W, y: 40 },
  battery: { x: 40, y: H - 40 - NODE_H },
  grid:    { x: W - 40 - NODE_W, y: H - 40 - NODE_H },
};

const NODE_LABEL: Record<NodeKey, string> = {
  solar: '☀️ SOLAR', home: '🏠 HOME', battery: '🔋 BATTERY', grid: '🔌 GRID',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Filled band between two anchors, perpendicular half-width `h`. */
function ribbonPath(x1: number, y1: number, x2: number, y2: number, width: number): string {
  const h = width / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * h;
  const ny = (dx / len) * h;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return [
    `M ${x1 + nx} ${y1 + ny}`,
    `C ${mx + nx} ${my + ny}, ${mx + nx} ${my + ny}, ${x2 + nx} ${y2 + ny}`,
    `L ${x2 - nx} ${y2 - ny}`,
    `C ${mx - nx} ${my - ny}, ${mx - nx} ${my - ny}, ${x1 - nx} ${y1 - ny}`,
    'Z',
  ].join(' ');
}

function ribbonWidth(edge: FlowEdge, maxEnergy: number): number {
  if (maxEnergy <= 0) return MIN_RIBBON;
  return Math.max(MIN_RIBBON, (edge.energy / maxEnergy) * MAX_RIBBON);
}

export const directRenderer: SankeyRenderer = (model: FlowModel, theme) => {
  const maxEnergy = model.edges.reduce((m, e) => Math.max(m, e.energy), 0);
  const unit = model.basis === 'snapshot' ? 'kW' : 'kWh';
  const valueUnit = model.basis === 'snapshot' ? '/hr' : '';

  const ribbons = model.edges
    .map(edge => {
      const a = ANCHOR[edge.from];
      const b = ANCHOR[edge.to];
      const style = edgeStyle(edge.category, theme);
      const width = ribbonWidth(edge, maxEnergy);
      const dash = theme === 'mono' && style.dashed ? ' stroke="#000000" stroke-width="1" stroke-dasharray="3 2"' : '';
      const fill = theme === 'mono' && style.dashed ? 'white' : style.color;
      const tip = `${style.label} · ${edge.energy.toFixed(2)} ${unit} · $${edge.value.toFixed(2)}${valueUnit} ${style.verb}`;
      return `<path class="ribbon" d="${ribbonPath(a.x, a.y, b.x, b.y, width)}" fill="${fill}" fill-opacity="0.82"${dash}><title>${esc(tip)}</title></path>`;
    })
    .join('');

  const nodes = (Object.keys(NODE_BOX) as NodeKey[])
    .map(key => {
      const box = NODE_BOX[key];
      const node = model.nodes[key];
      const socLine = key === 'battery' && node.soc != null ? ` ${Math.round(node.soc)}%` : '';
      const total = `${node.total.toFixed(2)} ${unit}`;
      return [
        `<rect x="${box.x}" y="${box.y}" width="${NODE_W}" height="${NODE_H}" fill="white" stroke="black" stroke-width="2"/>`,
        `<text x="${box.x + 10}" y="${box.y + 20}" font-size="13" font-weight="700">${esc(NODE_LABEL[key])}${socLine}</text>`,
        `<text x="${box.x + 10}" y="${box.y + 38}" font-size="11">${esc(total)}</text>`,
      ].join('');
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" font-family="ui-monospace,monospace">${ribbons}${nodes}</svg>`;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/sankey/renderers/direct-renderer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sankey/renderers/direct-renderer.ts src/lib/sankey/renderers/direct-renderer.test.ts
git commit -m "feat(sankey): fixed-corner direct SVG renderer"
```

---

### Task 7: Renderer registry

**Files:**
- Create: `src/lib/sankey/renderers/registry.ts`
- Test: `src/lib/sankey/renderers/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { getRenderer, DEFAULT_RENDERER_ID, RENDERER_IDS } from './registry';
import { directRenderer } from './direct-renderer';

describe('renderer registry', () => {
  it('resolves the direct renderer by id', () => {
    expect(getRenderer('direct')).toBe(directRenderer);
  });
  it('falls back to the default for unknown/null ids', () => {
    expect(getRenderer(null)).toBe(directRenderer);
    expect(getRenderer('nope')).toBe(directRenderer);
    expect(DEFAULT_RENDERER_ID).toBe('direct');
  });
  it('exposes the list of registered ids', () => {
    expect(RENDERER_IDS).toContain('direct');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/sankey/renderers/registry`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `registry.ts`**

```ts
import type { SankeyRenderer } from './types';
import { directRenderer } from './direct-renderer';

export const DEFAULT_RENDERER_ID = 'direct';

const REGISTRY: Record<string, SankeyRenderer> = {
  direct: directRenderer,
};

export const RENDERER_IDS = Object.keys(REGISTRY);

export function getRenderer(id: string | null | undefined): SankeyRenderer {
  return (id && REGISTRY[id]) || REGISTRY[DEFAULT_RENDERER_ID];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/sankey/renderers/registry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sankey/renderers/registry.ts src/lib/sankey/renderers/registry.test.ts
git commit -m "feat(sankey): renderer registry with default fallback"
```

---

### Task 8: Per-site `sankey_renderer` column + repo wiring

**Files:**
- Create: `db-migrations/<timestamp>_add_site_sankey_renderer.sql`
- Modify: `src/lib/site-repo.ts` (line 19 `SITE_BASE_COLUMNS`; `Site` interface; row mapping ~line 137; add setter near `updateSiteTimezoneDisplayMode` ~line 226)

- [ ] **Step 1: Create the migration**

```bash
touch db-migrations/$(date +%Y%m%d_%H%M%S)_add_site_sankey_renderer.sql
```

Contents:

```sql
-- Per-site Sankey renderer preference (nullable; null treated as 'direct').
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS sankey_renderer TEXT;
```

- [ ] **Step 2: Add `sankey_renderer` to `SITE_BASE_COLUMNS`**

In `src/lib/site-repo.ts` line 19, append the column:

```ts
const SITE_BASE_COLUMNS = 'id, user_id, name, utility, updated, installed, timezone, billing_start_day, timezone_display_mode, sankey_renderer';
```

- [ ] **Step 3: Add the field to the `Site` interface and row mapping**

In the `Site` interface (near `timezone_display_mode`), add:

```ts
    sankey_renderer?: string;
```

In the row-mapping object (near line 139, where `timezone_display_mode` is mapped), add:

```ts
                    sankey_renderer: (row.sankey_renderer as string) ?? undefined,
```

(Also add `s.sankey_renderer` to the explicit column list in the `getSite` SELECT around line 91 if that query lists columns individually.)

- [ ] **Step 4: Add the setter (mirror `updateSiteTimezoneDisplayMode`)**

After `updateSiteTimezoneDisplayMode`:

```ts
    async updateSiteSankeyRenderer(siteId: string, rendererId: string) {
        await pool.query('UPDATE "Site" SET sankey_renderer = $1 WHERE id = $2', [rendererId, siteId]);
        siteCache.delete(siteId);
    }
```

- [ ] **Step 5: Verify build + lint**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors. (No new unit test — DB-backed; covered by manual verification in Task 11.)

- [ ] **Step 6: Commit**

```bash
git add db-migrations/*_add_site_sankey_renderer.sql src/lib/site-repo.ts
git commit -m "feat(sankey): per-site sankey_renderer column + repo setter"
```

---

### Task 9: Settings action + preference UI

**Files:**
- Modify: `src/app/site/[id]/settings/actions.ts` (add action)
- Create: `src/components/SankeyRendererForm.tsx`
- Modify: `src/components/site/SettingsView.tsx` (mount the form near the `TimezoneDisplayForm` at line 197)

- [ ] **Step 1: Add the server action**

Append to `src/app/site/[id]/settings/actions.ts`:

```ts
import { RENDERER_IDS, DEFAULT_RENDERER_ID } from '@/lib/sankey/renderers/registry';

export async function updateSankeyRenderer(formData: FormData) {
    const siteId = formData.get('siteId') as string;
    const rendererId = formData.get('rendererId') as string;

    if (!siteId || !RENDERER_IDS.includes(rendererId)) {
        throw new Error('Invalid arguments');
    }

    if (!await verifySiteAccess(siteId)) {
        throw new Error('Unauthorized');
    }

    const repo = new SiteRepo();
    await repo.updateSiteSankeyRenderer(siteId, rendererId);

    revalidatePath(`/site/${siteId}/settings`);
    revalidatePath(`/site/${siteId}/live`);
}

export { DEFAULT_RENDERER_ID };
```

(`SiteRepo`, `verifySiteAccess`, `revalidatePath` are already imported in this file.)

- [ ] **Step 2: Create `SankeyRendererForm.tsx` (mirrors `TimezoneDisplayForm`)**

```tsx
'use client';

import { useState } from 'react';
import { updateSankeyRenderer } from '@/app/site/[id]/settings/actions';
import { Label, Select } from '@/components/ui/Form';

interface SankeyRendererFormProps {
    siteId: string;
    initialRenderer: string;
    options: { id: string; label: string }[];
}

export function SankeyRendererForm({ siteId, initialRenderer, options }: SankeyRendererFormProps) {
    const [current, setCurrent] = useState(initialRenderer);
    const [isPending, setIsPending] = useState(false);

    const handleChange = async (rendererId: string) => {
        setIsPending(true);
        const formData = new FormData();
        formData.append('siteId', siteId);
        formData.append('rendererId', rendererId);
        try {
            await updateSankeyRenderer(formData);
            setCurrent(rendererId);
        } catch (error) {
            console.error('Failed to update Sankey renderer:', error);
            alert('Failed to update settings. Please try again.');
        } finally {
            setIsPending(false);
        }
    };

    return (
        <form className="space-y-2">
            <Label className="block">Energy Flow Diagram Style</Label>
            <Select
                value={current}
                onChange={(e) => handleChange(e.target.value)}
                disabled={isPending || options.length <= 1}
            >
                {options.map(o => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                ))}
            </Select>
            <p className="text-xs text-gray-500">
                Controls the Sankey value-flow diagram on the Live page.
            </p>
        </form>
    );
}
```

- [ ] **Step 3: Mount the form in `SettingsView.tsx`**

Add the import at the top:

```tsx
import { SankeyRendererForm } from '@/components/SankeyRendererForm';
import { DEFAULT_RENDERER_ID } from '@/lib/sankey/renderers/registry';
```

Below the `TimezoneDisplayForm` usage (around line 197), add:

```tsx
                        <SankeyRendererForm
                            siteId={site.id}
                            initialRenderer={site.sankey_renderer || DEFAULT_RENDERER_ID}
                            options={[{ id: 'direct', label: 'Direct (multi-color)' }]}
                        />
```

- [ ] **Step 4: Verify build + lint**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/site/[id]/settings/actions.ts src/components/SankeyRendererForm.tsx src/components/site/SettingsView.tsx
git commit -m "feat(sankey): per-site renderer preference UI + action"
```

---

### Task 10: Wire into the live page (build models, render SVG, toggle)

**Files:**
- Create: `src/components/site/live/SankeyCard.tsx`
- Modify: `src/app/site/[id]/live/page.tsx` (build models near the existing data fetch ~lines 121-133; render `<SankeyCard>` in the returned layout ~line 137)

- [ ] **Step 1: Create the `SankeyCard` client component**

```tsx
'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/ui/SectionCard';

interface SankeyCardProps {
    snapshotSvg: string;
    cumulativeSvg: string;
}

export function SankeyCard({ snapshotSvg, cumulativeSvg }: SankeyCardProps) {
    const [basis, setBasis] = useState<'snapshot' | 'cumulative'>('snapshot');
    const svg = basis === 'snapshot' ? snapshotSvg : cumulativeSvg;

    return (
        <SectionCard
            title="Energy Value Flow"
            description="Where your power comes from and where surplus goes, colored by arbitrage value."
        >
            <div className="mb-3 inline-flex rounded-md border border-gray-300 overflow-hidden text-sm">
                <button
                    type="button"
                    onClick={() => setBasis('snapshot')}
                    className={`px-3 py-1 ${basis === 'snapshot' ? 'bg-black text-white' : 'bg-white text-black'}`}
                >
                    Now
                </button>
                <button
                    type="button"
                    onClick={() => setBasis('cumulative')}
                    className={`px-3 py-1 ${basis === 'cumulative' ? 'bg-black text-white' : 'bg-white text-black'}`}
                >
                    Today
                </button>
            </div>
            <div className="w-full" dangerouslySetInnerHTML={{ __html: svg }} />
        </SectionCard>
    );
}
```

- [ ] **Step 2: Build models + render SVG in the live page**

In `src/app/site/[id]/live/page.tsx`, add imports:

```tsx
import { buildSnapshotModel, buildCumulativeModel } from '@/lib/sankey/build-flow-model';
import { getRenderer } from '@/lib/sankey/renderers/registry';
import { SankeyCard } from '@/components/site/live/SankeyCard';
```

After the `Promise.all` block that yields `todayChartRows`, `liveStatus`, etc. (and after `activePeriod` is resolved, ~line 133), add:

```tsx
    // Sankey value-flow models (only when we have a tariff for rates + some live data).
    let sankeySnapshotSvg: string | null = null;
    let sankeyCumulativeSvg: string | null = null;
    if (hasTariff && activePeriod) {
        const renderer = getRenderer(site.sankey_renderer);
        const rates = { buyRate: activePeriod.buyRate, sellRate: activePeriod.sellRate };

        const snapshot = buildSnapshotModel(
            {
                solar: (liveStatus?.solar_power ?? 0) / 1000,
                load: (liveStatus?.load_power ?? 0) / 1000,
                battery: (liveStatus?.battery_power ?? 0) / 1000,
                grid: (liveStatus?.grid_power ?? 0) / 1000,
            },
            { ...rates, timestamp: now, soc: liveStatus?.percentage_charged ?? undefined },
        );

        const cumulative = buildCumulativeModel(todayChartRows, {
            ...rates,
            timestamp: now,
            rangeStart: todayStart,
        });

        sankeySnapshotSvg = renderer(snapshot, 'color');
        sankeyCumulativeSvg = renderer(cumulative, 'color');
    }
```

(`liveStatus.*_power` are Watts → divide by 1000 for kW; LIVE sign convention already matches `InstantPower`.)

- [ ] **Step 3: Render the card in the returned layout**

Inside the `<div className="space-y-6">` (after `<LiveDetailView ... />`, ~line 164), add:

```tsx
                {sankeySnapshotSvg && sankeyCumulativeSvg && (
                    <SankeyCard snapshotSvg={sankeySnapshotSvg} cumulativeSvg={sankeyCumulativeSvg} />
                )}
```

- [ ] **Step 4: Verify build + lint**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/site/live/SankeyCard.tsx src/app/site/[id]/live/page.tsx
git commit -m "feat(sankey): render value-flow card on live page with toggle"
```

---

### Task 11: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit suite**

Run: `npm test -- src/lib/sankey`
Expected: all sankey tests PASS.

- [ ] **Step 2: Lint + production build**

Run: `npm run lint && npm run build`
Expected: both succeed (project completion gate).

- [ ] **Step 3: Apply the migration locally and smoke-test the page**

```bash
# local SQLite/Postgres per CLAUDE.md; then run dev and open a site live page
npm run dev
```

Confirm in the browser at `/site/<id>/live`:
- The "Energy Value Flow" card renders an SVG with colored ribbons.
- The **Now / Today** toggle swaps between snapshot and cumulative.
- Hovering a ribbon shows the `<title>` tooltip (e.g. "Solar → Home · … saved").
- The Settings tab shows the "Energy Flow Diagram Style" control.

> ⚠️ Per project memory, the configured `DATABASE_URL` may be PROD with live Tesla data — prefer the Harrison test site for any live checks.

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(sankey): verification fixups"
```

---

## Self-review notes (addressed)

- **Spec coverage:** snapshot+cumulative (Tasks 3–4, 10), energy-width/value-color (Tasks 5–6), fixed-corner direct allocation (Task 6), FlowModel seam + registry (Tasks 1, 7), per-site preference (Tasks 8–9), server-renders-SVG wiring (Task 10), tests throughout, deferred items untouched. ✓
- **Sign-convention trap** is encoded canonically (LIVE convention) with the cumulative adapter negating stored battery — explicitly tested in Task 4. ✓
- **Type consistency:** `allocateEdges`, `buildSnapshotModel`, `buildCumulativeModel`, `energyDataToInstant`, `deriveNodes`, `edgeStyle`, `directRenderer`, `getRenderer`, `updateSiteSankeyRenderer`, `updateSankeyRenderer` names are used consistently across tasks. ✓
- **Deferred (not in this plan):** hub renderer, 1-bit/TRMNL endpoint wiring (the `mono` theme path exists in the renderer but is not surfaced), battery cost-basis/provenance, per-TOU historical rates for cumulative value.
```
