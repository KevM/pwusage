# ROI Report, Real-World Counterfactuals & Arbitrage Estimate (Phase 2)

**Date:** 2026-06-13
**Status:** Design approved, pending spec review
**Branch context:** `feat/roi` — builds on the Phase 1 battery-provenance foundation (`2026-06-12-battery-provenance-design.md`).

## Problem

Phase 1 produced `EnergyRollup`: durable, per-tariff-period daily records of energy flows, snapshotted rates, and battery tank state (origin + cost basis of stored energy). We can now compute what the home **actually** paid. What we cannot yet answer is the homeowner's real question:

> **Has my solar + Powerwall paid for itself yet, and when will it — versus the choices a normal household would actually make?**

Answering it requires comparing the actual bill against the **realistic alternatives** (not a strawman), and decomposing the savings, while also exposing *where* the battery's savings come from and where it quietly loses money.

## Goal

A per-site report with two surfaces:

1. **Payback dashboard** (Layout A) — for solar, battery, and combined: cumulative savings to date, % of capital cost recovered, projected break-even date, and a cumulative-savings curve climbing toward the system-cost line. Savings are measured against the **real-world decision ladder** below.
2. **Estimated arbitrage panel** — a clearly-labeled *estimate* (matching the `EstimatedBillView` convention) of where the battery's value came from: discharge source-split, net arbitrage P&L, and flags for losing cycles (e.g. Storm Watch grid-charging). This is what finally puts Phase 1's tank provenance to work.

## Conceptual model — the scenario matrix

The report rests on a 2×3 matrix: **system** (No Solar / Solar, no battery / Solar + Battery) × **rate plan** (Fixed flat / TOU). Every cell is a bill computable from already-stored data — physical flows priced under a plan — so the whole matrix is read-side only (no storage beyond the two `solar_only` columns).

|  | Fixed (flat) | TOU |
|---|---|---|
| **No Solar** | A · `load_wh × fixedBuy` — exact | B · `Σ load_wh × buy_rate` — exact |
| **Solar, no battery** | C · solar-only flows × flat — exact | D · solar-only flows × TOU — exact |
| **Solar + Battery** | E · **actual** flows × flat — good¹ | F · **actual metered bill** (TOU) — actual |

¹ Cell E prices the real (TOU-optimized) battery flows at the flat rate — "my exact usage, billed flat." It diverges from a truly flat-optimized battery only by (a) round-trip losses on grid-charged energy and (b) rare missed solar-to-battery storage, because under a flat rate a grid charge→discharge cycle is just **time-shifting an import, and time has no price on a flat plan**. Both leaks are second-order; shown with a one-line footnote. (A truly flat-optimal dispatch would need a battery re-simulation — out of scope, and unnecessary given how small the gap is.)

### Headline payback — the realistic diagonal

A no-battery household would **not** rationally sit on TOU (nothing to shift ⇒ TOU only hurts; cell D > cell C, which the matrix shows). So the payback headline runs the diagonal of choices people actually make: **A → C → F**.
- `solarValue   = A − C`  — both on the **fixed** plan; what panels save a flat-rate household.
- `batteryValue = C − F`  — the battery **and** the TOU plan it unlocks (bundled: the battery is what earns the right to be on TOU).
- `totalSaved   = A − F   = solarValue + batteryValue` (by construction).

### Secondary — splitting battery hardware from the TOU plan

The full matrix additionally lets us decompose `batteryValue` along the bottom row, holding the system fixed:
- `batteryHardwareValue = C − E`  — adding the battery while staying on flat (self-consumption value).
- `touPlanValue         = E − F`  — switching to TOU given you have the battery (the arbitrage value the plan unlocks).
- `batteryHardwareValue + touPlanValue = C − F = batteryValue` (E cancels).

This answers the rate-plan question ("is TOU actually beating flat for my system?") separately from the hardware question, using cell E's "good" estimate.

