# Smart Shift Bill-Date Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price Smart Shift starts against each rate period's bank on the bill date, using Solcast for 7 days and the site's last 28 days of grid history after that (or history alone without Solcast). Recommend the cheapest start that a cautious projection says leaves no bank more than 3 kWh short.

**Architecture:**
- **Server:** `/api/mobile/load-planning-context` gains per-slot grid history: a typical value (median), a cautious value (the "dull day", about 1 in 4) and solar (median), built from 28 days and memoized per site per local day. `/api/mobile/bill-summary` extends `tariffTimeline` to the bill date.
- **iOS:** `LoadTimingForecastEstimator` splits its single horizon into:
  - a search window (starts today/tomorrow, which is also the chart window);
  - a projection to the bill date (typical);
  - a 7-day safety window (cautious).
  
  `SmartShiftPresentation` explains the result.

**Tech Stack:** Next.js / TypeScript / Vitest / Temporal (server); Swift 6, SwiftUI, Swift Testing, XcodeGen (`cmd/ios-app/run-tests.sh`).

**Spec:** `docs/superpowers/specs/2026-10-18-smart-shift-cycle-projection-design.md`. Read it first. It builds on `docs/superpowers/specs/2026-10-18-smart-shift-energy-weather-design.md`.

**Branch:** stack on `claude/smart-shift-energy-weather-5de814` (the energy weather redesign, not yet merged).

## Global Constraints

