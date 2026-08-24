# Load Affordance UI — Design

**Date:** 2026-08-24
**Status:** Draft (pending spec review)
**Author:** Kevin Miller (with Claude)

## Overview

Surface the "Load timing this cycle" information where it can actually be acted on,
and reframe it around the question users actually ask:

> Can I charge my car right now? Can I run a load of laundry?

Today that information is buried at the bottom of `/site/[id]/live`, expressed as
marginal cost per TOU period. A marginal cost of 12¢/kWh does not tell you whether a
60 kWh car charge is a good idea — that depends on how much **surplus** (net export)
the active period has banked this cycle, because the load is priced at the sell rate
only until the surplus runs out and at the (much higher) buy rate after that.

Three changes:

1. **Reorder** — "Load timing this cycle" moves to the top of the Live view.
2. **A "Can I run this now?" widget** inside that card: pick a load size, see what it
   costs in the active period and in the periods coming up.
3. **A load-headroom glyph** in the live status header: one tinted glyph answering
   "what size load is safe right now?" at a glance, on every page.

All three read from one data-driven table of load profiles and one pure pricing module,
so the header glyph and the widget can never disagree.

## Goals

- Answer "can I run this load now, or should I wait?" without the user doing arithmetic.
- Put the answer on every page (header glyph), with detail one tap away (Live view).
- Make the load definitions **data-driven and easy to reconfigure** — no code changes
  to add a heat pump, no database migration.
- Add **no meaningful DB egress** to `/api/site-live-data`, which PR #108 just optimized.

## Non-Goals (deferred)

- **Persisting load profiles in the database.** Explicitly out of scope. Profiles live in
  a JSON file in the repo. Moving them to `AppSettings` or per-site settings later
  requires changing only the loader, not either surface.
- **Per-site or per-user customization** of load sizes or thresholds.
- **Scheduling or automating** loads. This feature informs; it does not act.
- **TRMNL changes.** The e-ink layout is untouched. New fields on `LoadTimingPeriod` are
  additive and ignored by the TRMNL renderer.
- Exact headroom in the header. The header is deliberately approximate; see
  "Egress and precision".

## Key Decisions (from brainstorming)

| Decision | Choice |
| --- | --- |
| Framing | **Per-load affordance** ("can I run this?"), not per-period marginal cost |
| Live view widget | **Preset buttons + slider**, cost shown per period |
| Header treatment | **Bare tinted glyph pill** — no number; the number is on the Live page |
| Glyph tiers | Read from the profile table; several profiles may share a glyph |
| Load size vs. headroom | `kwh` sets the price, `headroomKwh` sets the verdict and the glyph tier |
| Load config storage | **JSON file in repo**, typed loader. No DB table, no migration |
| Header headroom accuracy | **Approximate**, derived from rows already in memory |
| Section placement | Load timing card moves to **top** of the Live view |

## Load Profiles (data-driven configuration)

A single JSON file drives both surfaces. `kwh` is what the load consumes; `headroomKwh`
is the surplus required before the header glyph will green-light it. They are separate
numbers on purpose — a 60 kWh car charge wants more than 60 kWh of margin before it is
worth calling "safe".

`src/lib/load-profiles.json`:

```json
{
  "profiles": [
    { "id": "car-large",  "label": "Big car",    "kwh": 100, "headroomKwh": 160, "glyph": "car" },
    { "id": "car-small",  "label": "Little car", "kwh": 60,  "headroomKwh": 100, "glyph": "car" },
    { "id": "laundry",    "label": "Laundry",    "kwh": 8,   "headroomKwh": 20,  "glyph": "appliance" },
    { "id": "dishwasher", "label": "Dishwasher", "kwh": 5,   "headroomKwh": 5,   "glyph": "small" }
  ]
}
```

**Several profiles may share a glyph.** A household with a 100 kWh car and a 60 kWh car
gets two entries that both render the car glyph at different thresholds; the list is
expected to grow this way, so nothing keys off glyph uniqueness.

