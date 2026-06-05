# Compact Mobile Site Header — Design

**Date:** 2026-06-05
**Status:** Approved for planning
**Area:** `cmd/next-app/src/components/GlobalHeader.tsx`, `HeaderLiveStats.tsx`

## Problem

On mobile the global header consumes too much vertical space. In portrait
(iPhone 15 Pro, 393px) the live-stats card goes full width and wraps to three
internal rows (LIVE/BATTERY, SOLAR/GRID, LOAD), with the nav glyphs forced onto
a fourth full-width row below. In landscape (852px) it collapses to one line but
still reads as a heavy gray card. The header eats dashboard space even when
plenty of horizontal room is available.

Goals (all four matter):
- Reduce vertical height in portrait.
- Reduce visual weight.
- Make better use of available width.
- More consistent layout across portrait/landscape.

## Content priority (from the user)

- Metric importance: **Solar > Grid > Load**. **Battery is optional.**
- Sparklines, text labels, and the full "LIVE" pill are all expendable on small
  screens.

## Approach: Compact inline strip with progressive enhancement

The header becomes a single flex row at **every** width:

```
[logo]   ●  ☀ 1.9   ⚡ 0.0 ↓   ⌂ 2.1  kW          👤 🔔 ⮐
```

Today the nav block is forced to `w-full` on mobile (its own row) and the stats
card is wide enough to wrap. We remove both constraints: the stats strip is
`flex-1 min-w-0` (shrinks gracefully), logo and nav stay `shrink-0`. The same
fundamental layout is used at all widths and progressively enriched — one mental
model across orientations.

### Responsive tiers

Breakpoints are Tailwind defaults (`sm` 640, `md` 768, `lg` 1024). iPhone 15 Pro
portrait ≈ 393px (base), landscape ≈ 852px (`md`).

| Element                         | base (<640) | sm (640+) | md (768+) | lg (1024+) |
|---------------------------------|:-----------:|:---------:|:---------:|:----------:|
| LIVE indicator                  | dot only    | dot+"Live"| dot+"Live"| dot+"Live" |
| Solar / Grid / Load values      | ✅          | ✅        | ✅        | ✅         |
| Battery glyph                   | hidden      | ✅        | ✅        | ✅         |
| Text labels (SOLAR/GRID/LOAD)   | hidden      | hidden    | ✅        | ✅         |
| Sparklines                      | hidden      | hidden    | hidden    | ✅         |

Net effect:
- **Portrait:** tight one-liner — icon + value per metric, no battery, no
  labels, no sparklines.
- **iPhone landscape (md):** labels + values + battery, **no sparklines**
  (slimmer and lighter than today — decided: drop sparklines until desktop).
- **Desktop (lg):** full rich card with labels and sparklines.

Battery is the first element dropped (ranked optional). All visibility is via
Tailwind responsive classes (`hidden sm:inline-flex`, `md:inline`, `lg:block`);
no JS width detection.

### Compact metric rendering

Each metric is a small colored **icon + value**, with a **single shared `kW`**
after the group (instead of three "x.x kW" repetitions):

- Icons are tiny SVGs colored to the existing palette — Solar amber, Grid gray,
  Load blue — matching the current value colors. They replace the text labels on
  small screens while preserving glanceability.
- **Grid keeps a small direction arrow** (↓ import / ↑ export), shown whenever
  `|gridPower|` exceeds a small threshold and hidden when ~0. The sparkline
  previously encoded grid direction by color; since the sparkline is hidden
  below `lg`, this arrow preserves import/export meaning for the #2-priority
  metric. (Decided: yes, show the arrow.)
- Values use the existing `Math.abs(w)/1000` → one-decimal formatting.

### Visual weight

On small screens the strip drops its border and heavy gray fill, keeping only a
barely-there rounded background so it still reads as a tappable target. The
border and card fill return at `md`/`lg`. The whole strip remains a `Link` to
`/site/[id]/live` (unchanged behavior). The header continues to hide the live
stats entirely when already on the live-detail page (`showLiveStats` logic in
`GlobalHeader` is unchanged).

## Code shape

- **New `header-metrics.ts`** — pure `buildHeaderMetricsModel(stats)` that maps
  `SiteLiveData` to a display model: formatted Solar/Grid/Load strings, grid
  direction (`'import' | 'export' | 'none'`), battery percentage and activity.
  This is the cohesive, unit-testable unit; the component becomes a thin
  renderer.
- **`HeaderLiveStats.tsx`** — rewritten to render the responsive strip from the
  model. Polling, loading, and error states are preserved (loading/error render
  in the same compact shell).
- **Three small icon components** (Solar/Grid/Load) — colored SVG glyphs,
  ~14px, consistent stroke with existing nav glyphs.
- **`GlobalHeader.tsx`** — adjust the nav and stats wrappers so the nav no
  longer forces a second row on mobile and the three groups share one row
  (`flex-nowrap`, strip `flex-1 min-w-0`, nav/logo `shrink-0`).

## Testing

Per TDD, write failing tests first against `buildHeaderMetricsModel`:
- Power formatting (W → one-decimal kW; absolute values).
- Grid direction thresholds: import (positive beyond threshold), export
  (negative beyond threshold), none (near zero).
- Battery percentage/activity passthrough.

Responsive Tailwind visibility is not unit-tested (class-only); verified
visually. Existing `MiniSparkline` / `LiveMetricChip` tests must continue to
pass; `npm run lint` and `npm run build` must pass before completion.

## Out of scope

- Moving nav to a bottom bar.
- Changes to the live-detail page header itself.
- Changing the 5-minute polling cadence.

## Open risks

- **Single-row fit at 393px:** logo + LIVE dot + 3 metrics + shared unit + 3 nav
  glyphs is tight. Mitigations baked in: battery dropped, labels/sparklines
  dropped, LIVE text dropped, `flex-1 min-w-0` shrink. If still cramped,
  fallback is reducing nav glyph size on mobile (`w-5` instead of `w-6`).
