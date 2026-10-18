# Smart Shift Energy Weather Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Smart Shift Job card with a verdict sentence, cost bars, a why line and a per-rate-period "energy weather" chart. It works with or without a Solcast forecast, opens on the last Job viewed, and uses "Verb the noun" Job names.

**Architecture:** `LoadTimingForecastEstimator` gains a `Projection` seam: `.forecast` keeps today's math, and `.flat` holds balances still, so one engine prices start times both ways. Its `Comparison` also returns per-period balance lanes for "start now" and the recommended start. A pure `SmartShiftPresentation` turns that into display values (all copy lives there and is unit-tested). Thin SwiftUI views (cost bars, a Swift Charts chart, a details sheet) render it inside `LoadTimingView`.

**Tech Stack:** Swift 6 / SwiftUI, iOS 18, Swift Charts, Swift Testing (`@Test`, `#expect`), XcodeGen via `cmd/ios-app/run-tests.sh`.

**Spec:** `docs/superpowers/specs/2026-10-18-smart-shift-energy-weather-design.md`. Read it first; the mockups are in `docs/superpowers/specs/assets/`.

**Branch:** start from the tip of `feat/smart-shift-one-job-card` (PR #157), or from `main` once #157 is merged. All paths below are relative to `cmd/ios-app/`.

## Global Constraints

- iOS 18 SwiftUI; follow `SectionTheme` and existing dark-mode conventions; mockup colors are illustrative.
- No new Solcast requests and no new server routes. Everything is computed on device from the bill response, tariff timeline, cycle balances, Solcast batch and planning context.
- The overlay and comparison are computed once per body pass, never on the minute tick (keep PR #157's frozen-forecast behavior).
- One word for the concept: "bank" (banked / owed). Never "cushion", "surplus" or "grid rate" in new copy.
- Job names are used verbatim; no "Run"/"Charge" prefixes.
- VoiceOver: the verdict, bars and lane end values are readable, and the chart has an accessibility summary.
- Run the suite with `./run-tests.sh` (or `./run-tests.sh <SuiteName>`); expected final line `** TEST SUCCEEDED **`.

## Review Focus

1. **Recommended start equals now** (savings at or below the currency minor unit): exactly one cost bar, no percent label, one line per lane, and the "now: no cheaper time today" headline. Tested in Task 4.
2. **A plan whose rate period has no balance yet** (`pricingPeriods` lacks it): the forecast-free path prices it at the buy rate and flags it, and the screen shows the unobserved-balance note rather than hiding. Tested in Tasks 2 and 4.
3. **Three or four rate periods**: only lanes the plans touch plus the period in effect now, ordered by first occurrence from now, and a switch marker at each period change inside the horizon. Tested in Task 3.
4. **Zero and negative starting balances**: the start label reads "0 kWh now", "−6 kWh owed now" or "+18 kWh banked now"; equal end values on a lane produce one end label. Tested in Task 4.
5. **DST fall-back day in flat mode**: candidate starts and the horizon follow the site's wall clock (25-hour day), with no duplicate start times. Tested in Task 2.

---

### Task 1: "Verb the noun" Job names and store migration

**Files:**
- Modify: `PWUsage/State/LoadProfileStore.swift` (`schemaVersion`, `defaultProfiles`, `loadCollection`)
- Modify: `PWUsage/Views/LoadTimingView.swift:55-61` (`actionTitle`, `explorationTitle`)
- Modify: `PWUsage/Views/LoadProfilesSheet.swift` (custom-name placeholder)
- Test: `PWUsageTests/LoadProfileStoreTests.swift`, `PWUsageTests/LoadTimingViewTests.swift`

**Interfaces:**
- Produces: `LoadProfileStore.schemaVersion == 2`; built-in names `car` → "Charge the car", `dishwasher` → "Wash the dishes", `washer` → "Wash the laundry", `dryer` → "Dry the laundry", `washer-dryer-combo` → "Wash and dry the laundry"; `custom-example` → "Bake bread". `LoadTimingPresentation.actionTitle(for:)` returns `profile.name`.

- [ ] **Step 1: Write the failing tests** in `LoadProfileStoreTests`:
  - `migratesVersionOneBuiltInNames`: seed `UserDefaults` with a v1 collection (version 1, today's built-in names, a custom UUID job named "Pool pump", `selectedProfileID: "dryer"`). After `LoadProfileStore(userDefaults:)`, built-ins carry the new names, "Pool pump" is unchanged, `selectedProfileID == "dryer"`, energy and car settings are untouched, and the persisted version is 2.
  - `renamesSeededCustomExampleOnlyWhileUnchanged`: `custom-example` named "Custom" becomes "Bake bread"; named "Hot tub" stays "Hot tub".
  - `freshInstallUsesVerbNames`: `profiles.map(\.name)` equals the six new names in order.
  - In `LoadTimingViewTests`, update `recommendationAndExplorationTitlesNameProfileKind` to expect `actionTitle(for: car) == "Charge the car"`, and remove the `explorationTitle` assertions.
- [ ] **Step 2: Run** `./run-tests.sh LoadProfileStoreTests`. Expected: FAIL (old names; a v1 collection still loads as version 1).
- [ ] **Step 3: Implement.** Set `schemaVersion = 2` and use the new default names. `loadCollection` accepts versions 1 and 2. For version 1, it replaces each built-in's name with its default's name, and renames `custom-example` only while its name is exactly "Custom". Then it returns a version-2 collection; `init` already persists. `actionTitle(for:)` returns `profile.name`; delete `explorationTitle` and its call sites. The custom name `TextField` placeholder becomes "Bake bread".
- [ ] **Step 4: Run** `./run-tests.sh`. Expected: `** TEST SUCCEEDED **` (fix any other assertions on old names).
- [ ] **Step 5: Commit** `feat(ios): name Smart Shift Jobs "Verb the noun" and migrate saved Jobs`.

### Task 2: Projection seam with a flat (forecast-free) projection

**Files:**
- Modify: `PWUsage/Models/LoadTimingForecastEstimator.swift`
- Test: `PWUsageTests/LoadTimingForecastEstimatorTests.swift`

**Interfaces:**
- Produces:
  ```swift
  enum Projection: Equatable {
      case forecast(intervals: [SolarForecastInterval], context: PlanningContext)
      case flat(timeZone: String)
  }
  static func evaluate(profile: LoadProfile, now: Date, timing: LoadTiming, projection: Projection,
                       balanceSourceTime: Date, billingCycleEnd: Date, currencyCode: String) -> Result
  ```
  `Comparison` gains `let hasUnobservedBalance: Bool` (always `false` for `.forecast`). The existing `evaluate(profile:now:timing:forecast:context:...)` stays as a one-line wrapper calling `.forecast`, so existing call sites and tests are unchanged.

- [ ] **Step 1: Write the failing tests** (reuse the file's existing tariff fixtures):
  - `flatProjectionPricesLaterStartFromOffPeakBank`: Peak 07:00–16:30 (buy 0.38, sell 0.10), Off-Peak otherwise (buy 0.20, sell 0.26). Balances: Peak −6, Off-Peak +18. Job: 14 kWh over 5.9 h, now 08:30. Expect `recommendedStart` = 16:30 local, `costNow ≈ 14 × 0.38` (all bought during Peak), `recommendedCost ≈ 14 × 0.26` (credit given up), `estimatedSolarContribution == 0`.
  - `flatProjectionAllowsHourOldBalances`: `balanceSourceTime` 55 minutes before now. `.flat` returns a comparison; `.forecast` with the same input returns `.staleBalance` (it keeps 30 minutes).
  - `flatProjectionPricesMissingPeriodAtBuyRate`: Off-Peak is missing from `pricingPeriods`. The comparison exists, `hasUnobservedBalance == true`, and running in Off-Peak costs the buy rate.
  - `flatProjectionFollowsFallBackWallClock` (Review Focus 5): America/Chicago on 2026-11-01, now 00:10. `evaluatedStarts` has no duplicates, every start is on a local :00/:30 boundary, a tariff switch or now, and the horizon ends at local midnight after the 25-hour day plus the next full day (capped by cycle end).
- [ ] **Step 2: Run** `./run-tests.sh LoadTimingForecastEstimatorTests`. Expected: FAIL (no `Projection`).
- [ ] **Step 3: Implement.** Route the solar, household and coverage lookups through the projection:
  - `.flat` has net export 0 for every interval; integration boundaries are the tariff and half-hour boundaries only; forecast/context coverage checks and `firstContextGap` are skipped; solar contribution is 0.
  - Maximum balance age is 30 minutes for `.forecast` (unchanged) and 60 minutes for `.flat`.
  - Missing balances: `.forecast` keeps its truncate-or-reject rule. `.flat` seeds the missing period at 0 and sets `hasUnobservedBalance`.
  - The horizon for `.flat` is `min(endOfTomorrow, billingCycleEnd, contiguousTariffEnd)`.
  - The `.flat` assumptions list replaces the household line with "Balances are held at today's observed values; no solar or household use is projected."
- [ ] **Step 4: Run** `./run-tests.sh LoadTimingForecastEstimatorTests`, then `./run-tests.sh`. Expected: new and existing tests pass.
- [ ] **Step 5: Commit** `feat(ios): price Smart Shift start times without a solar forecast`.

### Task 3: Balance lanes in the comparison

**Files:**
- Modify: `PWUsage/Models/LoadTimingForecastEstimator.swift`
- Test: `PWUsageTests/LoadTimingForecastEstimatorTests.swift`

**Interfaces:**
- Consumes: `Projection`, `evaluate(... projection: ...)` from Task 2.
- Produces (nested in `LoadTimingForecastEstimator`, referenced elsewhere as `LoadTimingForecastEstimator.BalancePoint`/`.BalanceLane`):
  ```swift
  struct BalancePoint: Equatable { let date: Date; let kwh: Double }
  struct BalanceLane: Equatable {
      let periodKey: String
      let startKwh: Double                 // projected balance at `now`
      let recommended: [BalancePoint]      // now → horizonEnd, baseline + recommended run
      let startNow: [BalancePoint]         // now → horizonEnd, baseline + run starting now
  }
  ```
  `Comparison` gains `let lanes: [BalanceLane]` and `let periodSwitches: [Date]`, the tariff period changes in (now, horizonEnd).

- [ ] **Step 1: Write the failing tests:**
  - `lanesTrackEachPlanAgainstItsBank`: with Task 2's flat fixture, there are lanes for Off-Peak and Peak. Off-Peak `recommended.last.kwh ≈ 18 − 14` and `startNow.last.kwh ≈ 18`. Peak `startNow.last.kwh ≈ −6 − 14` and `recommended.last.kwh ≈ −6`. `startKwh` is +18 and −6, and `periodSwitches` contains 16:30 local.
  - `lanesShowOnlyTouchedPeriodsAndCurrent` (Review Focus 3): four periods (Super Off-Peak, Off-Peak, Mid, Peak), with both plans inside Off-Peak and Mid while Off-Peak is in effect now. The lanes are exactly the touched periods plus the current one, ordered by first occurrence from now.
  - `forecastLanesIncludeProjectedSolar`: with a `.forecast` fixture that has positive solar during Peak, the Peak `recommended` series rises while that plan doesn't touch Peak.
- [ ] **Step 2: Run** `./run-tests.sh LoadTimingForecastEstimatorTests`. Expected: FAIL.
- [ ] **Step 3: Implement.** After scoring, re-integrate from `now` to `horizonEnd` for two plans: the start-now run and the recommended run, each as baseline flow plus load in the run's intervals. Record each period's balance at every integration boundary into that period's points. Integrate the baseline from `projectionStart` to `now` once to get `startKwh`. Lane selection and order: periods whose balance differs from baseline in either plan, plus the period in effect at `now`, ordered by first tariff segment at or after `now`. Use the same validity guards as `score`.
- [ ] **Step 4: Run** `./run-tests.sh`. Expected: `** TEST SUCCEEDED **`.
- [ ] **Step 5: Commit** `feat(ios): return per-period balance lanes for Smart Shift`.

### Task 4: SmartShiftPresentation (all copy and display decisions)

**Files:**
- Create: `PWUsage/Views/SmartShiftPresentation.swift`
- Test: `PWUsageTests/SmartShiftPresentationTests.swift`

**Interfaces:**
- Consumes: `LoadTimingForecastEstimator.Result/Comparison/BalanceLane` (Tasks 2–3), `LoadProfile`, `LoadTiming`.
- Produces:
  ```swift
  struct SmartShiftScreen: Equatable {
      enum Content: Equatable { case verdict(SmartShiftVerdict), blocked(String), noJobs }
      let content: Content
  }
  struct SmartShiftVerdict: Equatable {
      let headline: String
      let barsCaption: String
      let bars: [CostBar]                 // recommended first; 1 bar when recommended == now
      let percentLess: String?            // "36% less"
      let why: String
      let laterLabel: String              // "Charge later"
      let nowLabel: String                // "Charge now"
      let lanes: [LaneDisplay]
      let note: Note?
      let accessibilitySummary: String
  }
  struct CostBar: Equatable { let label: String; let amount: String; let value: Double; let isRecommended: Bool }
  struct LaneDisplay: Equatable {
      let title: String                   // "Off-Peak bank (kWh)"
      let startLabel: String              // "+18 kWh banked now" / "−6 kWh owed now" / "0 kWh now"
      let recommended: [LoadTimingForecastEstimator.BalancePoint]
      let startNow: [LoadTimingForecastEstimator.BalancePoint]?   // nil when recommended == now
      let endLabels: [String]             // 1 when both end at the same rounded value, else [recommended, now]
      let switches: [Date]
  }
  enum Note: Equatable { case connectSolcast, forecastState(String), unobservedBalance }
  enum ForecastAvailability: Equatable { case none, loading, unusable(String), ready }
  enum SmartShiftPresentation {
      static func make(profile: LoadProfile?, result: LoadTimingForecastEstimator.Result,
                       forecast: ForecastAvailability, refreshUnavailable: Bool, timing: LoadTiming,
                       now: Date, billingCycleEnd: Date, currencyCode: String, timeZone: String) -> SmartShiftScreen
      static let connectSolcastNote = "Without a solar forecast, banks are shown as they stand now. Connect Solcast to see today's solar."
      static let checkingSolarNote = "Checking today's solar…"
      static let unobservedBalanceNote = "Some rate periods have no balance yet, so they're priced at the full rate."
  }
  ```

Fixed copy (from the spec, exact):
- Headline, later: `"\(name) at \(time): about \(money(savings)) cheaper than now"`. Headline, now: `"\(name) now: no cheaper time today"`.
- Bars caption: `"Added to your bill (shorter is better)"` with two bars, `"Added to your bill"` with one.
- `percentLess`: `"\(Int(((now − later) / now × 100).rounded()))% less"`; `nil` when there is one bar or `now <= 0`.
- Legend verb: the first word of the name for built-in Jobs ("Charge later"/"Charge now", "Wash later"), and "Start later"/"Start now" for custom Jobs.
- Why line (my call): `"Starting now runs during \(nowPeriod), where you \(bankPhrase). Run at \(time) to use your \(laterPeriod) bank."` `bankPhrase` is "have no bank" when the balance is ≤ 0, else "have \(n) kWh banked". When recommended == now: `"It's \(nowPeriod), and your \(nowPeriod) bank covers \(share) of this run."`, where `share` is "all", "most" (≥50%) or "some", or `"It's \(nowPeriod); this run is bought at the full rate."` if the bank is ≤ 0.
- `note`: `.connectSolcast` for `.none`; `.forecastState(checkingSolarNote)` for `.loading`; `.forecastState(msg)` for `.unusable(msg)`; `.unobservedBalance` when `comparison.hasUnobservedBalance` (this takes precedence over `.ready`; with `.none`, show `connectSolcast`).
- Blocked: when `refreshUnavailable`, `!timing.hasTariff`, or the result's reason is `.staleBalance`, `.missingTariff`, `.incompleteBalance` or `.noFittingRun`, use `.blocked` with one sentence. Map these from the existing `LoadTimingPresentation.recommendationMessage` copy, joining its title and detail into one sentence. `.noFittingRun` where the Job started now would finish after `billingCycleEnd` uses PR #157's "This job would continue beyond the current billing cycle…" sentence; any other `.noFittingRun` uses "This job is longer than the time Smart Shift can compare right now." (Each Job is evaluated alone, so PR #157's "Another saved job…" case no longer arises.)
- `accessibilitySummary`: one sentence per lane: `"\(period) bank: \(startLabel); \(laterLabel) leaves \(x), \(nowLabel) leaves \(y)."`

- [ ] **Step 1: Write the failing tests** with fixture comparisons (build `Comparison` values directly; no estimator):
  - `laterStartVerdict`: "Charge the car", savings 1.89, costs 3.38 and 5.27. Expect headline `"Charge the car at 4:30 PM: about $1.89 cheaper than now"`, two bars with the recommended one first, `percentLess == "36% less"`, laterLabel "Charge later", note `.connectSolcast` for `.none`.
  - `nowIsCheapestShowsOneBar` (Review Focus 1): recommended == now. Expect headline `"Charge the car now: no cheaper time today"`, one bar, `percentLess == nil`, every lane's `startNow == nil`, caption "Added to your bill".
  - `startLabelsAndMergedEndLabels` (Review Focus 4): starts +18, −6 and 0 render as "+18 kWh banked now", "−6 kWh owed now" and "0 kWh now". A lane whose two plans end at the same rounded value has one end label.
  - `unobservedBalanceNote` (Review Focus 2): `hasUnobservedBalance` with `.ready` gives `.unobservedBalance`.
  - `customJobLegend`: a custom Job "Pool pump" gives "Start later"/"Start now".
  - `staleDataBlocks`: `refreshUnavailable == true` gives `.blocked`, with no verdict.
  - `billingCycleCrossingBlocks`: `.noFittingRun`, where a now-start would finish after `billingCycleEnd`, gives `.blocked` containing "beyond the current billing cycle".
  - `whyLineNamesPeriods`: Peak now with balance −6, later Off-Peak: `"Starting now runs during Peak, where you have no bank. Run at 4:30 PM to use your Off-Peak bank."`
- [ ] **Step 2: Run** `./run-tests.sh SmartShiftPresentationTests`. Expected: FAIL (types missing).
- [ ] **Step 3: Implement** `SmartShiftPresentation.make` and its helpers. Format money with the existing currency formatter used by `LoadTimingForecastPresentation`, and times in `timeZone` like `LoadTimingForecastPresentation.clock`.
- [ ] **Step 4: Run** `./run-tests.sh SmartShiftPresentationTests`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ios): Smart Shift verdict, cost and lane presentation`.

### Task 5: Cost bars and energy weather chart views

**Files:**
- Create: `PWUsage/Views/SmartShiftCostBars.swift`, `PWUsage/Views/EnergyWeatherChart.swift`
- Modify: `PWUsage/Views/SolarForecastPreviews.swift` (add previews)

**Interfaces:**
- Consumes: `SmartShiftVerdict`, `CostBar`, `LaneDisplay` (Task 4).
- Produces: `SmartShiftCostBars(verdict: SmartShiftVerdict)` and `EnergyWeatherChart(verdict: SmartShiftVerdict, timeZone: String)`.

- [ ] **Step 1: Build `SmartShiftCostBars`.** Bar widths are proportional to `value / max(value)`, the recommended bar is emphasized (accent, bold label) and the other is muted. `percentLess` sits in the dashed-outlined gap after the shorter bar and is hidden when it doesn't fit (`ViewThatFits`). Each row combines into one accessibility element: "\(label), \(amount)".
- [ ] **Step 2: Build `EnergyWeatherChart`** with Swift Charts, one `Chart` per lane:
  - background: an `AreaMark`/`RectangleMark` band, green above 0 and orange below;
  - a `RuleMark` at 0, and dashed `RuleMark`s at `switches` annotated "← \(before) | \(after) →";
  - `LineMark` series: recommended thick and solid, startNow thin, dashed and muted, both using `.interpolationMethod(.linear)`;
  - the start label at the leading edge and end labels as trailing annotations;
  - an x-axis with the times now, each switch and each run end, formatted in `timeZone`.
  
  `.accessibilityElement(children: .ignore)` with `.accessibilityLabel(verdict.accessibilitySummary)`.
- [ ] **Step 3: Add previews** for: a later start with a forecast, a later start without a forecast (Connect Solcast note), now-is-cheapest, and a 3-period tariff. Use fixture verdicts built with `SmartShiftPresentation.make`.
- [ ] **Step 4: Run** `./run-tests.sh`. Expected: `** TEST SUCCEEDED **` (this compiles the views and previews).
- [ ] **Step 5: Commit** `feat(ios): cost bars and energy weather chart`.

### Task 6: Wire the new card into LoadTimingView

**Files:**
- Modify: `PWUsage/Views/LoadTimingView.swift` (`body` job card path, `jobCard`, `forecastOverlay`, `observedPeriods`, picker, `init`)
- Modify: `PWUsage/Views/LoadTimingForecastPresentation.swift` (expose the existing one-line state notes for `ForecastAvailability.unusable`)
- Test: `PWUsageTests/LoadTimingViewTests.swift`

**Interfaces:**
- Consumes: `SmartShiftPresentation.make`, `SmartShiftCostBars`, `EnergyWeatherChart`, `LoadTimingForecastEstimator.evaluate(... projection:)`, `LoadProfileStore.selectedProfileID` / `selectProfile(id:)`.
- Produces: `static func forecastAvailability(state: SolarForecastEnhancementState, connection: SolarForecastConnectionState, cause: SolarForecastUnavailableCause?, reason: SolarForecastEnhancementUnavailableReason?) -> ForecastAvailability` on `LoadTimingForecastPresentation`. It reuses the existing note strings without `unavailableNotePrefix`.

- [ ] **Step 1: Write the failing tests** in `LoadTimingViewTests`:
  - `forecastAvailabilityMapsStates`: `.notConnected` gives `.none`; `.loadingWithBasic` gives `.loading`; `.awaitingArraySelection` gives `.unusable("Choose your solar arrays to add a forecast.")`; `.enhanced` gives `.ready`; a `.rateLimited` cause gives `.unusable` with Solcast's limit sentence.
  - `defaultJobIsLastViewed`: a store with `selectedProfileID == "dryer"` makes the view's initial Job "dryer" (expose the existing `initialExploredProfileID` resolution as `static func initialJobID(store:) -> String?`).
- [ ] **Step 2: Run** `./run-tests.sh LoadTimingViewTests`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The selected Job is `exploredProfileID ?? profileStore.selectedProfileID`, and the picker calls `profileStore.selectProfile(id:)`. Delete "Recommended Now", "Back to Recommended", `showsBackToSuggestion` and the fits-surplus copy.
  - Compute the result once per body pass, outside the `TimelineView`: `.forecast` when `coordinator.solarForecastState == .enhanced` with batch and context, otherwise `.flat(timeZone:)`. If the `.forecast` result is unavailable for any reason (for example its 30-minute balance age), evaluate `.flat` instead and pass `.unusable(<that reason's one-line note>)`. Pass the result to `SmartShiftPresentation.make`.
  - Render the verdict headline, `SmartShiftCostBars`, the why line, the legend and `EnergyWeatherChart`, then the note. `.connectSolcast` renders the sentence with a "Connect Solcast" button that sets `isSolarForecastSheetPresented = true`.
  - Then a "How this is worked out ›" row (Task 7) and the "Try another job ›" row.
  - Remove `observedPeriods` from the main screen; Task 7 shows it in details.
- [ ] **Step 4: Run** `./run-tests.sh`. Expected: `** TEST SUCCEEDED **`; delete tests for removed copy.
- [ ] **Step 5: Commit** `feat(ios): show the Smart Shift verdict, cost bars and energy weather`.

### Task 7: "How this is worked out" details sheet

**Files:**
- Create: `PWUsage/Views/SmartShiftDetailsView.swift`
- Modify: `PWUsage/Views/LoadTimingView.swift` (present the sheet)
- Modify: `PWUsage/Views/SmartShiftPresentation.swift` (`static func periodRows(timing: LoadTiming, currencyCode: String) -> [PeriodRow]`)
- Test: `PWUsageTests/SmartShiftPresentationTests.swift`

**Interfaces:**
- Produces: `struct PeriodRow: Equatable { let name: String; let buy: String; let sell: String; let balance: String }`, and `SmartShiftDetailsView(verdict: SmartShiftVerdict, comparison: LoadTimingForecastEstimator.Comparison?, rows: [PeriodRow], forecastFetchedAt: Date?, contextAsOf: Date?)`.

- [ ] **Step 1: Write the failing test** `periodRowsListEveryPricingPeriod`: three `pricingPeriods` give three rows in tariff order, with balances formatted like the lane start labels ("+18 kWh banked").
- [ ] **Step 2: Run** `./run-tests.sh SmartShiftPresentationTests`. Expected: FAIL.
- [ ] **Step 3: Implement** `periodRows`, plus a `List` sheet with these sections:
  - "Rate periods": the rows.
  - "This run": kWh drawn from each bank vs bought, from the comparison's lanes.
  - "Freshness": the solar forecast and household pattern freshness, reusing `DashboardPresentation.freshness`.
  - "Assumptions": `comparison.assumptions`.
- [ ] **Step 4: Run** `./run-tests.sh`. Expected: `** TEST SUCCEEDED **`.
- [ ] **Step 5: Commit** `feat(ios): Smart Shift details sheet with rate periods`.

### Task 8 (nice to have): Point out a better Job

**Files:**
- Modify: `PWUsage/Views/SmartShiftPresentation.swift` (`static func betterJobHint(selectedID: String, savingsByJob: [(LoadProfile, Double)], currencyCode: String) -> (id: String, text: String)?`)
- Modify: `PWUsage/Views/LoadTimingView.swift` (hint on the Try another job row; tapping switches Job)
- Test: `PWUsageTests/SmartShiftPresentationTests.swift`

- [ ] **Step 1: Write the failing test** `hintsOnlyWhenAnotherJobSavesMore`: selected saves 0.40 and "Wash the dishes" saves 2.10, which gives `"Wash the dishes: save about $2.10 by waiting"`. When the selected Job saves the most, it gives `nil`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Evaluate other Jobs in the same body pass, reusing the computed projection inputs. Skip the hint when there is no forecast-free or forecast result for them.
- [ ] **Step 4: Run** `./run-tests.sh`. Expected: `** TEST SUCCEEDED **`.
- [ ] **Step 5: Commit** `feat(ios): hint at a Job with a bigger saving`.

### Task 9: Verify on device

- [ ] **Step 1:** Run `./run-tests.sh`, then generate and open the project with `open PWUsage.xcodeproj` from the worktree path (give the user this command).
- [ ] **Step 2:** On device, with and without Solcast connected, confirm against the spec mockups:
  - the verdict, bars and % label;
  - the lanes start at now and the switch markers line up;
  - "Connect Solcast" opens settings;
  - the screen reopens on the last Job;
  - built-in names migrated;
  - VoiceOver reads the chart summary.
- [ ] **Step 3:** Report results; don't push until the user asks.