`src/lib/load-profiles.ts` imports the JSON, validates it at module load, and exports a
typed, sorted view:

```ts
export type LoadGlyph = 'car' | 'appliance' | 'small';

export interface LoadProfile {
    id: string;
    label: string;
    kwh: number;          // energy the load consumes
    headroomKwh: number;  // surplus needed before the glyph green-lights it
    glyph: LoadGlyph;
}

export const LOAD_PROFILES: LoadProfile[];       // sorted by headroomKwh, descending
export const MAX_PROFILE_KWH: number;            // drives the slider's upper bound
```

Validation throws at module load — a bad edit fails the build rather than rendering a
broken UI. Rules:

- every field present; `kwh` and `headroomKwh` positive
- `headroomKwh >= kwh` — a profile with less headroom than the load it describes would
  make the glyph contradict the widget (see "Verdicts and headroom")
- `id` unique; `glyph` one of the registered icons
- **no uniqueness requirement on `glyph`** — many profiles per glyph is the expected case

Because the list is sorted at load time and both surfaces iterate it, adding a profile is
a one-row edit that appears in the widget's presets and the glyph tiers simultaneously.

Adding a *new icon* is necessarily code — an SVG has to exist — but it is confined to one
place: `LoadHeadroomGlyph` holds a `Record<LoadGlyph, ComponentType>` registry, so a new
icon means one SVG plus one entry plus one member on the `LoadGlyph` union.

## Core Module: `src/lib/load-affordance.ts`

Pure, no IO, fully unit-tested. The single source of truth for load pricing.

```ts
export interface PeriodPricing {
    surplusKwh: number;   // cycle net export for the period; negative means deficit
    buyRate: number;
    sellRate: number;
}

export interface LoadCost {
    total: number;
    coveredKwh: number;   // priced at the sell rate
    boughtKwh: number;    // priced at the buy rate
    verdict: 'covered' | 'tight' | 'partial' | 'bought';
}

export function costToRun(loadKwh: number, pricing: PeriodPricing, headroomKwh?: number): LoadCost;
export function glyphForHeadroom(surplusKwh: number): LoadGlyph | null;
export function profileForHeadroom(surplusKwh: number): LoadProfile | null;
```

`costToRun` implements the whole idea:

```
covered = min(loadKwh, max(surplusKwh, 0))
bought  = loadKwh - covered
total   = covered * sellRate + bought * buyRate
```

A 60 kWh car charge against a 10 kWh Peak surplus at 12¢ sell / 48¢ buy is
10 × 0.12 + 50 × 0.48 = **$25.20**; the same charge in an Off-peak period holding a
120 kWh surplus at 3¢ is **$1.80**.

`profileForHeadroom` returns the first profile whose `headroomKwh` the surplus clears
(the list is pre-sorted descending), or `null` for "avoid large loads";
`glyphForHeadroom` is that profile's glyph. With several profiles sharing a glyph, the
selected profile is what the tooltip names, so "Little car" and "Big car" are
distinguishable even though the icon is the same.

### Verdicts and headroom

The dollar figure depends only on `kwh` — how much of the load clears at the sell rate
before crossing into buy-rate territory. The **verdict** additionally consults
`headroomKwh`, because a load can be fully affordable and still empty the buffer that has
to last the rest of the cycle:

| Condition | Verdict |
| --- | --- |
| `surplus >= headroomKwh` | `covered` |
| `surplus >= loadKwh` but `< headroomKwh` | `tight` |
| `0 < surplus < loadKwh` | `partial` |
| `surplus <= 0` | `bought` |

`covered` and `tight` cost identical dollars — that is the point. For a 60 kWh car charge
with `headroomKwh: 100`, a 120 kWh surplus is `covered` and a 70 kWh surplus is `tight`,
both priced entirely at the sell rate. Without the distinction the header glyph (which
withholds the car below 100) would contradict a green widget tile at 70 kWh.