**Physical flows are rate-agnostic.** Solar-only import/export Wh and the actual edge flows are the same regardless of which plan prices them, so the data model stores energies once and the read side prices every cell under the right plan.

### Why the solar-only flows must be simulated at 5-min, not period grain

A TOU period can span many hours (on-peak 8am–8pm). Within one period, midday solar surplus and evening load are offset in time; netting them at period grain (`Σload − Σsolar`) pretends solar covers the evening — impossible without a battery — which **understates cells C/D and therefore the battery's value.** So solar-only import/export is accumulated **per 5-min interval** (`net = load − solar`; positive ⇒ import, negative ⇒ export), then summed. (The No-Solar cells have no such issue — load × rate is exact at any grain.)

### Why store the solar-only result durably

5-min `EnergyData` is **not retained** long-term (DB-size policy; it is re-fetchable from Tesla, which the Phase 1 backfill already does). We don't want the report hitting Tesla on every load. So, mirroring Phase 1 — *compute high-resolution while the data is fresh, keep the durable aggregate* — the daily rollup computes the solar-only sim at 5-min and stores the per-period result. Because the backfill re-downloads history, **every period, past and future, is exact** — no coarse fallback.

### Why the arbitrage panel needs Phase 1 (and the payback number doesn't)

Two different questions:
- **"Is the battery worth it?"** (payback) → `C − F`. Answered by re-pricing the matrix; needs **no** provenance. It is also the *correct* measure — it automatically absorbs round-trip losses, which a naive provenance P&L overstates.
- **"Is the battery being used *well* — where does its value come from, where does it lose money?"** (arbitrage estimate) → needs the tank's **cost basis**, because it scores each charge→discharge as a trade. This is the only *actionable* part of the report (e.g. "Storm Watch cost you $148 — limit it to storm season"), and it directly serves `GOALS.md`'s optimization mission.

## Data model

### `EnergyRollup` — add two columns (one migration)

```
solar_only_import_wh   integer  NOT NULL DEFAULT 0   -- Wh imported, solar-only (no-battery) scenario, 5-min sim
solar_only_export_wh   integer  NOT NULL DEFAULT 0   -- Wh exported, solar-only (no-battery) scenario, 5-min sim
```

Energies, not dollars — consistent with Phase 1. Priced at read time under whichever plan each cell uses. `NOT NULL DEFAULT 0` is safe: the replay always (re)writes these; the default only covers the migration instant before backfill re-runs.

### `SiteRoiConfig` — new table

Owner/investment metadata **plus** the chosen fixed-plan rates (the realistic flat plan a no-battery household would be on). One row per site; cost/date fields nullable so a site can configure solar, battery, neither, or both.

```
site_id              text          PK, FK → Site
solar_cost           numeric       NULL   -- net cost after incentives
solar_install_date   date          NULL
battery_cost         numeric       NULL   -- net cost after incentives
battery_install_date date          NULL
fixed_buy_rate       numeric       NULL   -- $/kWh import on the flat plan (cells A, C, E)
fixed_sell_rate      numeric       NULL   -- $/kWh export/NEM credit on the flat plan (cells C, E)
created_at           timestamptz   NOT NULL DEFAULT now()
updated_at           timestamptz   NOT NULL DEFAULT now()
```

A component participates in the dashboard only when its cost is set; the payback/decomposition requires the fixed-rate fields to be set (otherwise the dashboard shows an empty state prompting for them).

