# Smart Shift Glanceable Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Smart Shift card's text, cost bars and time-series charts with a split headline, choice tiles and one rate-period bar chart that responds to the selected tile, with badges and a tappable saving slot.

**Architecture:** All display decisions stay in `SmartShiftPresentation` and reach the views as plain values on `SmartShiftVerdict`, so they are unit tested. New fields are added beside the old ones (Tasks 1–3), a new chart and screen use them (Tasks 4–5), and the old fields, views and tests go last (Task 6), so every commit builds. No estimator, API or contract changes.

**Tech Stack:** Swift, SwiftUI, Swift Testing, `cmd/ios-app/run-tests.sh`, `cmd/ios-app/lint.sh`.

**Spec:** [`docs/superpowers/specs/2026-11-05-smart-shift-glanceable-design.md`](../specs/2026-11-05-smart-shift-glanceable-design.md). Read it and open its prototype first. The prototype's feel and order are the target.

## Global Constraints

- Work on a new branch from `origin/main`, `claude/smart-shift-glanceable`. Never commit to `main`. Leave the owner's uncommitted `AppIcon.icon/icon.json` change alone.
- Run all iOS commands from `cmd/ios-app`. Use `PWUSAGE_TEST_TIMEOUT_SECONDS=300 ./run-tests.sh --quick <filter>` while iterating.
- Every task: failing test first, `./lint.sh` clean, zero compiler warnings. `--strict` must report zero; no `swiftlint:disable`.
- File limit 400 lines (warn), type body 350, function body 50, line 120. Split rather than suppress.
- Exact copy: `Distance to net zero`, `kWh by <MMM d>`, `Least expensive`, `Most expensive`, `Save <amount>`, `Now`, `No cheaper time today`.
- Colors: `Color.emphasis` for the run and selection only. The check mark is green and the most-expensive mark is red. Owed and banked data colors stay as they are.
- Motion values: tile tap about 0.6 s, fast first; slot return 1.15 s, `.timingCurve(0.6, 0.02, 0.8, 0.25, duration: 1.15)`; slot minimum height 22 pt; slot tap target at least 44 pt.
- Bars come from `comparison.lanes`, which holds the periods either run touches plus the one in effect now. Don't add bars for other periods.

## Review Focus

1. A refresh changes or removes the selected choice while Now is selected, or during the slot's return: the screen lands on a valid choice with no stale badge, and the return can't leave the slot stuck. Test in Task 5 (`SmartShiftSelection`).
2. The recommended start arrives while the screen is open, so there's one tile: selection falls back to it and nothing dangles. Test in Task 5.
3. A very small job (0.1 kWh) or a run that rounds to zero: no `+0` label, a visible sliver for a non-zero run, and no false slot. Tests in Tasks 2, 3 and 4.
4. Totals that round to zero show `0`, on the owed side, with no `0 owed` or `-0`. Test in Task 2.
5. Three rate periods, with a middle-priced one holding the largest block: a middle bar gets no badge, and the bars fit at phone width. Tests in Tasks 3 and 4.

---

### Task 1: Headline, tiles and chart title

**Files:**
- Modify: `PWUsage/Views/LoadTiming/SmartShiftModels.swift`, `PWUsage/Views/LoadTiming/SmartShiftPresentation+Context.swift`
- Create: `PWUsage/Views/LoadTiming/SmartShiftPresentation+Choices.swift`
- Test: create `PWUsageTests/SmartShiftGlanceableTests.swift` as `extension SmartShiftPresentationTests`

**Interfaces — Produces:**

```swift
enum SmartShiftChoiceID: Equatable, Hashable { case recommended, now }

struct SmartShiftChoice: Equatable {
    let id: SmartShiftChoiceID
    let label: String     // "At 7:33 PM", "Tomorrow at 7:33 PM", "Now"
    let price: String
    let caption: String   // "All Off-peak", "Mostly On-peak", "On-peak and Off-peak"
}
```

