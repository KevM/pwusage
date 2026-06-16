# Flexible Plan Comparison Matrix — Design

**Date:** 2026-06-15
**Status:** Design approved (brainstorm), pending spec review
**Branch context:** `feat/roi`. Builds on the comparison-tariff foundation (`2026-06-13-roi-comparison-tariffs-design.md`) and the keep-forever retention change (`src/lib/retention.ts`, 2026-06-15). **Supersedes** the standalone F1 plan (`2026-06-14-roi-comparison-tariffs.md` follow-on / `2026-06-15-roi-f1-fixed-column-pricing.md`) and the old "2b hourly profile" / F2 follow-ons in `TODO.md` — they are folded into the phasing here.

## Problem

The Savings scenario matrix compares system configurations (No Solar / Solar / Solar+Battery) against exactly two *fixed-role* columns: a theoretical **Fixed** baseline and the **actual metered** plan (assumed TOU). It cannot:

- compare against an **arbitrary number** of plans the user defines;
- price a **theoretical TOU** plan (only Fixed comparison is implemented; the TOU editor branch is a placeholder);
- price any column **date-resolved** — all history is priced at one current rate, so years where a plan's rate differed are misstated. The user has had two real TOU plans over time *and* would compare against two fixed rates; neither is currently representable.

Root cause: the matrix prices from `EnergyRollup`, which is bucketed by the *metered* plan's TOU periods and snapshots a single rate. You cannot re-bucket it into a *different* plan's TOU windows, and it isn't date-resolved.

## Goal

