# TRMNL chart hour labels: use site timezone, not server timezone

**Date:** 2026-05-22
**Branch:** `fix/trmnl-chart-site-timezone`
**Status:** Approved design

## Problem

The TRMNL e-ink charts label their x-axis with hour ticks ("12am / 6am / 12pm /
6pm"). These tick clock-times are computed from the **process** timezone. On
Vercel (UTC), every site — regardless of physical location — gets ticks anchored
to UTC midnight rather than the site's local midnight. For a California user the
"12am" tick is skewed 7–8 hours from where they perceive midnight.

The bug appears in three spots in `cmd/next-app/src/lib/trmnl/charts.ts`:

1. `buildHourLabelEntries` — `labelTime.setHours(h, 0, 0, 0)` reads process TZ.
   Used by `renderEnergyChart` and `renderSocChart`.
2. `renderBatterySocGlyphStrip` — its private `formatHour` uses `Date.getHours()`.
3. `renderBatterySocGlyphStrip` — its own inline hour loop also uses
   `labelTime.setHours(...)`.

The site's IANA timezone already exists (`Site.timezone`) and is already computed
in the markup route as `const tz = site.timezone || 'UTC'`. It is simply never
threaded into the renderer.

## Approach

Thread the site's IANA timezone from the markup route down to the chart
functions, and compute hour ticks in that zone using `@js-temporal/polyfill` —
the same idiom already used in `src/lib/billing-cycle.ts` for "site-local clock
time → UTC instant" math. Temporal is DST-correct, so a 6am tick lands at the
right x even on spring-forward / fall-back days.

### The cohesive unit

Extract one tz-aware, pure, directly-testable function that both label consumers
share, eliminating the glyph-strip duplication rather than patching each copy:

```ts
interface HourTick {
    epochMs: number;             // UTC instant of the site-local h:00
    label: string;               // "12am" | "6am" | "12pm" | "6pm" | "12am"
}

// Returns the 12am/6am/12pm/6pm/next-12am instants for the site-local day
// containing `startTime`, filtered to [startTime, endTime], computed in
// `timeZone`. Defaults to 'UTC' when timeZone is absent.
function buildHourTicks(startTime: number, endTime: number, timeZone?: string): HourTick[]
```

Consumers:

- `buildHourLabelEntries(startTime, endTime, getX, leftInset, timeZone)` — calls
  `buildHourTicks`, maps each tick to `{ x: getX(epochMs), label, anchor }`, and
  keeps the existing "ensure 12am is visible" fallback logic unchanged.
- `renderBatterySocGlyphStrip` — calls `buildHourTicks` and drops its private
  `formatHour` and inline hour loop.

### Threading the timezone

1. `RenderContext` (`src/lib/trmnl/types.ts`) gains `timezone?: string`.
2. `markup/route.ts` sets `timezone: tz` in the `renderCtx` object.
3. `energy-chart.ts` adds `timeZone: ctx.timezone` to `EnergyChartOptions`;
   `soc.ts` passes `ctx.timezone` into `renderSocChart` and
   `renderBatterySocGlyphStrip` options.
4. The chart functions forward `timeZone` to `buildHourTicks`.

## Error handling / test stability

`timeZone` defaults to **`'UTC'`** when absent (undefined or empty string):
deterministic, matches production, and keeps every existing snapshot stable —
they run under the `TZ=UTC` pin and pass no tz, so they still produce identical
UTC ticks.

The `process.env.TZ = 'UTC'` pin in `vitest.setup.ts` **stays** (belt-and-braces).
Keeping it lets the new tests prove tz-awareness independently of process tz: a
test that pins process TZ to UTC but passes a non-UTC `timeZone` and observes the
ticks move can only pass if the function honors the passed tz.

## Testing (TDD — write failing first)

- **Unit on `buildHourTicks`:** with process `TZ=UTC` (pin) but
  `timeZone='America/Los_Angeles'`, assert the "12am" tick lands at the
  LA-midnight *UTC instant* (08:00 UTC in winter / 07:00 UTC in summer), not
  00:00 UTC. This is the assertion that fails today and proves the fix.
- **DST case:** a spring-forward day in `America/Los_Angeles` to validate Temporal
  correctness (no drift across the transition).
- **`buildHourLabelEntries`:** the same non-UTC tz shifts `x` positions vs UTC.
- **Regression:** existing `charts.test.ts` snapshots remain green (UTC default).

## Files touched

- `cmd/next-app/src/lib/trmnl/charts.ts` — extract `buildHourTicks`; make
  `buildHourLabelEntries` and `renderBatterySocGlyphStrip` tz-aware.
- `cmd/next-app/src/lib/trmnl/types.ts` — add `timezone?` to `RenderContext`.
- `cmd/next-app/src/lib/trmnl/sections/energy-chart.ts` — pass tz.
- `cmd/next-app/src/lib/trmnl/sections/soc.ts` — pass tz.
- `cmd/next-app/src/app/api/trmnl/markup/route.ts` — set `renderCtx.timezone`.
- `cmd/next-app/src/lib/trmnl/charts.test.ts` — new tz-awareness tests.

## Follow-up

Once landed, remove the now-resolved "TRMNL chart hour labels should use site
timezone" item from `TODO.md`.

## Out of scope

- Removing the `TZ=UTC` pin (kept as belt-and-braces).
- The unrelated `timezone_display_mode: 'SITE' | 'BROWSER'` setting on `Site` —
  charts follow the site timezone regardless; browser-relative display is a
  separate concern not raised here.
