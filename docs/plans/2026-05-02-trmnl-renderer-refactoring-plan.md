# TrmnlRenderer Refactoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the 1000+ line `TrmnlRenderer` class into smaller, testable, cohesive pure functions (icons, layout engine, components, charts) to enable TDD and improve maintainability.

**Architecture:** We will create a `src/lib/trmnl/` directory. We will extract static SVG assets to `icons.ts`, layout calculations to `layout-engine.ts`, sub-sections to `components.ts`, and SVG charting logic to `charts/*.ts`. Finally, we will refactor the main `TrmnlRenderer` to act only as a coordinator.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Extract Static Icons

**Files:**
- Create: `cmd/next-app/src/lib/trmnl/icons.ts`
- Create: `cmd/next-app/src/lib/trmnl/icons.test.ts`
- Modify: `cmd/next-app/src/lib/trmnl-renderer.ts`

**Step 1: Write the failing test**

```typescript
// cmd/next-app/src/lib/trmnl/icons.test.ts
import { describe, it, expect } from 'vitest';
import { getSunIcon, getGridIcon, getChargingIcon, getDischargingIcon } from './icons';

describe('Trmnl Icons', () => {
    it('returns SVG strings for base icons', () => {
        expect(getSunIcon(40)).toContain('<svg');
        expect(getGridIcon(40)).toContain('<svg');
        expect(getChargingIcon(32)).toContain('<svg');
        expect(getDischargingIcon(32)).toContain('<svg');
    });
});
```

**Step 2: Run test to verify it fails**
Run: `npm run test -- cmd/next-app/src/lib/trmnl/icons.test.ts`
Expected: FAIL (module not found)

**Step 3: Write minimal implementation**
Extract `SUN_ICON`, `GRID_ICON`, `CHARGING_ICON`, `DISCHARGING_ICON` and their `_LARGE` variants, plus `renderGridIcon` and `renderSunIcon` from `trmnl-renderer.ts` into exported functions in `icons.ts`. Update `trmnl-renderer.ts` to import them to keep it building.

**Step 4: Run test to verify it passes**
Run: `npm run test -- cmd/next-app/src/lib/trmnl/icons.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add cmd/next-app/src/lib/trmnl/icons.ts cmd/next-app/src/lib/trmnl/icons.test.ts cmd/next-app/src/lib/trmnl-renderer.ts
git commit -m "refactor: extract static SVG icons to trmnl/icons.ts"
```

---

### Task 2: Extract Layout Engine

**Files:**
- Create: `cmd/next-app/src/lib/trmnl/layout-engine.ts`
- Create: `cmd/next-app/src/lib/trmnl/layout-engine.test.ts`
- Modify: `cmd/next-app/src/lib/trmnl-renderer.ts`

**Step 1: Write the failing test**

```typescript
// cmd/next-app/src/lib/trmnl/layout-engine.test.ts
import { describe, it, expect } from 'vitest';
import { calculateLayoutBudget, LayoutState } from './layout-engine';

describe('Layout Engine', () => {
    it('calculates very dense layout correctly', () => {
        const mockCtx: any = { todayGrid: 10, todaySolar: 10, batterySoc: 50 };
        const mockCfg: any = { showLiveGrid: true, showLiveSolar: true, showLiveBattery: true, showEnergyChart: true, showBatterySoc: true, showEstimatedBill: true };
        const layout: LayoutState = calculateLayoutBudget(mockCtx, mockCfg);
        expect(layout.isVeryDenseLayout).toBe(true);
        expect(layout.billRowsTarget).toBeLessThanOrEqual(2);
    });
});
```

