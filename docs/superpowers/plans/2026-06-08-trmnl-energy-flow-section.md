# Sankey Energy-Flow Section for TRMNL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Sankey energy value-flow diagram to the TRMNL device as a new composable full-view section, gated by a per-screen `showEnergyFlow` toggle with a Now/Today (`flowBasis`) selector, rendered server-side as a 1-bit SVG.

**Architecture:** Reuse the existing `FlowModel` core and `directRenderer` `mono` path unchanged. The markup route builds the model (mirroring `live/page.tsx`) and passes a pre-rendered SVG string into `RenderContext.flowSvg`. A new registry section emits it; the layout engine sizes it like the other flexible sections. A dedicated e-ink renderer is deferred.

**Tech Stack:** Next.js (App Router), TypeScript, Vitest, TRMNL Framework v2 markup.

**Spec:** `docs/superpowers/specs/2026-06-08-trmnl-energy-flow-section-design.md`

**Working directory for all commands:** `cmd/next-app`

---

## File Structure

| File | Responsibility | Action |
| --- | --- | --- |
| `src/lib/trmnl-component-config.ts` | `showEnergyFlow` + `flowBasis` config fields, normalize, defaults | Modify |
| `src/lib/trmnl-component-config.test.ts` | Config field tests | Modify |
| `src/lib/trmnl/types.ts` | `RenderContext.flowSvg` | Modify |
| `src/lib/trmnl/sections/types.ts` | `configKey` union += `'showEnergyFlow'` | Modify |
| `src/lib/sankey/renderers/direct-renderer.ts` | Mono text labels + scale-to-fit SVG attrs | Modify |
| `src/lib/sankey/renderers/direct-renderer.test.ts` | Mono label assertions | Modify |
| `src/lib/trmnl/sections/flow.ts` | New flow section | Create |
| `src/lib/trmnl/sections/flow.test.ts` | Flow section tests | Create |
| `src/lib/trmnl/sections/registry.ts` | Register `flowSection` | Modify |
| `src/lib/trmnl-renderer.ts` | `flow` slot in `renderFull` | Modify |
| `src/lib/trmnl/layout-engine.ts` | `hasFlowSection`, `flowMinHeight`, budget tuning | Modify |
| `src/lib/trmnl/layout-engine.test.ts` | Layout tests for flow | Modify |
| `src/app/api/trmnl/markup/route.ts` | Build model + render `flowSvg`; debug header | Modify |
| `src/app/trmnl/manage/page.tsx` | Checkbox + basis select | Modify |
| `src/lib/trmnl/render-full.test.ts` | Characterization snapshot matrix | Modify |

---

## Task 1: Config fields `showEnergyFlow` + `flowBasis`

**Files:**
- Modify: `src/lib/trmnl-component-config.ts`
- Modify: `src/lib/trmnl-component-config.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests to `src/lib/trmnl-component-config.test.ts` inside the existing `describe('TRMNL component config defaults', ...)` block:

```ts
    it('defaults showEnergyFlow off and flowBasis to cumulative', () => {
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showEnergyFlow).toBe(false);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.flowBasis).toBe('cumulative');
    });

    it('reads showEnergyFlow / flowBasis from snake_case aliases', () => {
        const stored = { show_energy_flow: true, flow_basis: 'snapshot' };
        const cfg = normalizeTrmnlComponentConfig(stored);
        expect(cfg.showEnergyFlow).toBe(true);
        expect(cfg.flowBasis).toBe('snapshot');
    });

    it('falls back to default flowBasis (cumulative) for an invalid value', () => {
        const stored = { ...DEFAULT_TRMNL_COMPONENT_CONFIG, flowBasis: 'bogus' };
        expect(normalizeTrmnlComponentConfig(stored).flowBasis).toBe('cumulative');
    });

    it('falls back to default showEnergyFlow (false) when missing from stored config', () => {
        const legacyStored = { ...DEFAULT_TRMNL_COMPONENT_CONFIG } as Record<string, unknown>;
        delete legacyStored.showEnergyFlow;
        delete legacyStored.flowBasis;
        const cfg = normalizeTrmnlComponentConfig(legacyStored);
        expect(cfg.showEnergyFlow).toBe(false);
        expect(cfg.flowBasis).toBe('cumulative');
    });