New `SmartShiftVerdict` fields: `title: String`, `subtitle: String`, `choices: [SmartShiftChoice]` (recommended first; one when the recommended start is now), `chartTitle: String`, `chartSubtitle: String`. Add `Context.runKwh(_ lane: BalanceLane, for id: SmartShiftChoiceID) -> Double`, which is `max(projectedKwh - projectedAfter…, 0)`.

- [ ] **Step 1: Create the branch and commit the design**

```bash
git switch -c claude/smart-shift-glanceable origin/main
git add docs/superpowers/specs/2026-11-05-smart-shift-glanceable-design.md docs/superpowers/specs/assets/2026-11-05-smart-shift-glanceable-prototype.html docs/superpowers/plans/2026-11-06-smart-shift-glanceable.md
git commit -m "docs: design and plan for a glanceable Smart Shift screen"
```

- [ ] **Step 2: Write the failing tests**

Use `Self.make(profile: Self.pump, …)`; its 14 kWh over 5.9 h matches the fixture lanes.

```swift
@Test func savingStartSplitsTheHeadlineAndOffersTwoChoices() throws {
    let verdict = try Self.verdict(Self.make(profile: Self.pump))
    #expect(Self.normalized(verdict.title) == "Pool pump at 4:30 PM")
    #expect(verdict.subtitle == "About \(Self.money(1.89)) cheaper than now")
    #expect(verdict.choices.map(\.id) == [.recommended, .now])
    #expect(Self.normalized(verdict.choices[0].label) == "At 4:30 PM")
    #expect(verdict.choices[0].price == Self.money(3.38))
    #expect(verdict.choices[0].caption == "All Off-Peak")
    #expect(verdict.choices[1].label == "Now")
    #expect(verdict.choices[1].price == Self.money(5.27))
    #expect(verdict.choices[1].caption == "All Peak")
    #expect(verdict.chartTitle == "Distance to net zero")
    #expect(verdict.chartSubtitle.hasPrefix("kWh by "))
}
@Test func tomorrowStartSaysSoOnItsTile()              // label "Tomorrow at 4:30 PM", from recommendedStart at(40.5)
@Test func nowBestIsOneChoice()                        // title "Pool pump now", subtitle "No cheaper time today", one .now choice
@Test func unsafeNowKeepsTheWarningInTheSubtitle()     // .nowUnsafe: "About $X more than now, but it won't leave Peak short"
@Test func noSafeStartKeepsTheWarningInTheSubtitle()   // .noSafeStart: "The least risky time, but a cloudy week could still leave Peak short"
@Test func captionNamesTheLargestShare()               // 60/40 → "Mostly A"; 50/30/20 → "A and B"; ≥95% → "All A"
```

Copy the safety fixtures from `SmartShiftPresentationTests+Safety.swift`.

- [ ] **Step 2b: Run them**

Run: `PWUSAGE_TEST_TIMEOUT_SECONDS=300 ./run-tests.sh --quick SmartShiftPresentationTests`
Expected: FAIL, because the new fields don't exist.

- [ ] **Step 3: Implement** the types and fields, and in the new file an `extension SmartShiftPresentation.Context` with `title`, `subtitle`, `choices`. Move `headline`'s branch logic so `subtitle` reuses the words and `claimsSaving`. Tile labels are `capitalized(when(comparison.recommendedStart))`. Keep the old `headline` until Task 6.

- [ ] **Step 4: Run them.** Expected: PASS.

- [ ] **Step 5: Lint and commit.** `./lint.sh`, then commit `feat(ios): add Smart Shift headline and choice values`.

---

### Task 2: Bars and totals

**Files:**
- Modify: `SmartShiftModels.swift`, `SmartShiftPresentation+Choices.swift`
- Create: `PWUsage/Views/LoadTiming/SmartShiftPresentation+Bars.swift`
- Test: `PWUsageTests/SmartShiftGlanceableTests.swift`, `PWUsageTests/SmartShiftPropertyTests.swift`

**Interfaces — Produces:**

