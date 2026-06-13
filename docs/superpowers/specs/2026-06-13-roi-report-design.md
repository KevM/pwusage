# ROI Report & Counterfactual Savings (Phase 2)

**Date:** 2026-06-13
**Status:** Design approved, pending spec review
**Branch context:** `feat/roi` — builds directly on the Phase 1 battery-provenance foundation (`2026-06-12-battery-provenance-design.md`).

## Problem

Phase 1 produced `EnergyRollup`: durable, per-tariff-period daily records of energy flows, snapshotted rates, and battery tank state. We can now compute what the home **actually** paid for energy. What we cannot yet answer is the homeowner's real question:

> **Has my solar + Powerwall paid for itself yet, and when will it?**

Answering that requires comparing the actual bill against what the bill *would have been* without the system — a counterfactual — and dividing the cumulative savings against what the hardware cost.

## Goal

A per-site **ROI report** (Layout A "payback dashboard") that shows, for solar, battery, and the combined system:
- cumulative savings to date,
- percent of capital cost recovered,
- a projected break-even date,
- a cumulative-savings curve climbing toward the system-cost line.

Savings are decomposed into a **solar** share and a **battery** share via two counterfactual scenarios.

## Conceptual model

Three cost figures per tariff period, then differenced:

| Scenario | Definition | Source |
|---|---|---|
| **No-system** | grid-only home: all load imported, no solar, no battery | `load_wh × buy_rate` (exact, derivable) |
| **Solar-only** | solar serves load directly; surplus exported, deficit imported; **no battery** | simulated at 5-min, stored (see below) |
| **Actual** | real metered bill reflecting the battery's operation | existing rollup edges × stored rates |

Derived savings:
- `solarValue   = noSystemCost − solarOnlyCost`  (value of having panels)
- `batteryValue = solarOnlyCost − actualCost`    (value of having the Powerwall on top of solar)
- `totalSaved   = noSystemCost − actualCost`      ( = solarValue + batteryValue, by construction)

**Why counterfactuals, not Phase 1 provenance, for the headline.** The battery's value here is `solarOnlyCost − actualCost` — the actual bill already embeds the battery's real operation, so no tank cost-basis is needed to isolate it. Phase 1's provenance (discharge source-split, "banked cheap / spent dear" arbitrage P&L) answers a *different, complementary* question and is **deferred to a later report** (see Out of scope). v1 is counterfactual-only.

### Why the solar-only scenario must be simulated at 5-min, not period grain

A TOU period can span many hours (on-peak is 8am–8pm — 12 hours). Within one period, midday solar surplus and evening load are offset in time. Netting them at period grain (`Σload − Σsolar`) makes it look as if solar covers the evening load — which it cannot without a battery. That **systematically understates `solarOnlyCost`, and therefore understates `batteryValue`**, defeating the goal of isolating the Powerwall. So the solar-only import/export must be accumulated **per 5-min interval** (`net = load − solar` each interval; positive ⇒ import, negative ⇒ export), then summed.

The no-system scenario has no such problem — buy rate is constant within a period, so `load_wh × buy_rate` is exact at any grain.

### Why store the solar-only result durably

5-min `EnergyData` is **not retained** long-term (DB-size policy; it is re-fetchable from Tesla on demand, which is how the Phase 1 backfill already works). We do **not** want the ROI report hitting Tesla on every load. So, mirroring Phase 1's philosophy — *compute high-resolution while the data is fresh, keep the durable aggregate* — the daily rollup computes the solar-only sim at 5-min and stores the per-period result. Because the backfill re-downloads historical 5-min data, **every period, past and future, is exact** — there is no coarse-approximation fallback.

## Data model

### `EnergyRollup` — add two columns (one migration)

```
solar_only_import_wh   integer  NOT NULL DEFAULT 0   -- Wh imported in the solar-only (no-battery) scenario
solar_only_export_wh   integer  NOT NULL DEFAULT 0   -- Wh exported in the solar-only (no-battery) scenario
```

Energies, not dollars — consistent with Phase 1. `solarOnlyCost` is derived at read time as
`solar_only_import_wh × buy_rate − solar_only_export_wh × sell_rate` using the row's already-snapshotted `buy_rate`/`sell_rate` (no frozen dollars, no join). The no-system bill needs no column (`load_wh × buy_rate`); the actual bill comes from existing edge columns.

`NOT NULL DEFAULT 0` is safe because every rollup row is (re)written by the replay, which will always populate these; the default only covers the migration instant before backfill re-runs.

### `SiteRoiConfig` — new table (capital costs)

Owner/investment metadata, distinct from utility rate structure. One row per site, all cost/date fields nullable so a site can configure solar, battery, neither, or both.

```
site_id            text          PK, FK → Site
solar_cost         numeric       NULL   -- net cost after incentives
solar_install_date date          NULL
battery_cost       numeric       NULL   -- net cost after incentives
battery_install_date date        NULL
created_at         timestamptz   NOT NULL DEFAULT now()
updated_at         timestamptz   NOT NULL DEFAULT now()
```

A component (solar / battery) participates in the dashboard only when its cost is set; components without a cost are omitted.

### Explicitly *not* in this phase

