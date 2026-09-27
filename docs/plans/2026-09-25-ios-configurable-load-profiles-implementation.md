# Configurable iOS Load Profiles Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a user configure device-wide load profiles and see one duration-aware cost estimate for starting the selected load now.

**Architecture:** The mobile bill endpoint adds a bounded, timestamped tariff timeline to its existing load-timing response. The iOS app stores profiles locally, derives appliance or Car wall energy and duration, and prices the run against that timeline and the current observed per-period balance. The Load timing screen moves editing to a sheet and replaces whole-load-per-period comparisons with one start-now result.

**Tech Stack:** Next.js route and pure TypeScript helper, Vitest, SwiftUI, UserDefaults, Swift Testing. Design: `docs/plans/2026-09-25-ios-configurable-load-profiles-design.md`.

---

### Task 1: Produce a mobile tariff timeline

**Files:** Create `cmd/next-app/src/lib/load-timing-timeline.ts` and `cmd/next-app/src/lib/load-timing-timeline.test.ts`; modify `cmd/next-app/src/lib/load-timing.ts` and `cmd/next-app/src/app/api/mobile/bill-summary/route.ts`.

1. Write a failing Vitest case with a tariff switching at a non-hour minute. Assert contiguous UTC `start`/`end` segments, the period name, `buyRate`, and `sellRate`. Add a daylight-saving transition case and a season-change case. Use the existing tariff fixture shape in `cmd/next-app/src/app/api/mobile/bill-summary/route.test.ts`.
2. Run `npm run test -- --run src/lib/load-timing-timeline.test.ts` from `cmd/next-app`; confirm the new cases fail.
3. Implement a pure `buildLoadTimingTimeline(schedule, now, horizonEnd)` helper. Walk UTC instants at one-minute resolution, compare matched schedule ID and resolved rates, and merge adjacent minutes with the same period identity and rates. The first segment starts at `now` (including seconds); the last ends at `horizonEnd`. Use a seven-day horizon, which covers a full 200 kWh battery charge at the planned Level 1 assumption. Return no timeline if the start has no resolvable tariff or rates. Keep the helper isolated from the existing display-oriented hourly transition walker.
4. Add `tariffTimeline: { start: string; end: string; periodKey: string; name: string; buyRate: number; sellRate: number }[]` to the mobile load-timing response. Build it only in the mobile bill route; do not enlarge web or TRMNL responses. Extend the route test to check first and last timestamps, a rate crossing, and unchanged authorized data reads.
5. Run `npm run test -- --run src/lib/load-timing-timeline.test.ts src/app/api/mobile/bill-summary/route.test.ts`; expect all cases to pass. Commit as `feat(mobile): expose upcoming tariff timeline`.

### Task 2: Decode the timeline in iOS

**Files:** Modify `cmd/ios-app/PWUsage/Models/MobileContracts.swift`; add or extend contract decoding tests in `cmd/ios-app/PWUsageTests` and preview JSON in `cmd/ios-app/PWUsage/Views/DashboardPreviews.swift`.

1. Add a failing Swift Testing case that decodes the exact ISO-date and rate fields returned by Task 1, including an empty timeline. Preserve compatibility with older cached responses by decoding a missing `tariffTimeline` as an empty array.
2. Run `./run-tests.sh MobileContractsTests` from `cmd/ios-app` (use the actual suite name if existing tests use another one); confirm the case fails.
3. Add a typed `LoadTimingTariffSegment: Decodable, Equatable` with `Date` boundaries and finite rate validation at estimate time. Update the preview fixture so the new start-now UI can render realistic transitions.
4. Rerun the focused native suite; expect pass. Commit as `feat(ios): decode load timing tariff timeline`.

### Task 3: Persist device-wide profiles

**Files:** Create `cmd/ios-app/PWUsage/Models/LoadProfile.swift`, `cmd/ios-app/PWUsage/State/LoadProfileStore.swift`, and `cmd/ios-app/PWUsageTests/LoadProfileStoreTests.swift`; modify `cmd/ios-app/PWUsage/PWUsageApp.swift` only as needed to provide the shared store.

1. Write failing Swift Testing cases for built-in defaults, create/rename/edit/delete custom loads, reset a built-in, selected-profile persistence, and malformed saved data. Use an isolated `UserDefaults(suiteName:)` in each fixture.
2. Run `./run-tests.sh LoadProfileStoreTests`; confirm failure.
3. Implement a versioned Codable collection. Use stable built-in IDs (`car`, `dishwasher`, `washer`, `dryer`, `washer-dryer-combo`) and UUIDs for custom loads. Seed Car at 60 kWh, 20% to 80%, Level 2; Dishwasher at the existing 5 kWh and Combo at the existing 8 kWh. Seed a removable/renameable Custom example at its current 20 kWh. Give Washer, Dryer, and the Custom example clearly editable durations and any missing energy defaults; record all default numbers in one place. Validate finite positive kWh and duration, nonempty trimmed custom names, SOC from 0–100, and target no lower than initial SOC. Store one collection regardless of selected site.
4. Rerun the focused suite; expect pass. Commit as `feat(ios): persist device-wide load profiles`.