```swift
enum SmartShiftBadge: Equatable { case cheapest, priciest }

struct SmartShiftBarState: Equatable {
    let runKwh: Double
    /// Where the bar ends, on the bill-style axis: owed is positive.
    let totalPosition: Double
    let runLabel: String?   // "+24", nil when it rounds to zero
    let total: String       // "86 owed", "12 banked", "0"
    var badge: SmartShiftBadge?
    var badgeLabel: String?
}

struct SmartShiftBar: Equatable {
    let periodKey: String
    let name: String
    let rate: String
    let buyRate: Double
    let baselinePosition: Double   // EnergyBalanceAxis.position(forBank: projectedKwh)
    let recommended: SmartShiftBarState
    let now: SmartShiftBarState
    func state(for id: SmartShiftChoiceID) -> SmartShiftBarState
}
```

New verdict field: `rateBars: [SmartShiftBar]`, highest buy rate first, ties keeping lane order. Consumes `Context.runKwh` from Task 1.

- [ ] **Step 1: Write the failing tests**

```swift
@Test func barsReadHighestRateFirstFromTheProjectionEnd() throws {
    let lanes = [Self.lane("Off-Peak", start: 18, later: 4, startNow: 18),
                 Self.lane("Peak", start: -6, later: -6, startNow: -20)]
    let verdict = try Self.verdict(Self.make(profile: Self.pump, result:
        .init(comparison: Self.comparison(lanes: lanes), unavailableReason: nil)))
    #expect(verdict.rateBars.map(\.name) == ["Peak", "Off-Peak"])
    let peak = verdict.rateBars[0]
    #expect(peak.baselinePosition == 6)
    #expect(peak.now.runKwh == 14 && peak.now.runLabel == "+14" && peak.now.total == "20 owed")
    #expect(peak.recommended.runKwh == 0 && peak.recommended.runLabel == nil && peak.recommended.total == "6 owed")
    #expect(verdict.rateBars[1].baselinePosition == -18 && verdict.rateBars[1].recommended.total == "4 banked")
}
@Test func barsUseProjectionEndValuesNotTheChartEdge()  // lane with explicit projectedKwh / projectedAfter… differing from .last
@Test func aRunThatRoundsToZeroHasNoLabel()             // 0.1 kWh run: runLabel nil, runKwh 0.1
@Test func aTotalThatRoundsToZeroReadsZero()            // total 0.2 → "0", never "0 owed" or "-0"
```

In `SmartShiftPropertyTests`, add the spec's check against the real estimator, with the flat projection and generated banks:

```swift
@Test func runsAgreeOnTheBaselineAndMoveTheSameEnergy()
// For every lane: projectedKwh − after ≥ −0.001 for both runs, and the two runs' total
// energy across lanes matches the job's energy within 0.05 kWh.
```

If this property fails on real data, stop and report it to the owner rather than loosening it, because the bars would misstate the run.

- [ ] **Step 1b: Run them.** Expected: FAIL, because `rateBars` doesn't exist.

- [ ] **Step 2: Implement** `Context.rateBars` in the new file. Totals use `endLabel`, and rates use `rate(key, sell: false)`. Positions go through `EnergyBalanceAxis.position(forBank:)`. Leave `badge` and `badgeLabel` nil.

- [ ] **Step 3: Run them.** Expected: PASS.

- [ ] **Step 4: Lint and commit** `feat(ios): add Smart Shift rate-period bars`.

---

### Task 3: Badges, labels and the slot

**Files:**
- Modify: `SmartShiftPresentation+Bars.swift` (or split to `+Guidance.swift` if over budget), `SmartShiftModels.swift`
- Test: `PWUsageTests/SmartShiftGlanceableTests.swift`

**Interfaces — Consumes:** `SmartShiftBar`, `SmartShiftBadge`. **Produces:**

```swift
struct SmartShiftSlot: Equatable {
    let periodKey: String
    let extraKwh: Double
    let label: String               // "Save $5.04"
    let accessibilityLabel: String  // "Save about $5.04 by starting at 7:33 PM"
}
```