A **flexible extended grid**: 3 system configs × **N plan columns** (the user's actual metered plan plus any number of user-defined comparison plans, Fixed or TOU). Every column is priced **date-resolved across full history** — each historical hour priced at that plan's rate in effect on its date. Cells show **cumulative total dollars** over all available history.

## Key decisions (from brainstorming)

1. **Layout = extended grid** (system configs as rows, plans as columns). Not a leaderboard or baseline-savings view (those can layer on later).
2. **All columns date-resolved** across full history (including the actual/metered column).
3. **Cells = cumulative total dollars** over all history (continuity with today's behavior).
4. **One stored substrate — the hourly profile** — replacing `EnergyRollup`. Pricing *and* battery provenance are computed **on read** from it.
5. **Hourly-grain provenance, on read** — the tank cost-basis replay moves from 5-min to hourly buckets; minor intra-hour blur accepted. Raw 5-min `EnergyData` is kept forever, so full-fidelity recompute is always recoverable.
6. **F1 folded in** — the date-resolution *timeline* concept survives but binds to the hourly-profile engine, not `EnergyRollup`.
7. **One column per plan timeline** — "Your plan" is a single column = the metered tariff's effective-dated version timeline (the two real TOU plans stitched by date). Each comparison plan is one column = its own dated-version timeline.
8. **Mobile = transpose to per-plan cards**; desktop = widened grid with a pinned config column and horizontal scroll on overflow.
9. **Hour-alignment caveat accepted** — hourly buckets exactly price any TOU plan with hour-aligned windows (essentially all utility plans); sub-hour windows are documented as unsupported, not engineered for.
10. **Robust plan manager; TOU comparison via clone-and-tweak** — the minimal editor is rebuilt into a multi-plan manager with per-plan/per-version CRUD. There is no schedule-authoring UI today, so TOU comparison plans (and historical metered versions) are created by **cloning an existing tariff and tweaking rates/windows**, not authored from scratch (deferred).

## Architecture

```
Raw EnergyData (5-min, kept forever)
        │  backfill + forward maintenance
        ▼
Hourly profile  ── SOLE stored aggregate, key (site_id, local_date, hour 0–23)
        │         energy only: full per-flow energies + solar-only counterfactual
        │         + actual import/export. No rates, no tank state.
        ├─────────────► Pricing engine (on read): price(planTimeline, profile)
        │                 re-buckets 24 hourly values into the plan's TOU windows,
        │                 date-resolved; Fixed = degenerate flat case.
        └─────────────► Provenance/arbitrage (on read): sequential tank replay over
                          hourly buckets, date-resolved metered rates.
                                   │
                                   ▼
                          Savings tab: extended grid + arbitrage + monthly series
```

`EnergyRollup`, `EnergyRollupRow`, `RollupRepo`, and the period-bucketed rollup *output* of `rollup-service` are **retired**. The `rollup` and `index-history` crons are repointed to build the hourly profile. The provenance replay logic in `battery-provenance/` is reused, re-grained from per-period to hourly.

### Why one substrate is safe here

`EnergyRollup` is **not in production**; its only reader is the Savings tab (`page.tsx`: `buildRoiSummary`, `computeArbitrage`, `monthlyCumulative`). The rest is the write pipeline. So consolidating onto the hourly profile has no production-billing risk and removes a redundant aggregate.

## Data model

### `EnergyHourly` (new) — the sole aggregate

Key: `(site_id, local_date, hour)` where `hour` ∈ 0..23 (local time). Energy in Wh:

```
site_id            text     NOT NULL
local_date         date     NOT NULL   -- 'YYYY-MM-DD', site-local
hour               smallint NOT NULL   -- 0..23, site-local
load_wh            double precision NOT NULL
solar_to_home_wh   double precision NOT NULL
solar_to_battery_wh double precision NOT NULL
solar_to_grid_wh   double precision NOT NULL
grid_to_home_wh    double precision NOT NULL
grid_to_battery_wh double precision NOT NULL
battery_to_home_wh double precision NOT NULL
battery_to_grid_wh double precision NOT NULL
solar_only_import_wh double precision NOT NULL  -- counterfactual: solar, no battery
solar_only_export_wh double precision NOT NULL
PRIMARY KEY (site_id, local_date, hour)
```

- **No `buy_rate`/`sell_rate`** — pricing is on read, date-resolved from the plan timeline.
- **No tank/provenance columns** — provenance is replayed on read.
- `actual_import_wh = grid_to_home_wh + grid_to_battery_wh`; `actual_export_wh = solar_to_grid_wh + battery_to_grid_wh` (derived, not stored, mirroring today's fold).
- DST: `hour` is the site-local clock hour; the backfill assigns each 5-min sample to its local-date/hour. Spring-forward/fall-back hours are handled by the local-time bucketing (a fall-back day has 25 local-hour buckets; spring-forward 23) — pricing is per local hour against the plan's local windows, so this is consistent.

### `Tariff` — already has `effective_from`

The foundation added `effective_from` per version. The metered plan's timeline is its `is_current` + historical versions ordered by `effective_from`. Comparison plans (reporting-only) likewise. The pricing engine builds a **date-resolved schedule** from a version timeline (latest version whose `effective_from ≤ date`, undated = earliest, carry earliest backward / latest forward) — generalizing the F1 `FixedBaseline` rule to full Schedules.

### Retire

`EnergyRollup` table + `EnergyRollupRow` + `RollupRepo`. (Migration drops the table; it holds no production data.)

## Pricing engine

A pure unit: given a **plan timeline** (versions with `effective_from`, each a parsed Schedule) and the hourly profile rows, produce the three config bills (No Solar / Solar / Solar+Battery) summed over history.

```
priceColumn(planTimeline, hourlyRows) -> { noSolar, solar, solarBattery }
  for each hourly row r:
    rate = planTimeline.scheduleOn(r.local_date).rateAt(r.local_date, r.hour)  // {buy, sell}
    noSolar      += r.load * rate.buy
    solar        += r.solar_only_import * rate.buy - r.solar_only_export * rate.sell
    solarBattery += r.actual_import * rate.buy      - r.actual_export * rate.sell
```

- **Fixed plan:** `rateAt` returns the same buy/sell for every hour ⇒ equivalent to multiplying daily/total energy by the flat rate (the F1 result).
- **TOU plan:** `rateAt` resolves the plan's window for `(date, hour)` (season + day-of-week + hour) and returns that window's rate. Hour-aligned windows ⇒ exact.
- **Actual/metered column:** identical call with the metered plan's timeline; this is what makes the actual column date-resolved without re-rolling up (subsumes F2).

The matrix is `priceColumn` mapped over `[meteredTimeline, ...comparisonTimelines]`. Solar/battery value decompositions per column are derived as today (No Solar − Solar, Solar − Solar+Battery, etc.).

## Provenance / arbitrage (on read)

The battery cost-basis "tank" replay (currently in `rollup-service`/`battery-provenance`) is re-grained to consume hourly rows in chronological order, using the date-resolved **metered** rate for grid-charge cost basis. Output feeds the existing `computeArbitrage` shape. Replay is over ~24 × days buckets (e.g. 3 years ≈ 26k) — fast enough on read; memoizable per request.

## Backfill & maintenance

- **Backfill:** build `EnergyHourly` from raw `EnergyData` for all history. Reuse the `index-history` backfill machinery (day-by-day, budgeted), changing its output from period rollups to hourly buckets. Because raw is kept forever, full history is available.
- **Forward:** the daily `rollup` cron computes the prior day's hourly buckets (replacing period-rollup writes).
- **Counterfactual flows:** `solar_only_import/export` are computed by the same provenance replay logic that produces them today, aggregated to hourly instead of per-period.

## UI

### Extended grid (desktop)

- Rows: No Solar / Solar / Solar+Battery. Columns: Your plan (metered) + each comparison plan.
- First column (config labels) is **sticky/pinned**; plan columns scroll horizontally on overflow.
- Column header shows the plan name + a type/sub-label (TOU / Fixed; "metered"). "You are here" marks the metered column × Solar+Battery.
- Per-row highlight of the cheapest cell (modest), preserving today's green-cheaper styling.

### Mobile (transpose)

- Each plan renders as a stacked **card** with its three config rows; the metered card badged "You are here". Cards collapse/expand; comparison cards can be collapsed by default below the metered one.

### Plan management

The current `ComparisonTariffEditor` is minimal (add a flat Fixed plan; TOU is a placeholder; no edit/delete; no per-version management). It is rebuilt into a robust **comparison-plan manager** in the Savings settings.

**Important constraint:** there is **no schedule-authoring UI** in the app today. Metered tariffs' seasons/schedules are *imported from Tesla* (`refresh-tariffs` → `importer/tariff-parser.ts`); `TariffList` only displays them. So TOU plans cannot currently be hand-authored from scratch, and this design does **not** build a from-scratch schedule editor.

**Manager panel** (one section, per site):

- **Your plan (metered)** — shown read-only as a **version timeline** (current + historical versions ordered by `effective_from`), badged "You are here". Rates are not editable here (imported). Includes **"+ add past version"** (see Historical metered entry).
- **Comparison plans** — a list, each a **dated-version timeline**. Per plan: **edit**, **+ version** (append a new effective-dated version), **delete plan**; per version: **edit**, **delete version**. Type badge (Fixed / TOU).
- **Add comparison plan → Fixed** or **TOU**.

**Authoring a Fixed comparison plan** — the existing simple form: name, `effective_from`, buy + sell rate. Mints the flat full-year/all-week chain (the `0..6` day-of-week gotcha) via the existing `fixed-comparison.ts` builder.

**Authoring a TOU comparison plan — clone & tweak** (decided in brainstorming; no from-scratch editor):

- The user picks a **clone source**: their metered plan (any version) or an existing comparison plan. The source's parsed season/schedule structure is **deep-copied** into a new `reporting_only` tariff with a new name + `effective_from`.
- A light **tweak editor** then exposes the cloned structure for adjustment — primarily **per-window buy/sell rates**, and optionally **window start/end times** — without the user building seasons/windows from nothing. Coverage and the `0..6` day-of-week invariant are inherited from the valid source and preserved by construction; the editor must not let a tweak break full-day/full-week coverage.
- This covers the dominant use case ("what if my TOU rates / peak window were different"). Arbitrary brand-new TOU topologies are out of scope until a later from-scratch-editor phase (noted under Out of scope).

**Historical metered entry** — to complete the metered timeline for users who joined after a rate change: **"+ add past version"** clones the current metered tariff into a *new metered version* (not reporting-only), lets the user adjust its rates, and sets its `effective_from` (and thus its derived effective range — it runs until the next version). This is the same clone-and-tweak mechanism, targeting the metered lineage. Because the pricing engine resolves the metered timeline by date, these past versions price the corresponding history correctly.

**Validation:**

- **Name uniqueness** — a comparison plan's name must not collide with the metered plan or another current comparison plan for the site (guards the `(site_id, name) WHERE is_current` index); rejected inline.
- **Version ordering** — `effective_from` values within a lineage should be distinct; the timeline is ordered by date with derived ranges (latest = "current"). Undated = "since the beginning".
- **Coverage** — a TOU plan (cloned) must retain full-day/full-week/full-year coverage so every hour resolves a rate; the tweak editor validates that edits don't open a gap.

**API / repo:** extend `comparison-tariff` route + `ComparisonTariffRepo` beyond flat-Fixed create: clone-from-source (metered or comparison) into a reporting-only TOU tariff, append version, edit version, delete version/plan, and list plans **with their type + full version timeline**. Metered historical-version create reuses the existing metered `TariffRepo` add-version path with an `effective_from`.

## Caveats

- **Hour-aligned TOU only** — sub-hour windows unsupported (documented).
- **Hourly-grain provenance** — intra-hour charge/discharge cycling is blurred in arbitrage P&L; full fidelity recoverable from retained raw data if ever needed.
- **Cumulative totals grow with history length** — acceptable per decision 3; an annualized/time-range view is a possible later layer.

## Testing strategy

- **Hourly bucketing:** raw 5-min samples aggregate into correct local-date/hour buckets, including a DST fall-back (25-bucket) and spring-forward (23-bucket) day.
- **Pricing engine — Fixed parity:** a Fixed plan priced via `priceColumn` equals energy-total × flat rate (regression vs the F1/old scalar math).
- **Pricing engine — TOU bucketing:** a two-window TOU plan prices peak/off-peak energy at the correct rates; hour-aligned windows are exact.
- **Date resolution:** an hour before the earliest version uses the earliest rate; between versions uses the covering version; after the latest carries forward; inclusive on `effective_from`.
- **Actual column = metered timeline:** two metered TOU versions stitched by date produce per-period bills matching hand arithmetic (the F2 correctness goal).
- **Provenance parity (within tolerance):** hourly tank replay reconciles with the 5-min replay to within an accepted tolerance on a sample site.
- **Retirement:** no remaining reader imports `RollupRepo`/`EnergyRollupRow`; build/lint pass.
- **Clone fidelity:** cloning a TOU tariff (metered or comparison) into a reporting-only copy deep-copies every season/schedule; the clone resolves the same period as the source for sample timestamps (Wed/ Sun, peak/off-peak), and tweaking a window rate changes only that window.
- **Validation:** duplicate plan name rejected; a tweak that would drop full-day/full-week coverage is rejected; metered historical version with an `effective_from` prices the covered history at its rate.

## Phasing (each ships working software)

- **Phase B — Hourly profile foundation:** `EnergyHourly` table + migration; backfill from raw (repoint `index-history`); forward maintenance (repoint `rollup` cron); counterfactual flow computation at hourly grain. *(Old EnergyRollup writes kept until Phase C cuts over, or cut in one go — sequencing decided in the plan.)*
- **Phase C — Pricing + provenance on read; retire EnergyRollup:** `priceColumn` engine (Fixed + TOU, date-resolved, incl. metered timeline); on-read provenance/arbitrage from hourly; repoint Savings tab; drop `EnergyRollup`/`RollupRepo`.
- **Phase D — Flexible grid UI + plan management:** extended grid (desktop scroll + mobile cards, N columns, "you are here"); rebuilt comparison-plan manager (list + per-plan/per-version CRUD + name/coverage validation); **clone-and-tweak** authoring for TOU comparison plans and for historical metered versions. (Fixed authoring + version timeline reuse the foundation's editor.) Large enough that the manager + clone-and-tweak may split into its own plan from the grid UI.

Each phase becomes its own implementation plan via the writing-plans skill.

## Out of scope

- Leaderboard / pick-a-baseline views (decision 1 — possible later layers).
- **From-scratch TOU schedule authoring** — building seasons/windows from nothing. TOU comparison plans are created by clone-and-tweak only; arbitrary new TOU topologies wait for a dedicated editor phase.
- Sub-hour TOU windows.
- Annualized / time-range cell views.
- Full consolidation of provenance to a non-replay model (we keep on-read replay).
