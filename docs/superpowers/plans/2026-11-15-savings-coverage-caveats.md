# Savings Coverage Caveats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a savings figure leaves days out, say which rate plan is missing for which days, and give the owner one tap to fix it.

**Architecture:** `SavingsCalculator.priceCycle` already decides per slot whether a day is counted. It now also records, for each site-local day, why an uncounted day was left out. `makeFigures` turns those per-day records into `SavingsFigures.coverageGaps` for each period (cycle, year, lifetime). `SavingsPresentation.caveats` turns gaps into fixed copy plus an action; the Bill card and Solar System section render them and route the actions to `FixedRatePlanForm` or the Rate Plans screen. Copy and math come from the same loop, so they cannot disagree.

**Tech Stack:** Swift 6, SwiftUI, Swift Testing, XcodeGen (`cmd/ios-app`). iOS only; no server change.

**Spec:** Savings Phase 2 plan [`2026-11-14-savings-phase-2.md`](./2026-11-14-savings-phase-2.md) and its design spec [`../specs/2026-11-13-savings-and-roi-design.md`](../specs/2026-11-13-savings-and-roi-design.md) §6. Decisions below were made with the owner on 2026-11-15 and take precedence.

**Base:** `main` (PR #374 merged 2026-11-15).

## Decisions

- Partial estimates stay. Each period shows its figure, then `Based on X of Y days`, then one caveat line per fixable cause. Complete coverage shows nothing extra.
- Causes, per uncounted site-local day in the period:
  1. **No fixed rate plan:** the day has data, and some data slot got `.unknown` from `reference.period(at:strict: true)`.
  2. **No rate plan:** the day has data, and some data slot got `.unknown` from `actual.period(at:strict: true)`.
  3. **No data:** no slot on the day has recorded grid and all three scenario grids (includes days with no stored `EnergyFlowDay`). Informational only: no caveat line, since `Based on X of Y days` already says it.
  A day missing both plans counts under both 1 and 2 (fixing one alone does not bring it back). Days without data are never blamed on a plan.
- A "data slot" is one where recorded `gridWh` and the three scenario `gridWh` values are all non-nil: exactly the slots `priceCycle` can price. A day is **counted** when at least one slot was priced (today's `hasRecordedSlot`).
- Ranges per cause are runs of that cause's days, sorted. A run breaks only at a **counted** day, so a gap interrupted by days with no data reads as one range. `days` is the exact count of that cause's days, not the span.
- The fixed rate plan line uses the "starts" form when every gap day is before the reference timeline's earliest `effectiveFrom`; otherwise it uses the range form.
- **Edit Fixed Rate Plan** opens `FixedRatePlanForm` editing the **earliest** reference period (the one whose start leaves days out), with a one-tap suggestion to start on the first uncounted day. **Fix Rate Plans** opens the existing Rate Plans screen (`TariffSheet`). Both screens already refresh savings on save (`DashboardCoordinator+Tariffs.swift` `refreshSavings(timeline:)`; `saveFixedRatePlan`).
- On the Solar System section, caveats appear once, under **Lifetime** (lifetime gaps include the year's). The Bill card shows the cycle's.
- A period with zero counted days but a fixable gap still shows its caveats (today the Bill card hides itself when `daysWithData == 0`, which hides exactly the case that most needs the prompt).
- Out of scope: inferring rate plans automatically (later work).

## Global Constraints

- Voice (`docs/voice-and-terms.md`): "rate plan", never "tariff"; no "Time of Use"/"TOU" on these surfaces; "about" on every estimate; no dashes as separators (ranges use "to"); title case buttons, sentence case body; curly apostrophe `’` as in existing savings copy.
- Fixed copy (en_US, dates via `RatePlanTimelineFormatting.displayDate`, e.g. `Nov 1, 2026`):
  - `Your fixed rate plan starts Nov 1, 2026, so earlier days aren’t counted.` → button `Edit Fixed Rate Plan`
  - `We don’t have your fixed rate plan for <ranges>, so those days aren’t counted.` → button `Edit Fixed Rate Plan`
  - `We don’t have your rate plan for Mar 2 to Jun 30, 2024, so those days aren’t counted.` → button `Fix Rate Plans`
  - `<ranges>`: one day `Mar 2, 2024`; one range in one year `Mar 2 to Jun 30, 2024`; across years `Dec 20, 2023 to Jan 4, 2024`; two ranges joined with ` and `; three or more `41 days between Mar 2, 2024 and Jun 30, 2025`.
  - Order: fixed rate plan line first, then rate plan line.
- iOS app is beta: no compatibility shims for old builds or cached reports.
- CI: `cd cmd/ios-app && ./lint.sh` (swiftformat `--lint`, swiftlint `--strict`, zero warnings) and `./run-tests.sh`. Iterate with `./run-tests.sh --quick <Suites>`. Run `./generate.sh` after adding files.
- Swift Testing only; TDD (failing test first).
- Pure logic lives in `SavingsCalculator` / `SavingsPresentation`; views only render and route.
- The three-year benchmark (`Three synthetic years compute under 5 seconds`) must still pass; gap tracking adds per-day work, not per-slot resolver calls.

## Review Focus

1. **Coverage arithmetic must add up:** for every period, `daysWithData + (uncounted days) == daysInPeriod`, including days with no stored `EnergyFlowDay`. → Task 1 `uncountedDaysPartitionThePeriod`.
2. **A day with recorded grid but nil home use** (scenario grids nil) on a day with both plans: it is "no data", not a plan gap. → Task 1 `incompleteSlotsAreNoDataNotPlanGaps`.
3. **A cycle with zero counted days** because the fixed rate plan starts in the future or after the cycle start: the Bill card still renders, with the caveat and no `$0` headline. → Task 3 `zeroCountedCycleShowsCaveatsWithoutHeadline`.
4. **A fixed rate plan gap after the plan ends** (`effectiveTo` set, or a hole between two reference plans): range form, not "starts" form. → Task 2 `fixedGapAfterPlanStartUsesRangeForm`.
5. **Many short rate plan holes** (more than two runs): one line with the day count, not a long list. → Task 2 `threeOrMoreRangesSummarizeAsDayCount`.

---

### Task 1: Classify uncounted days in `SavingsCalculator`

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/Savings/SavingsCalculator.swift`
- Modify: `cmd/ios-app/PWUsage/Models/Bill/Pricing/RatePeriodResolver.swift` (add `earliestEffectiveFrom`)
- Test: `cmd/ios-app/PWUsageTests/SavingsCoverageTests.swift` (new suite)
- Modify: `cmd/ios-app/PWUsageTests/SavingsCalculatorTests+Helpers.swift`: move the helpers into a shared `enum SavingsTestFixtures` (call sites in `SavingsCalculatorTests` updated), add `effectiveTo: String? = nil` to `makeFlatPeriod`, and add `makeTimeline(actual: [TariffPeriodDTO], reference: [TariffPeriodDTO]) -> SiteTariffsTimelineResponse` for multi-period fixtures

**Interfaces:**
- Produces:
  ```swift
  enum SavingsGapCause: Equatable, Sendable { case noFixedRatePlan, noRatePlan, noData }
  struct SavingsDayRange: Equatable, Sendable { let first: String; let last: String } // site-local "yyyy-MM-dd", inclusive
  struct SavingsCoverageGap: Equatable, Sendable {
      let cause: SavingsGapCause
      let days: Int
      let ranges: [SavingsDayRange]          // sorted; a run breaks only at a counted day
      let fixedRatePlanStart: String?        // .noFixedRatePlan only: reference earliest effectiveFrom when every gap day precedes it
  }
  // SavingsFigures gains (memberwise default keeps existing call sites compiling):
  var coverageGaps: [SavingsCoverageGap] = []   // ordered noFixedRatePlan, noRatePlan, noData; causes with 0 days omitted
  func gap(_ cause: SavingsGapCause) -> SavingsCoverageGap?
  // RatePeriodResolver:
  var earliestEffectiveFrom: String? { get }   // min effectiveFrom of its periods
  ```
- Internals (private, decided here): `CycleResult` carries `dayStatuses: [String: DayStatus]` keyed by `EnergyFlowDay.day`, where `DayStatus` is `counted` or `uncounted(missingRatePlan: Bool, missingFixedRatePlan: Bool)`. In `priceCycle`, check scenario grid completeness **before** resolving periods; resolve each data slot's `actual` and `reference` period once (as now) and set the day's flags from the `.unknown` results. `makeFigures` merges the cycles' maps, walks every site-local day from `startDay` through `today` (format with `RatePlanTimelineFormatting.formatYMD(_:in:)` in the resolver's zone; a day absent from the map is no data), and builds the gaps. Keep `daysWithData` computed as today.

- [x] **Step 1: Write the failing tests** in `SavingsCoverageTests` (UTC timeline, `billingDay: 1`, flat plans from the helpers):
  - `completeCoverageHasNoGaps`: plans from 2020-01-01, data every day of the cycle → `report.cycle.coverageGaps.isEmpty`.
  - `fixedRatePlanStartingLateIsNoFixedRatePlan`: data 2026-06-01…06-10, reference from `2026-06-05`, now 2026-06-10 12:00 → `cycle.gap(.noFixedRatePlan) == SavingsCoverageGap(cause: .noFixedRatePlan, days: 4, ranges: [.init(first: "2026-06-01", last: "2026-06-04")], fixedRatePlanStart: "2026-06-05")`; `gap(.noRatePlan) == nil`.
  - `missingRatePlanIsNoRatePlan`: actual from `2026-06-04`, reference from 2020 → `gap(.noRatePlan)?.days == 3`, ranges `[2026-06-01…2026-06-03]`, `fixedRatePlanStart == nil`.
  - `dayMissingBothPlansAppearsInBothCauses`: actual and reference both from `2026-06-03` → both gaps have `days == 2`.
  - `incompleteSlotsAreNoDataNotPlanGaps`: 2026-06-02 has grid but `load: [nil]`; reference from 2026-06-05 → 06-02 is in `gap(.noData)` and **not** in `gap(.noFixedRatePlan)` (`days == 3`).
  - `missingStoredDaysAreNoData`: stored days 06-01 and 06-04 only, now 06-04 → `gap(.noData)?.days == 2`, ranges `[06-02…06-03]`.
  - `runsBridgeNoDataDaysButBreakAtCountedDays`: three actual periods `[06-01…06-02]`, `[06-07…06-07]`, `[06-09…open]`; reference from 2020; data every day 06-01…06-10 except 06-04 (no stored day) → `gap(.noRatePlan)?.ranges == [06-03…06-06, 06-08…06-08]`, `days == 4` (06-03, 06-05, 06-06, 06-08); `gap(.noData)?.days == 1`.
  - `fixedGapAfterReferenceEndsHasNoStart`: reference `effectiveTo: "2026-06-05"` → `gap(.noFixedRatePlan)?.fixedRatePlanStart == nil`, ranges `[06-06…06-10]`.
  - `uncountedDaysPartitionThePeriod`: a fixture with all three causes and no day missing both plans (reference from 06-05, actual missing 06-07…06-08, no stored day 06-10, now 06-12) → for cycle, year and lifetime, `daysWithData + (noData + noFixedRatePlan + noRatePlan days) == daysInPeriod`.
  - `yearAndLifetimeGapsSpanCycles`: data across three billing cycles, reference starting in the middle cycle → `lifetime.gap(.noFixedRatePlan)` is one range crossing the first cycle boundary, `cycle.gap(.noFixedRatePlan) == nil`.
  - In the existing `SavingsCalculatorTests`, extend `excludesDaysBeforeReferenceEffectiveFrom` with `#expect(report.lifetime.gap(.noFixedRatePlan)?.fixedRatePlanStart == "2026-01-01")`.
- [x] **Step 2: Run** `./run-tests.sh --quick SavingsCoverageTests SavingsCalculatorTests`. Expected: FAIL (types not defined).
- [x] **Step 3: Implement** the types and the classification described in Interfaces. `fixedRatePlanStart` = `reference.earliestEffectiveFrom` when the gap's last day `<` it, else `nil`.
- [x] **Step 4: Run** the two suites, then `./run-tests.sh --quick SavingsModelTests SavingsPresentationTests` (they build `SavingsFigures`) and `./lint.sh`. Expected: PASS, benchmark still under budget.
- [x] **Step 5: Commit** `feat(savings): classify uncounted days by cause per period`.

### Task 2: Caveat copy in `SavingsPresentation`

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/Shared/SavingsPresentation.swift`
- Test: `cmd/ios-app/PWUsageTests/SavingsPresentationTests.swift`

**Interfaces:**
- Consumes: Task 1 `SavingsFigures.coverageGaps`, `SavingsCoverageGap`, `SavingsDayRange`.
- Produces:
  ```swift
  struct SavingsCaveat: Equatable, Sendable, Identifiable {
      enum Action: Equatable, Sendable {
          case editFixedRatePlan(suggestedStart: String?) // first uncounted day when the "starts" form applies
          case fixRatePlans
      }
      let text: String
      let action: Action
      var actionTitle: String { get }   // "Edit Fixed Rate Plan" | "Fix Rate Plans"
      var id: String { get }            // "fixed" | "ratePlan"
  }
  extension SavingsPresentation {
      static func caveats(_ figures: SavingsFigures) -> [SavingsCaveat]
      static func dayRangesText(_ ranges: [SavingsDayRange], days: Int) -> String
  }
  ```
- Dates format with `RatePlanTimelineFormatting.displayDate` (en_US_POSIX, so copy is stable); the same-year short form drops the year from the first date using the same style without `.year()`.

- [x] **Step 1: Write the failing tests** (strings exactly as in Global Constraints):
  - `fixedRatePlanStartCaveat`: gap with `fixedRatePlanStart: "2026-11-01"`, ranges `[2026-10-01…2026-10-31]` → `[SavingsCaveat(text: "Your fixed rate plan starts Nov 1, 2026, so earlier days aren’t counted.", action: .editFixedRatePlan(suggestedStart: "2026-10-01"))]`.
  - `ratePlanRangeCaveat`: ranges `[2024-03-02…2024-06-30]` → text `"We don’t have your rate plan for Mar 2 to Jun 30, 2024, so those days aren’t counted."`, action `.fixRatePlans`.
  - `fixedGapAfterPlanStartUsesRangeForm`: no `fixedRatePlanStart` → `"We don’t have your fixed rate plan for …"`, action `.editFixedRatePlan(suggestedStart: nil)`.
  - `dayRangesTextForms`: single day → `"Mar 2, 2024"`; across years → `"Dec 20, 2023 to Jan 4, 2024"`; two ranges → `"Mar 2 to Mar 5, 2024 and Jun 1 to Jun 30, 2024"`.
  - `threeOrMoreRangesSummarizeAsDayCount`: three ranges, `days: 41` → `"41 days between Mar 2, 2024 and Jun 30, 2025"`.
  - `caveatsOrderFixedThenRatePlan` and `noDataAloneGivesNoCaveats` and `completeCoverageGivesNoCaveats`.
- [x] **Step 2: Run** `./run-tests.sh --quick SavingsPresentationTests`. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** the suite and `./lint.sh`. Expected: PASS.
- [x] **Step 5: Commit** `feat(savings): caveat copy for uncounted days`.

### Task 3: Mockups (gate for Task 4)

- [x] **Step 1:** Publish mockups as an Artifact (light and dark), using the copy from Task 2:
  - Bill tab savings card, partial cycle: headline, breakdown, `Based on 14 of 31 days`, the fixed rate plan caveat with **Edit Fixed Rate Plan**.
  - Bill tab card with **zero counted days**: no `$` headline; title `See what you’ve saved`, then the caveat line(s) and button(s). (Proposed; owner to confirm.)
  - Solar System Savings section: Past Year and Lifetime blocks, both caveats under Lifetime only, each with its button.
  - `FixedRatePlanForm` opened from the caveat: Starts on row showing the current start, and a button under it `Start on Oct 1, 2026` that sets the date (proposed; owner to confirm, or open the date picker directly instead).
  - Rate Plans screen presented as a sheet from the Bill tab with a **Done** button.
- [ ] **Step 2:** The owner approves or edits. **Task 4 does not start until they approve.** Record the approved layout and any copy changes in this plan (and in Task 2's tests if copy changed) before Task 4.

### Task 4: Render caveats and route the actions

**Files:**
- Create: `cmd/ios-app/PWUsage/Views/Shared/SavingsCaveatRows.swift` (a view rendering `[SavingsCaveat]`: caption text, then a borderless button per caveat; takes `onAction: (SavingsCaveat.Action) -> Void`)
- Create: `cmd/ios-app/PWUsage/Views/Bill/RatePlansSheet.swift` (`NavigationStack { TariffSheet(site:actions:) }` with a **Done** toolbar button)
- Modify: `cmd/ios-app/PWUsage/Views/Bill/BillSavingsCard.swift`, `cmd/ios-app/PWUsage/Views/Bill/BillView.swift` (`BillSheet` gains `.ratePlans`; `.fixedRatePlan` carries the suggestion), `cmd/ios-app/PWUsage/Views/SolarSystem/SolarSystemSavingsSection.swift`, `cmd/ios-app/PWUsage/Views/SolarSystem/SolarSystemView.swift` (takes `site: MobileSite`), `cmd/ios-app/PWUsage/Views/Settings/SettingsView.swift` (passes `site`; uses the shared actions factory), `cmd/ios-app/PWUsage/Views/Bill/FixedRatePlanForm.swift` (`suggestedStartDate: String?`), `cmd/ios-app/PWUsage/Views/Bill/ActiveRatePlanCardView.swift` or a new `State/Home/DashboardCoordinator+Tariffs.swift` extension (`TariffTimelineActions.live(_ coordinator: DashboardCoordinator)` built from the closures `SettingsView` uses today), `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+Savings.swift` (`earliestReferencePeriod`)
- Test: `cmd/ios-app/PWUsageTests/SavingsPresentationTests.swift`

**Interfaces:**
- Consumes: Task 2 `SavingsPresentation.caveats`, `SavingsCaveat.Action`.
- Produces:
  - `BillSavingsCard` gains `onCaveatAction: (SavingsCaveat.Action) -> Void`; `SolarSystemSavingsSection` gains the same.
  - `SavingsPresentation.showsCard(_ figures: SavingsFigures) -> Bool` = `daysWithData > 0 || !caveats(figures).isEmpty` (pure, tested).
  - `DashboardCoordinator.earliestReferencePeriod: TariffPeriodDTO?` = reference period with the smallest `effectiveFrom`.
  - Routing: `.editFixedRatePlan(suggestedStart: s)` opens `FixedRatePlanForm(existing: s == nil ? activeReferencePeriod : earliestReferencePeriod, suggestedStartDate: s, …)`; `.fixRatePlans` presents `RatePlansSheet`. Call `coordinator.refreshSavings()` in the sheet's `onDismiss` for the Rate Plans sheet only if Task 4 Step 4 shows the card stale after an edit (saves already refresh it).

- [ ] **Step 1: Write the failing tests:** `zeroCountedCycleShowsCaveatsWithoutHeadline` (`showsCard` true for `daysWithData: 0` with a `.noRatePlan` gap; false with only `.noData`), `showsCardForCountedDays`.
- [ ] **Step 2: Run** `./run-tests.sh --quick SavingsPresentationTests`. Expected: FAIL.
- [ ] **Step 3: Implement** `showsCard`, then the views and routing per the approved mockups. Views call only `SavingsPresentation`; no gap logic in views.
- [ ] **Step 4: Verify in the simulator** (iPhone 17, demo or a dev site): set the fixed rate plan start after the first history day → caveat appears on the Bill card and under Lifetime; tap **Edit Fixed Rate Plan**, use the suggested start, save → caveat disappears and `Based on` counts rise. Delete a rate plan span in Rate Plans → **Fix Rate Plans** line appears and opens the Rate Plans sheet. Check light and dark mode and the largest Dynamic Type size.
- [ ] **Step 5: Run** `./generate.sh`, `./run-tests.sh` (full) and `./lint.sh`. Expected: PASS, zero warnings.
- [ ] **Step 6: Commit** `feat(ios): explain partial savings and link to the rate plan fix`.