```

Also update the two existing `toEqual` assertions in the `'builds two default screens...'` test to include the new fields. Screen 1 `componentConfig` adds `showEnergyFlow: false, flowBasis: 'cumulative'`; Screen 2 `componentConfig` adds the same two fields:

```ts
        expect(defaultScreens[0]).toEqual({
            id: 'screen-1',
            name: 'Screen 1',
            componentConfig: {
                showLiveGrid: true,
                showLiveSolar: true,
                showLiveBattery: true,
                showEnergyChart: true,
                showBatterySoc: true,
                showEstimatedBill: false,
                showLoadTiming: false,
                showEnergyFlow: false,
                flowBasis: 'cumulative',
                batterySocMode: 'chart'
            }
        });

        expect(defaultScreens[1]).toEqual({
            id: 'screen-2',
            name: 'Screen 2',
            componentConfig: {
                showLiveGrid: true,
                showLiveSolar: true,
                showLiveBattery: true,
                showEnergyChart: false,
                showBatterySoc: false,
                showEstimatedBill: true,
                showLoadTiming: true,
                showEnergyFlow: false,
                flowBasis: 'cumulative',
                batterySocMode: 'chart'
            }
        });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/trmnl-component-config`
Expected: FAIL — `showEnergyFlow` / `flowBasis` undefined; `toEqual` mismatches.

- [ ] **Step 3: Implement the config fields**

In `src/lib/trmnl-component-config.ts`:

Add the import at the top of the file:

```ts
import type { FlowBasis } from './sankey/flow-model';
```

Add the two fields to the `TrmnlComponentConfig` interface (after `showLoadTiming: boolean;`):

```ts
    showEnergyFlow: boolean;
    flowBasis: FlowBasis;
```

Add an `asFlowBasis` helper next to `asBatterySocMode`:

```ts
function asFlowBasis(value: unknown, fallback: FlowBasis): FlowBasis {
    return value === 'snapshot' || value === 'cumulative' ? value : fallback;
}
```

Add the two fields to `DEFAULT_TRMNL_COMPONENT_CONFIG` (after `showLoadTiming: false,`):

```ts
    showEnergyFlow: false,
    flowBasis: 'cumulative',
```

Add the two fields to the object returned by `normalizeTrmnlComponentConfig` (after the `showLoadTiming` line):

```ts
        showEnergyFlow: asBoolean(fromKeys(record, ['showEnergyFlow', 'show_energy_flow']), DEFAULT_TRMNL_COMPONENT_CONFIG.showEnergyFlow),
        flowBasis: asFlowBasis(fromKeys(record, ['flowBasis', 'flow_basis']), DEFAULT_TRMNL_COMPONENT_CONFIG.flowBasis),
```

In `buildDefaultTrmnlComponentScreens`, add the two fields to **both** screen literals' `componentConfig`. Screen 1 spreads `DEFAULT_TRMNL_COMPONENT_CONFIG` so it already includes them — leave it. The Screen 2 literal is explicit; add after its `showLoadTiming: true,`:

```ts
                showEnergyFlow: false,
                flowBasis: 'cumulative',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/trmnl-component-config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/trmnl-component-config.ts src/lib/trmnl-component-config.test.ts
git commit -m "feat(trmnl): add showEnergyFlow + flowBasis component config"
```

---

## Task 2: `RenderContext.flowSvg` + section `configKey` union

**Files:**
- Modify: `src/lib/trmnl/types.ts`
- Modify: `src/lib/trmnl/sections/types.ts`

This task is a pure type extension with no behavior, so it has no standalone unit test; it is verified by the build and by Tasks 4–6 which consume the types.

- [ ] **Step 1: Add `flowSvg` to `RenderContext`**

In `src/lib/trmnl/types.ts`, add to the `RenderContext` interface (after the `timezone?` field):

```ts
    /** Pre-rendered 1-bit Sankey SVG for the flow section. Built by the markup
     *  route when showEnergyFlow is on and a tariff period (rates) exists. */
    flowSvg?: string;
```

- [ ] **Step 2: Extend the section `configKey` union**

In `src/lib/trmnl/sections/types.ts`, add `'showEnergyFlow'` to the `configKey` union:

```ts
    configKey: 'showLiveGrid' | 'showLiveSolar' | 'showLiveBattery'
        | 'showEnergyChart' | 'showBatterySoc' | 'showEstimatedBill'
        | 'showLoadTiming' | 'showEnergyFlow' | null;
