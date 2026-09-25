# iOS Load Timing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an iOS dashboard Load timing utility after Current bill, with an active-period summary and a native detail screen matching the web card's capabilities.

**Architecture:** Extend the existing five-minute mobile live contract with a small active-period projection derived from its existing cached rollup and today bins. Extend the slower mobile bill response with the canonical `computeLoadTiming` view using the cycle usage it already reads. Swift renders both and computes preset/custom load estimates locally from server-provided pricing. Preserve the current coordinator, source timestamps and refresh behavior.

**Tech Stack:** Next.js/TypeScript/Vitest, PostgreSQL aggregate repository, SwiftUI/Swift Testing, XcodeGen.

**Workspace:** `/Users/kevm/.codex/worktrees/ios-load-timing/pwusage` on `codex/ios-load-timing`. The user's separate `ios-fixes` checkout has an uncommitted dashboard tile reorder; leave it untouched. The implementation starts from `ios-fixes` HEAD, which contains post-PR #110 pull-to-refresh and Mac UI work.

**Design:** `docs/plans/2026-09-24-ios-load-timing-design.md`.

---

### Task 1: Server active-period summary

**Files:** Modify `cmd/next-app/src/lib/headroom-from-bins.ts`, `cmd/next-app/src/lib/headroom-from-bins.test.ts`, `cmd/next-app/src/lib/mobile-dashboard-contract.ts`, `cmd/next-app/src/lib/mobile-dashboard-contract.test.ts`, `cmd/next-app/src/app/api/site-live-data/route.ts`, `cmd/next-app/src/app/api/site-live-data/route.test.ts`. A small pure adapter in `cmd/next-app/src/lib/mobile-load-timing.ts` with its own test is welcome if it keeps route logic small.

1. Write failing tests for an active period with surplus, deficit, neutral balance, and no observations even though another TOU period has data. The last state must be **unknown**, not measured zero. Test that the mobile response carries active period name, buy/sell rate-derived marginal cost, basis, balance or null, and the real energy sample timestamp. Test no tariff/schedule and unresolvable rates.
2. Run focused red tests from `cmd/next-app`: `npm run test -- --run src/lib/headroom-from-bins.test.ts src/lib/mobile-dashboard-contract.test.ts src/app/api/site-live-data/route.test.ts`.
3. Add an optional `activeLoadTiming` field to the version-1 mobile live response to support backend/client rollout order. Derive it from the already computed schedule, cached prior-day rollup and today bins; do not add a cycle query or Tesla request. Use the web's 0.1 kWh neutral threshold and buy/sell marginal-rate rule. Distinguish missing period observations from a measured zero without changing the existing web `loadHeadroom` behavior unless required by a failing test.
4. Re-run focused tests, inspect the route's mocked repository calls, then commit with `feat(ios): expose active load timing summary`.

### Task 2: Server full detail in bill response

**Files:** Modify `cmd/next-app/src/app/api/mobile/bill-summary/route.ts`, `cmd/next-app/src/app/api/mobile/bill-summary/route.test.ts`, `cmd/next-app/src/lib/mobile-dashboard-contract.ts`, `cmd/next-app/src/lib/mobile-dashboard-contract.test.ts`. Reuse `cmd/next-app/src/lib/load-timing.ts` and `cmd/next-app/src/lib/load-affordance.ts`; do not fork tariff logic.

1. Write failing tests for the full detail payload with observed-period tiles, configured but unobserved pricing periods, active marker, next cheaper or cheapest-now cue, next starts, buy/sell rates, and source/cycle times. Include no tariff, no cycle data, seasonal schedule and authorization cases. Assert that `getUsageByTOU` is called once, as before.
2. Run `npm run test -- --run src/app/api/mobile/bill-summary/route.test.ts src/lib/mobile-dashboard-contract.test.ts` and confirm red.
3. Build a `Schedule` from the site's current tariffs, resolve the active period and call `computeLoadTiming(schedule, usage, now, site.timezone, activePeriod)`. Map its serializable values into an optional `loadTiming` property in the bill response; do not serialize full tariff objects or raw energy rows. Keep existing bill fields and version 1 wire compatibility. Include the existing calculation and energy source timestamps.
4. Re-run focused tests and the mobile route egress trace (`npm run test -- --run scripts/mobile-route-egress-trace.test.ts`) to confirm no added SQL calls/results on the live route and no second cycle read in bill route. Commit with `feat(ios): include load timing detail in bill response`.

