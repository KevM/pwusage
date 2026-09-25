# iOS Load Timing Polish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the native Load timing screen compact, show USD unit rates in cents, and estimate a configurable car charge.

**Architecture:** Keep the existing mobile API payload and `LoadTimingEstimator.costToRun` calculation. Add a pure car energy helper and adapt the SwiftUI screen's local selection state; format unit rates at the presentation boundary. Total estimated prices remain in the site's currency.

**Tech Stack:** SwiftUI, Swift Testing, iOS 18+, existing `cmd/ios-app/run-tests.sh`.

---

### Task 1: Unit-rate language and section labels

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/DashboardPresentation.swift`
- Modify: `cmd/ios-app/PWUsage/Views/LoadTimingView.swift`
- Test: `cmd/ios-app/PWUsageTests/DashboardPresentationTests.swift`
- Test: `cmd/ios-app/PWUsageTests/LoadTimingViewTests.swift`

1. Add a failing Swift Testing case proving a USD `0.04` rate is rendered as `4¢/kWh` and a non-USD rate retains its currency format. Run `./run-tests.sh DashboardPresentationTests` from `cmd/ios-app` and confirm failure.
2. Update the shared `loadRate` formatter for USD and keep `loadRateAccessibilityLabel` speaking cents. Keep `currency` for total estimates. Run the focused suite and confirm pass.
3. Rename **Observed this cycle** to **Your energy balance** and add **By rate period this billing cycle** supporting text. Keep the tiles limited to observed periods.
4. Remove the recommendation card heading and card chrome; retain the recommendation message inline near the top under the screen title. Preserve all recommendation states and accessibility. Add or update a focused view presentation test for the inline text. Run `./run-tests.sh LoadTimingViewTests`.
5. Commit these changes with a conventional message.

### Task 2: Car estimate and compact controls

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/LoadTimingEstimator.swift`
- Modify: `cmd/ios-app/PWUsage/Views/LoadTimingView.swift`
- Modify: `cmd/ios-app/PWUsage/Views/DashboardPreviews.swift` if fixture or preview setup needs adjustment
- Test: `cmd/ios-app/PWUsageTests/LoadTimingEstimatorTests.swift`
- Test: `cmd/ios-app/PWUsageTests/LoadTimingViewTests.swift`

1. Add failing tests for a pure helper such as `carChargeKwh(capacityKwh:currentPercent:targetPercent:)`: `60,20,80 -> 36`; target no higher than current -> `0`; invalid/non-finite input cannot produce a negative or non-finite value. Run `./run-tests.sh LoadTimingEstimatorTests` to confirm failure.
2. Implement the helper. Replace Big car and Little car profile choices with a single Car choice, retaining Laundry and Dishwasher. Keep preset amounts and headroom behavior for those two profiles.
3. Put Car, Laundry, Dishwasher, Custom chips in one horizontally scrolling row with visible selection and accessible names. Car defaults to 60 kWh capacity, 20% current charge, and 80% target. Show compact capacity and current-charge controls plus one **Charge to** slider. Display the computed kWh and note that charging losses are excluded. Keep values within sensible bounds and make the target/current relationship clear.
4. Replace the Custom kWh slider with a compact numeric amount control. Remove covered/bought graphical bars; keep coverage quantities and verdict as text in each estimate row. Reduce avoidable spacing without hiding rate, start cue, total, or VoiceOver information.
5. Update focused tests and previews. Run `./run-tests.sh LoadTimingEstimatorTests` and `./run-tests.sh LoadTimingViewTests`; commit these changes with a conventional message.

### Task 3: Integrated verification and review

1. Run `./run-tests.sh` from `cmd/ios-app` (never run `xcodebuild test` directly). Verify the full native suite passes.
2. Run `npm run lint`, `npm run test -- --run`, and `npm run build` from `cmd/next-app` because repository guidance requires them, even though server code is untouched.
3. Inspect a SwiftUI preview or simulator rendering for narrow iPhone width and large text, especially chip scrolling and the single Car slider. Check `git diff --check` and the PR diff. Commit any corrections, then push the feature branch to update PR #114.