```

- [ ] **Step 3: Verify the project still type-checks**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors).

- [ ] **Step 4: Commit**

```bash
git add src/lib/trmnl/types.ts src/lib/trmnl/sections/types.ts
git commit -m "feat(trmnl): add flowSvg render-context field + configKey"
```

---

## Task 3: `directRenderer` mono text labels + scale-to-fit

**Files:**
- Modify: `src/lib/sankey/renderers/direct-renderer.ts`
- Modify: `src/lib/sankey/renderers/direct-renderer.test.ts`

The color theme (live page) must stay byte-for-byte unchanged; all changes are gated on `theme === 'mono'`, except the `preserveAspectRatio` attribute which is harmless in both themes.

- [ ] **Step 1: Write the failing tests**

Add these tests to `src/lib/sankey/renderers/direct-renderer.test.ts` inside the `describe('directRenderer', ...)` block:

```ts
  it('uses plain-text node labels (no emoji) under the mono theme', () => {
    const svg = directRenderer(model, 'mono');
    expect(svg).toContain('SOLAR');
    expect(svg).toContain('HOME');
    expect(svg).not.toContain('☀️');
    expect(svg).not.toContain('🏠');
    expect(svg).not.toContain('🔋');
    expect(svg).not.toContain('🔌');
  });

  it('keeps emoji node labels under the color theme', () => {
    const svg = directRenderer(model, 'color');
    expect(svg).toContain('☀️');
  });

  it('emits preserveAspectRatio so the section can scale it to fit', () => {
    const svg = directRenderer(model, 'mono');
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/sankey/renderers/direct-renderer`
Expected: FAIL — emoji still present in mono; no `preserveAspectRatio`.

- [ ] **Step 3: Implement the mono label + aspect changes**

In `src/lib/sankey/renderers/direct-renderer.ts`:

Add a text-only label map next to the existing `NODE_LABEL`:

```ts
const NODE_LABEL_MONO: Record<NodeKey, string> = {
  solar: 'SOLAR', home: 'HOME', battery: 'BATTERY', grid: 'GRID',
};
```

The renderer's exported function signature is `(model, theme)`. In the `bar` closure, it currently reads `NODE_LABEL[p.key]`. Change the `name` line to pick the label set by theme. Replace this line:

```ts
    const name = `${esc(NODE_LABEL[p.key])}${soc}`;
```

with:

```ts
    const labels = theme === 'mono' ? NODE_LABEL_MONO : NODE_LABEL;
    const name = `${esc(labels[p.key])}${soc}`;
```

(`theme` is already in scope — it is the second parameter of the exported `directRenderer` and the `bar` closure is defined inside it.)

Add `preserveAspectRatio="xMidYMid meet"` to **both** `<svg ...>` open tags in the file (the empty-state SVG on the "No energy flow" path, and the main SVG on the final `return`). For the main return, change:

```ts
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" font-family="ui-monospace,monospace">${ribbons}${bars}</svg>`;
```

to:

```ts
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" font-family="ui-monospace,monospace">${ribbons}${bars}</svg>`;
```

And for the empty-state SVG, change:

```ts
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" font-family="ui-monospace,monospace"><text ...
```

to add `height="100%" preserveAspectRatio="xMidYMid meet"` after `width="100%"` (keep the rest of the line identical):

```ts
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" font-family="ui-monospace,monospace"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="currentColor" fill-opacity="0.6">No energy flow</text></svg>`;
```

> Note on `width="100%" height="100%"`: with a `viewBox` and `preserveAspectRatio="xMidYMid meet"`, the SVG fills whatever sized box the section wrapper gives it (Task 4), scaling centered and aspect-preserved. In an unconstrained container the percentage height resolves against the parent the same as before for the live page, whose `SankeyCard` wrapper already gives it width-driven height; this does not change the color render in practice (the live-page tests below confirm no regression).

- [ ] **Step 4: Run the renderer tests to verify they pass**

Run: `npm test -- src/lib/sankey/renderers/direct-renderer`
Expected: PASS.

- [ ] **Step 5: Run the broader sankey suite to confirm no regression**

Run: `npm test -- src/lib/sankey`
Expected: PASS (existing color-theme tests still green).

- [ ] **Step 6: Commit**

```bash
git add src/lib/sankey/renderers/direct-renderer.ts src/lib/sankey/renderers/direct-renderer.test.ts
git commit -m "feat(sankey): mono text labels + scale-to-fit svg for trmnl"
```

---

## Task 4: The `flow` section + registry + renderFull slot

**Files:**
- Create: `src/lib/trmnl/sections/flow.ts`
- Create: `src/lib/trmnl/sections/flow.test.ts`
- Modify: `src/lib/trmnl/sections/registry.ts`
- Modify: `src/lib/trmnl-renderer.ts`

This task references `layout.hasFlowSection` / `layout.flowMinHeight`, which Task 5 adds to `LayoutState`. To keep this task self-contained and testable now, the section reads them defensively (`l.hasFlowSection`, `l.flowMinHeight ?? 0`) and its test constructs a `LayoutState`-shaped object with those fields set explicitly. Task 5 then wires the real budget values.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/trmnl/sections/flow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { flowSection } from './flow';
import type { RenderContext } from '../types';
import type { LayoutState } from '../layout-engine';

function makeLayout(overrides?: Partial<LayoutState>): LayoutState {
    return { hasFlowSection: true, flowMinHeight: 300 } as unknown as LayoutState;
}

function makeCtx(overrides?: Partial<RenderContext>): RenderContext {
    return {
        siteName: 'Test Site',
        dateRange: '5/1 - 6/1',
        tariffGroups: [],
        totalCost: 0,
        currency: '$',
        displayCost: '$0.00',
        costLabel: 'Total Cost',
        flowSvg: '<svg id="flow"></svg>',
        ...overrides
    };
}

describe('flowSection', () => {
    it('has the showEnergyFlow config key', () => {
        expect(flowSection.id).toBe('flow');
        expect(flowSection.configKey).toBe('showEnergyFlow');
    });

    it('is enabled when the layout flags a flow section', () => {
        expect(flowSection.isEnabled(makeLayout())).toBe(true);
        expect(flowSection.isEnabled({ hasFlowSection: false } as unknown as LayoutState)).toBe(false);
    });

    it('renders the pre-rendered svg inside a height-bounded wrapper', () => {
        const html = flowSection.render(makeCtx(), makeLayout());
        expect(html).toContain('<svg id="flow"></svg>');
        expect(html).toContain('height: 300px');
    });

    it('no-ops when flowSvg is absent', () => {
        const html = flowSection.render(makeCtx({ flowSvg: undefined }), makeLayout());
        expect(html).toBe('');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/trmnl/sections/flow`
Expected: FAIL — `./flow` module not found.

- [ ] **Step 3: Implement the section**

Create `src/lib/trmnl/sections/flow.ts`:

```ts
import type { TrmnlSection } from './types';

export const flowSection: TrmnlSection = {
    id: 'flow',
    label: 'Energy Flow',
    configKey: 'showEnergyFlow',
    isEnabled: (l) => Boolean(l.hasFlowSection),
    render: (ctx, l) => {
        if (!ctx.flowSvg) return '';
        // Fixed-aspect SVG (preserveAspectRatio) scales centered to fill this
        // budgeted box. overflow:hidden clamps it to the height budget so a
        // dense layout can't push the footer off-screen.
        return `
            <div class="flex flex--row flex--center-x flex--center-y w--full" style="height: ${l.flowMinHeight}px; min-height: ${l.flowMinHeight}px; overflow: hidden;">
                ${ctx.flowSvg}
            </div>
        `;
    }
};
```

- [ ] **Step 4: Run the section tests to verify they pass**

Run: `npm test -- src/lib/trmnl/sections/flow`
Expected: PASS.

- [ ] **Step 5: Register the section and add the renderFull slot**

In `src/lib/trmnl/sections/registry.ts`, import and append `flowSection`:

```ts
import { flowSection } from './flow';
```

```ts
export const SECTION_REGISTRY: TrmnlSection[] = [
    liveSection,
    energyChartSection,
    socSection,
    billSection,
    loadTimingSection,
    flowSection
];
```

In `src/lib/trmnl-renderer.ts` `renderFull`, add the flow slot directly after the live slot. Change:

```ts
                    ${html.live ?? ''}
                    ${html.energyChart ?? ''}
```

to:

```ts
                    ${html.live ?? ''}
                    ${html.flow ?? ''}
                    ${html.energyChart ?? ''}
```

- [ ] **Step 6: Verify build + full trmnl section suite**

Run: `npm test -- src/lib/trmnl/sections`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/trmnl/sections/flow.ts src/lib/trmnl/sections/flow.test.ts src/lib/trmnl/sections/registry.ts src/lib/trmnl-renderer.ts
git commit -m "feat(trmnl): add flow section + registry + renderFull slot"
```

---

## Task 5: Layout-engine budget — `hasFlowSection` + `flowMinHeight`

**Files:**
- Modify: `src/lib/trmnl/layout-engine.ts`
- Modify: `src/lib/trmnl/layout-engine.test.ts`

Flow is a flexible section modeled on load-timing: it counts toward `activeSectionCount` (driving density tiers), fills the height when solo, and drops to a density-stepped floor when co-displayed. Its height is also folded into the bill's available-height math so a bill + flow screen does not overflow.

- [ ] **Step 1: Update the layout test helper, then write failing tests**

First, in `src/lib/trmnl/layout-engine.test.ts`, the `makeCfg` helper returns `TrmnlComponentConfig` and will no longer type-check once Task 1 added required fields. Add the two fields to its literal (after `showLoadTiming: false,`):

```ts
        showEnergyFlow: false,
        flowBasis: 'cumulative',
```

Then add these tests inside `describe('calculateLayoutBudget', ...)`:

```ts
        it('flags a flow section and counts it toward density', () => {
            const soloFlow = calculateLayoutBudget(makeCtx(), makeCfg({ showEnergyFlow: true }));
            expect(soloFlow.hasFlowSection).toBe(true);
            expect(soloFlow.activeSectionCount).toBe(1);
            expect(soloFlow.flowMinHeight).toBeGreaterThan(300);

            const off = calculateLayoutBudget(makeCtx(), makeCfg());
            expect(off.hasFlowSection).toBe(false);
            expect(off.flowMinHeight).toBe(0);
        });

        it('shrinks the flow floor when co-displayed with other sections', () => {
            const solo = calculateLayoutBudget(makeCtx(), makeCfg({ showEnergyFlow: true }));
            const coDisplayed = calculateLayoutBudget(
                makeCtx({ todayGrid: 5, todaySolar: 3 }),
                makeCfg({ showEnergyFlow: true, showLiveGrid: true, showLiveSolar: true, showLiveBattery: true, showEnergyChart: true })
            );
            expect(coDisplayed.flowMinHeight).toBeLessThan(solo.flowMinHeight);
            expect(coDisplayed.isDenseLayout || coDisplayed.isVeryDenseLayout).toBe(true);
        });

        it('reaches very-dense when flow joins live + chart + soc', () => {
            const layout = calculateLayoutBudget(
                makeCtx({ todayGrid: 5, todaySolar: 3, batterySoc: 80 }),
                makeCfg({
                    showEnergyFlow: true, showLiveGrid: true, showLiveSolar: true,
                    showLiveBattery: true, showEnergyChart: true,
                    showBatterySoc: true, batterySocMode: 'glyph'
                })
            );
            // live row + chart + SoC glyph + flow = 4 active sections.
            expect(layout.activeSectionCount).toBe(4);
            expect(layout.isVeryDenseLayout).toBe(true);
            expect(layout.flowMinHeight).toBe(150);
        });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/trmnl/layout-engine`
Expected: FAIL — `hasFlowSection` / `flowMinHeight` undefined.

- [ ] **Step 3: Implement the budget fields**

In `src/lib/trmnl/layout-engine.ts`:

Add the two fields to the `LayoutState` interface (in the section-heights group, after `socGlyphSectionHeight: number;`):

```ts
    /* ---- flow section ---- */
    hasFlowSection: boolean;
    flowMinHeight: number;
```

In `calculateLayoutBudget`, read the config flag near the other flags (after `const showLoadTiming = config.showLoadTiming;`):

```ts
    const showEnergyFlow = config.showEnergyFlow;
```

Add a derived flag near `hasLoadTimingSection`:

```ts
    const hasFlowSection = showEnergyFlow;
```

Fold it into `activeSectionCount` — change:

```ts
    const activeSectionCount = (hasLiveRow ? 1 : 0)
        + (showEnergyChart ? 1 : 0)
        + (hasStandaloneSocSection ? 1 : 0)
        + (showEstimatedBill ? 1 : 0)
        + (hasLoadTimingSection ? 1 : 0);
```

to:

```ts
    const activeSectionCount = (hasLiveRow ? 1 : 0)
        + (showEnergyChart ? 1 : 0)
        + (hasStandaloneSocSection ? 1 : 0)
        + (showEstimatedBill ? 1 : 0)
        + (hasLoadTimingSection ? 1 : 0)
        + (hasFlowSection ? 1 : 0);
```

Compute `flowMinHeight` after the load-timing height block (after the `loadTimingMinHeight` assignment). It mirrors the load-timing ladder — solo fills the viewport, co-displayed steps down by density:

```ts
    // Flow is a flexible, fixed-aspect SVG section (mirrors load-timing): solo
    // it fills the height; co-displayed it takes a density-stepped floor and the
    // section's preserveAspectRatio scales the diagram to fit.
    const flowMinHeight = !hasFlowSection
        ? 0
        : (activeSectionCount <= 1
            ? Math.max(220, TRMNL_HEIGHT - FOOTER_HEIGHT - ESTIMATED_GAP)
            : (isVeryDenseLayout ? 150 : (isDenseLayout ? 200 : 240)));
```

Fold flow height into the bill's non-bill budget so bill + flow does not overflow. In the `if (showEstimatedBill) { ... }` block, change:

```ts
        const nonBillSectionsHeight =
            liveSectionHeightEstimate +
            (showEnergyChart ? chartMinHeight : 0) +
            (hasStandaloneSocChart ? socChartMinHeight : socGlyphSectionHeight) +
            (hasLoadTimingSection ? loadTimingMinHeight : 0) +
            FOOTER_HEIGHT;
```

to:

```ts
        const nonBillSectionsHeight =
            liveSectionHeightEstimate +
            (showEnergyChart ? chartMinHeight : 0) +
            (hasStandaloneSocChart ? socChartMinHeight : socGlyphSectionHeight) +
            (hasLoadTimingSection ? loadTimingMinHeight : 0) +
            (hasFlowSection ? flowMinHeight : 0) +
            FOOTER_HEIGHT;
```

and add flow to the `renderedSections` count in the same block — change:

```ts
        const renderedSections = (hasLiveRow ? 1 : 0)
            + (showEnergyChart ? 1 : 0)
            + (hasStandaloneSocSection ? 1 : 0)
            + (hasLoadTimingSection ? 1 : 0)
            + 1 // bill
            + 1; // footer
```

to:

```ts
        const renderedSections = (hasLiveRow ? 1 : 0)
            + (showEnergyChart ? 1 : 0)
            + (hasStandaloneSocSection ? 1 : 0)
            + (hasLoadTimingSection ? 1 : 0)
            + (hasFlowSection ? 1 : 0)
            + 1 // bill
            + 1; // footer
```

Add both fields to the returned object (in the section-heights group, after `socGlyphSectionHeight,`):

```ts
        hasFlowSection,
        flowMinHeight,
```

- [ ] **Step 4: Run the layout tests to verify they pass**

Run: `npm test -- src/lib/trmnl/layout-engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/trmnl/layout-engine.ts src/lib/trmnl/layout-engine.test.ts
git commit -m "feat(trmnl): budget the flow section across layout combinations"
```

---

## Task 6: Markup route builds `flowSvg`

**Files:**
- Modify: `src/app/api/trmnl/markup/route.ts`
- Modify: `src/app/api/trmnl/markup/route.test.ts`

Build the model mirroring `live/page.tsx:142-163`: snapshot from cached `liveStatus`, cumulative from the already-fetched `todayRaw` rows. Rates come from the current period when one resolves, else default to zero — the diagram is sized by **energy** (rates only affect the `$` tooltip text), so it always renders when enabled, even outside a known TOU window or with empty data (the renderer returns its "No energy flow" placeholder SVG). No new DB or Tesla calls.

- [ ] **Step 1: Write a failing test**

The existing test fixture (`beforeEach`) returns a site with `tariffs: []` and empty energy rows. With the relaxed guard below, an enabled flow section still renders the renderer's "No energy flow" placeholder SVG — which is exactly what this test asserts. Add to `src/app/api/trmnl/markup/route.test.ts` inside the `describe('/api/trmnl/markup', ...)` block:

```ts
    it('includes the flow svg when showEnergyFlow is enabled', async () => {
        const componentConfig = encodeURIComponent(JSON.stringify({
            showLiveGrid: false, showLiveSolar: false, showLiveBattery: false,
            showEnergyChart: false, showBatterySoc: false, showEstimatedBill: false,
            showLoadTiming: false, showEnergyFlow: true, flowBasis: 'cumulative',
            batterySocMode: 'chart'
        }));
        const res = await GET(new Request(
            `http://localhost/api/trmnl/markup?site_id=site-1&component_config=${componentConfig}`
        ));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.markup).toContain('<svg');
        expect(body.markup).toContain('preserveAspectRatio="xMidYMid meet"');
        expect(body.markup).toContain('No energy flow'); // empty fixture -> placeholder
    });

    it('omits the flow svg when showEnergyFlow is off', async () => {
        const componentConfig = encodeURIComponent(JSON.stringify({
            showLiveGrid: false, showLiveSolar: false, showLiveBattery: false,
            showEnergyChart: false, showBatterySoc: false, showEstimatedBill: false,
            showLoadTiming: false, showEnergyFlow: false, flowBasis: 'cumulative',
            batterySocMode: 'chart'
        }));
        const res = await GET(new Request(
            `http://localhost/api/trmnl/markup?site_id=site-1&component_config=${componentConfig}`
        ));
        const body = await res.json();
        expect(body.markup).not.toContain('No energy flow');
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/app/api/trmnl/markup/route`
Expected: FAIL — no flow SVG in the markup.

- [ ] **Step 3: Implement the model build in the route**

In `src/app/api/trmnl/markup/route.ts`, add imports near the other `@/lib` imports:

```ts
import { buildSnapshotModel, buildCumulativeModel } from '@/lib/sankey/build-flow-model';
import { getRenderer } from '@/lib/sankey/renderers/registry';
```

The route already computes `currentPeriod` (line ~668), `loadTimingActive` (with `buyRate`/`sellRate`), `latestLiveStatus`, `todayRaw`, `todayStart`, and `now`. After `batterySoc` / `batteryStatus` are resolved and **before** the `renderCtx` object is built (line ~731), add:

```ts
        // --- ENERGY-FLOW SANKEY (mirror live/page.tsx data sources) ---
        // Rendered whenever the screen wants it. Rates come from the current
        // tariff period when one resolves, else zero (diagram is sized by
        // energy; rates only color the $ tooltip). Reuses data already in
        // hand — no new fetches.
        let flowSvg: string | undefined;
        if (componentConfig.showEnergyFlow) {
            const rates = loadTimingActive
                ? { buyRate: loadTimingActive.buyRate, sellRate: loadTimingActive.sellRate }
                : { buyRate: 0, sellRate: 0 };
            const renderer = getRenderer(site.sankey_renderer);
            const flowModel = componentConfig.flowBasis === 'snapshot'
                ? buildSnapshotModel(
                    {
                        solar: (latestLiveStatus?.solar_power ?? 0) / 1000,
                        load: (latestLiveStatus?.load_power ?? 0) / 1000,
                        battery: (latestLiveStatus?.battery_power ?? 0) / 1000,
                        grid: (latestLiveStatus?.grid_power ?? 0) / 1000,
                    },
                    { ...rates, timestamp: now, soc: latestLiveStatus?.percentage_charged ?? undefined },
                )
                : buildCumulativeModel(todayRaw, { ...rates, timestamp: now, rangeStart: todayStart });
            flowSvg = renderer(flowModel, 'mono');
        }
```

Add `flowSvg` to the `renderCtx` object (after `loadTiming: loadTimingView`):

```ts
            flowSvg
```

> Note: `site.sankey_renderer` resolves to the only registry entry (`direct`) today; rendering with `theme='mono'` is what makes it 1-bit. When a dedicated `mono-trmnl` renderer lands later, this selection is the single line to change.

- [ ] **Step 4: Add the debug-header flag**

In the `componentDebug` array (line ~769), add a flow entry after the `lt:` line:

```ts
            `flow:${componentConfig.showEnergyFlow ? 1 : 0}`,
            `fb:${componentConfig.flowBasis}`,
```

- [ ] **Step 5: Run the route test to verify it passes**

Run: `npm test -- src/app/api/trmnl/markup/route`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/trmnl/markup/route.ts src/app/api/trmnl/markup/route.test.ts
git commit -m "feat(trmnl): render flow svg in the markup route"
```

---

## Task 7: Settings UI — checkbox + basis select

**Files:**
- Modify: `src/app/trmnl/manage/page.tsx`

This is presentational wiring matching the existing Battery-Level checkbox + mode select. It is verified by `npm run build` / `npm run lint`; there is no unit test for this page (it has none today).

- [ ] **Step 1: Add the flow checkbox + basis select**

In `src/app/trmnl/manage/page.tsx`, inside the `Charts and Tables` grid (after the `Load timing` `Label` block that closes near line 686), add a new block modeled on the `Battery Level` checkbox + select:

```tsx
                                            <div className="space-y-1.5">
                                                <Label className="flex items-start gap-2 text-sm font-normal text-gray-700 dark:text-gray-200 cursor-pointer">
                                                    <Checkbox
                                                        className="mt-0.5"
                                                        checked={editingScreen?.componentConfig.showEnergyFlow ?? false}
                                                        onChange={(e) => updateEditingConfig((prev) => ({ ...prev, showEnergyFlow: e.target.checked }))}
                                                    />
                                                    <span className="leading-tight">Energy Flow Diagram</span>
                                                </Label>
                                                <div className="pl-6">
                                                    <Select
                                                        value={editingScreen?.componentConfig.flowBasis ?? 'cumulative'}
                                                        onChange={(e) => updateEditingConfig((prev) => ({
                                                            ...prev,
                                                            flowBasis: e.target.value === 'snapshot' ? 'snapshot' : 'cumulative'
                                                        }))}
                                                        className="h-8 text-xs py-0"
                                                    >
                                                        <option value="snapshot">Now</option>
                                                        <option value="cumulative">Today</option>
                                                    </Select>
                                                </div>
                                            </div>
```

- [ ] **Step 2: Verify lint + build**

Run: `npm run lint`
Expected: PASS.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/trmnl/manage/page.tsx
git commit -m "feat(trmnl): energy-flow toggle + Now/Today basis in screen editor"
```

---

## Task 8: Characterization snapshots + final verification

**Files:**
- Modify: `src/lib/trmnl/render-full.test.ts`

- [ ] **Step 1: Add flow cases to the snapshot matrix and fix the helper**

In `src/lib/trmnl/render-full.test.ts`, the `makeCfg` helper casts to `TrmnlComponentConfig`, so add the two new fields to its literal (after `showLoadTiming: false,`) for correctness:

```ts
        showEnergyFlow: false,
        flowBasis: 'cumulative',
```

In `makeCtx`, supply a `flowSvg` so the on-cases render content. Add to the returned object (after `loadTiming`):

```ts
        flowSvg: cfg.showEnergyFlow ? '<svg data-test="flow" viewBox="0 0 760 340" preserveAspectRatio="xMidYMid meet"></svg>' : undefined
```

Add these rows to the `MATRIX` array:

```ts
    ['flow-only', { showEnergyFlow: true }],
    ['flow-snapshot-only', { showEnergyFlow: true, flowBasis: 'snapshot' }],
    ['live-chart-flow', { showLiveGrid: true, showLiveSolar: true, showLiveBattery: true, showEnergyChart: true, showEnergyFlow: true }],
    ['bill-plus-flow', { showEstimatedBill: true, showEnergyFlow: true }]
```

- [ ] **Step 2: Run and review the new snapshots**

Run: `npm test -- src/lib/trmnl/render-full`
Expected: FAIL the first time (new snapshots are missing). Re-run with update:

Run: `npm test -- src/lib/trmnl/render-full -u`
Expected: PASS. Then open `src/lib/trmnl/__snapshots__/render-full.test.ts.snap` and eyeball the new `flow-*` / `*-flow` entries: each should contain the `data-test="flow"` SVG inside a height-bounded wrapper, and the `all-off` snapshot should be unchanged.

- [ ] **Step 3: Commit the snapshots**

```bash
git add src/lib/trmnl/render-full.test.ts src/lib/trmnl/__snapshots__/render-full.test.ts.snap
git commit -m "test(trmnl): characterization snapshots for the flow section"
```

- [ ] **Step 4: Full verification**

Run: `npm test`
Expected: PASS (entire suite).

Run: `npm run lint`
Expected: PASS.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Manual device-preview smoke check (optional but recommended)**

Start the dev server (`npm run dev`), open a site's TRMNL manage page, enable **Energy Flow Diagram**, toggle **Now/Today**, and confirm the live preview shows the 1-bit Sankey scaling to fit. Confirms the end-to-end wiring before merge.

---

## Self-Review Notes

- **Spec coverage:** config fields (Task 1), `flowSvg` context (Task 2), mono renderer tweak (Task 3), section + slot (Task 4), layout budget incl. full composability (Task 5), markup route model build mirroring live page (Task 6), settings UI (Task 7), tests incl. snapshots (every task + Task 8). All spec sections map to a task.
- **Type consistency:** `showEnergyFlow` / `flowBasis` / `flowSvg` / `hasFlowSection` / `flowMinHeight` are used identically across tasks. `FlowBasis` is imported from `lib/sankey/flow-model` (already exported there).
- **No new fetches:** Task 6 reuses `loadTimingActive`, `latestLiveStatus`, `todayRaw`, `todayStart`, `now` — all already computed upstream in the route.