When `headroomKwh` is omitted — a custom slider amount with no matching profile —
`covered` and `tight` collapse into `covered`.

## Surface 1 — Live View

### Reorder

`LiveDetailView` renders the Load timing card first. New order: **Load timing → Today
chart → Today so far → Sankey → Battery hold.**

### "Can I run this now?" widget

A client component inside the Load timing card, below the existing period grid:

- Preset buttons rendered from `LOAD_PROFILES` in a **wrapping** chip row — the list is
  expected to grow past the three or four seeded entries, so it must not assume a single
  line — plus a slider (1 → `MAX_PROFILE_KWH`, step 1) for custom amounts. Selecting a
  preset carries its `headroomKwh` into the verdict; dragging the slider does not.
- A cost tile per TOU period, active period first, each showing `costToRun` for the
  selected size, colored by verdict, and labelled with the period's `nextStartPhrase`
  ("in 2h 10m") so "wait" is an obvious option. The tile's mini bar always shows the
  exact sell/buy split, so `covered` and `tight` differ in label colour while the bar
  keeps reporting the same underlying arithmetic.
- All arithmetic is client-side off data already sent to the page. No new fetch, no
  server round-trip on slider movement.

### Supporting change

`LoadTimingPeriod` in `src/lib/load-timing.ts` gains `buyRate` and `sellRate`. Both
values already exist on the grouped rows inside `computeLoadTiming`; they are simply not
exposed today, and the widget cannot price a load without both sides of the cliff. Purely
additive — existing consumers and the TRMNL renderer are unaffected.

## Surface 2 — Header Glyph

`HeaderLiveStats` gains a glyph pill at the end of the metrics strip: a Tabler-style
outline glyph on a tinted background, no number. Green for car/appliance, amber for
small, red for avoid-large-loads. The `title` attribute names the selected profile and
the surplus ("Peak · 70 kWh surplus — Little car"), which is what disambiguates two
profiles sharing one icon. The strip already links to `/site/[id]/live`, where the exact
numbers live.

Note the limit honestly: `title` is a hover affordance, so on touch devices the glyph
conveys only its category and the specific profile is revealed by tapping through to the
Live view. That is the intended division — glyph for the glance, page for the detail —
but it does mean the icon alone cannot distinguish a big car from a little one on a
phone.

The four glyphs are hand-authored 24×24 outline SVGs matching the existing `SolarIcon` /
`GridIcon` style in that file — heroicons has neither a car nor a washing machine. The
pill is omitted entirely when the site has no tariff or headroom is unavailable.

## Surface 3 — API and Egress

`/api/site-live-data` gains one field:

```ts
loadHeadroom: {
    surplusKwh: number;
    periodName: string;
    glyph: LoadGlyph | null;
    profileLabel: string | null;   // names the tier the surplus cleared, for the tooltip
} | null;
```

### Egress and precision

This route is polled every 5 minutes per visible tab, and PR #108 was specifically about
cutting its egress. Measured against the dev snapshot using the worst-case site (30
schedule rows, 27 days into its cycle); figures are Postgres text-representation bytes,
a close proxy for node-pg wire bytes:

| Query | Rows | Bytes |
| --- | --- | --- |
| *Current* bucketed 24h (sparklines) | 95 | 8.7 KB |
| Naive: cycle aggregates (27 days) | 105 | 5.4 KB |
| Naive: today's raw rows | 225 | 14.5 KB |
| Naive: all-version schedules | 30 | 1.1 KB |
| Naive: tariff versions | 1 | 0.08 KB |

The naive approach adds **~21 KB per poll, ~3.4× the route's current energy-query
egress** — roughly 6 MB/day for a tab left open. Rejected.

Instead:

- **Today's contribution costs nothing.** The sparkline query already spans a rolling
  24 hours, and site-local midnight is never more than 24 hours ago, so today's rows are
  *already in memory*. The active period's today-so-far energy is derived by filtering
  those bins to `timestamp >= siteMidnight`, attributing each to a TOU period, and
  summing `avg_grid_power × 3` (three 5-minute samples per 15-minute bin). No query
  changes at all.