New verdict field: `slot: SmartShiftSlot?`. Add `Context.costPerKwh(_ draw: Draw) -> Double`, blended as `(fromBank × sell + (kwh − fromBank) × buy) / kwh`, using `nowDraws` and `laterDraws`.

Rules (spec, "Where badges go" and "The slot"):
- Guidance shows only when `claimsSaving || (isNow && safety == .nowSafe)`. Otherwise no badge, label or slot.
- **Check:** on the shown best choice (recommended, or Now when `isNow`), on its largest block, when that block's cost per kWh is the lowest of the run's blocks and at least one other `timing.pricingPeriods` buy rate is strictly higher. Its label is `Least expensive` only if the bar's buy rate is the lowest of `pricingPeriods`; otherwise the check shows alone.
- **Red mark:** Now choice only, when not `isNow`: the block with the highest cost per kWh, when that exceeds the recommended run's average. Label `Most expensive` only if the bar's buy rate is the highest of `pricingPeriods`.
- **No clear winner** (tied cost per kWh for the top or bottom block): no badge.
- **Slot:** only when `claimsSaving` and not `isNow`, independent of the red mark. On the bar with the largest `recommended.runKwh − now.runKwh`; ties go to the lower recommended cost per kWh; no slot unless that gain exceeds 0.05 kWh.

- [ ] **Step 1: Write the failing tests**

```swift
@Test func savingCaseBadgesAndLabelsBothChoices() throws {
    let verdict = try Self.verdict(Self.make(profile: Self.pump))
    let peak = try #require(verdict.rateBars.first { $0.name == "Peak" })
    let offPeak = try #require(verdict.rateBars.first { $0.name == "Off-Peak" })
    #expect(offPeak.recommended.badge == .cheapest && offPeak.recommended.badgeLabel == "Least expensive")
    #expect(peak.now.badge == .priciest && peak.now.badgeLabel == "Most expensive")
    #expect(peak.recommended.badge == nil && offPeak.now.badge == nil)
    let slot = try #require(verdict.slot)
    #expect(slot.periodKey == "Off-Peak" && slot.extraKwh == 14 && slot.label == "Save \(Self.money(1.89))")
    #expect(Self.normalized(slot.accessibilityLabel) == "Save about \(Self.money(1.89)) by starting at 4:30 PM")
}
@Test func unsafeStatesShowNoGuidance()                  // .nowUnsafe and .noSafeStart: every badge, label and slot nil
@Test func nowBestGetsACheckWithoutARedMarkOrSlot()      // isNow: .cheapest on the run's block; no .priciest; slot nil
@Test func aSinglePricePlanGetsNoCheck()                 // one period, or equal buy rates: no badge
@Test func aBankCheaperThanTheLowestRateChecksWithoutALabel() // check on a higher-buy-rate bar: badgeLabel nil
@Test func aMixedBlockUsesItsBlendedCost()               // 5 kWh bank at 0.04 + 3 kWh bought at 0.10 ≈ 0.0625
@Test func aMiddlePricedLargestBlockGetsNoBadge()        // three periods
@Test func aSavingWithNoRedMarkStillHasASlot()
@Test func noBarGainingEnergyMeansNoSlot()               // gain ≤ 0.05 kWh
@Test func slotTiesGoToTheCheaperBar()
```

- [ ] **Step 1b: Run them.** Expected: FAIL.

- [ ] **Step 2: Implement** the rules on `Context`, filling in `badge`, `badgeLabel` and `slot`.

- [ ] **Step 3: Run them.** Expected: PASS.

- [ ] **Step 4: Lint and commit** `feat(ios): add Smart Shift badges and saving slot`.

---

### Task 4: Chart geometry and view

**Files:**
- Create: `PWUsage/Views/LoadTiming/SmartShiftBarGeometry.swift`, `PWUsage/Views/LoadTiming/SmartShiftBankChart.swift`
- Test: create `PWUsageTests/SmartShiftBarGeometryTests.swift`

