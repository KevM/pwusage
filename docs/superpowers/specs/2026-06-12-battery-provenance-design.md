# Battery Power Provenance & Per-Period Energy Rollups

**Date:** 2026-06-12
**Status:** Design approved, pending spec review
**Branch context:** `feat/roi` — this is the data foundation for a future ROI report (Phase 2, separate spec).

## Problem

Today, energy cost is computed only at the **grid boundary** (`gridKwh × rate`, see `energy-repo.ts` and `marginal-cost.ts`). The battery is a black box: once energy enters it, we lose track of whether it came from solar or grid, and what it cost to put there. So when the battery later serves load, we cannot label that energy "from solar" or "from grid," nor say what we paid for it.

We want **battery power provenance**: carry the origin (and cost basis) of stored energy through charge → discharge, so every battery discharge can be attributed to a source and a cost. This unlocks per-tariff-period cost analysis, arbitrage P&L, and (Phase 2) whole-history ROI.

## Goal

A daily rollup, one row per tariff period per day, capturing:
- All per-period system energy flows (the sankey edges).
- A running **tank** describing the composition and cost basis of energy currently in the battery, carried forward across periods and days.

From these, discharge source-split, discharge cost basis, period costs, arbitrage P&L, and ROI inputs are all derivable at read time.

## Background / current state

- **`EnergyData`** holds 5-minute samples: `load_power, solar_power, grid_power, battery_power, battery_soc`, keyed by `(timestamp, site_id, tariff_id)` with a nullable `tariff_schedule_id`. Sign conventions: `battery_power` + = charge; `grid_power` + = import.
- **Sankey allocation already exists.** `sankey/build-flow-model.ts` → `allocateEdges(energyDataToInstant(row), rates)` performs solar-first merit-order allocation per instant, producing edges including `solar-battery`, `grid-battery`, `battery-home`, `battery-grid`. The replay **reuses this** rather than reinventing allocation.
- **Tesla provides charge provenance directly.** `calendar_history?kind=energy` returns `battery_energy_imported_from_solar` and `battery_energy_imported_from_grid` per interval (`EnergyHistoryEntry` in `tesla-client.ts`). The importer currently **discards** them (`energy-transformer.ts` collapses everything to load/solar/grid/battery/soc).
- **`EnergyUsage` is already dropped** (migration `20260428182618`). `EnergyRollup` is greenfield.
- **Retention prunes raw data.** The `cleanup` cron deletes `EnergyData` older than `DATA_RETENTION_DAYS` (default 365). Therefore `EnergyRollup` is the **durable** record (daily grain, kept indefinitely), and a day must be rolled up before retention removes its 5-min rows.
- **Tariff schedule durability.** Tariff changes are believed to create **new** `TariffSchedule` rows rather than mutating existing ones, so a historical `tariff_schedule_id` still resolves to the rates that applied then. *To verify in planning.* The whole "derive costs by join" approach depends on this.

## Conceptual model

The battery is a single **mixed reservoir** (weighted-average / average-cost inventory accounting). Energy is fungible; provenance is an accounting overlay, not physics.

**The tank** is per-site running state with four quantities:
- `tank_solar_wh`, `tank_grid_wh` — energy currently stored, by origin.
- `tank_solar_cost`, `tank_grid_cost` — the cost basis (dollars) of that stored energy.

**Charge** adds to the tank, valued at charge time:
- grid → battery: `+wh` to `tank_grid_wh`, `+wh × buyRate(period)` to `tank_grid_cost` (cash paid to import).
- solar → battery: `+wh` to `tank_solar_wh`, `+wh × sellRate(period)` to `tank_solar_cost` (opportunity cost — the export revenue forgone; solar is **not** free).

**Discharge** removes proportionally across all four quantities (the ratio and the $/Wh are preserved through a discharge), so a discharge inherits the tank's current blend.

**Carry-forward.** The tank is seeded each period from the most recent prior period's ending state (the last period of the previous day seeds the first period of the next day). This is why the ending tank state lives **in the rollup row** — no separate state table.

### Why cost basis is stored, not derived

