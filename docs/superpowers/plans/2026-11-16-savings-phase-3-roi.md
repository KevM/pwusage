# Savings Phase 3: Return on Investment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners enter what their solar and Powerwall cost; the iOS Solar System screen shows how much each has paid back and about when each (and the whole system) pays for itself, with its assumptions listed.

**Architecture:** The server stores per-site, per-component costs in a small `SiteSystemCost` table and sends them, with the site's install date, inside the existing rate plan timeline response (`systemCosts`), so they arrive with the data savings already reprice from and survive reinstalls. Writes go through one `PUT /api/site/{id}/system-costs` under the rate plan routes' permission check. On the phone, `SavingsCalculator` adds per-component "since install" figures and the last 12 cycles' costs to `SavingsReport`, `RateGrowth` measures the actual timeline's yearly rate rise, and a pure `PaybackCalculator` turns report + costs + degradation into paid-to-date and a break-even month. Views only render `PaybackPresentation` output.

**Tech Stack:** Next.js App Router + `pg` + vitest (`cmd/next-app`); Swift 6, SwiftUI, Swift Testing, XcodeGen (`cmd/ios-app`).

**Spec:** [`../specs/2026-11-13-savings-and-roi-design.md`](../specs/2026-11-13-savings-and-roi-design.md) §1, §2, §6.1, §7. Built on Phase 2 ([`2026-11-14-savings-phase-2.md`](./2026-11-14-savings-phase-2.md)), coverage caveats ([`2026-11-15-savings-coverage-caveats.md`](./2026-11-15-savings-coverage-caveats.md)) and URDB estimates ([`2026-11-15-urdb-estimated-rate-plans.md`](./2026-11-15-urdb-estimated-rate-plans.md)). Mockups: [`savings-phase-3-roi-mockups.html`](./savings-phase-3-roi-mockups.html) (published as https://claude.ai/artifact/Q12KLonX5gaTEKd6S8Sc4Y).

**Base:** `main` at `edfc3342` (#380 merged).

## Decisions (owner, 2026-11-16, take precedence over the spec)

- **Estimates and coverage:** payback and break-even always show, with Phase 2's coverage line, estimated-share line and caveat buttons under them. The only hold-back: no break-even date while the last 12 cycles have fewer than **300** counted days (paid-to-date still shows).
- **Placement:** a new **Payback** section on Solar System, directly under Savings; a **System Costs** sheet edits the inputs. iOS only; no web UI (web savings needs the scenario port, already a follow-up).
- **Powerwall install date replaces Phase 2's "first day with battery flow" rule** when entered: it sets scenario 2's battery start and the Powerwall payback start. With none entered, the flow rule stays and pre-fills the form.

## Decisions (builder's, from spec §7 and §9)

- **Storage and transport:** table `SiteSystemCost`, one row per `(site_id, component)`. Costs ride in `SiteTariffsTimelineResponse.systemCosts`, so the timeline `ETag` and `LocalBillBuilder.timelineFingerprint` change with them and savings recompute (the Powerwall date changes scenario 2). Response stays `version: 2`.
- **Net cost** = `price − incentives − credit`, credit = `taxCreditPercent / 100 × max(0, price − incentives)`; `taxCreditPercent == nil` means the toggle is off. Stated in the form footer.
- **Credit pre-fill by install year** (editable): ≤ 2019 → 30; 2020–2021 → 26; 2022–2025 → 30; ≥ 2026 → off (the residential clean energy credit ended for expenditures after 2025). Spec's "30% default" holds for every year it existed at 30%.
- **Payback periods:** solar = sum over cycles of S4 − S3 from the cycle containing the solar install date; Powerwall = S3 − S1 from the cycle containing the Powerwall install date. The install cycle counts in full (netting is per cycle; splitting it would break the bill's rule). No solar install date → the site's install date.
- **Projection, per future billing cycle** (monthly steps from the cycle after the current one, horizon **30 years**): base = the same-position cycle among the last 12 (seasonality), each scaled up by `daysInCycle / daysWithData` to fill uncounted days; a cycle with 0 counted days uses the 12-cycle mean daily savings × its length. Then:
  - rates: × `(1 + g)^t`, `t` = years from now; `g` from `RateGrowth` (below);
  - solar part: × `(1 − d)^(age)/(1 − d)^(ageNow)`, `d` = Panel Health decline when `agingConfidence != nil`, `= clamp(−agingPercentPerYear, 0, 2) / 100`, else **0.005**;
  - Powerwall part: × `capacity(ageAt t) / capacity(ageNow)` with `capacity(a) = max(0.3, 1 − 0.03 a)`: linear from Tesla's Powerwall Limited Warranty (70% of energy capacity at 10 years). Assumes savings scale with capacity.
  - Break-even = first cycle whose cumulative paid-to-date + projected ≥ net cost; already ≥ → the historical cycle where it crossed ("Paid off around …"). Not within 30 years → `.notWithinHorizon`. Net cost ≤ 0 → `.noCost` (no line). Combined uses the sum of both streams against the sum of both net costs.
- **Rate growth:** hourly mean buy rate of the **actual** timeline (`RatePeriodResolver.period(at:)`, strict, skipping `.unknown`) for the last 365 days vs the 365 days starting at the first covered day; `g = (last / first)^(1 / years) − 1` with `years` = start-to-start gap. Fewer than **2** years between them, or either mean missing → `g = 0.03`, `isMeasured = false`. Clamp `g` to `[0, 0.10]`.
- **Season words:** Mar–May spring, Jun–Aug summer, Sep–Nov fall, Dec–Feb winter; December counts toward the next year (Dec 2029 → "winter 2030").

## Global Constraints

- Voice (`docs/voice-and-terms.md`): "rate plan", never "tariff"; "about" on every figure built on estimates or projection; title case buttons, sentence case body; curly `’`; no dashes as separators.
- Fixed copy (from the mockups; Task 7 may change it):
  - empty: `Enter what your system cost to see how much it has paid back and when it should pay for itself.` → `Enter System Costs`
  - headline: `Paid back about $9,050 of $26,250`; date: `Paid off around summer 2035`; component: `around spring 2031`, `about $7,840 of $16,100`, Powerwall adds `, since Mar 4, 2024`
  - hold-back: `We’ll estimate when it pays for itself once a full year of savings is counted (214 of 300 days so far).`
  - never: `not within 30 years`; Powerwall-only note: `At its current pace, your Powerwall won’t pay for itself within 30 years. Under full net metering a battery adds little to savings.`
  - assumptions: `Your usage stays like the last 12 months`; `Rates rise about 4.1% a year, the pace of your rate plans since 2019` (unmeasured: `Rates rise about 3% a year, a typical pace`); `Solar output falls about 0.6% a year, as Panel Health measured` (default: `Solar output falls about 0.5% a year, a typical rate`); `Powerwall capacity falls about 3% a year, in line with Tesla’s warranty (70% after 10 years)`
  - form footer: `Paying off a loan? Enter the total you’ll pay over the loan as the price. The tax credit is counted on the price after rebates. Everyone on this site sees these costs.`
- Cross-app contract: `tariff-contract.ts` ⇄ `MobileTariffs.swift` in the same PR; Swift decodes `systemCosts` with `decodeIfPresent` (existing fixtures keep decoding).
- Server: Vercel Hobby 60 s; no cron; new table enables RLS, revokes `PUBLIC, anon, authenticated`, grants `service_role` (copy the header of `20261114123925_tariff_reference_periods.sql`). Storage: two rows per site, under 200 bytes each.
- iOS: beta, no compatibility shims; Swift Testing; TDD; `./generate.sh` after adding files; `./lint.sh` (swiftformat `--lint`, swiftlint `--strict`) and `./run-tests.sh` with zero warnings. The three-year benchmark (`Three synthetic years compute under 5 seconds`) must still pass with rate growth included.
- Pure logic in `SavingsCalculator`, `RateGrowth`, `PaybackCalculator`, `PaybackPresentation`; views render and route only.
- Live checks: Harrison site only.

## Review Focus

1. **Install date after every stored day** (owner typed a future date, or a date past the last synced day): paid-to-date is $0 with no crash, projection still runs from the last 12 cycles' component savings. → Task 3 `componentStartAfterLastDayGivesZeroFigures`.
2. **Negative or zero yearly savings** (Powerwall under full net metering; S3 − S1 < 0): never a break-even date, `.notWithinHorizon`, and no infinite loop. → Task 5 `negativeSavingsNeverBreakEven`.
3. **Incentives larger than the price or price 0:** net cost ≤ 0 shows no break-even line and no division by zero in the progress bar. → Task 5 `zeroNetCostHasNoBreakEven`; server Task 1 rejects `incentives > price`.
4. **A site with no Powerwall** (`battery == nil`, no battery flows, no Powerwall row): form hides the Powerwall group; combined equals solar. → Task 5 `solarOnlyCombinedEqualsSolar`, Task 8 `formOmitsPowerwallWithoutBattery`.
5. **A billing-day change or a cycle with zero counted days inside the last 12:** base cycle uses the mean daily rate, no NaN. → Task 5 `emptyBaseCycleUsesMeanDailySavings`.

---

### Task 1: Server — `SiteSystemCost` storage, `systemCosts` in the timeline, `PUT /api/site/{id}/system-costs`

**Files:**
- Create: `cmd/next-app/db-migrations/<timestamp>_site_system_costs.sql` (`npm run create-migration -- site_system_costs` if present)
- Create: `cmd/next-app/src/lib/system-costs.ts` (+ `system-costs.test.ts`): validation and row ⇄ DTO mapping
- Create: `cmd/next-app/src/app/api/site/[id]/system-costs/route.ts` (+ `route.test.ts`)
- Modify: `cmd/next-app/src/lib/tariff-contract.ts`, `cmd/next-app/src/lib/tariff-timeline-repo.ts` (`buildSiteTariffsTimelineResponse`, `getTimeline`), `cmd/next-app/src/lib/tariff-timeline-repo.test.ts`

**Interfaces:**
- Produces (SQL): `"SiteSystemCost"(site_id TEXT FK Site ON DELETE CASCADE, component TEXT CHECK (component IN ('solar','powerwall')), install_date DATE NULL, price NUMERIC(12,2) NOT NULL CHECK (price >= 0), tax_credit_percent NUMERIC(5,2) NULL CHECK (tax_credit_percent BETWEEN 0 AND 100), incentives NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (incentives >= 0), updated_by_user_id TEXT NULL FK User ON DELETE SET NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (site_id, component))`.
- Produces (wire):
  ```ts
  export interface SystemCostDTO { installDate: string | null; price: number; taxCreditPercent: number | null; incentives: number }
  export interface SystemCostsDTO { siteInstalled: string; solar: SystemCostDTO | null; powerwall: SystemCostDTO | null }
  // SiteTariffsTimelineResponse.systemCosts: SystemCostsDTO
  ```
  `siteInstalled` = `Site.installed` as site-local `YYYY-MM-DD`.
- Produces (lib): `parseSystemCostsInput(body: unknown): { solar: SystemCostDTO | null; powerwall: SystemCostDTO | null }` throwing `TariffValidationError` (reuse the class so the route maps it to 400). Rules: `price` finite, 0 ≤ price ≤ 1,000,000; `incentives` 0 ≤ incentives ≤ price; `taxCreditPercent` null or 0–100; `installDate` null or a real `YYYY-MM-DD` between `2000-01-01` and today + 1 day. `null` component → delete that row.
- Produces (repo): `TariffTimelineRepo.saveSystemCosts(siteId, userId, input) : Promise<SiteTariffsTimelineResponse>` (upsert/delete in one transaction; no re-attribution).
- Produces (HTTP): `PUT /api/site/{id}/system-costs`, auth exactly as `POST /api/site/[id]/tariffs/reference` (`isCrossOriginRequest` → 403, `getCurrentUser` + `verifySiteAccess` → 401), returns `jsonWithETag(timeline)`.

- [ ] **Step 1: Write failing tests.** `system-costs.test.ts`: `accepts a full solar and powerwall input`, `rejects incentives above price`, `rejects a future install date`, `null component means delete`. `tariff-timeline-repo.test.ts`: `includes system costs and the site install date` (row with price `"24000.00"` → `24000`; installed `2023-11-14T08:00Z`, zone `America/Los_Angeles` → `"2023-11-14"`), `system costs default to null components`. `route.test.ts`: `saves costs and returns the timeline`, `rejects unauthorised sites` (401), `rejects cross-origin` (403), `maps validation errors to 400`.
- [ ] **Step 2: Run** `npx vitest run src/lib/system-costs.test.ts src/lib/tariff-timeline-repo.test.ts src/app/api/site/[id]/system-costs` — FAIL.
- [ ] **Step 3: Implement** migration, lib, repo method, route and the response field. Map `NUMERIC` strings with `Number(...)`.
- [ ] **Step 4: Run** the tests, `npm run lint`, `npm run typecheck`, `npx vitest run` — PASS.
- [ ] **Step 5: Commit** `feat(api): store system costs per site and send them with the rate plan timeline`.

### Task 2: iOS — decode `systemCosts`, save call, coordinator and demo

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift`, `cmd/ios-app/PWUsage/Networking/PWUsageAPI+Tariffs.swift`, `cmd/ios-app/PWUsage/Models/DashboardContracts.swift`, `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+Savings.swift`, `cmd/ios-app/PWUsage/Demo/DemoAPI.swift`, `cmd/ios-app/PWUsage/State/Bill/LocalBillBuilder.swift` (`timelineFingerprint` covers `systemCosts`)
- Test: `cmd/ios-app/PWUsageTests/MobileTariffsDecodingTests.swift` (or the existing timeline decoding suite), `cmd/ios-app/PWUsageTests/LocalBillBuilderTests.swift`

**Interfaces:**
- Consumes: Task 1 wire shape (same PR).
- Produces:
  ```swift
  struct SystemCostDTO: Codable, Equatable, Sendable { var installDate: String?; var price: Double; var taxCreditPercent: Double?; var incentives: Double }
  struct SystemCostsDTO: Codable, Equatable, Sendable { let siteInstalled: String; var solar: SystemCostDTO?; var powerwall: SystemCostDTO? }
  // SiteTariffsTimelineResponse.systemCosts: SystemCostsDTO?  (decodeIfPresent)
  struct SystemCostsWriteRequest: Encodable, Sendable { let solar: SystemCostDTO?; let powerwall: SystemCostDTO? }
  // API + protocol: func saveSystemCosts(siteID: String, body: SystemCostsWriteRequest) async throws -> SiteTariffsTimelineResponse
  // DashboardCoordinator: func saveSystemCosts(_ request: SystemCostsWriteRequest) async -> String?  // error message, nil on success; stores the returned timeline in savingsTimeline and refreshes savings
  ```
  `SystemCostDTO.price` etc. encode `null` explicitly for nil optionals (the server distinguishes null from missing only at the component level, so either is fine; be consistent with `TariffPlanWriteRequest`).

- [ ] **Step 1: Write failing tests:** `decodesSystemCosts`, `decodesTimelineWithoutSystemCosts` (existing fixture → `nil`), `encodesSystemCostsWriteRequest` (nil powerwall → `"powerwall":null`), `fingerprintChangesWhenSystemCostsChange`.
- [ ] **Step 2: Run** `./run-tests.sh --quick <those suites>` — FAIL.
- [ ] **Step 3: Implement.** `DemoAPI.saveSystemCosts` returns its timeline with the request applied, in memory only.
- [ ] **Step 4: Run** the suites and `./lint.sh` — PASS.
- [ ] **Step 5: Commit** `feat(ios): decode and save system costs`. **Tasks 1–2 ship as PR 1.**

### Task 3: iOS — Powerwall start override and per-component figures in `SavingsCalculator`

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/Savings/SavingsScenarioFlows.swift`, `cmd/ios-app/PWUsage/Models/Savings/SavingsCalculator.swift`, `cmd/ios-app/PWUsage/State/Savings/SavingsModel.swift` (pass the new inputs; `ComputeReport` signature)
- Test: `cmd/ios-app/PWUsageTests/SavingsScenarioFlowsTests.swift`, `cmd/ios-app/PWUsageTests/SavingsCalculatorTests.swift`, `cmd/ios-app/PWUsageTests/SavingsModelTests.swift`

**Interfaces:**
- Consumes: Task 2 `SystemCostsDTO`.
- Produces:
  ```swift
  // SavingsScenarioFlows.build(days:battery:batteryStartOverride: String? = nil, roundTripEfficiency:)
  //   override (YYYY-MM-DD) replaces the first-flow day; days before it get S2 = S3; batteryStartDay reports the day used.
  struct ComponentStarts: Equatable, Sendable { let solar: Date?; let powerwall: Date? }  // site-local midnights
  struct CycleSavings: Equatable, Sendable { let start: Date; let end: Date; let costs: ScenarioCosts; let daysWithData: Int; let daysInCycle: Int }
  // SavingsReport gains:
  //   let solarSinceInstall: SavingsFigures        // cycles from the one containing starts.solar (or first stored day)
  //   let powerwallSinceInstall: SavingsFigures?    // nil when there is no Powerwall start
  //   let recentCycles: [CycleSavings]              // the last 12 cycles, oldest first (== year)
  // SavingsCalculator.compute(scenarios:actual:reference:billingDay:now:starts: ComponentStarts)
  ```
  `SavingsModel` derives `ComponentStarts` from `timeline.systemCosts` (solar: `solar?.installDate ?? siteInstalled`; powerwall: `powerwall?.installDate ?? scenarios.batteryStartDay`, nil when both nil) and passes `systemCosts?.powerwall?.installDate` as `batteryStartOverride`.

- [ ] **Step 1: Write failing tests:** flows › `batteryStartOverrideReplacesFirstFlowDay`, `overrideBeforeFirstFlowStartsSimulationEarlier`; calculator › `solarSinceInstallStartsAtInstallCycle` (install mid-cycle: that cycle counts in full, earlier cycles don't), `powerwallSinceInstallUsesScenarioThreeMinusOne`, `componentStartAfterLastDayGivesZeroFigures`, `recentCyclesAreLastTwelveOldestFirst`; model › `powerwallInstallDateFeedsScenarioStart`.
- [ ] **Step 2: Run** `./run-tests.sh --quick SavingsScenarioFlowsTests SavingsCalculatorTests SavingsModelTests` — FAIL.
- [ ] **Step 3: Implement.** Reuse `makeFigures` over the cycle-result slice so coverage gaps and `estimatedDays` come out the same way as the other periods.
- [ ] **Step 4: Run** the suites and the three-year benchmark — PASS; `./lint.sh` clean.
- [ ] **Step 5: Commit** `feat(ios): per-component savings since install and owner-entered Powerwall start`.

### Task 4: iOS — `RateGrowth` from the actual timeline

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Savings/RateGrowth.swift`
- Modify: `cmd/ios-app/PWUsage/Models/Savings/SavingsCalculator.swift` (add `let rateGrowth: RateGrowth` to `SavingsReport`, measured from `actual` and the first stored day)
- Test: `cmd/ios-app/PWUsageTests/RateGrowthTests.swift`

**Interfaces:**
- Consumes: `RatePeriodResolver.matchedPeriod(at:strict:)` / `period(at:)`.
- Produces:
  ```swift
  struct RateGrowth: Equatable, Sendable {
      let annualRate: Double        // 0.0 ... 0.10
      let isMeasured: Bool
      let measuredSince: String?    // YYYY-MM-DD of the first covered day, when measured
      static let typical = RateGrowth(annualRate: 0.03, isMeasured: false, measuredSince: nil)
      static func measure(actual: RatePeriodResolver, firstDay: Date, now: Date) -> RateGrowth
  }
  ```

- [ ] **Step 1: Write failing tests:** `twoPlansFourYearsApartGiveCompoundRate` (flat 0.20 from 2020-01-01, flat 0.2431 from 2024-01-01, now 2025-01-01 → `annualRate ≈ 0.0499 ± 0.0005`, `isMeasured`, `measuredSince == "2020-01-01"`), `underTwoYearsUsesTypical`, `fallingRatesClampToZero`, `unknownHoursAreSkipped` (a hole in the timeline doesn't drag the mean to 0), `timeOfUseMeanWeighsHours` (0.40 for 5 h/day, 0.20 otherwise → mean 0.2417).
- [ ] **Step 2: Run** `./run-tests.sh --quick RateGrowthTests` — FAIL.
- [ ] **Step 3: Implement** with hourly samples at `hh:30` site-local (≈ 17.5k resolver calls per site; well inside the benchmark).
- [ ] **Step 4: Run** — PASS; benchmark still under 5 s; `./lint.sh` clean.
- [ ] **Step 5: Commit** `feat(ios): measure the yearly rate rise from the rate plan timeline`.

### Task 5: iOS — `PaybackCalculator`

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Savings/PaybackCalculator.swift`
- Test: `cmd/ios-app/PWUsageTests/PaybackCalculatorTests.swift`

**Interfaces:**
- Consumes: Task 3 `SavingsReport` (`solarSinceInstall`, `powerwallSinceInstall`, `recentCycles`, `year`), Task 4 `RateGrowth`, Task 2 `SystemCostsDTO`, `SolarHealthReport.ChangeOverTime?`.
- Produces:
  ```swift
  enum SystemComponent: String, Sendable { case solar, powerwall }
  enum BreakEven: Equatable, Sendable {
      case paidOff(month: Date)          // site-local first of the month it crossed
      case projected(month: Date)
      case notWithinHorizon
      case needsFullYear(countedDays: Int)   // year.daysWithData < 300
      case noCost
  }
  struct ComponentPayback: Equatable, Sendable { let component: SystemComponent; let netCost: Double; let paidToDate: Double; let since: String; let breakEven: BreakEven }
  struct PaybackAssumptions: Equatable, Sendable { let rateGrowth: RateGrowth; let solarDecline: Double; let solarDeclineMeasured: Bool; let batteryFadePerYear: Double? }
  struct PaybackResult: Equatable, Sendable { let components: [ComponentPayback]; let combined: ComponentPayback?; let assumptions: PaybackAssumptions; let coverage: SavingsFigures }
  enum PaybackCalculator {
      static let minimumCountedDays = 300
      static let horizonYears = 30
      static let defaultSolarDecline = 0.005
      static let batteryFadePerYear = 0.03
      static func netCost(_ cost: SystemCostDTO) -> Double
      static func defaultTaxCreditPercent(installYear: Int) -> Double?
      static func solarDecline(_ change: SolarHealthReport.ChangeOverTime?) -> (rate: Double, measured: Bool)
      static func compute(report: SavingsReport, costs: SystemCostsDTO, change: SolarHealthReport.ChangeOverTime?,
                          timeZone: TimeZone, now: Date) -> PaybackResult?   // nil when no component has a cost row
  }
  ```
  `combined` is nil when only one component has a cost; its `since` is the earlier start. `coverage` = `solarSinceInstall` (for the coverage/estimate/caveat lines). Algorithm per "Decisions (builder's)".

- [ ] **Step 1: Write failing tests:**
  - `netCostTakesCreditAfterIncentives` (24,000, 30%, 1,000 → 16,100); `creditOffMeansNoCredit`; `defaultCreditByInstallYear` (2019 → 30, 2021 → 26, 2023 → 30, 2026 → nil);
  - `solarDeclineUsesConfidentMeasurement` (−0.6, `.confident` → 0.006, measured), `solarDeclineFallsBackWithoutConfidence` (→ 0.005), `improvingOutputClampsToZero`;
  - `flatSavingsBreakEvenMonth` (12 cycles of $100 S4−S3, g 0, d 0, net 3,000, paid 600 → 24 cycles after the current → that month);
  - `paidOffReportsCrossingCycle`, `rateGrowthShortensPayback`, `batteryFadeLengthensPowerwallPayback`;
  - `negativeSavingsNeverBreakEven`, `zeroNetCostHasNoBreakEven`, `fewerThan300DaysNeedsFullYear` (paid-to-date still set), `solarOnlyCombinedEqualsSolar` (combined nil, single component), `emptyBaseCycleUsesMeanDailySavings`.
- [ ] **Step 2: Run** `./run-tests.sh --quick PaybackCalculatorTests` — FAIL.
- [ ] **Step 3: Implement.** Iterate future cycles with `BillingCycle` dates; stop at the first crossing or the horizon (at most 360 steps).
- [ ] **Step 4: Run** — PASS; `./lint.sh` clean.
- [ ] **Step 5: Commit** `feat(ios): payback to date and break-even projection`.

### Task 6: iOS — `PaybackPresentation`

**Files:**
- Create: `cmd/ios-app/PWUsage/Views/Shared/PaybackPresentation.swift`
- Test: `cmd/ios-app/PWUsageTests/PaybackPresentationTests.swift`

**Interfaces:**
- Consumes: Task 5 types; `SavingsPresentation.aboutAmount`, `coverageLine`, `estimatedShareLine`, `caveats`; `RatePlanTimelineFormatting.displayDate`.
- Produces: `PaybackPresentation.headline(_:currency:) -> String`, `breakEvenLine(_: BreakEven, timeZone:) -> String?`, `componentLines(_: ComponentPayback, currency:, timeZone:) -> (title: String, amount: String, when: String?)`, `assumptionLines(_: PaybackAssumptions, hasPowerwall: Bool) -> [String]`, `seasonText(month: Date, timeZone:) -> String` (`"spring 2031"`), `progress(_: ComponentPayback) -> Double` (0…1, 0 when net cost ≤ 0), `powerwallNeverNote(_: PaybackResult) -> String?`. Copy exactly as Global Constraints.

- [ ] **Step 1: Write failing tests:** `headlineMatchesCopy`, `seasonTextMapsMonths` (Mar → spring, Dec 2029 → `winter 2030`, Feb 2030 → `winter 2030`), `breakEvenLinesForEachCase`, `assumptionLinesMeasuredAndDefault`, `progressClampsAndHandlesZeroCost`, `holdBackLineShowsCountedDays`.
- [ ] **Step 2: Run** `./run-tests.sh --quick PaybackPresentationTests` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `./lint.sh` clean.
- [ ] **Step 5: Commit** `feat(ios): payback copy`.

### Task 7: Mockups (gate for Task 8)

- [x] **Step 1:** Published https://claude.ai/artifact/Q12KLonX5gaTEKd6S8Sc4Y (source [`savings-phase-3-roi-mockups.html`](./savings-phase-3-roi-mockups.html)): empty, main, System Costs sheet, under a year, paid off / never.
- [ ] **Step 2:** The owner approves or edits them. **Task 8 does not start until they approve.** Record copy or layout changes here and in Global Constraints before Task 8.

### Task 8: iOS — System Costs sheet and Payback section

**Files:**
- Create: `cmd/ios-app/PWUsage/Views/SolarSystem/SystemCostsForm.swift`, `cmd/ios-app/PWUsage/Views/SolarSystem/SolarSystemPaybackSection.swift`
- Modify: `cmd/ios-app/PWUsage/Views/SolarSystem/SolarSystemView.swift` (section under `SolarSystemSavingsSection`; new `savingsSheet` case `.systemCosts`)
- Test: `cmd/ios-app/PWUsageTests/SystemCostsDraftTests.swift`

**Interfaces:**
- Consumes: Tasks 2, 5, 6; `coordinator.savings`, `coordinator.savingsTimeline?.systemCosts`, `coordinator.savingsTimeline?.battery`, `solarHealth?.report?.changeOverTime`.
- Produces: `struct SystemCostsDraft` (pure, in `SystemCostsForm.swift`): `init(costs: SystemCostsDTO?, batteryStartDay: String?, hasPowerwall: Bool, timeZone: TimeZone)`, `var request: SystemCostsWriteRequest?` (nil while invalid), `var solarNetCost: Double?`, `var powerwallNetCost: Double?`; changing an install date re-applies `defaultTaxCreditPercent` only while the owner hasn't touched the credit. `hasPowerwall` = `battery != nil || batteryStartDay != nil || costs?.powerwall != nil`.
- The section renders: `.notReady` savings → nothing (Savings section already explains); no cost rows → empty state; otherwise `PaybackCalculator.compute` (cheap; in the view body is fine, or memoised on the report) and the mockup B/D/E layouts; caveat rows via `SavingsCaveatRows` with the existing `routeCaveat`.

- [ ] **Step 1: Write failing tests:** `draftPrefillsSiteInstallAndBatteryStart`, `draftPrefillsCreditFromInstallYear`, `editedCreditSurvivesDateChange`, `draftRejectsIncentivesAbovePrice`, `formOmitsPowerwallWithoutBattery`, `draftBuildsRequestWithNullForRemovedComponent`.
- [ ] **Step 2: Run** `./run-tests.sh --quick SystemCostsDraftTests` — FAIL.
- [ ] **Step 3: Implement** the sheet and section per the approved mockups (currency fields with the locale's formatter, `DatePicker` with `in: ...today`, the footer copy).
- [ ] **Step 4: Run** `./run-tests.sh` (full) and `./lint.sh` — PASS, zero warnings. Check light/dark and Dynamic Type in the simulator; with the Harrison site on beta, save costs, kill and relaunch, and confirm they persist and a second account on the site sees them.
- [ ] **Step 5: Commit** `feat(ios): system costs and payback on Solar System`. **Tasks 3–8 ship as PR 2.**
