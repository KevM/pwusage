# Bill outlook design

Approved direction: extend the native iOS Current Bill screen with the familiar
Smart Shift chart language, historical balances, solar/history projections, and
a visible billing deadline. Web, widgets, notifications, and automatic battery
actions are follow-ups, not part of this first delivery.

## Experience

- Show “So far” and “At cycle end” estimates above the chart. These retain the
  existing bill estimate's scope: energy charges/credits, not unknown fees/taxes.
- Use one aligned chart lane per rate period, matching Smart Shift's green export
  cushion, orange import gap, zero line, typography, and spacing. Keep different
  rate plans separate even when their period names match.
- Show recorded cumulative energy as a solid line, future estimated energy as a
  dashed line, and label both in a bill-specific legend. Smart Shift's dashed
  alternative-job line has a different meaning; share drawing primitives, not
  its comparison legend or job-specific model.
- Mark Now and the cycle end. The observed/forecast join uses the actual energy
  cutoff, not the current wall clock; disclose any gap between the two.
- Default to the whole cycle. Tap/drag selects a date across all lanes and shows
  the estimated amount and period balances at that time. Provide an accessible
  equivalent, not a gesture-only readout.
- In the final seven local calendar days, elevate “Cycle ends in N days” and
  explain a material projected import gap or its likely closure. This threshold
  is an implementation default. Link to Smart Shift for timing heavy energy use.
  Do not claim credits expire, recommend spending a cushion, or promise savings
  without settlement-rule support.
- State whether the outlook uses solar forecasts plus typical home use, recent
  grid history, or both. Do not present a history-only estimate as weather-based.

## Data and calculation

Current Bill uses MobileBillResponse and DB-backed bill-summary. Smart Shift's
LoadTimingForecastEstimator already integrates solar, home/battery profiles, and
historical grid flow. Extract reusable baseline flow projection without creating
a dummy job. Preserve Smart Shift's behavior and existing freshness limits.

Recorded chart points must come from actual cycle history, never from the typical
day profile. Add bounded cumulative daily history plus the latest cutoff point to
the bill contract. Preserve gaps and unavailable attribution; missing is not zero.
Use local calendar days and the exclusive next-cycle start for cutoff semantics.

Billing pricing must follow DesignDecisions.md section 6 and bill-pricing.ts:
bucket by rate-plan name and period, net across seasonal versions, and retain the
historical rates for proportional residual pricing. Current period totals alone
cannot reconstruct those rate buckets. Supply the underlying measured rate buckets
needed for projection and use parity fixtures for any Swift pricing implementation.
Never reprice all measured energy at the current rate or sum daily settled costs.

Forecast solar drives the available near-term window (at most the existing seven
days); historical grid patterns cover the remaining cycle where usable. Stop at
unsupported coverage and label a partial projection by its actual end date rather
than “At cycle end.” Do not extend Smart Shift's rate-change-limited output and
pretend it covers the full billing cycle.

## Refresh and unavailable states

Reuse coordinator caches, request deduplication, site validation, and local solar
credentials. Opening billing must not cause a live Tesla fetch or repeated solar
requests. Keep the recorded bill visible when forecasting fails. Distinguish stale
observations, missing history, missing rates, and unavailable solar; use history
fallback only when the context is valid. Discard results for a previously selected
site. Scrubbing the chart performs no network requests.

## Verification

Cover pricing parity across seasonal versions, sign conventions, exact historical
endpoint equality with the existing bill, forecast continuity, no double counting
of the latest five-minute interval, missing data, local midnight/DST, cycle rollover,
and fallback behavior. Verify coordinator freshness/site switching and Smart Shift
regressions. Inspect both screens in the simulator, including VoiceOver/Dynamic
Type, short cycles, long labels, and absent forecasts. Use run-tests.sh for every
iOS test run; run web tests, lint, and build before implementation completion.
