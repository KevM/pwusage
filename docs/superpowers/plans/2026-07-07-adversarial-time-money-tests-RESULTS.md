# Adversarial Time-and-Money Test Hunt — Results (2026-07-07)

## Bugs found and fixed
- **billing-cycle short-month clamped anchor**: Confirmed. A fix was previously present in `main` via a `constrainedDayForMonth` helper, but it has been refactored and cleaned up to match the plan's clean `Math.min(day, zonedNow.daysInMonth)` approach.
- **schedule wrapped day-of-week ranges**: Confirmed and fixed. Week-wrapping day ranges (e.g., Sunday through Thursday nights represented as `6` wrapping to `3` in Tesla encoding) are now correctly handled in `matchDayOfWeek` and sized properly in the schedule sort comparator.
- **tou-aggregation zero-tariff crash**: Confirmed and fixed. The utility was verified to crash with a `TypeError` if a site had no tariffs, which has been resolved with an early return that preserves series data passthrough for charting.

## Probes that failed unexpectedly (bugs found by Tasks 3–6)
- **None**: All probe tests passed successfully on their first run, verifying that existing implementation behaviors for DST transitions, Chilean midnight, holiday observance, and importer window boundaries are correct.

## Behavior pinned by new regression tests
- DST fall-back repeated hour + spring-forward skipped hour (America/Chicago 2026)
- Season boundary at site-local midnight
- Saturday Christmas / Sunday New Year observance
- DST-skipped local midnight (America/Santiago)
- 23h/25h import-day windows

## Known issues documented, deliberately not changed
1. **Net-metering cost semantics** (`tou-aggregation.ts` cost loop): imports and exports are netted *within a bucket* before pricing. Pinned by the existing test "calculates credit correctly for negative net grid usage". Intentional.
2. **`Math.abs()` on rates** (`tou-aggregation.ts` cost loop): a negative `sell_rate` (export penalty, seen in some AU tariffs) would be inverted into a credit. No negative-rate tariffs exist in this product's data today; flag, don't fix.
3. **Pass-1 midpoint fallback** (`tou-aggregation.ts` ~line 103): rows with NULL `tariff_schedule_id` resolve TOU at `row.day + 12h` = UTC noon, which is early morning in US zones. Only affects legacy rows; best-effort by design.
4. **`date_trunc('day', timestamp)`** in `energy-repo.ts` `getCycleAggregates` groups prior-cycle aggregates by UTC day, not site-local day. TOU correctness doesn't depend on it (`tariff_schedule_id` is stored per-row); SQL-side, not reachable from unit tests.
5. **Same-month wrapped seasons** (`schedule.ts` `matchSeason`): `from_month === to_month && from_day > to_day` (e.g. "Jun 15 → next Jun 10") never matches. No evidence Tesla emits this encoding.
