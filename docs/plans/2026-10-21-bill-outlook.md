# Bill Outlook Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add historical and projected rate-period lanes to iOS billing using Smart Shift's visual language, with selected-date bill estimates and a clear cycle deadline.

**Architecture:** Keep measured history and rate attribution on the server; project locally using the existing solar cache and historical context. Share baseline flow and chart primitives with Smart Shift, while preserving canonical billing pricing and independent screen semantics.

**Tech Stack:** Swift/SwiftUI/Charts, Swift Testing, existing TypeScript mobile routes, PostgreSQL repositories, Vitest.

---

Design: `docs/plans/2026-10-21-bill-outlook-design.md`.
Read `Authentication.md`, `DesignDecisions.md` sections 2 and 6, and
`docs/voice-and-terms.md` before implementation. Fetch current framework-specific
documentation through Context7 before using or changing framework APIs.

## Task 1: Establish canonical billing history and pricing fixtures

Files:
- Modify `cmd/next-app/src/lib/bill-pricing.test.ts`
- Create `cmd/next-app/src/lib/test-support/bill-outlook-fixtures.json`
- Inspect `cmd/next-app/src/lib/bill-pricing.ts` and `cmd/next-app/src/lib/energy-repo.ts`

1. Record shared fixtures with measured rate buckets and expected costs: imports,
   exports, opposing seasonal balances, distinct plans with identical period names,
   and a projected future bucket that changes which measured energy remains priced.
2. Add tests proving fixture expectations through canonical `priceBillUsage`.
3. Run `npm run test -- --run src/lib/bill-pricing.test.ts` from cmd/next-app.
4. Include the documented 27.471 kWh export / 18.243 kWh import example, expecting
   9.228 kWh export and -0.36912 cost at the common 0.04 sell rate.
5. Commit fixtures only after passing. Do not change established pricing policy.

## Task 2: Provide recorded cumulative history and rate buckets

Files:
- Create `cmd/next-app/src/lib/bill-outlook-history.ts` and `.test.ts`
- Modify `cmd/next-app/src/app/api/mobile/bill-summary/route.ts` and `route.test.ts`
- Modify `cmd/next-app/src/lib/mobile-dashboard-contract.ts`
- Modify the energy repository/interface implementations if an existing bounded read is insufficient.

1. Write failing tests for cumulative local-day history and the exact latest-data
   endpoint, incomplete attribution, missing days, DST, and exclusive cycle end.
2. Define an optional backward-compatible bill outlook field containing timestamped
   cumulative period balances, original rate buckets, and explicit coverage metadata.
3. Implement from DB history only. Do not multiply repository reads by chart points;
   read the bounded cycle once and aggregate in memory or a bounded grouped query.
4. Price each historical cumulative snapshot using canonical pricing. Never sum
   already-settled daily costs. Assert the final snapshot matches currentBill.
5. Extend route tests for authorization, empty/incomplete history, and unchanged
   old response fields. Run targeted history and route tests, then commit.

## Task 3: Extract baseline projection and implement bill outlook calculations

Files:
- Modify `cmd/ios-app/PWUsage/Models/LoadTimingForecastEstimator.swift`
- Create `cmd/ios-app/PWUsage/Models/EnergyFlowProjection.swift`
- Create `cmd/ios-app/PWUsage/Models/BillOutlook.swift`
- Modify `cmd/ios-app/PWUsage/Models/MobileContracts.swift`
- Create `cmd/ios-app/PWUsageTests/BillOutlookTests.swift`
- Retain `cmd/ios-app/PWUsageTests/LoadTimingForecastEstimatorTests.swift`

1. Add Swift Testing cases for decoding old responses, positive-export chart signs,
   shared pricing fixtures, history-only fallback, and no double-counted last interval.
2. Extract the baseline integration from the existing estimator without changing
   Smart Shift's candidate scoring, cautious projection, or stopping rules.
3. Implement a job-independent bill projection combining measured rate buckets and
   projected flows. Include source kind, coverage end, and unavailable reasons.
4. Port canonical pricing narrowly with fixture parity. Handle seasonal rate changes
   through the billing policy; refuse unsupported gaps instead of inventing rates.
5. Test complete/partial horizons, midnight/DST, cycle rollover, missing solar, and
   valid history fallback. Run `./run-tests.sh BillOutlookTests` and then
   `./run-tests.sh LoadTimingForecastEstimatorTests` sequentially from cmd/ios-app.
6. Commit after both pass. Keep DEVELOPMENT_TEAM unchanged.

## Task 4: Share forecast refresh lifecycle

Files:
- Modify `cmd/ios-app/PWUsage/State/DashboardCoordinator.swift`
- Create `cmd/ios-app/PWUsageTests/BillOutlookCoordinatorTests.swift`

1. Write failing tests for billing-first navigation, cached history/solar reuse,
   request deduplication, refresh failures, and switching sites during a request.
2. Expose a shared planning refresh entry point for billing and Smart Shift.
   Preserve bill/history/solar freshness independently and original source timestamps.
3. Ensure billing appearance never forces live Tesla/history ingestion and chart
   selection never triggers refresh work.
4. Run `./run-tests.sh BillOutlookCoordinatorTests` followed by existing relevant
   coordinator suites; inspect retained artifacts if any run times out.
5. Commit the verified lifecycle change.

## Task 5: Build billing lanes using shared chart primitives

Files:
- Modify `cmd/ios-app/PWUsage/Views/EnergyWeatherChart.swift`
- Create `cmd/ios-app/PWUsage/Views/EnergyBalanceChart.swift`
- Create `cmd/ios-app/PWUsage/Views/BillOutlookPresentation.swift`
- Modify `cmd/ios-app/PWUsage/Views/BillView.swift`
- Create `cmd/ios-app/PWUsageTests/BillOutlookPresentationTests.swift`

1. Write presentation tests for recorded/forecast legend, selected-date amount,
   period naming, partial forecasts, deadline count, and unavailable values.
2. Extract lane rendering with configurable series, markers, and accessibility text.
   Keep Smart Shift's comparison legend intact; billing uses a separate legend.
3. Add So far/At cycle end summary, aligned period lanes, recorded-to-dashed forecast
   transition, Now/cycle-end markers, and synchronized date selection/readout.
4. Default to whole-cycle display; include accessible date selection and support
   Dynamic Type. Do not visually connect missing measured history as known data.
5. Show the deadline reminder in the final seven local days and a Smart Shift link.
   Explain likely gap closure or remaining gaps without credit-expiration claims.
6. Run `./run-tests.sh BillOutlookPresentationTests`; inspect simulator screenshots
   of Billing and Smart Shift with forecast, history-only, and unavailable data.
7. Commit after presentation tests and visual verification pass.

## Task 6: Complete verification and delivery

1. Run `./run-tests.sh` from cmd/ios-app, without overlapping test runs.
2. From cmd/next-app run `npm run test -- --run`, `npm run lint`, and `npm run build`.
3. Inspect any failure before changing code. Repeat checks affected by repairs.
4. Verify no live API refresh was added, credentials remain device-local, source
   dates remain truthful, and the measured endpoint still matches currentBill.
5. Review the diff and commit remaining verified changes. Report checks and any
   material limits; create a draft PR only if requested as part of delivery.

## Completion criteria

The user can read the current estimate, inspect the next few days, see the cycle-end
outlook when coverage supports it, understand each rate period's cushion/gap, and
notice the approaching billing deadline using familiar Smart Shift visuals.