### Task 4: Estimate energy, duration, and segmented cost

**Files:** Modify `cmd/ios-app/PWUsage/Models/LoadTimingEstimator.swift`; add focused cases to `cmd/ios-app/PWUsageTests/LoadTimingEstimatorTests.swift`.

1. Write failing cases for a flat appliance run crossing a rate change, repeated segments with the same period key consuming surplus once, a deficit, a period with no observed balance, exact end at a boundary, insufficient timeline, and zero Car charge. Add Level 1 and Level 2 cases asserting that battery energy, wall energy, and duration differ.
2. Run `./run-tests.sh LoadTimingEstimatorTests`; confirm failure.
3. Add a pure `estimateStartNow(profile, start, tariffTimeline, observedBalances)` result containing total cost or an unavailable reason, finish time, wall kWh, and per-segment breakdown. Price `min(segmentKwh, max(remainingSurplus[periodKey], 0))` at `sellRate`, the rest at `buyRate`, then reduce that period's remaining surplus. Appliance power is `totalKwh / durationHours`. Car battery energy is `capacityKwh × (targetSOC − initialSOC) / 100`; wall energy is battery energy divided by the selected level's internal efficiency; duration is wall energy divided by wall kW. Use clearly labeled approximation constants of 1.5 kW and 85% efficiency for Level 1, and 9 kW and 90% efficiency for Level 2. Keep them internal; label UI results approximate. Reject non-finite and non-positive inputs; do not show a partial total when the timeline ends early.
4. Rerun the focused suite; expect pass. Commit as `feat(ios): estimate start-now load cost across tariffs`.

### Task 5: Build the Load profiles sheet

**Files:** Create `cmd/ios-app/PWUsage/Views/LoadProfilesSheet.swift`; modify `cmd/ios-app/PWUsage/Views/LoadTimingView.swift` to present it.

1. Build a SwiftUI preview with all built-ins and two custom loads. Check that labels, units, and Add/Edit/Delete controls remain readable at accessibility text sizes.
2. Implement built-in edit and reset, plus custom create, edit, and delete. Use steppers for Car capacity and SOC levels and a Level 1 / Level 2 picker. Appliance and custom editors expose name where applicable, kWh, and duration. Save through `LoadProfileStore` only after validation; keep unsaved edits local to the sheet. Provide meaningful VoiceOver labels for each control and destructive confirmation for delete.
3. Run `./run-tests.sh LoadProfileStoreTests`; expect pass. Commit as `feat(ios): add load profile settings sheet`.

### Task 6: Replace the detail estimate and fixed action cue

**Files:** Modify `cmd/ios-app/PWUsage/Views/LoadTimingView.swift` and `cmd/ios-app/PWUsage/Models/LoadTimingAffordance.swift`; update `cmd/ios-app/PWUsageTests/LoadTimingViewTests.swift` and `cmd/ios-app/PWUsageTests/LoadTimingAffordanceTests.swift`.

1. Write presentation tests for selected-load title, approximate wall-energy text, finish time, tariff breakdown, unavailable states, zero-charge state, and the current-balance/source-time explanation. Remove assertions that depend on the old fixed Dishwasher/Laundry/Car headroom ranking.
2. Run the two focused suites; confirm the new assertions fail.
3. Keep the chip picker and Car battery visualization; remove inline profile editing. Place the gear in the toolbar and open the sheet. Show one selected-load start-now result and use it in the large action panel. Keep observed billing-cycle period tiles and existing refresh/staleness behavior. Retain cheaper-period information only as informational timing, without claiming that moving the entire run to that period would produce the displayed start-now cost.
4. Rerun the focused suites. Check previews for a tariff crossing, a long Level 1 charge, no cycle data, stale data, and large Dynamic Type. Commit as `feat(ios): show selected load start-now estimate`.

### Task 7: Final verification

1. From `cmd/next-app`, run `npm run lint`, `npm run test -- --run`, and `npm run build`. Expect exit code 0 for each.
2. From `cmd/ios-app`, run `./run-tests.sh` once for the full Swift Testing suite. Use this script for every native run; inspect retained artifacts before changing code if it times out.
3. Review the mobile contract JSON size and ensure the timeline adds no Tesla call or additional database read. Review the estimate at a real site with a rate crossing and compare the breakdown sum to the total.
4. Run `git diff --check` and `git status --short`; commit any verification fixes with clear conventional messages.
