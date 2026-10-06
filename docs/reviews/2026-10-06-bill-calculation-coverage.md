# Bill calculation test review

## Existing coverage

- `billing-cycle.test.ts`: site-local midnight, western/eastern timezones, DST changes, year rollover, leap years, short months, and clamped billing anchors.
- `energy-repo.test.ts`: numeric database values, raw/aggregate queries, historical tariff/schedule resolution, and future-window clamping.
- `tou-aggregation.test.ts`: same-rate import/export cancellation, surplus credits, raw-plus-prior-day aggregation, historical version lookup, missing lookups, and sites without tariffs.
- `BillSummary.test.tsx`: merges duplicate period names and sums energy/cost.
- Mobile bill route tests: requested cycle, totals, currency, authorization, unknown estimates, and seasonal/version presentation grouping. The seasonal test supplies precomputed costs; it does not exercise the real calculator.
- TRMNL renderer tests: negative values render as credits.
- Native iOS contract/presentation tests: server cost decoding, nullable estimates, signed period values, and currency formatting. iOS consumes server calculations rather than recalculating the bill.

## Coverage added

- Calculation-level seasonal split with surplus before the boundary and deficit after it, using Harrison's exact values.
- Explicit expected boundary settlement policy, including zero combined energy with different seasonal rates.
- Surplus/deficit in both directions, all-import/all-export, zero rates, and exact cancellation within one pricing bucket.
- Same TOU name across tariff versions versus genuinely different tariff names, and isolation between TOU periods.
- Prior-day aggregates combined with today's raw rows at a season boundary.
- Historical bucket costs must remain independent of current configured rates.
- Real calculated costs reaching web rendering and mobile summary, rather than presentation tests accepting arbitrary mock costs.

The user confirmed that the energy bucket spans the seasonal boundary.
The new real-calculator regression tests cover both web/mobile and TRMNL.
The mobile seasonal test now consumes actual calculated costs, and the web
rendering regression checks both layouts with the same calculated result.
Additional pricing tests cover proportional offsets with multiple historical
buy/sell rates, input-order independence, repeated pricing, sub-Wh balances,
negative buy rates, the existing absolute-sell-rate convention, empty windows,
and delimiter-containing names (which exposed and fixed a grouping collision).

## Limits of this review

These tests cover the net-energy estimate, not utility fixed charges, taxes,
or reconciliation against an actual provider invoice. Native iOS receives
server costs; no native calculation or contract change was needed.
Existing unknown-tariff fallbacks are retained. The review also found and
fixed missing/null schedule rate inheritance in the bill aggregators, with
regressions for prior-day and today's raw data, and a historical-schedule query
check preserving all-version lookup. Zero overrides remain valid and do not
fall back to season rates. Completely malformed/incomplete tariffs still use
the existing Unknown/$0 behavior; that behavior is documented by existing tests
rather than treated as a valid provider bill.


## Verification against stored Harrison data

A read-only run of the corrected repository against the September 11–October 11
cycle returned On-Peak net grid energy **-9.228 kWh**, On-Peak cost **-$0.36912**,
and total estimated energy bill **$32.48818**. No stored data or tariffs changed.


Final checks: **1008 tests passed**, one existing test skipped; lint and production
build passed. Thirty tests were added, and the old mocked seasonal presentation
expectation was replaced with a real-calculator regression. No native Swift
source or mobile response contract changed.