- **Prior days are cached to the day boundary.** Cycle aggregates for completed days
  change only at site-local midnight, so an in-process memo keyed on
  `(siteId, siteMidnight)` — the same per-instance caching pattern as the pooled `pg`
  client from PR #105 — pays 5.4 KB once per site per day on a warm instance.

**Steady-state addition: ~0 KB per poll**, plus ~6.5 KB per site per day on cold starts.

The tradeoff, stated plainly: the header number is approximate. `avg × 3` over-counts
any partial bin (the in-progress one) and any bin with missing samples, and 15-minute
bins are coarser than the 5-minute samples the Live page uses. The error is small
relative to tier boundaries at 100 / 20 / 0 kWh, and this value only ever selects a
glyph — it is never displayed as a number. The Live page continues to run the exact
`computeLoadTiming` computation it runs today. Where the two could visibly disagree is a
site sitting within a kilowatt-hour or two of a threshold; the glyph may lag the Live
page by one bin. That is acceptable for a four-state indicator.

## Error Handling and Edge Cases

| Case | Behavior |
| --- | --- |
| No tariff configured | No glyph; widget shows the existing "configure a tariff" prompt |
| No cycle data yet | No glyph; existing "no cycle data" message stands |
| No active TOU period (schedule gap) | No glyph; widget still prices the upcoming periods |
| Surplus below the smallest threshold (incl. deficit) | Avoid-large-loads glyph; in deficit every kWh is priced at the buy rate |
| `sellRate` missing/zero | Falls out of `costToRun` naturally — covered portion costs 0 |
| Malformed `load-profiles.json` | Throws at module load; build fails |

## Testing

Unit tests (Vitest, co-located):

- `load-affordance.test.ts` — `costToRun` across covered / tight / partial / bought,
  including the worked car-charge example above; the `covered` vs `tight` pair asserting
  identical totals with differing verdicts; omitted `headroomKwh` collapsing to
  `covered`; zero and negative surplus; zero rates. `profileForHeadroom` and
  `glyphForHeadroom` at and either side of every threshold, including the empty-profile
  and deficit cases, and a two-profiles-one-glyph fixture asserting the *profile*
  resolves distinctly where the glyph does not.
- `load-profiles.test.ts` — the shipped JSON validates and sorts descending by
  `headroomKwh`; fixtures violating each rule throw (missing field, non-positive `kwh`,
  `headroomKwh < kwh`, duplicate `id`, unknown `glyph`); a fixture with two profiles
  sharing a glyph is accepted.
- Header-headroom derivation — bin attribution and the `avg × 3` conversion against a
  fixture of bucketed rows, including a partial trailing bin and a gap, asserting the
  approximation lands in the same tier as the exact computation.
- `load-timing.test.ts` — extended to assert `buyRate` / `sellRate` are exposed and that
  existing assertions still hold.

Existing TRMNL tests must stay green unchanged — that is the check that the
`LoadTimingPeriod` addition really is additive.

Then `npm test`, `npm run lint`, `npm run build`.

## Files

**New**
- `src/lib/load-profiles.json`
- `src/lib/load-profiles.ts`
- `src/lib/load-affordance.ts` (+ test)
- `src/components/site/live/RunLoadNowWidget.tsx`
- `src/components/ui/LoadHeadroomGlyph.tsx`

**Modified**
- `src/lib/load-timing.ts` — expose `buyRate` / `sellRate`
- `src/components/site/live/LiveDetailView.tsx` — reorder
- `src/components/site/live/PeriodCardRow.tsx` — mount the widget
- `src/app/api/site-live-data/route.ts` — `loadHeadroom` field + day-boundary memo
- `src/lib/site-live-data-client.ts` — type
- `src/components/HeaderLiveStats.tsx` — glyph pill
- `src/lib/header-metrics.ts` — carry headroom into the model
