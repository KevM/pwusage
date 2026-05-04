# TrmnlRenderer Refactoring Design

## Overview
The `TrmnlRenderer` class has grown into a monolithic "God Type" (1000+ lines) mixing layout calculations, SVG asset definitions, chart generation, and HTML templating. This makes it difficult to maintain and test. This design proposes a functional decomposition approach to break the renderer into cohesive, testable modules.

## Goals
- Increase testability, enabling TDD for layout math and chart logic.
- Simplify `TrmnlRenderer` by extracting concerns.
- Improve modularity for future component additions.

## Architecture & File Structure
The refactoring will introduce a new `src/lib/trmnl/` directory within `cmd/next-app/`.

- `src/lib/trmnl-renderer.ts`: Remains the entry point but acts only as a coordinator.
- `src/lib/trmnl/layout-engine.ts`: Contains pure functions for calculating pixel budgets and component flags.
- `src/lib/trmnl/icons.ts`: Holds static SVG asset generators.
- `src/lib/trmnl/charts/`: Directory for complex SVG data visualization.
  - `energy-chart.ts`
  - `soc-chart.ts`
  - `soc-glyphs.ts`
- `src/lib/trmnl/components.ts`: Functions for HTML snippet generation (e.g., Live Stats, Bill).

## Data Flow
1. `TrmnlRenderer.renderFull(ctx)` is invoked.
2. It calls `calculateLayoutBudget(ctx, config)` from the `layout-engine`, receiving a `LayoutState` object.
3. It passes both `ctx` and `LayoutState` to pure component functions (e.g., `renderLiveStats(ctx, layout)`).
4. The individual template strings are concatenated into the main view and returned.

## Testing Strategy
- **Layout Engine**: Tested purely on configuration permutations.
- **Charts**: Data smoothing and path generation can be tested in isolation.
- **Components**: Can be tested independently for correct HTML structure based on layout flags.