**Keying stays Phase-1-pure.** `EnergyRollup` remains keyed by the **active** `tariff_schedule_id` only. Comparison/ROI tariff schedules **never** FK or key it; all counterfactual pricing is read-time arithmetic over the plan-agnostic stored energies. (Pricing a *different* TOU schedule — shifted peak windows — needs a finer plan-agnostic grain than the rollup holds; that's the Phase 2b hourly profile, kept entirely separate.)

### Explicitly *not* in this phase

- **Fixed / recurring monthly charges** (daily meter/supply charge, service fees) — they belong on the **`Tariff`** model, owned by the future **bill-estimation** feature. They **cancel between the fixed-plan cells** (so `solarValue = A − C` is unaffected), but the fixed-vs-TOU plan *difference* would land in `batteryValue`/`totalSaved`. v1 is **energy-only**; this difference is a documented refinement.
- **Solar-specific fixed fees / minimum bills** — the case where even cell F's fixed charges diverge from the flat plan; future.
- **Literal per-cycle trade detection / precise "Storm Watch" labeling** — v1 flags losing cycles by a derivable heuristic (below), not by reconstructing discrete charge/discharge events.
- **Round-trip-loss line item** — derivable (cumulative charge Wh − discharge Wh, valued at blended basis) but a later refinement; v1's payback already absorbs losses correctly.

## Write side — counterfactual simulation

### Pure function

```
simulateSolarOnly(intervals) -> { importWh, exportWh }
  for each 5-min EnergyData row:
    net = load_power - solar_power      // W; integrate over the interval to Wh
    if net > 0: importWh += net         // solar can't cover load -> import
    else:       exportWh += -net        // surplus solar -> export
```

No battery, no tank — purely load vs solar. Lives in `battery-provenance/` (e.g. `counterfactual.ts`), unit-tested in isolation.

### Wiring

- `PeriodRollup` (`replay.ts`) gains `solarOnlyImportWh` / `solarOnlyExportWh`; the per-interval loop accumulates them alongside the existing edge accumulation. `emptyRollup` seeds them to 0.
- `RollupRepo.upsertRollups` grows 19 → 21 columns (insert + `ON CONFLICT DO UPDATE`).
- No change to cron/backfill entry points — both call the same replay, so both populate the new columns. Backfill re-downloads 5-min ⇒ historical rows become exact on re-run. Idempotent upsert preserved.

## Read side

### ROI / payback (`roi-service.ts`)

Reads all `EnergyRollup` rows + `SiteRoiConfig` (no Tesla calls, no joins) and folds:

- **Per period — the six matrix cells** (let `actualImport = grid_to_home_wh + grid_to_battery_wh`, `actualExport = solar_to_grid_wh + battery_to_grid_wh`):
  - `A = load_wh × fixedBuy`
  - `B = load_wh × buy_rate`
  - `C = solar_only_import_wh × fixedBuy − solar_only_export_wh × fixedSell`
  - `D = solar_only_import_wh × buy_rate − solar_only_export_wh × sell_rate`
  - `E = actualImport × fixedBuy − actualExport × fixedSell`
  - `F (actual) = actualImport × buy_rate − actualExport × sell_rate`  (TOU snapshotted rates)
- **Decompositions:** `solarValue = A − C`; `batteryValue = C − F`; `totalSaved = A − F`. Secondary: `batteryHardwareValue = C − E`; `touPlanValue = E − F`.
- **Aggregates:** lifetime totals (solar / battery / combined, plus the hardware/TOU split) + a **monthly-bucketed cumulative series** for the chart.
- **Projection (whole-history average rate):** `annualRate = totalSaved / daysOfData × 365`; per component `breakEvenDate = today + (cost − savedToDate) / componentAnnualRate`; a `lowConfidence` flag when `daysOfData < 365` (partial-season bias).
- **Plan classification & recommendation:** `classifyTariff(activeTariff)` → `fixed | TOU`, by whether the schedule's buy rates vary across the day. Marks the user's *actual* matrix cell (E if fixed, F if TOU) — detected, not assumed. For a TOU user, if cell E < cell F, surface a "consider a flat plan (~$X/yr)" recommendation; this is robust because cell E's bias *overstates* flat cost, so it can't false-positive. (A fixed user's "should I switch to TOU?" needs a comparison TOU schedule + the hourly profile — Phase 2b.)

### Arbitrage estimate (`arbitrage-service.ts`)

Per period, drawing on the Phase 1 tank (entry tank = the prior period's stored tank state, per the Phase 1 derivation rules):

- **Discharge** = `battery_to_home_wh + battery_to_grid_wh`.
- **Source split** = entry-tank ratio: `solarFraction = entry.tank_solar_wh / (entry.tank_solar_wh + entry.tank_grid_wh)`.
- **Discharge benefit** = `battery_to_home_wh × buy_rate + battery_to_grid_wh × sell_rate` (avoided import + export credit at the discharge period's rates).
- **Discharge cost basis** = `discharge_wh × (entry.tank_cost / entry.tank_wh)` (blended $/Wh of stored energy).
- **Net arbitrage P&L** = benefit − cost basis; summed to month/year/lifetime.
- **Losing-cycle flag (heuristic, derivable):** periods where per-kWh cost basis ≥ per-kWh benefit — i.e. the battery discharged energy that cost more to store than it captured. This catches Storm Watch (expensive on-peak grid charging) and similar without storing extra signals. Labeled generically ("losing cycle — likely expensive grid charging"); precise Storm-Watch attribution is out of scope.
- Presented **as an estimate** (clear "Estimated" framing, like the monthly bill), not as a competing payback figure.

## UI

New top-level **`savings`** tab in `SiteTabs`, labeled **"Savings"** (alongside `history` / `bill` / `settings`). Both surfaces — payback dashboard and estimated arbitrage panel — live on this one page. (`TabId` union and the `localStorage` last-tab list both gain `savings`.)

- **Payback hero:** combined "% recovered", `$ saved of $cost`, projected break-even, progress bar.
- **Scenario-matrix comparison:** the 2×3 grid of bills (system × plan), with the realistic diagonal (A→C→F) emphasized and cell E footnoted. The user's actual plan cell is marked **"you are here"** (from plan detection, not assumed); the cheaper option in their system row is highlighted, with a plan-switch recommendation banner when it isn't their current plan. Makes both the savings steps and the rate-plan question (E vs F) explicit. (A fixed user sees the TOU column as a "define a TOU plan to compare" prompt → 2b.)
- **Twin component cards:** ☀️ Solar / 🔋 Battery — progress bar, `saved / cost`, projected date.
- **Cumulative savings chart:** monthly points climbing toward a dashed system-cost line.
- **Estimated arbitrage panel:** net P&L, discharge source-split bar, losing-cycle flags — under an "Estimated" heading.
- **Caveat banner** when `lowConfidence`. **Empty state** when costs/fixed-rates unset → links to Settings.

**Settings tab** gains the `SiteRoiConfig` form: solar cost + install date, battery cost + install date, fixed-plan buy + sell rate.

## Testing

- **Unit — `simulateSolarOnly`:** per-interval netting; all-solar (export only), all-load (import only), zero; a period-grain-would-differ guard (protects the 5-min requirement).
- **Unit — payback derivations:** all six cell costs; `solarValue + batteryValue === totalSaved` and `batteryHardwareValue + touPlanValue === batteryValue` (E cancels); cell-F actual-cost formula; cell D > C on a TOU-unfriendly solar-only day; component omission when cost/fixed-rate unset; projection + break-even + `lowConfidence` boundary at 365 days.
- **Unit — arbitrage:** source-split from entry tank; benefit vs cost-basis P&L; losing-cycle flag fires on an expensive-grid-charge period and not on a normal off-peak→on-peak cycle.
- **Integration:** a synthetic day through the replay asserts stored `solar_only_import_wh/export_wh`; `batteryValue === C − F`; a Storm-Watch day raises a losing-cycle flag.
- **Idempotency:** re-running the rollup yields identical counterfactual columns.

## Deferred to Phase 2b — plan-agnostic hourly profile & TOU-to-TOU what-ifs

The highest-value follow-on: let the user test **alternative TOU schedules** — e.g. "my utility lets me pick my on-peak window; is 6am–6pm better than 7am–7pm?" Re-pricing under *different time windows* needs energy at a **re-bucketable, plan-agnostic grain**, which the period-keyed `EnergyRollup` structurally cannot provide.

- **New artifact:** a durable **hourly energy profile** — `(site_id, local_date, hour)` → `load_wh`, `solar_only_import/export_wh`, `actual_import/export_wh`. Plan-agnostic, ~24 rows/day (heavily compressed vs 5-min), populated in the same rollup pass (5-min netting preserved within each hour). Prices **any** plan — flat, current TOU, or a shifted-peak TOU — by re-bucketing hours into its periods at read time.
- **Comparison plans reuse the tariff editor:** a candidate schedule is a `Tariff` flagged reporting-only, used purely as a read-time bucketing spec — never referenced by any rollup.
- **Migration note:** when 2b lands, the `solar_only_*` columns move from `EnergyRollup` to the hourly profile (single counterfactual substrate), reverting `EnergyRollup` to exactly Phase 1. v1 accepts that small rework as the cost of shipping payback sooner.
- **Caveat:** the Solar+Battery what-if is behavior-fixed (re-pricing actual flows under new windows; a real window change would also re-tune the Powerwall). Directional, exact for the No-Solar/Solar-only rows. Matches the "expose estimates" philosophy.

## Out of scope (future)

- **Bill-estimation fixed/recurring charges** — Tariff-level schema + consumption; documented here only as the metadata home.
- **True flat-optimal battery re-dispatch** for cell E — v1 uses the "actual flows × flat" estimate instead (the gap is only round-trip loss + rare missed-solar).
- **Solar-specific fixed fees / minimum bills**, **round-trip-loss line item**, **literal per-cycle trade detection / precise Storm-Watch labeling**, **detailed financial model** (itemized credits, financing, degradation).

## Resolved decisions (from brainstorming)

1. **Headline:** whole-system payback ("have solar + Powerwall paid for themselves, and when").
2. **Baseline:** a full **2×3 scenario matrix** (system × Fixed/TOU). Headline payback runs the realistic diagonal (No Solar/Fixed → Solar/Fixed → Solar+Battery/TOU), not a same-tariff strawman. All six cells are read-side only; cell E (Solar+Batt on Fixed) is a "good" estimate (actual flows × flat) with a small round-trip-loss footnote, enabling a secondary battery-hardware-vs-TOU-plan split.
3. **Capital costs:** solar and battery captured **separately** (net cost + install date), in a dedicated **`SiteRoiConfig`** table.
4. **Fixed-rate source:** a **manual flat buy + sell rate** in `SiteRoiConfig` (the realistic plan a no-battery household would choose).
5. **Counterfactual accuracy/durability:** simulate solar-only at 5-min and **store** per-period energies on `EnergyRollup`; re-fetch history for backfill ⇒ exact throughout.
6. **Arbitrage panel:** **in scope**, presented **as an estimate** (matching monthly-bill estimation). This is what makes Phase 1's provenance pay off.
7. **Projection:** **whole-history average rate**, with a low-confidence caveat under a year of data.
8. **Fixed charges:** **energy-only v1, document the seam** — they belong on `Tariff` (bill-estimation), cancel between the fixed-plan cells, and their fixed-vs-TOU difference is a future refinement.
9. **Placement:** a new first-class **"Savings"** tab in `SiteTabs` (option A), holding both surfaces. Friendly label over "ROI"; doesn't foreclose a later "Money"/"Reports" grouping if more analytical views arrive.
10. **Plan detection:** classify the active tariff as fixed/TOU from its schedule rates; mark the actual matrix cell "you are here" and recommend a flat plan when cheaper (robust against false-positives via cell E's bias direction).
11. **Comparison-plan FK:** **none** — `EnergyRollup` stays keyed by the active schedule; comparison pricing is read-time over plan-agnostic energies.
12. **Phase 2b (deferred):** a plan-agnostic **hourly energy profile** unlocks TOU-to-TOU what-ifs (shift-my-peak-window) and fixed-user→TOU comparison; reuses the tariff editor for reporting-only comparison plans; `solar_only_*` migrate there when it lands.
```