- **Fixed / recurring charges** (daily meter/supply charge, monthly service fee) — these belong on the **`Tariff`** model (they are rate-plan attributes that change when you switch tariffs), owned by the future **bill-estimation** feature. They are *not* added here and are *not* in `SiteRoiConfig`. They also largely **cancel** in the ROI counterfactual: a fixed charge is paid in the no-system, solar-only, and actual scenarios alike, so it drops out of every difference. (Exception: utilities that levy a solar-specific fixed fee or minimum bill — a future refinement, noted in Out of scope.)

## Write side — counterfactual simulation

### Pure function

```
simulateSolarOnly(intervals) -> { importWh, exportWh }
  for each 5-min EnergyData row:
    net = load_power - solar_power        // instantaneous, in W; convert to Wh over the interval
    if net > 0: importWh += net           // solar can't cover load -> import
    else:       exportWh += -net          // surplus solar -> export
```

No battery, no tank — purely load vs solar. Lives in `battery-provenance/` (e.g. `counterfactual.ts`), unit-tested in isolation.

### Wiring

- `PeriodRollup` (`replay.ts`) gains `solarOnlyImportWh` / `solarOnlyExportWh`; the per-interval loop accumulates them alongside the existing edge accumulation. `emptyRollup` seeds them to 0.
- `RollupRepo.upsertRollups` grows from 19 → 21 columns (insert + `ON CONFLICT DO UPDATE`).
- No change to the daily rollup cron or the backfill script entry points — they call the same replay, so both paths populate the new columns. Backfill re-downloads 5-min data, so historical rows become exact on re-run. Idempotent upsert is preserved.

## Read side — ROI service

New `roi-service.ts`. Reads all `EnergyRollup` rows for a site (no Tesla calls, no joins) and folds them:

- **Per period:** `noSystemCost`, `solarOnlyCost`, `actualCost` → `solarValue`, `batteryValue`, `totalSaved` (formulas above).
- **Aggregates:** lifetime totals for solar / battery / combined; a **monthly-bucketed cumulative series** for the chart.
- **Projection (whole-history average rate):**
  - `daysOfData = (last local_date − first local_date) + 1`
  - `annualRate = totalSaved / daysOfData × 365`
  - per component: `remaining = cost − savedToDate`; `breakEvenDate = today + remaining / componentAnnualRate`
  - a `lowConfidence` flag when `daysOfData < 365` (partial-season bias) so the UI can caveat the projection.
- Returns a single view-model the dashboard renders directly.

`actualCost` per period = `(grid_to_home_wh + grid_to_battery_wh) × buy_rate − (solar_to_grid_wh + battery_to_grid_wh) × sell_rate`, all from existing columns.

## UI — Layout A (payback dashboard)

New **`roi`** tab in `SiteTabs` (alongside `history` / `bill` / `settings`).

- **Hero:** combined "% recovered", `$ saved of $cost`, projected break-even, progress bar.
- **Twin cards:** ☀️ Solar / 🔋 Battery — each a progress bar, `saved / cost`, projected date.
- **Cumulative savings chart:** monthly points climbing toward a dashed system-cost line (reuse existing charting).
- **Caveat banner** when `lowConfidence` (under a year of data).
- **Empty state:** when no `SiteRoiConfig` cost is set — "Add your system costs to see payback →" linking to Settings.

**Capital-cost entry** lives in the existing **Settings** tab: solar cost + install date, battery cost + install date, persisted to `SiteRoiConfig`.

## Testing

- **Unit — `simulateSolarOnly`:** netting per interval; all-solar (export only), all-load (import only), zero; that period-grain netting would differ (regression guard for the 5-min requirement).
- **Unit — derivations:** the three costs reconcile (`solarValue + batteryValue === totalSaved`); `actualCost` formula; component omission when cost unset.
- **Unit — projection:** annual-rate math, per-component break-even date, `lowConfidence` flag boundary at 365 days.
- **Integration:** a synthetic day through the replay asserts stored `solar_only_import_wh/export_wh`, and that `batteryValue === solarOnlyCost − actualCost`.
- **Idempotency:** re-running the rollup yields identical counterfactual columns.

## Out of scope (future)

- **Phase 1 provenance / arbitrage-P&L report** — discharge source-split and "banked cheap / spent dear" P&L. Complementary lens, separate report.
- **Bill-estimation fixed/recurring charges** — Tariff-level schema + consumption; a queued feature. Documented here only as the home for that metadata.
- **Solar-specific fixed fees / minimum bills** — the one case where fixed charges *don't* cancel in the counterfactual; revisit if a relevant tariff appears.
- **Detailed financial model** — itemized tax credits/rebates, financing interest, panel degradation. v1 takes a single net cost per component.

## Resolved decisions (from brainstorming)

1. **Headline:** whole-system payback ("have solar + Powerwall paid for themselves, and when").
2. **Baseline:** no-system, **plus** battery isolated via a solar-only counterfactual.
3. **Capital costs:** solar and battery captured **separately** (net cost + install date each), in a dedicated **`SiteRoiConfig`** table.
4. **Counterfactual accuracy/durability:** simulate solar-only at 5-min and **store** per-period results on `EnergyRollup` (re-fetch history for backfill ⇒ exact throughout).
5. **Provenance:** **counterfactual-only** for v1; Phase 1 provenance deferred.
6. **Projection:** **whole-history average rate**, with a low-confidence caveat under a year of data.
7. **Fixed charges:** **document the seam, build nothing** — they belong on `Tariff`, owned by bill-estimation, and cancel in the ROI counterfactual.
```