**Interfaces — Consumes:** `SmartShiftBar`, `SmartShiftSlot`, `SmartShiftChoiceID`. **Produces:**

```swift
struct SmartShiftBarGeometry {
    static let minimumSlotHeight: CGFloat = 22
    static let minimumBlockHeight: CGFloat = 3
    static let minimumLabelledBlockHeight: CGFloat = 12
    init(bars: [SmartShiftBar], slot: SmartShiftSlot?, plotHeight: CGFloat)
    func y(_ position: Double) -> CGFloat
    func base(of bar: SmartShiftBar) -> ClosedRange<CGFloat>           // zero line ↔ baseline
    func block(of bar: SmartShiftBar, for id: SmartShiftChoiceID) -> ClosedRange<CGFloat>
    func labelFitsInside(_ bar: SmartShiftBar, for id: SmartShiftChoiceID) -> Bool
    func slot(on bar: SmartShiftBar) -> ClosedRange<CGFloat>?          // directly above the Now total
}

struct SmartShiftBankChart: View {
    let bars: [SmartShiftBar]
    let slot: SmartShiftSlot?
    let selection: SmartShiftChoiceID
    /// The choice whose badges and labels show; lags `selection` during the slot's return.
    let marks: SmartShiftChoiceID
    let isSlotHeld: Bool      // keeps the slot at its Now position during the return
    let onTapSlot: () -> Void
}
```

Geometry: the domain covers zero, every baseline, every total under both choices and the slot's top, so the scale is fixed across selections. The block spans baseline to total, drawn over the gray; a run that isn't zero gets `minimumBlockHeight`, growing up from the baseline.

- [ ] **Step 1: Write the failing tests** with the demo numbers: On-peak baseline 62, runs 0 and 24; Off-peak baseline 198, runs 40 and 16; `plotHeight: 200`.

```swift
@Test func theScaleDoesNotChangeBetweenChoices()    // y(238) and y(0) same regardless of selection; 238 above 86 above 0
@Test func aBlockSpansBaselineToTotal()             // On-peak Now: y(86)...y(62)
@Test func aRunThroughZeroCrossesTheZeroLine()      // baseline −10, run 24: block contains y(0), from y(14) to y(−10)
@Test func aRunInsideABankStaysInsideTheGray()      // baseline −10, run 6: block from y(−4) to y(−10)
@Test func aTinyRunKeepsASliverAndLosesItsInsideLabel() // 0.1 kWh: height ≥ 3, labelFitsInside false
@Test func aSmallSlotKeepsItsMinimumHeight()        // 3 kWh gain: height ≥ 22, sits directly above the Now total
@Test func aSlotFitsWithinTheDomain()               // slot's top ≥ 0 at the tallest bar
@Test func threeBarsStayWithinPhoneWidth()          // bar width > 0 and no overlap for 3 bars at 280 pt
```

If the last test needs it, add `static func barWidth(count: Int, in width: CGFloat) -> CGFloat`.

- [ ] **Step 1b: Run them.** `PWUSAGE_TEST_TIMEOUT_SECONDS=300 ./run-tests.sh --quick SmartShiftBarGeometryTests`. Expected: FAIL.

- [ ] **Step 2: Implement the geometry.** Run the tests. Expected: PASS.

- [ ] **Step 3: Implement `SmartShiftBankChart`** per the spec's chart and badge sections and the prototype.
  - Draw with shapes rather than Swift Charts, so block and slot positions animate.
  - Totals go above an owed bar and below a banked one. `runLabel` goes inside the block when it fits, otherwise beside the bar.
  - The check is `checkmark.circle.fill` in green and the mark is `exclamationmark.circle.fill` in red, both with accessibility text.
  - The slot is a `Button`, with a 44 pt minimum hit target via `contentShape`, and `slot.accessibilityLabel`.
  - The chart is one accessibility element summarised for `marks`, highest rate first, plus the slot button.
  - Add `#Preview`s for saving, small job, banked crossing and three periods.