Two distinct kinds of cost:
- **Period flow costs** — import cost, export credit, the *benefit* of `battery→home` (avoided import at the discharge period's buy rate). These are **join-derivable** from the row's own `tariff_schedule_id`. **Never stored.**
- **Tank cost basis** — what stored energy cost to charge. This is **path-dependent**: a blend of every charge rate that fed the tank across prior periods/days, including occasional off-schedule grid charging (e.g. Tesla **Storm Watch** charging from grid at on-peak rates before a forecast outage). No join can recover it, because a blended tank has no single charge schedule to join to. It is stored for the same reason the tank ratio is stored — both are irreducible running state. Storing it is a memoized running aggregate, not denormalization of joinable data.

A bare ratio (energy only) would give the correct source *split* but would mis-cost any energy charged off the normal off-peak rate (Storm Watch is the motivating real case). Hence the two cost columns.

## Data model

### `EnergyData` — add two columns (one migration)

```
battery_charge_from_solar   integer  NULL   -- Wh, from Tesla calendar_history
battery_charge_from_grid    integer  NULL   -- Wh, from Tesla calendar_history
```

Nullable on purpose: historical rows we cannot re-fetch fall back to the sankey `allocateEdges` split at replay time. Fidelity is "Tesla-measured where available, derived otherwise" — never blocked. The importer (`energy-transformer.ts`) is updated to populate these from `battery_energy_imported_from_solar/grid`.

### `EnergyRollup` — new table

Grain: one row per **`(site_id, local_date, tariff_schedule_id)`**. `local_date` is the calendar date in the site's timezone.

**Stored — period energy flows (Wh):**
```
load_wh
solar_to_home_wh    solar_to_battery_wh   solar_to_grid_wh
grid_to_home_wh     grid_to_battery_wh
battery_to_home_wh  battery_to_grid_wh
```

**Stored — end-of-period tank state (carry-forward seed; path-dependent):**
```
tank_solar_wh   tank_grid_wh
tank_solar_cost tank_grid_cost
tank_as_of      -- timestamptz: the last EnergyData interval folded into this row's tank
```

`tank_as_of` exists because a TOU schedule can recur in two disjoint windows in a day (partial-peak morning + evening), so the carry-forward seed must be chronological, not per-schedule. The tank evolves continuously across all intervals in timestamp order; each row snapshots the continuous tank as of its last contributing interval. **Carry-forward seed = the row with the greatest `tank_as_of` strictly before the current period's first interval** (handles both day-to-day seeding and resumable mid-history backfill).

**Derived at read time (never stored):**
- Import cost / export credit / `battery→home` benefit → join `tariff_schedule_id` → `TariffSchedule` (coalescing schedule rates with the parent `TariffSeason` rates when the schedule's `buy_rate`/`sell_rate` are null — matches existing rate-resolution behavior).
- Discharge source split and cost basis both draw against the **entry tank** (the prior period's stored tank state), for consistency: solar fraction = `prior_tank_solar_wh / (prior_tank_solar_wh + prior_tank_grid_wh)`; cost basis = `discharge_wh × (prior_tank_cost ÷ prior_tank_wh)`. (Exact when no charging occurs within the period; the accepted approximation otherwise — see below.)
- Arbitrage P&L = discharge benefit − discharge cost basis; savings; ROI inputs.

Indexes: primary/unique on `(site_id, local_date, tariff_schedule_id)`; secondary on `(site_id, local_date)` for range reads and carry-forward lookup.

### Tables explicitly *not* created
- No `BatteryTankState` — the seed is the prior row's tank columns.
- No `BatteryDischargeProvenance` — discharge split/cost is derived from edges + tank ratio. (Inexact only when charge and discharge occur within the *same* tariff period, which is rare since charging is midday/overnight and discharging is on-peak evening — accepted approximation.)

## Algorithm (daily rollup)

Runs after site-local midnight, for each site, for the target local date(s).

```
seed = most recent EnergyRollup row for site, strictly before target period
       → (tank_solar_wh, tank_grid_wh, tank_solar_cost, tank_grid_cost)
       → empty tank at history genesis (see Open Questions: genesis seeding)

for each tariff period in the day (grouped by tariff_schedule_id):
    initialize period accumulators (edges) = 0
    tank = seed carried in from previous period
    for each 5-min EnergyData row in the period, in timestamp order:
        rates = resolve(buyRate, sellRate) for row.tariff_schedule_id  // coalesce w/ season
        edges = allocateEdges(energyDataToInstant(row), rates)         // reuse sankey
        chargeSolar = row.battery_charge_from_solar ?? edges['solar-battery']
        chargeGrid  = row.battery_charge_from_grid  ?? edges['grid-battery']
        // charge
        tank_solar_wh   += chargeSolar;  tank_solar_cost += chargeSolar * sellRate
        tank_grid_wh    += chargeGrid;   tank_grid_cost  += chargeGrid  * buyRate
        // discharge (battery-home + battery-grid)
        discharge = edges['battery-home'] + edges['battery-grid']
        if discharge > 0 and tank_total > 0:
            f = min(discharge, tank_total) / tank_total
            tank_solar_wh -= tank_solar_wh*f;  tank_solar_cost -= tank_solar_cost*f
            tank_grid_wh  -= tank_grid_wh*f;   tank_grid_cost  -= tank_grid_cost*f
        accumulate edge energies into period accumulators
    upsert EnergyRollup row (edges + ending tank state)
    seed = ending tank
```

Properties: pure function of `(day's EnergyData, prior tank, tariffs)`; **idempotent upsert**; safe to re-run.

## Backfill

1. **Charge-split backfill (one-time):** a script re-fetches Tesla `calendar_history` for historical dates and populates `battery_charge_from_solar/grid` where Tesla still has the data; the rest stay null (→ derived fallback). Billable Tesla calls, run once.
2. **Rollup backfill:** because the tank carries forward, replay **chronologically from the earliest available `EnergyData`**, snapshotting each period. Resumable (restart from last rolled-up period), idempotent.
3. **Retention coupling:** `EnergyRollup` must be produced before the `cleanup` cron prunes the underlying `EnergyData`. Whole-history ROI relies on the rollup as the permanent record; raw 5-min data beyond retention is gone.

## Cron scheduling

Follow the existing cron auth pattern (`Bearer ${CRON_SECRET}`, see `api/cron/cleanup/route.ts`). Vercel crons fire in UTC; a single daily run processes each site's *previous local day*, computing `local_date` per site timezone. Confirm whether to register in `vercel.json` or via the Supabase pg_cron path (cf. `2026-05-25-supabase-cron-trigger-design.md`) during planning.

## Edge cases

- **Null charge split** → fall back to `allocateEdges` `solar-battery`/`grid-battery`.
- **Storm Watch / off-schedule grid charge** → handled naturally; cost basis records the actual (possibly on-peak) rate.
- **Same-period charge+discharge** → end-of-period ratio differs slightly from mid-period draw ratio; accepted (rare).
- **Empty/zero tank** → guard division; discharge from empty tank only possible at genesis (see below).
- **Missing intervals / gaps** in `EnergyData` → replay tolerates gaps; tank simply doesn't change across the gap.
- **Tariff/season boundaries mid-day** → grouping by `tariff_schedule_id` handles multiple periods per day.

## Testing

- Unit: tank charge/discharge math (proportional draw preserves ratio and $/Wh); solar=sellRate, grid=buyRate valuation; null-split fallback.
- Unit: rate resolution (schedule rate vs season fallback).
- Property: order-independence of within-period accumulation for edges; carry-forward continuity across period/day boundaries.
- Integration: a synthetic arbitrage day (overnight grid charge, AM discharge, midday solar charge, PM discharge) asserts AM discharge is grid-origin and PM discharge is solar-heavy.
- Integration: a Storm Watch day asserts the on-peak grid charge raises discharge cost basis above the off-peak assumption.
- Idempotency: re-running the cron yields identical rows.

## Out of scope (Phase 2, separate spec)

- The ROI report UI and the **counterfactual** scenarios (no-solar, solar-only-no-battery). Those re-simulate over `EnergyRollup` (+ retained `EnergyData` where present) and are *enabled* by, but not part of, this foundation.

## Resolved decisions (from planning)

1. **Genesis seeding:** anchor on a **known-full** battery. Scan forward from the earliest available `EnergyData` to the first interval where `battery_soc ≥ FULL_THRESHOLD` (e.g. 98%); seed the tank from the **contiguous charge run-up** that filled it (sum `battery_charge_from_solar/grid` over the immediately preceding charging intervals, valued at each interval's rates). If no full anchor exists in the data, seed empty. This needs no battery-capacity datum and self-corrects within a cycle.
2. **Cron mechanism:** `vercel.json` cron with `Bearer ${CRON_SECRET}` auth (matches `cleanup`/`check-users`). Fires in UTC; processes each site's previous local day computed from `Site.timezone`.
3. **Columns:** stay minimal — energy edges + tank state + `tank_as_of` only. No stored rates, no SOC column. Rates always joined (relies on the durability guarantee).

## Open questions (resolve in planning)

1. **Confirm `TariffSchedule` immutability** (new rows on change, never in-place edits) — verify against the tariff-edit code path.
