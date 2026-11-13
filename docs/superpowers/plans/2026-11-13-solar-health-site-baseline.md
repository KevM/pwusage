# Solar Health Site Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score entered-panel sites against their own first year ("% of new") instead of nameplate × 85%, show rated efficiency when new against a healthy range, and carry the same baseline into the trend chart and house view.

**Architecture:** A new pure value type, `SolarHealthBaseline`, is derived from `SolarHealthResult.years` (monthly factors that already exist, no cache or pass change) plus the manual layout and `now`. A score extension compares each calendar month's latest factor with its baseline. `SolarHealthClassifier` builds both, reshapes `SolarHealthReport.HealthScore` around them, and moves the low-output rule to rated efficiency. Views read the baseline from the report through a small tested presentation type. Detected-only references never build a baseline and keep today's behaviour.

**Tech Stack:** Swift 6, SwiftUI, Swift Charts, Swift Testing.

**Spec:** `docs/superpowers/specs/2026-11-13-solar-health-site-baseline-design.md`

## Global Constraints

- All paths below are relative to `cmd/ios-app/` unless they start with `docs/` or `./cmd/`.
- Swift Testing only (`import Testing`, `@Suite`/`@Test`/`#expect`/`#require`); no XCTest.
- TDD: write the failing test first, run it and see it fail, implement, run it and see it pass, commit.
- Each task ends lint-clean: `./cmd/ios-app/lint.sh` from the repo root reports zero SwiftLint `--strict` violations and a clean SwiftFormat check. No `swiftlint:disable`, no baseline. Zero compiler warnings (fix any you see, even pre-existing ones).
- Lint budgets (`cmd/ios-app/AGENTS.md`): line 120, file 400 warn, type body 350, function body 50, cyclomatic complexity 10, nesting 1 type / 2 function, ≤ 5 parameters. No trailing commas in multiline literals.
- Iterate with `cd cmd/ios-app && ./run-tests.sh --quick <SuiteName>`. `SolarHealthPassTests`, `SolarHealthPassCacheTests` and `SolarHealthClassifierPassTests` are in `quick-test-skips.txt`: run them by name without `--quick` (`./run-tests.sh SolarHealthClassifierPassTests`). The final task runs plain `./run-tests.sh` (prefix `PWUSAGE_TEST_TIMEOUT_SECONDS=1500` if the machine is busy).
- Detected-only references (no manual layout) keep today's behaviour: no baseline, "best year = 100%" scaling, current trend and house inputs.
- The aging estimator (`SolarHealthClassifier+Aging.swift`) and its matched-pair confidence rule do not change.
- `SolarHealthPass.version` does not change: cached years already hold the monthly factors this uses.
- Commit messages: conventional commits, ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- User-facing copy follows `docs/voice-and-terms.md` (plain, calm, middle dot `·` for compact metadata, title case for buttons, sentence case for body). User-facing numbers use `FormatStyle`.
- Named constants, exact values from the spec:
  - `SolarHealthBaseline.windowMonths = 12`
  - `SolarHealthBaseline.minFrozenSeasons = 3`
  - `SolarHealthBaseline.olderSystemGapMonths = 13`
  - `SolarHealthClassifier.healthyEfficiencyRange = 0.82 ... 0.98`
  - `SolarHealthClassifier.provisionalLowEfficiency = 0.75`
  - `SolarHealthClassifier.provisionalLowMinClearDays = 10`
  - `SolarHealthClassifier.healthyScoreBandPercent = 8.0` (exists; emphasis below `1 − 8/100 = 0.92`)
  - Rated efficiency = baseline factor × `SolarLayoutDetector.derate` (0.85).
  - `SolarHealthClassifier.lowOutputThreshold` is removed.

## Review Focus

1. A just-entered new system with no monthly factor yet (fewer than 4 clear days in every month): there is no baseline, so `healthScore` is nil, but the Panel Health card must say it is learning, not ask the owner to enter panels they already entered. Test owned by Task 3 (`healthScore == nil`, no low-output finding) and Task 4 (`SolarHealthScorePresentation.waitingForClearDays` copy).
2. The latest install date is after every month with a factor (system entered ahead of its data): no baseline, no score, no findings from it, no crash. Test owned by Task 1.
3. A month whose baseline or current factor is zero or negative (a fit on a nearly dead month): it is skipped, never divides by zero or yields NaN/∞ in the score, trend or house. Test owned by Task 2.
4. A detected-only site (no entered panels) after this change: `healthScore` and `baseline` stay nil, trend rows and house opacity are exactly as today. Test owned by Task 3 and Task 6.
5. A calendar month whose only observations are before the window start (history before the newest system): it does not become that month's baseline; potential-vs-actual for that month falls back to the site-wide baseline. Test owned by Task 1 and Task 3.

---

### Task 1: Site baseline (window, per-month, site-wide, provisional, labels)

**Files:**
- Create: `PWUsage/Models/Solar/Health/SolarHealthBaseline.swift`
- Test: `PWUsageTests/SolarHealthBaselineTests.swift`