- [ ] **Step 4: Lint and commit** `feat(ios): add the Smart Shift bank chart`.

---

### Task 5: Screen, selection and motion

**Files:**
- Create: `PWUsage/Views/LoadTiming/SmartShiftChoiceTiles.swift`, `PWUsage/Views/LoadTiming/SmartShiftSelection.swift`
- Modify: `SmartShiftVerdictView.swift`, `LoadTimingView.swift`, `SmartShiftDetailsView.swift`
- Test: `PWUsageTests/SmartShiftGlanceableTests.swift`

**Interfaces — Consumes:** Tasks 1–4. **Produces:**

```swift
struct SmartShiftSelection: Equatable {
    private(set) var selected: SmartShiftChoiceID
    /// What the badges and labels show. It lags `selected` until the return lands.
    private(set) var marks: SmartShiftChoiceID
    private(set) var isReturning = false
    init(choices: [SmartShiftChoice])                  // starts on the first choice
    mutating func select(_ id: SmartShiftChoiceID)     // ignored while returning
    mutating func beginReturn()                        // now → recommended; marks stay until landed
    mutating func landReturn()
    mutating func reconcile(with choices: [SmartShiftChoice]) // falls back, and ends any return, if selected is gone
}
```

- [ ] **Step 1: Write the failing tests**

```swift
@Test func selectionOpensOnTheRecommendedChoice()
@Test func tappingATileMovesSelectionAndMarksTogether()
@Test func aReturnMovesTheSelectionNowAndTheMarksOnLanding() throws {
    var selection = SmartShiftSelection(choices: Self.twoChoices)
    selection.select(.now)
    selection.beginReturn()
    #expect(selection.selected == .recommended && selection.marks == .now && selection.isReturning)
    selection.select(.now)
    #expect(selection.selected == .recommended)   // ignored while returning
    selection.landReturn()
    #expect(selection.marks == .recommended && !selection.isReturning)
}
@Test func aRefreshThatRemovesTheSelectedChoiceFallsBack()   // Review Focus 2: one .now-only choice
@Test func aRefreshDuringAReturnEndsItCleanly()              // Review Focus 1
```

- [ ] **Step 1b: Run them.** Expected: FAIL.

- [ ] **Step 2: Implement `SmartShiftSelection`.** Run the tests. Expected: PASS.

- [ ] **Step 3: Implement `SmartShiftChoiceTiles`.** Buttons with the `.isSelected` trait; one sliding selection shape via `matchedGeometryEffect`. They stack at accessibility text sizes. A single choice is not a button.

- [ ] **Step 4: Rebuild `SmartShiftVerdictView`** in reading order: split headline, tiles, chart title and subtitle, chart, notes. Keep the notes as they are.
  - Add `.id` or `.onChange` so selection resets when the job changes and when `LoadTimingView.isSelected` becomes true, and calls `reconcile` when `verdict` changes.
  - **Tile tap:** `withAnimation(.smooth(duration: 0.6))`, with numbers via `.contentTransition(.numericText())`.
  - **Slot tap:** `withAnimation(.timingCurve(0.6, 0.02, 0.8, 0.25, duration: 1.15)) { beginReturn() } completion: { landReturn(); pop }`. The red mark fades when the return begins. At the end, `Most expensive` changes to `Least expensive`. The tile and check pop with a `.spring`, and a light `.sensoryFeedback(.impact(weight: .light), trigger:)` fires on landing.
  - **Reduce Motion:** no slide, growth or pop. Wrap the chart and tiles in `.id(selected)` with `.transition(.opacity)` and a 0.25 s ease, follow `DashboardView+Live.swift` for the environment value, and land at once.
  - **VoiceOver:** after the return lands, post `AccessibilityNotification.Announcement` naming the time and the new totals.

- [ ] **Step 5: Move the why text.** In `SmartShiftDetailsView`, add a first section showing `snapshot.verdict.why`. Remove `why` from the card. In `LoadTimingView.jobCard`, keep `How this is worked out`, `Try another job` and the hint unchanged.