**Step 2: Run test to verify it fails**
Run: `npm run test -- cmd/next-app/src/lib/trmnl/layout-engine.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**
Move the ~100 lines of math calculating `liveDensityScale`, `chartMinHeight`, `socChartMinHeight`, `billRowsTarget`, etc. from `renderFull` into `calculateLayoutBudget`. Define and export the `LayoutState` interface. Update `trmnl-renderer.ts` to call this function and use its outputs.

**Step 4: Run test to verify it passes**
Run: `npm run test -- cmd/next-app/src/lib/trmnl/layout-engine.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add cmd/next-app/src/lib/trmnl/layout-engine.ts cmd/next-app/src/lib/trmnl/layout-engine.test.ts cmd/next-app/src/lib/trmnl-renderer.ts
git commit -m "refactor: extract layout math to trmnl/layout-engine.ts"
```

---

### Task 3: Extract Sub-Components

**Files:**
- Create: `cmd/next-app/src/lib/trmnl/components.ts`
- Create: `cmd/next-app/src/lib/trmnl/components.test.ts`
- Modify: `cmd/next-app/src/lib/trmnl-renderer.ts`

**Step 1: Write the failing test**

```typescript
// cmd/next-app/src/lib/trmnl/components.test.ts
import { describe, it, expect } from 'vitest';
import { renderEstimatedBill } from './components';

describe('Trmnl Components', () => {
    it('renders estimated bill section', () => {
        const mockCtx: any = { showEstimatedBill: true, tariffGroups: [] };
        const mockLayout: any = { billCompactLevel: 0, showBillMetaHeader: true };
        const markup = renderEstimatedBill(mockCtx, mockLayout);
        expect(markup).toContain('<table');
    });
});
```

**Step 2: Run test to verify it fails**
Run: `npm run test -- cmd/next-app/src/lib/trmnl/components.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**
Extract `liveStatsSection`, `billSection`, `emptySection`, and `tariffTables` template logic from `renderFull` into pure functions in `components.ts` (e.g., `renderLiveStatsRow`, `renderEstimatedBill`).

**Step 4: Run test to verify it passes**
Run: `npm run test -- cmd/next-app/src/lib/trmnl/components.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add cmd/next-app/src/lib/trmnl/components.ts cmd/next-app/src/lib/trmnl/components.test.ts cmd/next-app/src/lib/trmnl-renderer.ts
git commit -m "refactor: extract UI components to trmnl/components.ts"
```

---

### Task 4: Extract Chart Generators

**Files:**
- Create: `cmd/next-app/src/lib/trmnl/charts.ts`
- Create: `cmd/next-app/src/lib/trmnl/charts.test.ts`
- Modify: `cmd/next-app/src/lib/trmnl-renderer.ts`

**Step 1: Write the failing test**

```typescript
// cmd/next-app/src/lib/trmnl/charts.test.ts
import { describe, it, expect } from 'vitest';
import { buildSmoothedSocSeriesForChart } from './charts';

describe('Trmnl Charts', () => {
    it('smooths SOC series data', () => {
        const data: any[] = []; // mock data
        const result = buildSmoothedSocSeriesForChart(data, 50, 0, 100);
        expect(Array.isArray(result)).toBe(true);
    });
});
```

**Step 2: Run test to verify it fails**
Run: `npm run test -- cmd/next-app/src/lib/trmnl/charts.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**
Move `renderChart`, `renderSocChart`, `renderBatterySocGlyphStrip`, `buildSocSeriesForChart`, `buildSmoothedSocSeriesForChart`, and `buildHourLabelEntries` into `charts.ts`. Export them and import back into `trmnl-renderer.ts`.

**Step 4: Run test to verify it passes**
Run: `npm run test -- cmd/next-app/src/lib/trmnl/charts.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add cmd/next-app/src/lib/trmnl/charts.ts cmd/next-app/src/lib/trmnl/charts.test.ts cmd/next-app/src/lib/trmnl-renderer.ts
git commit -m "refactor: extract charting logic to trmnl/charts.ts"
```

---

### Task 5: Final Cleanup and Verification

**Files:**
- Modify: `cmd/next-app/src/lib/trmnl-renderer.ts`

**Step 1: Cleanup TrmnlRenderer**
Remove any leftover unused methods or constants in `trmnl-renderer.ts`. Ensure `renderFull`, `renderHalfVertical`, etc., are now clean and purely coordinate the new external functions. Convert `TrmnlRenderer` from a static class to a collection of exported functions if practical, or just leave as a clean class.

**Step 2: Run full build and test suite**
Run: `npm run test && npm run build`
Expected: PASS

**Step 3: Commit**
```bash
git commit -am "refactor: final cleanup of TrmnlRenderer and verify build"
```