**Interfaces:**
- Consumes: `SolarHealthYear` (`year`, `months: [SolarHealthMonth]`), `SolarHealthCapacity`, `SolarHealthReference.directions`, `ManualSolarLayout.systems[].installDate`, `SolarSeason.of(month:latitude:)`.
- Produces:

```swift
struct SolarHealthMonthStamp: Comparable, Hashable, Sendable {
    let year: Int
    let month: Int            // 1...12
    init(year: Int, month: Int)
    init(_ date: Date, calendar: Calendar)
    var index: Int { get }    // year * 12 + month - 1, for ordering and arithmetic
    func adding(months: Int) -> SolarHealthMonthStamp
}

struct SolarHealthBaseline: Equatable, Sendable {
    enum Label: Equatable, Sendable { case asNew, firstYear(Int) }
    struct Month: Equatable, Sendable {
        let stamp: SolarHealthMonthStamp
        let capacity: SolarHealthCapacity
    }
    static let windowMonths = 12
    static let minFrozenSeasons = 3
    static let olderSystemGapMonths = 13

    let windowStart: SolarHealthMonthStamp
    /// Calendar month (1...12) → its first monthly capacity on or after `windowStart`, even after the window.
    let months: [Int: Month]
    /// Mean of the window months' site factors: clear-day weighted when frozen, equal weights while provisional.
    let siteFactor: Double
    /// Site-wide baseline per face, same weighting, over window months where the fit separated the faces.
    let directionFactors: [SolarHealthCapacity.Direction]
    /// Distinct seasons among all calendar-month baselines.
    let seasonsCovered: Int
    /// Clear days behind the window months.
    let clearDays: Int
    let isProvisional: Bool
    let label: Label
    /// Year of the newest system when history before it exists and there is more than one system.
    let restartYear: Int?
    /// `reference.directions.count`: a month separated the faces when its directions count matches.
    let faceCount: Int

    init?(years: [SolarHealthYear], reference: SolarHealthReference, manual: ManualSolarLayout,
          now: Date, calendar: Calendar = .current)
    func monthFactor(_ month: Int) -> Double              // months[month]?.capacity.site ?? siteFactor
    func directionFactor(azimuth: Double) -> Double       // matching directionFactors entry ?? siteFactor
    func isBeforeWindow(_ stamp: SolarHealthMonthStamp) -> Bool
    func isBeforeWindow(year: Int) -> Bool                 // year < windowStart.year
    /// "of new" or "of 2022", for "98% of new".
    var relativeUnit: String { get }
}
```