- [ ] **Step 6: Verify in the simulator, in demo mode**, as an iPhone and at the largest accessibility text size:
  - Saving, tile taps, slot tap.
  - Light and dark mode.
  - Reduce Motion.
  - Switching job, including a small custom job.
  - Pull-to-refresh with Now selected.

Screenshot each state. Check that the return reads as slow then fast and that labels never overlap.

- [ ] **Step 7: Lint and commit** `feat(ios): make the Smart Shift screen glanceable`.

---

### Task 6: Remove the old screen and finish

**Files:**
- Delete: `PWUsage/Views/LoadTiming/SmartShiftCostBars.swift`, `PWUsage/Views/Home/EnergyWeatherChart.swift`, `PWUsageTests/EnergyWeatherChartLayoutTests.swift`
- Modify: `SmartShiftModels.swift`, `SmartShiftPresentation+Context.swift`, `SmartShiftPresentation+Messages.swift`, `Home/BillOutlookChart.swift`, `Bill/BillEstimateDetails.swift`, `Bill/BillSavingsViews.swift`, `Solar/SolarForecastPreviews.swift`, `SmartShiftPresentationTests+Verdict.swift`, `+Safety.swift`, `+WorkedOut.swift`, `PreviewFixtureTests.swift`, `docs/voice-and-terms.md`, `cmd/ios-app/AGENTS.md`

**Interfaces — Produces:** `enum EnergyBalanceColors { static let owed: Color; static let banked: Color; static let rule: Color }`, placed beside `EnergyBalanceAxis` in `BillOutlookChart.swift`, with the same values as `EnergyWeatherChart.owedColor`, `bankedColor` and `ruleColor`.

- [ ] **Step 1: Migrate the tests first.**
  - `headline` assertions become `title` and `subtitle`.
  - `bars` and `barsCaption` become `choices`.
  - `lanes` assertions become `rateBars`.
  - `PreviewFixtureTests`: `.bars.count == 2` → `.choices.count == 2`; `.nowIsCheapest` → `.choices.count == 1`; `.threePeriods.lanes.count >= 2` → `.rateBars.count >= 2`.
  - Delete tests that only pin removed fields: `barsCaption`, `percentLess`, `axisDates`, `startLabel`, `endLabels`, switch markers.
  - Keep every test of `why`, notes, breakdowns and safety wording.

- [ ] **Step 2: Remove** `headline`, `barsCaption`, the `bars: [CostBar]` field, `percentLess`, `laterLabel`, `nowLabel` (keep the private verb helpers `costBreakdowns` needs), `lanes`, `axisDates`, `accessibilitySummary`, `CostBar`, `SwitchMarker`, `LaneDisplay`, `SwitchLabelLayout`, `Context.switchMarkers`, `Context.lane(_:)`, `startLabel`. Delete the two views and the layout tests. Move the three colors to `EnergyBalanceColors` and update every use.

- [ ] **Step 3: Docs.**
  - `docs/voice-and-terms.md`: add **net zero** under Smart Shift's "bank" rule, as the bank's goal. Add a note that `Save <amount>` in the slot omits "about" because the headline and VoiceOver carry it.
  - `cmd/ios-app/AGENTS.md`, Color section: add that red is a status color for Smart Shift's most-expensive mark only.

- [ ] **Step 4: Verify everything.**
  - `./lint.sh`: zero violations.
  - `PWUSAGE_TEST_TIMEOUT_SECONDS=1200 ./run-tests.sh`: all pass, zero compiler warnings.
  - `grep -rn "EnergyWeather\|SmartShiftCostBars\|barsCaption" PWUsage PWUsageTests`: no results.

- [ ] **Step 5: Commit** `refactor(ios): remove the old Smart Shift charts`.

- [ ] **Step 6: Push and open a draft PR** with screenshots of each state. Give the owner the worktree path and `open …/PWUsage.xcodeproj` for on-device checks: how the return feels, the haptic, and a re-test with the non-technical tester.
