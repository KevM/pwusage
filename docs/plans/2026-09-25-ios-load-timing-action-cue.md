# iOS Load Timing Action Cue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the small cheapest-period sentence with a prominent native “Can run now” verdict based on observed active-period headroom.

**Architecture:** Add a pure Swift decision helper that mirrors the website's largest-covered and next-unmet profile selection, using the existing `LoadTiming` contract and configured Car charge. Present its output as an accessible panel in `LoadTimingView`; keep cheaper-period guidance inside that panel.

**Tech Stack:** SwiftUI, Swift Testing, existing iOS mobile contracts and `cmd/ios-app/run-tests.sh`.

---

### Task 1: Compute the action cue from observed active-period balance

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/LoadTimingAffordance.swift`
- Create: `cmd/ios-app/PWUsageTests/LoadTimingAffordanceTests.swift`

1. Write Swift Testing cases for an observed active period with 17 kWh surplus: Dishwasher is covered, Laundry needs 3 kWh more; with 20 kWh: Laundry is covered; with enough headroom: dynamic Car is covered. Include a deficit, no active observation (even if `pricingPeriods` contains an active synthetic entry), zero planned Car charge, and `nextCheaper` preservation. Run `./run-tests.sh LoadTimingAffordanceTests` and confirm the new tests fail before implementation.
2. Implement a pure helper that reads `timing.periods.first(where: \.isActive)` and uses 5 kWh Dishwasher, 20 kWh Laundry, and `LoadTimingEstimator.carHeadroomKwh(plannedKwh:)` for positive Car planned kWh. Sort by headroom; choose the largest threshold at or below active `cycleNetExportKwh`, and the smallest threshold above it for next-up shortfall. Return semantic data (choice, balance, shortfall, cheaper period), leaving currency/name formatting to the view. An absent active observation returns an explicit awaiting-balance state.
3. Run focused tests, review boundary logic and sign convention, then commit with a conventional message.

### Task 2: Present a prominent, accessible action panel

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/LoadTimingView.swift`
- Modify: `cmd/ios-app/PWUsageTests/LoadTimingViewTests.swift` only for meaningful presentation-state tests

1. Replace the current inline recommendation with a full-width **Can run now** panel above **Your energy balance**. Show the largest covered choice in large type with an appropriate symbol; show active rate period and rounded surplus/deficit, then next-up shortfall. With no affordable choice, show **Avoid large loads**; with no observed active balance, say that this period's balance is not recorded yet. Keep the screen and estimator headings.
2. Preserve `nextCheaper` guidance as a short separate line in the panel: period name, marginal cents-per-kWh rate, and relative start phrase. Do not show the old cheapest-observed sentence. Ensure the panel's VoiceOver label speaks all meaningful content, and let large text wrap rather than clip.
3. Run `./run-tests.sh LoadTimingViewTests`, inspect relevant preview or simulator layout if available, self-review, and commit with a conventional message.

### Task 3: Integrated gates and PR update

1. Run `./run-tests.sh` from `cmd/ios-app`; do not invoke `xcodebuild test` directly.
2. Run `npm run test -- --run`, `npm run lint`, and `npm run build` from `cmd/next-app` as required repository gates. The web app itself is unchanged.
3. Check `git diff --check`, review the full branch diff, push `codex/ios-load-timing`, update PR #114, and verify CI and preview deployment.