- [ ] **Step 1: Write the failing tests** in `SolarHealthBaselineTests.swift` (`@Suite("Solar health baseline")`). Add a private helper `years(_ entries: [(year: Int, month: Int, factor: Double, clearDays: Int)]) -> [SolarHealthYear]` grouping entries into `SolarHealthYear`s with `directions: []`, and use `manualLayout(for: [.face(180, kw: 5)], installDates:)` from `Fixtures/SyntheticSolarSite.swift`. Dates are built with `Calendar.current` (the baseline's default), months as the 1st at noon.

```swift
@Test("Window starts at the first month with a factor and freezes after 12 months over 4 seasons")
// entries: 2024-04 (1.00, 20), 2024-07 (1.20, 4), 2024-10 (1.00, 20), 2025-01 (1.00, 4); now 2025-06-15
#expect(baseline.windowStart == SolarHealthMonthStamp(year: 2024, month: 4))
#expect(!baseline.isProvisional)
#expect(baseline.seasonsCovered == 4)
#expect(abs(baseline.siteFactor - 48.8 / 48) < 1e-9)     // clear-day weighted
#expect(baseline.clearDays == 48)
#expect(baseline.label == .asNew)
#expect(baseline.relativeUnit == "of new")

@Test("Provisional while the window is open, with months weighted equally")
// entries: 2026-05 (1.00, 20), 2026-06 (1.20, 4); now 2026-07-10
#expect(baseline.isProvisional)
#expect(abs(baseline.siteFactor - 1.10) < 1e-9)
#expect(baseline.seasonsCovered == 2)                   // spring, summer
#expect(baseline.clearDays == 24)

@Test("A closed window with fewer than three seasons stays provisional until later years fill them")
// entries: 2024-06, 2024-07, 2024-08 (1.0, 10 each); now 2025-09-01 → provisional, seasonsCovered 1
// add 2024-12 → still 2 seasons → provisional; add 2025-03 too → seasonsCovered 3 → !isProvisional
//   (2025-03 lies after the window but is March's first factor, so it counts as March's baseline)

@Test("A calendar month's baseline is its first factor on or after the window start")
// entries: 2024-04 … 2024-11 at 1.10 (10 each), 2025-12 at 0.98 (6); now 2026-01-15
#expect(baseline.months[12]?.stamp == SolarHealthMonthStamp(year: 2025, month: 12))
#expect(baseline.months[12]?.capacity.site == 0.98)
#expect(baseline.monthFactor(1) == baseline.siteFactor) // no January anywhere
#expect(abs(baseline.siteFactor - 1.10) < 1e-9)         // 2025-12 is outside the window

@Test("The newest install date restarts the window and earlier months are not baselines")
// manual: two systems, installDates [nil, 2024-03-01]; entries 2022-01 … 2025-02 at 1.0 (10 each),
//   except 2022-05 and 2023-05 at 0.90 and no 2024-05 or 2025-05; now 2025-06-15
#expect(baseline.windowStart == SolarHealthMonthStamp(year: 2024, month: 3))
#expect(baseline.months[5] == nil)                      // May only observed before the window
#expect(baseline.restartYear == 2024)
#expect(baseline.isBeforeWindow(SolarHealthMonthStamp(year: 2024, month: 2)))
#expect(!baseline.isBeforeWindow(SolarHealthMonthStamp(year: 2024, month: 3)))
#expect(baseline.isBeforeWindow(year: 2023))

@Test("History starting more than 13 months after install is labelled by its first year")
// installDates [2019-06-01]; entries 2022-01 … 2022-12 at 1.0; now 2023-03-01
#expect(baseline.label == .firstYear(2022))
#expect(baseline.relativeUnit == "of 2022")
#expect(baseline.restartYear == nil)                    // one system
// installDates [2024-03-01]; entries from 2024-04 → label == .asNew (gap 1 month)

@Test("No baseline when every factor predates the newest install")   // Review Focus 2
// installDates [2026-01-01]; entries 2024-04 … 2025-11; now 2026-02-01
#expect(SolarHealthBaseline(years: …, reference: …, manual: …, now: now) == nil)

@Test("Faces get a site-wide baseline only from months where the fit separated them")
// reference from two faces (90° and 270°, 3 kW each). Window months 2024-04 … 2025-03, 10 clear days:
//   2024-04 has directions [90: 1.10, 270: 1.00]; 2024-05 has one shared entry [90: 1.05]; others none.
#expect(baseline.directionFactors == [.init(azimuth: 90, factor: 1.10), .init(azimuth: 270, factor: 1.00)])
#expect(baseline.directionFactor(azimuth: 270) == 1.00)
#expect(baseline.directionFactor(azimuth: 180) == baseline.siteFactor)  // no such face
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cmd/ios-app && ./run-tests.sh --quick SolarHealthBaselineTests`
Expected: build failure, `cannot find 'SolarHealthBaseline' in scope`.

- [ ] **Step 3: Implement `SolarHealthBaseline.swift`**

Algorithm (the parts the tests do not pin):

```text
factorMonths  = every (stamp, capacity) from years[].months with capacity.site > 0, sorted by stamp
latestInstall = max(manual.systems.compactMap(\.installDate)) as a month stamp, or nil
firstFactor   = first factorMonths stamp >= (latestInstall ?? .min); nil → return nil
windowStart   = max(latestInstall ?? firstFactor, firstFactor)        // "later of"
windowEnd     = windowStart.adding(months: windowMonths)               // exclusive
months[m]     = first factorMonths entry with stamp >= windowStart and stamp.month == m
windowMonths  = months.values where stamp < windowEnd; empty → return nil
seasonsCovered= Set(months.keys.map { SolarSeason.of(month: $0, latitude: 0) }).count
                // the count is the same in either hemisphere, so no latitude is needed
isProvisional = SolarHealthMonthStamp(now) < windowEnd || seasonsCovered < minFrozenSeasons
weight(month) = isProvisional ? 1 : Double(month.capacity.clearDays)
siteFactor    = Σ weight·site / Σ weight over windowMonths with site > 0
separated     = month.capacity.directions.count == faceCount
directionFactors: for each reference direction, same weighted mean of the matching
                (azimuth within 0.5°) factor over separated windowMonths; omit faces with none
label         = latestInstall != nil && firstFactor.index - latestInstall.index > olderSystemGapMonths
                ? .firstYear(windowStart.year) : .asNew
restartYear   = manual.systems.count > 1 && latestInstall != nil && factorMonths.first.stamp < latestInstall
                ? latestInstall.year : nil
```

`relativeUnit` returns `"of new"` for `.asNew` and `"of \(year)"` for `.firstYear` (year without grouping: `String(year)`).

- [ ] **Step 4: Run to verify they pass**

Run: `cd cmd/ios-app && ./run-tests.sh --quick SolarHealthBaselineTests`
Expected: all 8 tests pass. Then `./cmd/ios-app/lint.sh` from the repo root: zero violations.

- [ ] **Step 5: Commit**

```bash
git add cmd/ios-app/PWUsage/Models/Solar/Health/SolarHealthBaseline.swift cmd/ios-app/PWUsageTests/SolarHealthBaselineTests.swift
git commit -m "feat(ios): learn each entered-panel site's clear-day baseline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Score vs new

**Files:**
- Create: `PWUsage/Models/Solar/Health/SolarHealthBaseline+Score.swift`
- Test: `PWUsageTests/SolarHealthBaselineTests+Score.swift`

**Interfaces:**
- Consumes: Task 1's `SolarHealthBaseline`, `SolarHealthMonthStamp`.
- Produces:

```swift
struct SolarHealthBaselineScore: Equatable, Sendable {
    /// Clear-day-weighted mean of current / baseline over calendar months; 1.00 when none compare. Not capped.
    let site: Double
    let comparedMonths: Int
    /// Per face, only faces present in `baseline.directionFactors`; 1.00 for a face with no comparison yet.
    let directions: [SolarHealthCapacity.Direction]
}
extension SolarHealthBaseline {
    func score(of years: [SolarHealthYear]) -> SolarHealthBaselineScore
}
```

- [ ] **Step 1: Write the failing tests** (extension of the Task 1 suite, reusing its `years(_:)` helper made `static` internal to the suite):

```swift
@Test("Year one scores 100% with nothing compared")
// entries 2026-04 … 2026-07 at 1.10; now 2026-08-01
#expect(score.site == 1.0); #expect(score.comparedMonths == 0)

@Test("A stable second year scores 100%")
// 2024-04 … 2025-03 at 1.10, then 2025-04 … 2025-09 at 1.10; now 2025-10-01
#expect(abs(score.site - 1.0) < 1e-9); #expect(score.comparedMonths == 6)

@Test("Each month uses its most recent later factor against its own baseline")
// 2024-04 … 2025-03 at 1.10; 2025-04 … 2025-09 at 1.10 * 0.98; 2026-04 … 2026-09 at 1.10 * 0.97
#expect(abs(score.site - 0.97) < 1e-9)

@Test("Months are weighted by the current observation's clear days")
// baselines May 1.00 and June 1.00; current May 0.90 (10 clear days), June 1.00 (30 clear days)
#expect(abs(score.site - 0.975) < 1e-9)

@Test("A better year reads above 100%")
// current months at baseline × 1.02 → #expect(abs(score.site - 1.02) < 1e-9)

@Test("Faces score against their own month baselines and skip unseparated months")
// two-face reference (90°, 270°). Baseline months 2024-04, 2024-05 separated [90: 1.10, 270: 1.00].
// 2025-04 separated [90: 1.10, 270: 0.96]; 2025-05 shared single entry [90: 1.03].
#expect(score.directions == [.init(azimuth: 90, factor: 1.0), .init(azimuth: 270, factor: 0.96)])

@Test("Zero or negative factors are skipped instead of dividing by them")   // Review Focus 3
// window 2024-04 … 2025-03 at 1.0 except June 2024 at 0.0; later: June 2025 0.9 (becomes June's
//   baseline, nothing after it), July 2025 -0.1 (skipped), August 2025 0.95
#expect(score.site.isFinite); #expect(abs(score.site - 0.95) < 1e-9); #expect(score.comparedMonths == 1)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cmd/ios-app && ./run-tests.sh --quick SolarHealthBaselineTests`
Expected: build failure, `value of type 'SolarHealthBaseline' has no member 'score'`.

- [ ] **Step 3: Implement `score(of:)`**

For each `(m, base)` in `months` with `base.capacity.site > 0`: the latest factor month with `month == m`, `stamp > base.stamp` and `site > 0`; ratio `site / base.site`, weight `capacity.clearDays`. Faces: same walk per `directionFactors` azimuth, using only months whose `directions.count == faceCount` on both sides and whose face factors are > 0.

- [ ] **Step 4: Run to verify they pass**

Run: `cd cmd/ios-app && ./run-tests.sh --quick SolarHealthBaselineTests`
Expected: all pass. `./cmd/ios-app/lint.sh` clean.

- [ ] **Step 5: Commit** — `feat(ios): score entered-panel sites against their own baseline` (with the Co-Authored-By line).

---

### Task 3: Classifier health score and expected energy as new

**Files:**
- Modify: `PWUsage/Models/Solar/Health/SolarHealthFindings.swift:73-80` (`HealthScore`), `PotentialVsActual`, add `SolarHealthReport.baseline`
- Modify: `PWUsage/Models/Solar/Health/SolarHealthClassifier.swift` (`classify`, `healthScore`, `potentialVsActual`)
- Modify: `PWUsage/Views/SolarSystem/SolarHealthSection.swift:41-62` (compile fix only)
- Test: `PWUsageTests/SolarHealthClassifierTests+Baseline.swift`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:

```swift
struct HealthScore: Equatable, Sendable {
    let scoreVsNew: Double              // SolarHealthBaselineScore.site
    let comparedMonths: Int
    let ratedEfficiency: Double         // baseline.siteFactor * SolarLayoutDetector.derate
    let nameplateKw: Double             // manual.nameplateKw(on: now)
    let bandPercent: Double
    let perDirection: [SolarHealthCapacity.Direction]   // score vs new per face
    let baseline: SolarHealthBaseline
    var isProvisional: Bool { baseline.isProvisional }
    /// Emphasis colour: frozen and below 100% − band.
    var isBelowBand: Bool { !isProvisional && scoreVsNew < 1 - bandPercent / 100 }
    /// The check-your-panels prompt: frozen and above the healthy range.
    var isAboveHealthyRange: Bool
}
struct PotentialVsActual { …existing…; var isAsNew = false }   // expectedKwh already × baseline when true
extension SolarHealthReport { var baseline: SolarHealthBaseline? { healthScore?.baseline } }
static let healthyEfficiencyRange = 0.82 ... 0.98   // on SolarHealthClassifier
```

`factor` and `impliedKw` are removed from `HealthScore`; `lowOutputThreshold` is removed.

- [ ] **Step 1: Write the failing tests** (`@Suite("Solar health classification against the site baseline")`, unit-level, built from hand-made `SolarHealthYear`s like `SolarHealthClassifierTests.makeResult`):

```swift
@Test("A frozen site reports score vs new, rated efficiency and per-face scores")
// manual south 5 kW; months 2024-04 … 2025-03 at 1.10 (10 days), 2025-04 … 2025-06 at 1.10 * 0.98; now 2025-07-01
let score = try #require(report.healthScore)
#expect(abs(score.scoreVsNew - 0.98) < 1e-9)
#expect(abs(score.ratedEfficiency - 1.10 * 0.85) < 1e-9)
#expect(!score.isProvisional); #expect(!score.isBelowBand); #expect(!score.isAboveHealthyRange)
#expect(report.baseline == score.baseline)

@Test("Emphasis starts below 92% of new")
// current months at 1.10 * 0.91 → isBelowBand; at 1.10 * 0.93 → !isBelowBand

@Test("Potential vs actual is scaled by that month's baseline")    // also Review Focus 5
// latest daily ratio 2025-06-10 expectedKwh 30, actualKwh 32; June baseline 1.10, site-wide 1.05
#expect(pva.expectedKwh == 33.0); #expect(pva.isAsNew)
// a day in a month with no baseline (only seen before the window) uses siteFactor instead

@Test("Entered panels with no monthly factor yet have no score and no low-output finding") // Review Focus 1
// manual source, one year with capacity nil and months []
#expect(report.healthScore == nil); #expect(!report.allFindings.contains { $0.kind == .lowOutput })

@Test("Detected-only sites keep today's report")                    // Review Focus 4
// SolarHealthReference(source: .detected, …) with the same years; classify(manual: nil)
#expect(report.healthScore == nil); #expect(report.baseline == nil)
#expect(report.potentialVsActual?.isAsNew == false)
#expect(report.changeOverTime.years.map(\.factor) == years.compactMap { $0.capacity?.site })
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cmd/ios-app && ./run-tests.sh --quick SolarHealthClassifierTests`
Expected: build failure on `scoreVsNew` / `isAsNew`.

- [ ] **Step 3: Implement.** In `classify`, build `baseline` only when `result.reference.source == .manual` and `manual` is non-nil, then `healthScore(baseline:years:manual:now:)` and `potentialVsActual(from:baseline:)` (month from the day string's `yyyy-MM`). Keep the existing low-output call compiling for now by gating it on `score.ratedEfficiency < healthyEfficiencyRange.lowerBound` (Task 4 finishes the rule). In `SolarHealthSection.healthScoreRows`, replace `score.factor` with `score.scoreVsNew`, the colour test with `score.isBelowBand`, and delete the "Implied capacity" row, only so the app builds; Task 5 rewrites these rows.

- [ ] **Step 4: Run to verify they pass**

Run: `cd cmd/ios-app && ./run-tests.sh --quick SolarHealthClassifierTests` then `./run-tests.sh --quick SolarHealthClassifierAgingTests` (unchanged, must stay green).
Expected: all pass. `./cmd/ios-app/lint.sh` clean.

- [ ] **Step 5: Commit** — `feat(ios): report Solar Health against the site's own baseline`.

---

### Task 4: Low-output and panel-check rules, end-to-end on synthetic sites

**Files:**
- Modify: `PWUsage/Models/Solar/Health/SolarHealthClassifier.swift` (low-output rule, constants)
- Test: `PWUsageTests/SolarHealthClassifierTests+Baseline.swift`, `PWUsageTests/SolarHealthClassifierPassTests.swift`

**Interfaces:**
- Consumes: Task 3's `HealthScore`.
- Produces: `static let provisionalLowEfficiency = 0.75`, `static let provisionalLowMinClearDays = 10`; finding `id: "low-output"`, `kind: .lowOutput`, title `"Output below what panels of this size usually make"`.

- [ ] **Step 1: Write the failing unit tests** (classifier suite from Task 3):

```swift
@Test("Low output on a frozen baseline is raised at its usual confidence")
// window months at 0.70 / 0.85 (rated efficiency 0.70), 12 months × 10 clear days; now one month after window
let finding = try #require(report.allFindings.first { $0.kind == .lowOutput })
#expect(finding.title == "Output below what panels of this size usually make")
#expect(finding.detail == "When new, your system made about 70% of its rating on clear days. "
    + "Healthy systems make 82–98%.")
#expect(finding.confidence == .confident)   // clearDays >= 20, as today

@Test("While provisional, low output needs below 75% and 10 clear days and is a first estimate")
// one month at 0.70 / 0.85 with 12 clear days → finding, confidence .initial
// same month with 8 clear days → no finding
// one month at 0.78 / 0.85 with 30 clear days (provisional, 78%) → no finding

@Test("High rated efficiency raises the panel prompt only once frozen")
// frozen window at 1.20 (efficiency 1.02) → score.isAboveHealthyRange, no finding of any new kind
// same months but now inside the window → !score.isAboveHealthyRange
```

- [ ] **Step 2: Write the failing pass tests** in `SolarHealthClassifierPassTests` (`SyntheticSolarSite`; add a `manual: ManualSolarLayout? = nil` parameter to `runPass`, defaulting to `manualLayout(for: site.planes)`). The synthetic truth at capacity 1 fits factor 1.00, rated efficiency 0.85.

```swift
@Test("A healthy new site reads 100% and is provisional in its first clear weeks")
// 2026-04-01 … 2026-05-15, now 2026-06-15
#expect(score.scoreVsNew == 1.0); #expect(score.isProvisional)
#expect(abs(score.ratedEfficiency - 0.85) < 0.03); #expect(report.visibleFindings.isEmpty)

@Test("A stable site stays within 1% of new and a declining one reads about 97% after two years")
// capacity { _, _ in 1 }, 2024-01-01 … 2025-12-31, now 2026-01-15 → abs(scoreVsNew - 1) < 0.01, !isProvisional
// capacity { year, month in pow(0.985, Double(year - 2024) + Double(month - 1) / 12) },
//   2024-01-01 … 2026-12-31, now 2027-01-15 → abs(scoreVsNew - 0.970) < 0.01

@Test("A site at 70% of its rating raises low output once frozen")
// capacity { _, _ in 0.70 / 0.85 }, 2024-01-01 … 2024-12-31, now 2025-02-15 → lowOutput present

@Test("Too few panels entered raises the check-your-panels prompt")
// a 94%-efficient array entered with 10% too few panels: capacity { _, _ in 1.10 / 0.9 },
//   2024-01-01 … 2024-12-31, now 2025-02-15 → score.isAboveHealthyRange, no lowOutput finding

@Test("A summer-only site is provisional with its seasons and clear days, and no warnings")
// 2026-06-01 … 2026-08-31, now 2026-09-15 → isProvisional, baseline.seasonsCovered == 1,
//   baseline.clearDays > 0, !isBelowBand, no lowOutput finding
```

The install-date restart is pinned at unit level in Task 1 (a synthetic single series cannot add a plane mid-history).

- [ ] **Step 3: Run to verify they fail**

Run: `cd cmd/ios-app && ./run-tests.sh --quick SolarHealthClassifierTests` and `./run-tests.sh SolarHealthClassifierPassTests`
Expected: the new low-output title/detail and provisional cases fail; pass tests that depend on them fail.

- [ ] **Step 4: Implement** `lowOutputFinding(score:)`: frozen → `ratedEfficiency < healthyEfficiencyRange.lowerBound && baseline.clearDays >= SolarHealthYearFit.minYearClearDays`, confidence `clearDays >= 20 ? .confident : .initial`; provisional → `ratedEfficiency < provisionalLowEfficiency && clearDays >= provisionalLowMinClearDays`, confidence `.initial`. Percentages in the detail via `FormatStyle` (`.percent.precision(.fractionLength(0))` for 70%; the range from the constants as `82–98%`).

- [ ] **Step 5: Run to verify they pass**

Run the same two commands (cap the pass suite with `PWUSAGE_TEST_TIMEOUT_SECONDS=1500` if needed).
Expected: all pass. `./cmd/ios-app/lint.sh` clean.

- [ ] **Step 6: Commit** — `feat(ios): judge low output on rated efficiency when new`.

---

### Task 5: Panel Health rows

**Files:**
- Create: `PWUsage/Views/SolarSystem/SolarHealthScorePresentation.swift`
- Modify: `PWUsage/Views/SolarSystem/SolarHealthSection.swift`
- Test: `PWUsageTests/SolarHealthScorePresentationTests.swift`

**Interfaces:**
- Consumes: Task 3's `HealthScore`, `PotentialVsActual.isAsNew`, `SolarHealthBaseline.relativeUnit`, `restartYear`, `label`; `SolarSystemDetailsRows.kilowatts(_:)`, `.direction(_:)`.
- Produces:

```swift
struct SolarHealthScorePresentation: Equatable {
    init(score: SolarHealthReport.HealthScore, locale: Locale = .current)
    static let waitingForClearDays = "Learning your system · waiting for clear days"
    let headline: String            // "98% of new" | "98% of 2022" | "Learning your system"
    let headlineDetail: String?     // "2 of 4 seasons · 31 clear days" while provisional
    let band: String                // "(±8%)"
    let isEmphasized: Bool          // score.isBelowBand
    let efficiencyLabel: String     // "When new" | "When new (so far)" | "In 2022" | "In 2022 (so far)"
    let efficiencyValue: String     // "94% of its 10.0 kW rating · healthy range 82–98%"
    let olderPanelsNote: String?    // "Older panels usually sit lower in this range." for .firstYear
    let restartNote: String?        // "Baseline restarted when the 2024 system was added"
    let directionRows: [(azimuth: Double, value: String)]  // "96% of new"; empty unless > 1 face
    let panelCheckPrompt: String?   // "Your system makes more than its entered rating allows. Check the panel count and wattage."
    static func potentialCaption(_ pva: SolarHealthReport.PotentialVsActual, locale: Locale = .current) -> String
}
```

(`directionRows` is an array of a small `struct DirectionRow: Equatable { let azimuth: Double; let value: String }` rather than a tuple, so the type stays `Equatable` and within the large-tuple rule.)

- [ ] **Step 1: Write the failing tests** with `Locale(identifier: "en_US")`, scores built through `SolarHealthClassifier.classify` on hand-made years (helper shared with Task 3's suite or copied minimal):

```swift
@Test("Frozen score reads as % of new with rated efficiency and the healthy range")
// scoreVsNew 0.98, rated 0.94 (factor 0.94 / 0.85), nameplate 10 kW, two faces 1.00 / 0.96
#expect(p.headline == "98% of new"); #expect(p.headlineDetail == nil); #expect(p.band == "(±8%)")
#expect(p.efficiencyLabel == "When new")
#expect(p.efficiencyValue == "94% of its 10.0 kW rating · healthy range 82–98%")
#expect(p.directionRows.map(\.value) == ["100% of new", "96% of new"])
#expect(p.panelCheckPrompt == nil); #expect(p.restartNote == nil)

@Test("Provisional score is learning, with seasons and clear days, and never emphasized")
// 2 seasons, 31 clear days, no compared months
#expect(p.headline == "Learning your system"); #expect(p.headlineDetail == "2 of 4 seasons · 31 clear days")
#expect(p.efficiencyLabel == "When new (so far)"); #expect(!p.isEmphasized)

@Test("Provisional score with compared months shows the figure with the learning detail")
// provisional (2 seasons) but comparedMonths > 0, scoreVsNew 0.97
#expect(p.headline == "97% of new")
#expect(p.headlineDetail == "Learning your system · 2 of 4 seasons · 31 clear days")

@Test("Older systems read against their first year and note that older panels sit lower")
// label .firstYear(2022), efficiency 0.91 → headline "…% of 2022", efficiencyLabel "In 2022",
//   efficiencyValue starts "91% of its", olderPanelsNote != nil

@Test("Restart and panel-check notes appear when they apply")
// restartYear 2024 → "Baseline restarted when the 2024 system was added"
// frozen efficiency 1.02 → panelCheckPrompt == "Your system makes more than its entered rating allows. "
//   + "Check the panel count and wattage."

@Test("Potential caption says what the system made as new")
// PotentialVsActual(day: "2026-05-03", expectedKwh: 41.2, actualKwh: 40.0, isAsNew: true)
#expect(SolarHealthScorePresentation.potentialCaption(pva, locale: en) ==
    "As new, your system made about 41.2 kWh on a clear day like 2026-05-03; yours made 40.0 kWh.")
// isAsNew false → "Expected 41.2 kWh on a clear day like 2026-05-03; yours made 40.0 kWh."
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cmd/ios-app && ./run-tests.sh --quick SolarHealthScorePresentationTests`
Expected: build failure, `cannot find 'SolarHealthScorePresentation' in scope`.

- [ ] **Step 3: Implement the presentation**, percentages with `.percent.precision(.fractionLength(0)).locale(locale)`, kW through `SolarSystemDetailsRows.kilowatts`, clear days with `.number.locale(locale)`, the range from `SolarHealthClassifier.healthyEfficiencyRange`.

- [ ] **Step 4: Rewire `SolarHealthSection`**: `healthScoreRows` shows `Health` (headline + band, emphasis colour when `isEmphasized`, detail line in `.caption`/`.secondary` under it), the efficiency row, `olderPanelsNote` and `restartNote` as captions, direction rows, and when `panelCheckPrompt` is set a row with that text and `Button("Check Panel Details", action: onEditLayout)`. Remove "Entered capacity" and "Implied capacity". When `report.healthScore == nil && report.source == .manual`, show `SolarHealthScorePresentation.waitingForClearDays` instead of `manualPromptRow` (Review Focus 1). `potentialRow` uses `potentialCaption`. Keep `body` sections small (extract `@ViewBuilder` helpers to stay under the function-body budget).

- [ ] **Step 5: Run to verify they pass**

Run: `cd cmd/ios-app && ./run-tests.sh --quick SolarHealthScorePresentationTests`
Expected: all pass. `./cmd/ios-app/lint.sh` clean, no warnings in the build log.

- [ ] **Step 6: Commit** — `feat(ios): show Panel Health as % of new with rated efficiency`.

---

### Task 6: Trend view and house view against the baseline

**Files:**
- Modify: `PWUsage/Views/SolarSystem/SolarHealthTrendView.swift`
- Modify: `PWUsage/Views/SolarSystem/SolarSystemHouseHealth.swift:70-100`
- Test: `PWUsageTests/SolarSystemHouseHealthTests.swift`, `PWUsageTests/SolarHealthBaselineTests+Score.swift`

**Interfaces:**
- Consumes: `SolarHealthReport.baseline`, `SolarHealthBaseline.siteFactor`, `directionFactor(azimuth:)`, `isBeforeWindow(_:)`, `isBeforeWindow(year:)`, `relativeUnit`.
- Produces: `extension SolarHealthBaseline { func relative(_ factor: Double) -> Double }` (`factor / siteFactor`, `siteFactor > 0` guaranteed by Task 1) in `SolarHealthBaseline+Score.swift`.

- [ ] **Step 1: Write the failing tests**

```swift
// SolarHealthBaselineTests+Score.swift
@Test("Trend values divide by the site-wide baseline")
// siteFactor 1.10 → #expect(abs(baseline.relative(1.078) - 0.98) < 1e-9)

// SolarSystemHouseHealthTests.swift
@Test("Entered-panel faces fade by their score against each face's baseline")
// two-face manual (90°, 270°, installDate nil). Years built so classify gives a frozen baseline:
//   2023 window months separated [90: 1.10, 270: 1.00]; 2025 year capacity directions [90: 0.99, 270: 1.00].
// report = SolarHealthClassifier.classify(result, manual:, now: 2026-01-15)
#expect(abs(overlay2025.panelOpacity(forAzimuth: 90) - 0.90) < 0.001)
#expect(abs(overlay2025.panelOpacity(forAzimuth: 270) - 1.0) < 0.001)

@Test("Years before the baseline window do not fade")
// same report, a 2021 year with capacity directions [90: 0.70, 270: 0.70] before a 2023 install date
#expect(overlay2021.panelOpacity(forAzimuth: 90) == 1.0)
```

The existing "Year scrubber fades each face by its fitted direction factor" test (report with `healthScore: nil`) stays unchanged and must still pass: it pins Review Focus 4.

- [ ] **Step 2: Run to verify they fail**

Run: `cd cmd/ios-app && ./run-tests.sh --quick SolarSystemHouseHealthTests` and `./run-tests.sh --quick SolarHealthBaselineTests`
Expected: `relative` missing; opacity 0.99 instead of 0.90.

- [ ] **Step 3: Implement.** In `SolarHouseHealthOverlay.init`, when `report?.baseline` is non-nil: if `baseline.isBeforeWindow(year: effectiveYear)` set `yearFactor = nil` and `directionFactors = []`; otherwise divide `yearFactor` by `baseline.siteFactor` and each direction factor by `baseline.directionFactor(azimuth:)`. `panelOpacity` keeps its `0.35 ... 1.0` clamp. In `SolarHealthTrendView`, with a baseline: yearly rows read `"\(percent)% \(baseline.relativeUnit) · \(n) clear days"` from `baseline.relative(entry.factor)` and use `.foregroundStyle(.secondary)` for `isBeforeWindow(year:)`; chart points use `relative(entry.factor) * 100`, pre-window points in `Color.secondary` (window points stay `Color.emphasis`); `chartYAxisLabel("% \(baseline.relativeUnit)")` ("% of new"). Without a baseline the view is unchanged. Percentages via `FormatStyle`.

- [ ] **Step 4: Run to verify they pass**

Run the same commands. Expected: all pass, including every existing `SolarSystemHouseHealthTests` case. `./cmd/ios-app/lint.sh` clean.

- [ ] **Step 5: Commit** — `feat(ios): show trend and house aging as % of new`.

---

### Task 7: Backtest report section and full verification

**Files:**
- Create: `PWUsageTests/DegradationBacktest/DegradationBacktestTests+Baseline.swift`
- Modify: `PWUsageTests/DegradationBacktest/DegradationBacktestTests.swift:13-26` (append the section)

**Interfaces:**
- Consumes: `SolarHealthClassifier.classify`, `HealthScore`, `DegradationBacktestInputs` (`config.manual`, `config.now`).
- Produces: `static func baselineSection(_ inputs: DegradationBacktestInputs, result: SolarHealthResult) -> [String]`.

- [ ] **Step 1: Add the section.** Lines: `"## 5. Site baseline"`, window start (`yyyy-MM`), provisional yes/no, seasons covered, rated efficiency (`%.1f%%`), score vs new (`%.1f%%`), per-face score, restart year if any. It writes only to `report.md`, never to the log (the suite's privacy rule). The suite is disabled without `PWUSAGE_SOLAR_BACKTEST_DIR`, so this is a manual check, not a gated test.

- [ ] **Step 2: Run the full default suite**

Run: `cd cmd/ios-app && PWUSAGE_TEST_TIMEOUT_SECONDS=1500 ./run-tests.sh`
Expected: `TEST SUCCEEDED`, non-zero test count, no compiler warnings in the log. Then `./cmd/ios-app/lint.sh` from the repo root: zero violations.

- [ ] **Step 3: Manual check (owner, local only).** With `PWUSAGE_SOLAR_BACKTEST_DIR` set, run `./run-tests.sh DegradationBacktestTests` and read section 5 of `report.md`: rated efficiency about 94% and score vs new near 100% for the owner's 10 kW layout.

- [ ] **Step 4: Commit** — `test(ios): report rated efficiency and score vs new in the backtest`.