- The cost model is unchanged: each period nets separately across the cycle (`priceBillUsage`); a banked kWh costs its sell rate, and an owed kWh its buy rate.
- **Forecast window:** 7 days (`hours=168` on the existing Solcast call). **No additional Solcast requests.**
- **History:** last **28** local days of grid flow per half-hour slot. Typical = median across usable days. Cautious = mean slot profile of the days in the **20th–30th percentile** band by whole-day grid net export (at least one day). At least 5 usable days, 90% coverage, as today.
- **Safety rule:** a start that draws on a bank (the typical projection prices part of the run at that period's sell rate) is eligible only if, under the cautious projection with that start, that bank is **≥ −3 kWh** at the safety-window end, which is `min(now + 7 days, projection end)`. The rule applies to starting now too. Recommend the cheapest eligible start (ties earliest). If none is eligible, pick the smallest cautious shortfall (ties: cheapest, then earliest).
- **Search window:** starts from now to midnight tomorrow (site time). A run may finish after midnight tomorrow, but must finish by the projection end.
- **Projection end:** the bill date (`cycleEnd`), cut short at the first rate change, the first period with no balance, or the end of tariff coverage, as today.
- **Additive contracts only:** an older server (no history fields) means the forecast coverage still bounds the projection, exactly as today. An older app ignores the new fields. A cached Solcast batch without `pv_estimate10` uses the median for the cautious run.
- The comparison is computed once per body pass (PR #157). Six Jobs per pass must stay within **≤ 40 ms forecast / ≤ 10 ms history-or-flat** on the simulator, measured as on the energy weather branch.
- Copy uses "bank" (banked/owed); never "cushion", "surplus", "grid rate".
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **DST fall-back inside the projection** (Nov 1 falls in Harrison's cycle): the 01:00 history slot applies to both 01:00 hours, so the 25-hour day projects 25 hours of grid flow, with no gap and no double day. Pinned in Task 5 (`historyFillFollowsFallBack`).
2. **App against an older server** (no history fields) with Solcast: the projection and search behave exactly as today. Every pre-existing `LoadTimingForecastEstimatorTests` case passes unchanged. Pinned in Task 5.
3. **No start passes the safety rule:** the headline names the least risky start and says a cloudy week could still leave the bank short. It never claims a saving. Pinned in Tasks 6 and 8.
4. **Rate change before the bill date:** the projection and safety window end at the change, and the bank note says "when rates change", not "bill date". Pinned in Tasks 5 and 8.
5. **Bill date inside the 7-day window:** the safety check uses the bill date. Pinned in Task 6 (`safetyWindowEndsAtBillDateWhenSooner`).

---

### Task 1: Server — grid history per half-hour slot

**Files:**
- Create: `cmd/next-app/src/lib/load-planning-days.ts` (day grid and row alignment, extracted from `load-planning-context.ts`)
- Create: `cmd/next-app/src/lib/load-planning-grid-history.ts`
- Modify: `cmd/next-app/src/lib/load-planning-context.ts` (use the extracted helper; behavior unchanged)
- Test: `cmd/next-app/src/lib/load-planning-grid-history.test.ts`; the existing `load-planning-context.test.ts` must pass unchanged

**Interfaces:**
- Produces:
  ```ts
  // load-planning-days.ts
  export interface AlignedDay { timestamps: Date[]; slots: Map<number, Date[]> }
  export function alignHistoryDays(rows: EnergyData[], timeZone: string, asOf: Date, days: number):
      { days: AlignedDay[]; rowsByTimestamp: Map<number, EnergyData>; candidateRows: number; unalignedRows: number;
        historyStart: Date; historyEnd: Date }
  // load-planning-grid-history.ts
  export const GRID_HISTORY_DAYS = 28;
  export interface GridHistorySlot { localMinute: number; gridNetExportKw: number | null;
      cautiousGridNetExportKw: number | null; solarKw: number | null }
  export interface GridHistory { usableDayCount: number; historyStart: string; historyEnd: string; slots: GridHistorySlot[] }
  export function buildGridHistory(rows: EnergyData[], timeZone: string, asOf: Date, days?: number): GridHistory
  ```
  Net export is `-grid_power` (grid is positive for import). Values are average kW over the slot, integrated like `homeKw`.

- [ ] **Step 1: Extract `alignHistoryDays`.** Move the expected-day grid, nearest-interval row claiming and day coverage filter out of `buildLoadPlanningContext` unchanged. Run `npm test -- src/lib/load-planning-context` from `cmd/next-app`. Expected: all pass.
- [ ] **Step 2: Write failing tests** in `load-planning-grid-history.test.ts`, using synthetic 5-minute rows for `America/Chicago`:
  - `typicalIsMedianNetExportPerSlot`: 28 full days where the 12:00 slot exports `d` kW on day `d` (1…28). Expect `gridNetExportKw` at minute 720 to be `14.5`.
  - `cautiousIsTheOneInFourDayProfile`: days ranked by whole-day export. With 28 days the band is sorted indexes `floor(0.2*27)=5` … `ceil(0.3*27)=9`. Expect `cautiousGridNetExportKw` to equal the mean of those 5 days' slot values.
  - `solarIsMedianPerSlot`: `solarKw` is the median of `solar_power` converted to kW.
  - `needsFiveUsableDays`: 4 usable days gives every value `null` and `usableDayCount == 4`.
  - `historyFillFollowsFallBack`: a window containing 2026-11-01. The fall-back day casts one vote per slot, with both 01:00 hours integrated together, matching `buildLoadPlanningContext`.
- [ ] **Step 3: Run** `npm test -- src/lib/load-planning-grid-history`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement `buildGridHistory`** on `alignHistoryDays`. The band and median rules are in Global Constraints. A slot with no covered band day gets `cautiousGridNetExportKw: null`.
- [ ] **Step 5: Run** `npm test -- src/lib/load-planning` and `npm run lint`. Expected: pass.
- [ ] **Step 6: Commit** `feat(server): 28-day grid history per half-hour for Smart Shift`.

### Task 2: Server — serve grid history, memoized per day

**Files:**
- Modify: `cmd/next-app/src/app/api/mobile/load-planning-context/route.ts`
- Create: `cmd/next-app/src/lib/household-pattern-cache.ts` (per-instance memo, modelled on `cycle-rollup-cache.ts`)
- Test: `cmd/next-app/src/app/api/mobile/load-planning-context/route.test.ts`

**Interfaces:**
- Consumes: `buildGridHistory`, `GRID_HISTORY_DAYS` (Task 1).
- Produces the response (version stays `1`, additive). Each slot gains `gridNetExportKw`, `cautiousGridNetExportKw` and `solarKw`. The top level gains `gridHistory: { usableDayCount, historyStart, historyEnd }`. The home and battery fields still come from 14 days.

- [ ] **Step 1: Write failing route tests:**
  - `servesGridHistoryInEachSlot`: the response slots carry the three new fields from a mocked repo.
  - `readsTwentyEightDaysOnce`: one `getRawEnergyData` call, spanning 28 local days.
  - `memoizesPerSiteAndLocalDay`: two requests on the same local day give one repo read; a request on the next local day reads again.
- [ ] **Step 2: Run** `npm test -- src/app/api/mobile/load-planning-context`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Fetch 28 days once, and pass the rows to both builders (`buildLoadPlanningContext` already ignores rows outside its 14-day window).
  - Merge `GridHistorySlot` values into the slots by `localMinute`.
  - Memo key: `siteId + historyEnd ISO`. The window ends at local midnight, so the result is fixed for the day. Cache only successful builds.
- [ ] **Step 4: Measure the read on the Dev DB.** For Harrison (`2252268092126997`), run:
  ```sql
  select count(*), sum(pg_column_size(e.*)) from "EnergyData" e
  where site_id = '2252268092126997' and timestamp >= now() - interval '28 days';
  ```
  Record the rows and bytes for the PR. Expected: about 8,000 rows. If the bytes are more than about 2 MB, stop and report before continuing.
- [ ] **Step 5: Run** `npm test` and `npm run lint` from `cmd/next-app`. Expected: pass.
- [ ] **Step 6: Commit** `feat(server): household pattern serves grid history, cached per day`.

### Task 3: Server — tariff timeline to the bill date

**Files:**
- Modify: `cmd/next-app/src/app/api/mobile/bill-summary/route.ts:93-99`
- Test: `cmd/next-app/src/app/api/mobile/bill-summary/route.test.ts`

- [ ] **Step 1: Write failing test** `tariffTimelineReachesBillDate`: with a cycle ending 20 days after `now`, the last segment's `end` equals `cycleEnd`. With a cycle ending 3 days out, the timeline still runs 7 days (no regression).
- [ ] **Step 2: Run** `npm test -- src/app/api/mobile/bill-summary`. Expected: FAIL.
- [ ] **Step 3: Implement:** the timeline end is `new Date(Math.max(now + 7 days, cycleEnd))`. Time the build for a 31-day horizon in the test. If it exceeds 50 ms, make `buildLoadTimingTimeline` sample every 15 minutes instead of every minute (all real tariff boundaries fall on 15-minute marks), with a test for a 15-minute boundary.
- [ ] **Step 4: Run** `npm test` and `npm run lint`. Expected: pass.
- [ ] **Step 5: Commit** `feat(server): tariff timeline reaches the bill date`.

### Task 4: iOS — contracts, Solcast horizon and cautious solar, household pattern without Solcast

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/MobileContracts.swift` (`MobileLoadPlanningContextResponse.Slot`, `estimatorContext`)
- Modify: `cmd/ios-app/PWUsage/Models/LoadTimingForecastEstimator.swift` (`PlanningSlot`, `PlanningContext`)
- Modify: `cmd/ios-app/PWUsage/Models/SolarForecast.swift` (`SolarForecastInterval`, `SolarForecast.combine`)
- Modify: `cmd/ios-app/PWUsage/Networking/SolcastClient.swift:73` (query)
- Modify: `cmd/ios-app/PWUsage/State/DashboardCoordinator.swift` (`loadTimingDetailAppeared`)
- Test: `PWUsageTests/MobileContractsTests.swift` (or the file that decodes the planning context today), `PWUsageTests/SolarForecastTests.swift`, `PWUsageTests/SolcastClientTests.swift`, `PWUsageTests/DashboardCoordinatorTests.swift`

**Interfaces:**
- Produces:
  ```swift
  // PlanningSlot gains (vars with defaults keep the existing memberwise init):
  var gridNetExportKw: Double? = nil
  var cautiousGridNetExportKw: Double? = nil
  // PlanningContext:
  var hasGridHistory: Bool   // any slot has gridNetExportKw
  // SolarForecastInterval gains:
  var cautiousPowerKw: Double? = nil   // summed pv_estimate10; nil in batches stored by older builds
  // DashboardCoordinator:
  @Published private(set) var householdPattern: LoadTimingForecastEstimator.PlanningContext?
  ```
  Response `Slot` decodes `gridNetExportKw`, `cautiousGridNetExportKw` and `solarKw` with `decodeIfPresent`.

- [ ] **Step 1: Write failing tests:**
  - `planningContextDecodesGridHistory` and `planningContextWithoutGridHistoryStillDecodes` (the old payload): `estimatorContext.hasGridHistory` is `true` and `false` respectively.
  - `combineKeepsCautiousSolar`: two arrays with `pv_estimate10` sum into `cautiousPowerKw`. If either array lacks it, `cautiousPowerKw == nil`.
  - `oldBatchDecodesWithoutCautiousSolar`: JSON without the key decodes, giving `nil`.
  - `forecastRequestAsksForSevenDays`: the request URL has `hours=168` and `format=json`.
  - `householdPatternLoadsWithoutSolcast`: with no Solcast credential, `loadTimingDetailAppeared` sets `householdPattern` and leaves `loadPlanningContext == nil` and `solarForecastConnection == .notConnected`. A second appearance within 24 h makes no second planning request.
- [ ] **Step 2: Run** `./run-tests.sh` from `cmd/ios-app`. Expected: FAIL (members missing).
- [ ] **Step 3: Implement.** In `loadTimingDetailAppeared`, before the credential guard, run the existing cached `planningContext(siteID:api:)` and publish its `context` as `householdPattern`. The Solcast path reuses the same cache, so it makes no extra request.
- [ ] **Step 4: Run** `./run-tests.sh`. Expected: `** TEST SUCCEEDED **`.
- [ ] **Step 5: Commit** `feat(ios): read grid history, cautious solar and 7-day forecasts`.

### Task 5: iOS — project banks to the bill date

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/LoadTimingForecastEstimator.swift`
- Test: `PWUsageTests/LoadTimingForecastEstimatorTests.swift` (append only; existing tests unchanged)

**Interfaces:**
- Consumes: `PlanningSlot.gridNetExportKw`, `PlanningContext.hasGridHistory` (Task 4).
- Produces:
  ```swift
  enum Projection: Equatable {
      case forecast(intervals: [SolarForecastInterval], context: PlanningContext)
      case history(context: PlanningContext)   // no Solcast: grid history from now
      case flat(timeZone: String)
  }
  static let forecastWindow: TimeInterval = 7 * 86_400
  // Comparison gains:
  let projectionEnd: Date
  let projectionEndsAtRateChange: Bool     // ended at a rate change or a period with no balance, before cycleEnd
  // BalanceLane gains (typical projection at projectionEnd):
  let projectedKwh: Double                 // without either run
  let projectedAfterRecommendedKwh: Double
  let projectedAfterStartNowKwh: Double
  ```
  `horizonEnd` keeps its meaning: the search and chart window end. Lane `recommended` / `startNow` series run only from now to `horizonEnd`.

**Flow source by instant** (typical run):
- **`.forecast`:** before `forecastEnd = min(now + forecastWindow, contiguous forecast end)`, Solcast `powerKw` − home − battery. After that:
  - if `context.hasGridHistory`, the slot's `gridNetExportKw`;
  - otherwise the projection ends at `forecastEnd`, as today.
- **`.history`:** the slot's `gridNetExportKw` throughout.
- **`.flat`:** 0.

`projectionEnd` = the min of `cycleEnd`, the tariff coverage end, the first incompatible rate change and the first period with no balance (the existing rules), and the source's end.

**Candidates:** start in `[now, horizonEnd)`, and `start + duration <= projectionEnd`. Price each against the baseline at `projectionEnd`, as `score` does today.

- [ ] **Step 1: Write failing tests:**
  - `historyProjectsBanksToTheBillDate`: `.history` with On-Peak slots at `+2` kW and Off-Peak at `-0.5`, over 10 days, `cycleEnd` = now + 10 d. Expect On-Peak `projectedKwh` = start + 2 × (On-Peak hours to cycle end), and `projectionEnd == cycleEnd`.
  - `forecastWindowThenHistory`: `.forecast` with 2 days of intervals and grid history. Expect `projectedKwh` = forecast-window flows + history flows after coverage.
  - `overdrawnBankRecoversByBillDate` (Harrison-like): Sunday, On-Peak +5, Off-Peak −64, car 52.7 kWh at 9 kW, history On-Peak +3 kW in weekday daylight slots, `cycleEnd` 23 days out. Expect the recommended run to lie entirely in On-Peak, and `recommendedCost ≈ 52.7 × 0.04`.
  - `runsMayFinishAfterTheSearchWindow`: `.flat`. A start at 20:00 tomorrow with a 6 h run is in `evaluatedStarts`, and `recommendedEnd > horizonEnd` when chosen.
  - `rateChangeEndsProjection`: a buy-rate change on day 5. Expect `projectionEnd` at the change, and `projectionEndsAtRateChange == true`.
  - `historyFillFollowsFallBack`: `America/Chicago` across 2026-11-01. The 25-hour day adds 25 hours of slot flow.
- [ ] **Step 2: Run** `./run-tests.sh LoadTimingForecastEstimatorTests`. Expected: FAIL.
- [ ] **Step 3: Implement.** The existing pre-change tests must pass unchanged: without grid history, `.forecast` keeps its coverage-bounded horizon.
- [ ] **Step 4: Run** `./run-tests.sh`. Expected: `** TEST SUCCEEDED **`.
- [ ] **Step 5: Commit** `feat(ios): project Smart Shift banks to the bill date`.

### Task 6: iOS — cautious projection and the safety rule

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/LoadTimingForecastEstimator.swift`
- Test: `PWUsageTests/LoadTimingForecastEstimatorTests.swift` (append)

**Interfaces:**
- Consumes: Task 5's projection, `SolarForecastInterval.cautiousPowerKw`, `PlanningSlot.cautiousGridNetExportKw`.
- Produces:
  ```swift
  static let safetyShortfallKwh = 3.0
  enum Safety: Equatable {
      case nowSafe                          // starting now passes
      case nowUnsafe(periodKey: String)     // a later start passes; recommendation may cost more than now
      case noSafeStart(periodKey: String)   // nothing passes; least shortfall chosen
  }
  struct RuledOut: Equatable { let start: Date; let cost: Double; let periodKey: String }
  // Comparison gains:
  let safetyEnd: Date      // min(now + forecastWindow, projectionEnd)
  let safety: Safety
  let ruledOut: RuledOut?  // cheapest candidate rejected by the rule, when cheaper than the recommendation
  ```
  `savings` stays `max(0, costNow - recommendedCost)`. `recommendedCost` may exceed `costNow` when `safety != .nowSafe`.

**Cautious run:** integrate the baseline once from `projectionStart` to `safetyEnd`, using `cautiousPowerKw ?? powerKw` in the forecast window and `cautiousGridNetExportKw ?? gridNetExportKw` after it. For each candidate and each period `p` where the typical projection prices part of the run at `p`'s sell rate (typical baseline at `projectionEnd` > 0 and the run draws on `p`): the cautious value at `safetyEnd` = cautious baseline − the run's draw in `p` before `safetyEnd`. That value must be `≥ -safetyShortfallKwh`.

- [ ] **Step 1: Write failing tests:**
  - `cautiousSafetyRulesOutADipACloudyWeekWouldSink`: median solar banks enough but `pv_estimate10` doesn't. The dip start is in `ruledOut`, and the recommendation is the cheapest passing start.
  - `nowIsCheckedToo`: now draws on On-Peak, and the cautious run leaves it at −5. Expect `safety == .nowUnsafe(periodKey: "ON_PEAK")`, `recommendedCost > costNow` and `savings == 0`.
  - `noSafeStartPicksSmallestShortfall`: every bank-drawing start fails. Expect `.noSafeStart` and the start with the least shortfall.
  - `shortfallOfThreeIsAllowed`: exactly −3.0 passes, and −3.01 fails.
  - `boughtPeriodsAreNotChecked`: an owed Off-Peak deeper than −3 does not block an Off-Peak start.
  - `missingCautiousSolarUsesMedian`: intervals without `cautiousPowerKw` give `.nowSafe` and `ruledOut == nil` where the typical run passes.
  - `safetyWindowEndsAtBillDateWhenSooner`: `cycleEnd` 3 days out gives `safetyEnd == cycleEnd`.
- [ ] **Step 2: Run** `./run-tests.sh LoadTimingForecastEstimatorTests`. Expected: FAIL.
- [ ] **Step 3: Implement** the selection order from Global Constraints. The minor-unit threshold compares a passing later start against a passing "now".
- [ ] **Step 4: Run** `./run-tests.sh`. Expected: `** TEST SUCCEEDED **`.
- [ ] **Step 5: Commit** `feat(ios): only suggest bank dips that survive a cloudy week`.

### Task 7: iOS — keep the per-pass cost in budget

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/LoadTimingForecastEstimator.swift`

- [ ] **Step 1: Measure** with a scratch timing test (do not commit it), like the energy weather branch's: six default Jobs, a Harrison-like tariff, `cycleEnd` 23 days out, `.forecast` with 7 days of intervals plus grid history, and `.history`. Record the ms per pass.
- [ ] **Step 2: If over budget** (40 ms forecast / 10 ms history), make these changes, keeping behavior:
  - binary-search forecast intervals and tariff segments by time;
  - precompute a `[localMinute: PlanningSlot]` map;
  - have `WallClock` step 15 minutes (DST and zone offsets are 15-minute multiples).
  
  The whole suite must stay green, and the existing DST tests guard the wall-clock change.
- [ ] **Step 3: Re-measure.** Expected: within budget. Record both numbers in the commit message.
- [ ] **Step 4: Commit** `perf(ios): keep bill-date projection within the per-pass budget`.

### Task 8: iOS — presentation, copy and wiring

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/SmartShiftPresentation.swift`, `SmartShiftDetailsView.swift`, `SmartShiftVerdictView.swift`, `LoadTimingView.swift`
- Test: `PWUsageTests/SmartShiftPresentationTests.swift`, `PWUsageTests/LoadTimingViewTests.swift`

**Interfaces:**
- Consumes: `Projection.history`, `Comparison.projectionEnd`, `projectionEndsAtRateChange`, `safetyEnd`, `safety`, `ruledOut`, lane `projected*` (Tasks 5–6); `DashboardCoordinator.householdPattern` (Task 4).
- Produces:
  - `SmartShiftPresentation.evaluate(...)` picks:
    - `.forecast` when the forecast is `.ready`;
    - otherwise `.history(context:)` when the context `hasGridHistory`;
    - otherwise `.flat`.
    
    `LoadTimingView` passes `coordinator.loadPlanningContext ?? coordinator.householdPattern` as `context`.
  - `SmartShiftVerdict.Note.connectSolcast(usesHistory: Bool)`.
  - `costBreakdowns(comparison:profile:timing:now:billingCycleEnd:currencyCode:timeZone:)`, with draws taken from the lane `projected*` values (not the chart-edge ends).
  - `static func ruledOutNote(comparison:profile:timing:now:timeZone:) -> String?`, shown in the details sheet.

**Exact copy** (pin each in a test; `<when>` is the existing "at 4:30 PM" / "tomorrow at 4:30 PM", `<date>` is `MMM d` in the site zone):
- **Headline, `.nowUnsafe`:** `"<name> <when>: about <$diff> more than now, but it won't leave <P> short"`. Caption `"Added to your bill"`, two bars (recommended first), no percent label.
- **Headline, `.noSafeStart`:** `"<name> <when>: the least risky time, but a cloudy week could still leave <P> short"`.
- **Why line, later clause, when the bank used exceeds today's balance:**
  - `"<When> it <mostly >uses your <P> bank, projected at <±n> kWh by <date>, giving up <sell> in credit."`
  - This replaces "energy your solar banks before then".
- **Why line, `.nowUnsafe`:** `"Starting now would draw on your <P> bank, which a cloudy week could leave more than 3 kWh short by <safetyDate>. <later clause>"`.
- **Bank note:** `"<P> bank is <±today> now, projecting <±projected> by <date> (bill date), <±after> after this charge."`. Use `"by <date>, when rates change,"` when `projectionEndsAtRateChange`.
- **Ruled-out line:** `"Charging <when> would be cheaper if the sun holds, but a cloudy week could leave <P> more than 3 kWh short by <safetyDate>, so it isn't suggested."` (the verb comes from the Job, e.g. "Washing", "Starting").
- **No-forecast note with history:** `"Without a solar forecast, banks follow your last four weeks. Connect Solcast to see this week's solar."`. Keep the existing sentence when the card falls back to flat.
- **Assumptions:**
  - `.forecast` with history: `"Solar follows your Solcast forecast for the next 7 days, then your last four weeks through the bill date."`
  - `.history`: `"Banks follow your last four weeks of grid use through the bill date."`
  - Both add: `"A start that dips into a bank must leave it no more than 3 kWh short after a cloudy week."`
  - Keep the existing "typical", "evaluated" and flat lines.

- [ ] **Step 1: Write failing tests**, one per copy line above, using the `harrisonSunday()` fixture extended with the Task 5–6 fields. Also add `evaluateUsesHistoryWithoutSolcast` (an assumptions line proves `.history` was used) and `draws use bill-date bank` (the 4:30 PM block for the Harrison numbers with a recovering bank prices all 52.7 kWh at 4¢).
- [ ] **Step 2: Run** `./run-tests.sh SmartShiftPresentationTests`. Expected: FAIL.
- [ ] **Step 3: Implement** the copy, the `evaluate` choice, the breakdown draws, the ruled-out line in `SmartShiftDetailsView` (above "Rate periods"), and the `.connectSolcast(usesHistory:)` rendering in `SmartShiftVerdictView`.
- [ ] **Step 4: Run** `./run-tests.sh`. Expected: `** TEST SUCCEEDED **`.
- [ ] **Step 5: Commit** `feat(ios): explain bill-date projections and safety in Smart Shift`.

### Task 9: Verify on device and record follow-ups

- [ ] **Step 1:** Add to `TODO.md`:
  - backfill and rollups (part of the rollup-storage migration);
  - a 1-in-4 *week* cautious history once months of history exist;
  - 14-day projected-bill views using `pv_estimate10`.
- [ ] **Step 2:** Run `npm test` and `npm run lint` (in `cmd/next-app`) and `./run-tests.sh` (in `cmd/ios-app`). Expected: all green.
- [ ] **Step 3:** Hand the owner the device check. Run `open <worktree>/cmd/ios-app/PWUsage.xcodeproj` against a server built from this branch, then check, for Harrison on a weekend with a sunny Monday:
  - the suggestion and both bars;
  - the bill-date bank note;
  - the ruled-out line when a dip is too risky;
  - the no-Solcast card (history note and assumptions).
- [ ] **Step 4: Commit** `docs: track Smart Shift projection follow-ups`. Don't push.