### Task 3: Native contracts and load estimator

**Files:** Modify `cmd/ios-app/PWUsage/Models/MobileContracts.swift`, `cmd/ios-app/PWUsage/Views/DashboardPresentation.swift`, `cmd/ios-app/PWUsageTests/MobileContractsTests.swift`, `cmd/ios-app/PWUsageTests/DashboardPresentationTests.swift`. Create `cmd/ios-app/PWUsage/Models/LoadTimingEstimator.swift` and `cmd/ios-app/PWUsageTests/LoadTimingEstimatorTests.swift` if separation helps.

1. Add Swift Testing fixtures for optional active/detail fields, null balance, rate basis, all period arrays, timestamps and older version-1 responses without the new fields. Add estimator parity cases against `cmd/next-app/src/lib/load-affordance.test.ts`: fully covered, tight, partial, bought and unknown. Include preset sizes/headroom from `cmd/next-app/src/lib/load-profiles.json` and custom 1–100 kWh amounts.
2. Run focused native red tests with `cmd/ios-app/run-tests.sh MobileContractsTests DashboardPresentationTests LoadTimingEstimatorTests`. Use this script for every native test run; never call `xcodebuild test` directly.
3. Decode additive fields without breaking older server responses. Implement the exact web cost formula: surplus covers up to the load amount at sell rate; remaining energy uses buy rate; headroom changes the verdict, not dollars. Format cost per kWh and surplus/deficit with accessible spoken labels. Keep display formatting separate from pricing math.
4. Re-run focused native tests. Commit with `feat(ios): decode and price load timing data`.

### Task 4: Dashboard card and native detail screen

**Files:** Modify `cmd/ios-app/PWUsage/Views/DashboardView.swift`, `cmd/ios-app/PWUsage/Views/DashboardPreviews.swift`; create `cmd/ios-app/PWUsage/Views/LoadTimingView.swift`; modify relevant Swift Testing files or create `cmd/ios-app/PWUsageTests/LoadTimingViewTests.swift` for testable presentation/state helpers. The Xcode project is generated from `cmd/ios-app/project.yml` by `generate.sh`; adjust project configuration only if automatic source discovery does not pick up the new files.

1. Add failing tests for presentation helpers and navigation state: Load timing follows Current bill, active summary shows period/rate/balance, missing observations display configured buy rate plus “No balance yet”, and missing tariff/data/stale states are explicit. Test load preset selection and slider arithmetic through pure helpers. Preserve existing dashboard tile order in this isolated branch; do not touch the user's separate uncommitted edit.
2. Run focused tests through `cmd/ios-app/run-tests.sh` and confirm red.
3. Add the Load timing `NavigationLink` after `billNavigation` with a compact card matching Current bill. Add the detail screen with next-cheaper/cheapest cue, observed period tiles, active marker/next-start, presets, custom kWh slider, per-period price and covered/bought bar. Use the shared coordinator's bill response and `refreshBill()` for pull-to-refresh; do not start an additional poller. Show cycle dates, source age, stale/unavailable and empty states, accessible labels and Dynamic Type layout. Update normal, empty and stale previews.
4. Run focused native tests and review simulator screenshots for default, long text and empty states. Commit with `feat(ios): add load timing dashboard and detail`.

### Task 5: Integration verification and finish

**Files:** Tests and documentation only as needed to fix concrete gaps. Inspect `git diff` against the design.

1. Verify backend/client parity for the same fixture and instant, including active transitions, cycle rollover, missing active observations, seasonal tariffs, DST and stale source times. Confirm route authorization, absent-field compatibility, and no new cycle read on the five-minute path. Repair any discovered discrepancy with focused tests first.
2. From `cmd/next-app`, run `npm run test -- --run`, `npm run lint`, and `npm run build`.
3. From `cmd/ios-app`, run `./run-tests.sh`. If it times out, inspect retained artifacts and simulator state before code changes; do not overlap test runs.
4. Inspect the complete diff, `git diff --check`, and the original checkout's untouched status. Commit any verification fixes with a conventional message. Report test counts and any material limits.

## Execution

The user chose Luna implementation in this session. Dispatch one bounded task at a time to a `gpt-6-luna` subagent, then review spec compliance and code quality before the next task. Do not start competing implementations in the shared checkout. The root agent owns integration, final verification and the user-facing result.
