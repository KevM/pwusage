# Savings (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The iOS app shows how much the owner's system saved, for the billing cycle, the year and its lifetime, split into solar and "Powerwall and your rate plan", by pricing four scenarios over the stored 5-minute flows.

**Architecture:** The server stores a second, owner-entered **reference fixed-rate timeline** in its own table (so no existing rate plan query changes) and sends it, plus the Powerwall's size and backup reserve, in the existing timeline response. The phone derives each scenario's per-slot grid series from the recorded flows (scenario 2 by a battery simulation), prices every scenario per billing cycle through the Phase 1 engine (`BillUsageAggregator` + `BillPricing`), and sums cycles into the three periods. The screens are settled with mockups before the UI task starts.

**Tech Stack:** Next.js App Router + `pg` + vitest (`cmd/next-app`); Swift 6, SwiftUI, Swift Testing, XcodeGen (`cmd/ios-app`).

**Spec:** [`docs/superpowers/specs/2026-11-13-savings-and-roi-design.md`](../specs/2026-11-13-savings-and-roi-design.md) §4.2, §6. Phase 1 plan: [`2026-11-14-on-device-bill-pricing.md`](./2026-11-14-on-device-bill-pricing.md).

## Scope and decisions beyond the spec

- **URDB is a separate plan.** Spec §4.3 (utility picker, matching the Tesla plan to a URDB revision, auto-built estimated and reference plans, the "Time of Use required for solar" rule list) is independent of the savings arithmetic and gets its own plan. Here the reference timeline is **owner-entered only**. Until the URDB plan lands, a site without a reference plan shows the bill but no savings, with a prompt to add the fixed rate plan the owner would be on without solar.
- **Reference timeline storage:** a sibling table `TariffReferencePeriod` with the same shape as `TariffEffectivePeriod`, pointing at ordinary `Tariff` rows (`source = 'manual'`, `is_current = false`). Editing it never queues re-attribution and never feeds `Schedule`, server attribution, the web app or TRMNL. Reference `Tariff` rows only reach the id → name maps (`TariffRepo.getTariffsForSite`), which is harmless. Append-only `Tariff` rule holds: edits create a new `Tariff` and move spans, as `createManualPeriod`/`updatePeriod` do.
- **Powerwall present from:** the first stored day with any slot where `|batteryWh| > 1`. Before that day scenario 2 equals scenario 3 (spec §6.1 "Before the Powerwall's install date"). Phase 3's owner-entered battery install date replaces this later.
- **Battery model** (spec §6.1, details are the builder's): usable capacity `nameplate_energy`; charge and discharge each limited to `nameplate_power × 5/60` Wh per slot; the 90% round-trip loss applied on charge (stored = charged × 0.9); the backup reserve (`backup_reserve_percent` of capacity) never discharged; charge only from solar surplus; discharge only to cover load; state of charge starts at the reserve on the first battery day and carries across days and gaps.
- **Periods:** cycle = the current billing cycle; year = the 12 billing cycles ending with the current one; lifetime = every cycle with stored flows. Netting stays per billing cycle (the bill's rule), so a period's figure is the sum of its cycles' figures.

## Global Constraints

- Voice: "rate plan", never "tariff"; "Time of Use" only on explainer surfaces; every savings figure says "about" (`docs/voice-and-terms.md`).
- Copy fixed by the spec: headline `Your system saved about $142 this month`; breakdown `Solar about $96 · Powerwall and your rate plan about $46`; fixed-rate comparison `On a fixed rate plan, your system would have saved about $…`; coverage `Based on 2,914 of 2,950 days`.
- Scenario arithmetic: headline = S4 − S1; solar = S4 − S3; Powerwall and your rate plan = S3 − S1; fixed-rate comparison = S4 − S2 (system) and S4 − S3 (solar alone).
- Defaults: round-trip efficiency `0.9`; slot length `300` s; battery-present threshold `1` Wh.
- Cross-app contract: `SiteTariffsTimelineResponse` changes land on both sides in the same PR; response stays `version: 2`; the app is in beta, so new fields are added in place (Swift decodes `referencePeriods` as `[]` and `battery` as `nil` when absent, so existing JSON fixtures keep decoding).
- Server: Vercel Hobby 60 s; new tables enable RLS, revoke `PUBLIC, anon, authenticated`, grant `service_role` (see the migration header template).
- iOS CI: `./lint.sh` clean (swiftformat `--lint`, swiftlint `--strict`), zero compiler warnings, Swift Testing. Iterate with `./run-tests.sh --quick <Suites>`, finish with `./run-tests.sh`.
- Web CI: `npm run lint`, `npm run typecheck`, vitest.

## Review Focus

1. **A cycle where the recorded bill is a net credit** (S1 < 0): savings S4 − S1 exceed S4's cost and must still show, not clamp. → Task 5 `savingsCanExceedNoSolarCostWhenBillIsCredit`.
2. **A site with no Powerwall** (`battery` nil or capacity 0, or no battery flows): S2 = S3 and "Powerwall and your rate plan" is only the plan difference. → Task 4 `noBatteryMakesScenarioTwoEqualThree`.
3. **A reference plan starting after the history start:** earlier days fall back to the earliest reference plan, matching `period(on:)`. → Task 3 `referenceResolverUsesEarliestPlanBeforeItsStart`.
4. **Slots with recorded grid but no solar** (night, gaps): solar counts as 0; slots with no recorded grid are skipped in every scenario, so all four cover the same slots as the bill. → Task 4 `scenariosCoverOnlyRecordedGridSlots`.
5. **DST days (276/300 slots) and gaps inside the battery run:** state of charge carries across them without jumping. → Task 4 `batteryStateCarriesAcrossDstAndGaps`.

---

### Task 1: Server — reference timeline storage and timeline response fields

**Files:**
- Create: `cmd/next-app/db-migrations/<timestamp>_tariff_reference_periods.sql` (use the repo's migration generator if present, else the existing header)
- Modify: `cmd/next-app/src/lib/tariff-contract.ts`, `cmd/next-app/src/lib/tariff-timeline-repo.ts` (`getTimeline`, `buildSiteTariffsTimelineResponse`)
- Test: `cmd/next-app/src/lib/tariff-timeline-repo.test.ts`, `cmd/next-app/src/lib/tariff-timeline-repo-postgres.test.ts`, `cmd/next-app/src/app/api/site/[id]/tariffs/route.test.ts`

**Interfaces:**
- Produces (SQL): `"TariffReferencePeriod"(id SERIAL PK, site_id TEXT FK Site ON DELETE CASCADE, tariff_id INTEGER FK Tariff ON DELETE CASCADE, effective_from DATE NOT NULL, effective_to DATE, updated_by_user_id TEXT FK User ON DELETE SET NULL, created_at TIMESTAMPTZ DEFAULT now())`, the same date check, index and gist no-overlap exclusion per `site_id` as `TariffEffectivePeriod`.
- Produces (wire): `SiteTariffsTimelineResponse.referencePeriods: TariffPeriodDTO[]` (same DTO; `source: 'manual'`; ordered by `effectiveFrom`), and `battery: { nameplateEnergyWh: number; nameplatePowerW: number; backupReservePercent: number } | null` read from `Site.json` (`nameplate_energy`, `nameplate_power`, `backup_reserve_percent`; null when energy is missing or 0).
- The timeline `ETag` (Phase 1) already hashes the body, so reference edits change it.

- [ ] **Step 1: Write failing tests.** `buildSiteTariffsTimelineResponse` › `includes reference periods ordered by start` and `maps battery fields from site json` (energy 13500, power 5000, reserve 20 → `{ nameplateEnergyWh: 13500, nameplatePowerW: 5000, backupReservePercent: 20 }`; missing energy → `null`). Postgres repo test › `reference periods never change the actual timeline` (a reference span overlapping a Tesla span is accepted; `resolveTariffForDate` still returns the Tesla tariff).
- [ ] **Step 2: Run** `npx vitest run src/lib/tariff-timeline-repo.test.ts src/lib/tariff-timeline-repo-postgres.test.ts` — FAIL.
- [ ] **Step 3: Implement** the migration and the two response fields. Reference rows load with the same seasons decompile path as actual periods.
- [ ] **Step 4: Run** the tests, `npm run lint`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(api): reference fixed-rate timeline and battery size in the rate plan timeline`.

### Task 2: Server — reference plan write endpoints

**Files:**
- Create: `cmd/next-app/src/app/api/site/[id]/tariffs/reference/route.ts` (+ `route.test.ts`), `cmd/next-app/src/app/api/site/[id]/tariffs/reference/[periodId]/route.ts` (+ `route.test.ts`)
- Modify: `cmd/next-app/src/lib/tariff-timeline-repo.ts`

**Interfaces:**
- Consumes: Task 1 table and response.
- Produces (repo): `createReferencePeriod(siteId, userId, input: TariffPlanWriteInput)`, `updateReferencePeriod(siteId, userId, periodId, patch)`, `deleteReferencePeriod(siteId, periodId)`, each returning `SiteTariffsTimelineResponse`. They reuse `validateTariffPlanInput`, `compileSeasonsToParsedTariff`, `insertTariffGraph` (with `is_current = false`) and `computeSpanMutations` against reference spans; they **never** call the re-attribution enqueue or `recomputeIsCurrentTariff`.
- Produces (HTTP): `POST /api/site/{id}/tariffs/reference`, `PATCH|DELETE /api/site/{id}/tariffs/reference/{periodId}`; auth exactly as `POST /api/site/{id}/tariffs` (`getCurrentUser` + `verifySiteAccess`); same error mapping; body shapes match the existing create/patch routes.

- [ ] **Step 1: Write failing tests:** `creates a reference plan without queuing re-attribution`, `rejects unauthorised sites`, `updates and deletes a reference period`, `a reference edit leaves the site's current Tesla plan current`.
- [ ] **Step 2: Run** the route tests — FAIL.
- [ ] **Step 3: Implement.** Extract shared span logic only where both callers use it unchanged; otherwise call the existing helpers.
- [ ] **Step 4: Run** tests, lint, typecheck — PASS.
- [ ] **Step 5: Commit** `feat(api): owner-entered reference fixed-rate plans`.

### Task 3: iOS — decode the reference timeline and battery; reference resolver; API calls

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift`, `cmd/ios-app/PWUsage/Models/Bill/Pricing/RatePeriodResolver.swift`, `cmd/ios-app/PWUsage/Networking/PWUsageAPI+Tariffs.swift`, `cmd/ios-app/PWUsage/Models/DashboardContracts.swift` (protocol), `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+Tariffs.swift`, `cmd/ios-app/PWUsage/Demo/DemoAPI.swift`, `cmd/ios-app/PWUsage/State/Bill/LocalBillBuilder.swift` (`timelineFingerprint` covers reference periods and battery)
- Test: `cmd/ios-app/PWUsageTests/RatePeriodResolverTests.swift` (or the existing resolver suite), `cmd/ios-app/PWUsageTests/MobileTariffsDecodingTests.swift` (or existing)

**Interfaces:**
- Produces: `SiteTariffsTimelineResponse.referencePeriods: [TariffPeriodDTO]` (decoded with `decodeIfPresent ?? []`), `battery: SiteBatteryDTO?` with `nameplateEnergyWh: Double`, `nameplatePowerW: Double`, `backupReservePercent: Double`.
- Produces: `RatePeriodResolver.init?(referenceOf timeline: SiteTariffsTimelineResponse)` — `nil` when `referencePeriods` is empty; same zone, holidays and plan choice rules as `init?(timeline:)`.
- Produces: `createReferenceRatePlan(siteID:body: TariffPlanWriteRequest)`, `updateReferenceRatePlan(siteID:periodID:body: TariffPlanPatchRequest)`, `deleteReferenceRatePlan(siteID:periodID:)` on the API (all `-> SiteTariffsTimelineResponse`) and matching coordinator methods that save the returned timeline like the existing mutations.

- [ ] **Step 1: Write failing tests:** `decodesReferencePeriodsAndBattery`, `decodesTimelineWithoutReferenceFields` (existing fixture JSON → `[]`, `nil`), `referenceResolverPricesFromReferencePlans`, `referenceResolverUsesEarliestPlanBeforeItsStart`, `fingerprintChangesWhenReferencePlanChanges`.
- [ ] **Step 2: Run** `./run-tests.sh --quick <those suites>` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suites and `./lint.sh` — PASS.
- [ ] **Step 5: Commit** `feat(ios): reference rate plan timeline and Powerwall size`.

### Task 4: iOS — scenario flows (solar alone, no solar, battery simulation)

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Savings/SavingsScenarioFlows.swift`
- Test: `cmd/ios-app/PWUsageTests/SavingsScenarioFlowsTests.swift`

**Interfaces:**
- Consumes: `EnergyFlowDay` (Phase 1), `SiteBatteryDTO` (Task 3).
- Produces:
  ```swift
  struct SavingsScenarioDays: Sendable {
      let recorded: [EnergyFlowDay]        // S1, unchanged
      let batteryFixed: [EnergyFlowDay]    // S2, gridWh replaced
      let solarAlone: [EnergyFlowDay]      // S3, gridWh replaced
      let noSolar: [EnergyFlowDay]         // S4, gridWh replaced
      let batteryStartDay: String?         // first day with |batteryWh| > 1, nil = no Powerwall
  }
  enum SavingsScenarioFlows {
      static func build(days: [EnergyFlowDay], battery: SiteBatteryDTO?, roundTripEfficiency: Double = 0.9) -> SavingsScenarioDays
  }
  ```
- Per slot, only where recorded `gridWh` and `loadWh` are non-nil (others stay nil in every scenario); solar nil counts as 0. S3 grid = load − solar. S4 grid = load. S2 follows the battery model in "Scope and decisions" (grid = load − solar + charged − discharged); before `batteryStartDay`, or with no battery, S2 = S3.

- [ ] **Step 1: Write failing tests:** `solarAloneIsLoadMinusSolar`, `noSolarImportsAllLoad`, `batteryChargesFromSurplusAndCoversEvening` (capacity 13,500 Wh, power 5,000 W, reserve 20% = 2,700 Wh, state starts at 2,700 Wh; 12 midday slots of 250 Wh surplus → S2 grid 0 in each and 2,700 Wh stored, state 5,400 Wh; then 8 evening slots of 250 Wh load, no solar → S2 grid 0 in each, state 3,400 Wh; a 9th slot that would take state below 2,700 Wh imports the shortfall), `batteryNeverDischargesBelowReserve`, `batteryRespectsPowerLimitPerSlot`, `energyBalancesEverySlot` (load = solar + grid + discharged − charged within 1e-9), `noBatteryMakesScenarioTwoEqualThree`, `scenariosCoverOnlyRecordedGridSlots`, `batteryStateCarriesAcrossDstAndGaps`, `daysBeforeBatteryStartMatchSolarAlone`.
- [ ] **Step 2: Run** `./run-tests.sh --quick SavingsScenarioFlowsTests` — FAIL.
- [ ] **Step 3: Implement** as a single pass over days sorted by `dayStart`.
- [ ] **Step 4: Run** — PASS; `./lint.sh` clean.
- [ ] **Step 5: Commit** `feat(ios): savings scenario flows with a solar-only Powerwall simulation`.

### Task 5: iOS — scenario pricing per billing cycle and the savings report

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Savings/SavingsCalculator.swift`
- Modify (if needed): `cmd/ios-app/PWUsage/Models/Bill/Pricing/BillingCycle.swift` (`cycles(billingDay:from:through:timeZone:) -> [(start: Date, end: Date)]`)
- Test: `cmd/ios-app/PWUsageTests/SavingsCalculatorTests.swift`, `cmd/ios-app/PWUsageTests/BillingCycleTests.swift`

**Interfaces:**
- Consumes: Task 4 `SavingsScenarioDays`; Phase 1 `BillUsageAggregator.buckets(days:from:to:resolver:)`, `BillPricing.costs(_:)`; Task 3 resolvers.
- Produces:
  ```swift
  struct ScenarioCosts: Equatable, Sendable { let recorded, batteryFixed, solarAlone, noSolar: Double }
  struct SavingsFigures: Equatable, Sendable {
      let costs: ScenarioCosts
      var total: Double { costs.noSolar - costs.recorded }
      var solar: Double { costs.noSolar - costs.solarAlone }
      var powerwallAndRatePlan: Double { costs.solarAlone - costs.recorded }
      var fixedRateSystem: Double { costs.noSolar - costs.batteryFixed }
      var fixedRateSolarAlone: Double { costs.noSolar - costs.solarAlone }
      let daysWithData: Int
      let daysInPeriod: Int
  }
  struct SavingsReport: Equatable, Sendable { let cycle: SavingsFigures; let year: SavingsFigures; let lifetime: SavingsFigures; let cycleStart: Date }
  enum SavingsCalculator {
      static func compute(scenarios: SavingsScenarioDays, actual: RatePeriodResolver, reference: RatePeriodResolver,
                          billingDay: Int, now: Date) -> SavingsReport
  }
  ```
- S1 prices with `actual`; S2–S4 with `reference`. Each cycle prices its own buckets (netting per cycle). Each slot's period is resolved once per resolver, not once per scenario (lifetime is ~100k slots per year). `daysWithData` counts site-local days with at least one recorded grid slot in the period; `daysInPeriod` counts days from the period start (or the first stored day, if later) through today.

- [ ] **Step 1: Write failing tests:** `cycleRecordedCostEqualsLocalBill` (same days and timeline: `cycle.costs.recorded == LocalBillBuilder` `estimatedCost`), `breakdownSumsToTotal`, `nettingStaysInsideEachCycle` (an export in one cycle doesn't offset an import in the next), `yearIsTwelveCyclesEndingNow`, `savingsCanExceedNoSolarCostWhenBillIsCredit`, `coverageCountsDaysWithData`; `BillingCycleTests` › `cyclesSpanFromFirstDayThroughNow`.
- [ ] **Step 2: Run** `./run-tests.sh --quick SavingsCalculatorTests BillingCycleTests` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; then time a lifetime compute over three synthetic years with the `PWUsageDevOptimized` scheme and record the time in the commit message (target: under 2 s on device; if over, cache per-cycle results by timeline fingerprint and cycle start before moving on).
- [ ] **Step 5: Commit** `feat(ios): price savings scenarios per billing cycle`.

### Task 6: iOS — savings state: when to compute, readiness and caching

**Files:**
- Create: `cmd/ios-app/PWUsage/State/Savings/SavingsModel.swift` (or a `DashboardCoordinator+Savings.swift` extension; follow how Phase 1 wired `LocalBillBuilder`)
- Test: `cmd/ios-app/PWUsageTests/SavingsModelTests.swift`

**Interfaces:**
- Consumes: Tasks 3–5; Phase 1 `SolarHistoryStore.flowDays(scope:from:to:)`, `RatePlanTimelineStore`, `timelineFingerprint`.
- Produces: `enum SavingsState { case notReady(SavingsNotReadyReason), ready(SavingsReport) }`, `enum SavingsNotReadyReason { case flowsMissing, noTimeline, noReferencePlan }`; computed off the main actor; recomputed only when the timeline fingerprint or the stored flows change (spec §4.4); never blocks the Bill tab.

- [ ] **Step 1: Write failing tests:** `noReferencePlanIsNotReady`, `computesOncePerFingerprint`, `recomputesWhenReferencePlanChanges`, `recomputesWhenNewDayArrives`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `./lint.sh` clean.
- [ ] **Step 5: Commit** `feat(ios): savings state with fingerprint-based recompute`.

### Task 7: Mockups (gate for Task 8)

- [ ] **Step 1:** Publish mockups as an Artifact: the Bill tab savings card (cycle figure, breakdown line, coverage, the no-reference-plan prompt), the Solar System savings section (year and lifetime, fixed-rate comparison), and the fixed rate plan form (plan name, price per kWh, export credit per kWh, starts on). Copy from Global Constraints.
- [ ] **Step 2:** The user approves or edits them. **Task 8 does not start until they approve.** Record the approved layout and any copy changes in this plan before Task 8.

### Task 8: iOS — fixed rate plan form and savings UI

**Files (final names follow the approved mockups):**
- Create: `cmd/ios-app/PWUsage/Views/Bill/FixedRatePlanForm.swift`, `cmd/ios-app/PWUsage/Views/Bill/BillSavingsCard.swift`, `cmd/ios-app/PWUsage/Views/SolarSystem/SolarSystemSavingsSection.swift`, `cmd/ios-app/PWUsage/Views/Shared/SavingsPresentation.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/BillView.swift`, `cmd/ios-app/PWUsage/Views/SolarSystem/SolarSystemView.swift`
- Test: `cmd/ios-app/PWUsageTests/SavingsPresentationTests.swift`

**Interfaces:**
- Consumes: Task 6 `SavingsState`; Task 3 reference plan calls.
- `FixedRatePlanForm` builds a `TariffPlanWriteRequest` with one all-year season and one all-day window (weekday and weekend) at the entered buy and sell rates; editing an existing reference plan uses `TariffPlanPatchRequest`.
- `SavingsPresentation` turns `SavingsFigures` into the fixed copy (currency formatting as the Bill tab does; "about" on every figure; negative savings read "cost about $…" — wording confirmed in Task 7).

- [ ] **Step 1: Write failing tests:** `headlineUsesAboutAndCurrency`, `breakdownLineMatchesCopy`, `coverageLineFormatsCounts`, `fixedRatePlanFormBuildsAllDaySeason`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the views per the approved mockups.
- [ ] **Step 4: Run** `./run-tests.sh` (full) and `./lint.sh` — PASS with zero warnings. Check light and dark mode and Dynamic Type in the simulator.
- [ ] **Step 5: Commit** `feat(ios): show savings on the Bill tab and Solar System view`.
