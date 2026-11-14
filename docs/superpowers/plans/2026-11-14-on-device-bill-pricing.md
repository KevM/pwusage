# On-Device Bill Pricing (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The iOS app prices the current bill, its outlook and Smart Shift's per-period figures from its own stored 5-minute flows and rate plan timeline, first in shadow mode beside `GET /api/mobile/bill-summary`, then in place of it.

**Architecture:** The server adds load and signed grid series to the existing history download and widens timeline holidays; it also generates shared pricing fixtures from its real engine. The app stores the new series beside solar, resolves each sample's rate period from the dated timeline, aggregates and nets per `(plan, rate period, rates)` exactly like `aggregateUsageByTOU` + `priceBillUsage`, ports the load-timing and outlook builders, and assembles a `MobileBillResponse` locally so no view changes. A pricing mode switch runs shadow comparison (reported to a small logging endpoint) before the app stops calling `bill-summary`.

**Tech Stack:** Next.js App Router + TypeScript + vitest (`cmd/next-app`); Swift 6, SwiftUI, Swift Testing, XcodeGen (`cmd/ios-app`).

**Spec:** [`docs/superpowers/specs/2026-11-13-savings-and-roi-design.md`](../specs/2026-11-13-savings-and-roi-design.md), sections 2, 4.1, 4.4, 5.

## Global Constraints

- No compatibility with older app builds (the iOS app is in beta): `GET`/`POST /api/mobile/solar-history` always send the new series and keep `version: 1`; the server deploys before the app build that needs it.
- Mobile contract changes land on both sides in the same PR (root `AGENTS.md`).
- Parity rule: the phone nets signed `grid_power` per `(plan name, rate period name)` across the billing cycle, offsetting proportionally and pricing the remainder at each bucket's own rates (`priceBillUsage`), with buckets keyed `[planName, periodName, buyRate, sellRate]` (`aggregateUsageByTOU`).
- Series values: `loadWh`, `gridWh` and `batteryWh` rounded to 0.01 Wh; `batterySoc` to 0.1 %; `solarWh` unchanged (0.1 Wh).
- All site-local date maths use the site's `timezone`, never the device's.
- Shadow threshold: a difference over $0.01 in `estimatedCost` or any period's `cost` is reported.
- The home location never reaches the server (privacy policy).
- Copy: "rate plan", never "tariff" or "TOU" in user-visible strings (`docs/voice-and-terms.md`).
- iOS: `cmd/ios-app/run-tests.sh` for every test run (`--quick` while iterating, default before commit); `./lint.sh` clean (`swiftformat --lint` + `swiftlint --strict`); zero compiler warnings. New files need no project edit (XcodeGen globs; `run-tests.sh` regenerates).
- Web: `npm test -- --run <file>`, `npm run lint`, `npx tsc --noEmit` from `cmd/next-app`.
- TDD: each task writes its failing test first.

## Review Focus

1. **Device in a different time zone from the site** (owner travelling): cycle bounds, day slots and rate periods must follow the site zone. Test in Task 6.
2. **DST days** (276 and 300 slots): every slot maps to the right instant and rate period. Fixture cases in Task 3, asserted in Task 6.
3. **A minute no rate period covers** (a plan with a window gap): the server prices it as plan `Unknown`/period `Unknown` at $0 rates; the phone must produce the same bucket, not drop the energy. Fixture case in Task 3, asserted in Task 6.
4. **Billing day past the month's end** (31 in February): cycle start and end match `getCurrentCycleStart`/`getNextCycleStart`. Test in Task 7.
5. **Stored days without the new series** (installed app upgrading, partway through the backfill): the local builder must report "not ready" and the app must keep showing the server bill, never a bill missing days. Test in Task 10.

---

### Task 1: History download carries load, grid and battery series

**Files:**
- Modify: `cmd/next-app/src/lib/prototypes/compact-history-store.ts` (add `readEnergyDays`, beside `readSolarDays` at line 425)
- Modify: `cmd/next-app/src/lib/prototypes/compact-energy.ts` (add `decodeDayFlows` beside `decodeDaySolar` at line 121)
- Modify: `cmd/next-app/src/app/api/mobile/solar-history/route.ts`
- Test: `cmd/next-app/src/app/api/mobile/solar-history/route.test.ts`, `cmd/next-app/src/lib/prototypes/compact-energy.test.ts`

**Interfaces:**
- Produces: `decodeDayFlows(archive: DayArchive, identity?: Identity): { timestamp: Date; solarWh: number; loadWh: number; gridWh: number; batteryWh: number; batterySoc: number | null }[]` (same integrity checks as `decodeDaySolar`, reads the `solar_power`, `load_power`, `grid_power`, `battery_power`, `battery_soc` columns).
- Produces: `CompactHistoryStore.readEnergyDays(siteId, from, end, changedSince, limit): Promise<EnergyHistoryDay[]>` where `EnergyHistoryDay` = `SolarHistoryDay` with `samples: { timestamp; solarWh; loadWh; gridWh; batteryWh; batterySoc }[]`.
- Produces (wire): GET and POST always add `loadWh`, `gridWh`, `batteryWh` and `batterySoc` (each `(number|null)[]`) to each day, slot-aligned like `solarWh`, rounded to 0.01. Response `version` stays 1. `readSolarDays` and `decodeDaySolar` are removed once nothing calls them.

- [ ] **Step 1: Write failing tests**
  - `compact-energy.test.ts` › `decodeDayFlows returns the archived load, grid and battery per sample`: encode a 3-sample day with `grid_power` `[120.5, -40.25, 0]`, `load_power` `[200, 10, 5]`, `battery_power` `[-30, 15.5, 0]` and `battery_soc` `[80, 80.5, null]`; assert decoded values equal them exactly and `decodeDaySolar` still matches the solar column.
  - `route.test.ts` › `GET adds slot-aligned flow series`: a day with a sample missing at slot 2 gives `null` at index 2 in all four new arrays, a sample with no SoC gives `batterySoc` `null`, and `gridWh[0] === 120.5`, `gridWh[1] === -40.25`.
  - `route.test.ts` › `POST fill returns flows for filled days`.
  - Existing `route.test.ts` expectations for `solarWh` stay unchanged.
- [ ] **Step 2: Run** `npm test -- --run src/app/api/mobile/solar-history/route.test.ts src/lib/prototypes/compact-energy.test.ts` — expected: the new tests FAIL.
- [ ] **Step 3: Implement** `decodeDayFlows` and `readEnergyDays` (same SQL as `readSolarDays`), and switch both handlers to them; slot mapping reuses `solarSlots`' offset logic for all three arrays.
- [ ] **Step 4: Run the same command** — expected: PASS. Then run `npm run lint` and `npx tsc --noEmit` — clean.
- [ ] **Step 5: Check today's freshness.** Read how `writeDay` is called for the open day (`site-live-data`, crons) and record in the commit message how often today's archive is rewritten compared with the rows `bill-summary` reads via `getRawEnergyData`. If the archive lags by more than one live refresh, add a line to `TODO.md` under a new "On-device bill pricing" heading; the shadow comparison (Task 11) measures it in production.
- [ ] **Step 6: Commit** `feat(api): add load, grid and battery series to mobile history download`.

### Task 2: Timeline holidays cover the whole history

**Files:**
- Modify: `cmd/next-app/src/lib/tariff-timeline-repo.ts:456`
- Test: `cmd/next-app/src/lib/tariff-timeline-repo.test.ts`

**Interfaces:**
- Produces (wire): `holidayDates` lists observed holidays for every year from the earliest period's `effectiveFrom` year (or this year when there are no periods) through next year.

- [ ] **Step 1: Write failing test** `tariff-timeline-repo.test.ts` › `holidayDates span from the earliest plan year through next year`: periods starting `2019-03-01`, today `2026-11-14` → contains `2019-07-04` and `2027-01-01`, and nothing before 2019.
- [ ] **Step 2: Run** `npm test -- --run src/lib/tariff-timeline-repo.test.ts` — FAIL.
- [ ] **Step 3: Implement** the year range in the return statement using `observedHolidayDates`.
- [ ] **Step 4: Run** — PASS; lint and tsc clean.
- [ ] **Step 5: Commit** `feat(api): send rate plan holidays for every history year`.

### Task 3: Shared pricing fixtures generated by the server engine

**Files:**
- Create: `cmd/next-app/scripts/bill-pricing-fixtures.ts` (case definitions + writer)
- Create: `cmd/next-app/src/lib/bill-pricing-fixtures.ts` (pure `buildBillPricingFixture(caseDef)` used by script and test)
- Create: `cmd/next-app/src/lib/bill-pricing-fixtures.test.ts`
- Create: `cmd/ios-app/PWUsageTests/Fixtures/BillPricing/<case>.json` (generated, checked in)
- Modify: `cmd/next-app/package.json` (script `fixtures:bill-pricing`)

**Interfaces:**
- Produces: fixture JSON, one file per case:
  ```json
  { "name": "...", "now": "ISO", "billingDay": 1,
    "timeline": { /* exact SiteTariffsTimelineResponse version 2 body */ },
    "days": [{ "day": "YYYY-MM-DD", "dayStart": "ISO", "solarWh": [], "loadWh": [], "gridWh": [] }],
    "expected": { "currentBill": { "estimatedCost": 0, "cycleStart": "ISO", "cycleEnd": "ISO",
                  "periods": [{ "tariffName": "", "periodName": "", "netGridKwh": 0, "cost": 0 }] },
                  "outlook": { /* BillOutlookHistory */ }, "loadTiming": { /* LoadTiming incl. tariffTimeline */ } } }
  ```
- `buildBillPricingFixture` runs the real server path on in-memory inputs: `new Schedule(tariffs, timezone)`, `EnergyRepo.aggregateUsageByTOU` with every sample passed as `todayRaw` and no prior aggregates, `priceBillUsage`, the outlook day loop from `getBillOutlook`, `computeLoadTiming`, and `buildLoadTimingTimeline`. The timeline JSON is produced by the same DTO mapping `tariff-timeline-repo.ts` uses, from the same tariff rows, so both sides read one source. Where that logic is inline in a class or route, extract it into an exported pure function first (no behaviour change; existing tests must still pass).

- [ ] **Step 1: Write failing test** `bill-pricing-fixtures.test.ts` › `checked-in fixtures match the server engine`: for each case definition, `buildBillPricingFixture(def)` deep-equals the parsed file in `cmd/ios-app/PWUsageTests/Fixtures/BillPricing/`.
- [ ] **Step 2: Run** `npm test -- --run src/lib/bill-pricing-fixtures.test.ts` — FAIL (no files).
- [ ] **Step 3: Implement** the builder and these cases (site zone `America/Denver` unless noted, billing day 1 unless noted):
  1. `single-plan-cycle`: one Time of Use plan, ten days, net import in Peak, net export in Off-Peak.
  2. `plan-change-mid-cycle`: manual plan from day 10 with the same period names, different rates (proportional netting across rates).
  3. `dst-spring-forward` (276 slots) and `dst-fall-back` (300 slots).
  4. `holiday-weekday`: a weekday holiday priced on weekend windows, in a past year.
  5. `season-boundary-mid-month`: seasons with `fromDay`/`toDay`, boundary inside the cycle.
  6. `gapped-day`: nil slots inside a day and a missing day.
  7. `uncovered-window`: a plan whose windows leave 13:00–14:00 uncovered (`Unknown` bucket).
  8. `billing-day-31-february`: billing day 31, `now` in February.
  9. `no-plan`: empty timeline (`hasTariff` false, `loadTiming` per server).
  Then run `npm run fixtures:bill-pricing` to write the files.
- [ ] **Step 4: Run** the test — PASS. Run the full `npm test -- --run` to prove the extractions changed nothing; lint and tsc clean.
- [ ] **Step 5: Commit** `test: generate shared bill pricing fixtures from the server engine`.

### Task 4: The app downloads and stores the new series (load, grid, battery, state of charge)

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/Solar/MobileSolarHistory.swift` (`MobileSolarHistoryDay` gains required `loadWh`, `gridWh`, `batteryWh`, `batterySoc`, each `[Double?]`, validated slot-aligned like `solarWh`)
- Modify: `cmd/ios-app/PWUsage/State/Solar/SolarHistoryPersistence.swift` (`SolarHistoryStoredDay` gains `load`, `grid`, `battery`, `soc`, each `[Float?]?`, decoded with defaults so old files load)
- Modify: `cmd/ios-app/PWUsage/State/Solar/SolarHistoryStore.swift` (merge stores the new series; add reads below)
- Test: `cmd/ios-app/PWUsageTests/SolarHistoryStoreFlowsTests.swift`

**Interfaces:**
- Produces: `struct EnergyFlowDay: Equatable, Sendable { let day: String; let dayStart: Date; let solarWh: [Float?]; let loadWh: [Float?]; let gridWh: [Float?]; let batteryWh: [Float?]; let batterySoc: [Float?] }`
- Produces: `SolarHistoryStore.flowDays(scope: SolarForecastSiteScope, from: Date, to: Date) throws -> [EnergyFlowDay]?` — `nil` when any stored day in the range lacks any of the four new series (not ready). Null values inside `batterySoc` are normal (Tesla API gaps) and never make a day not ready.
- Produces: `SolarHistoryStore.oldestDayMissingFlows(scope:) throws -> String?`.

- [ ] **Step 1: Write failing tests** in `SolarHistoryStoreFlowsTests`:
  - `decodesDaysWithFlows` and `rejectsDayWhoseFlowsAreNotSlotAligned`.
  - `mergeStoresFlowsBesideSolar`: merged day's `flowDays` returns the same slot values.
  - `oldFileWithoutFlowsLoadsAndReportsMissing`: a persisted year file written before this change loads; `flowDays` returns `nil`; `oldestDayMissingFlows` returns its first day.
  - `flowDaysNilWhenAnyDayInRangeLacksFlows`.
  - `daysWithStateOfChargeGapsAreReady`: a day whose `batterySoc` is all `null` but has the other series is returned by `flowDays`.
- [ ] **Step 2: Run** `./run-tests.sh --quick SolarHistoryStoreFlowsTests` — FAIL.
- [ ] **Step 3: Implement** the model, request parameter, persistence fields and the two reads.
- [ ] **Step 4: Run** the suite — PASS; `./lint.sh` clean; no warnings.
- [ ] **Step 5: Commit** `feat(ios): store load, grid and battery history beside solar`.

### Task 5: Backfill flows, current cycle first

**Files:**
- Modify: `cmd/ios-app/PWUsage/State/Solar/SolarHistoryStore.swift` (sync)
- Test: `cmd/ios-app/PWUsageTests/SolarHistoryStoreFlowsTests.swift`

**Interfaces:**
- Consumes: Task 4 reads.
- Produces: `SolarHistoryStore.syncFlows(scope:api:cycleStartDay:now:) async throws -> FlowSyncProgress` where `enum FlowSyncProgress: Equatable { case currentCycleReady, complete, partial(oldestMissing: String) }`. Order: GET pages from `cycleStartDay` through today first, then GET pages from `oldestDayMissingFlows` forward. GET only (no Tesla calls); progress survives relaunch because missing days are found from storage.

- [ ] **Step 1: Write failing tests**: `syncFlowsFetchesCurrentCycleFirst` (fake API records request order: first `from == cycleStartDay`), `syncFlowsResumesFromOldestMissingDay`, `syncFlowsCompleteWhenNothingMissing`.
- [ ] **Step 2: Run** `./run-tests.sh --quick SolarHistoryStoreFlowsTests` — FAIL.
- [ ] **Step 3: Implement** `syncFlows` reusing the existing page loop and `changedSince` overlap rules.
- [ ] **Step 4: Run** — PASS; lint clean.
- [ ] **Step 5: Commit** `feat(ios): backfill history flows starting with the current billing cycle`.

### Task 6: Rate period resolver and bill pricing engine

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Bill/Pricing/RatePeriodResolver.swift`
- Create: `cmd/ios-app/PWUsage/Models/Bill/Pricing/BillUsageAggregator.swift`
- Create: `cmd/ios-app/PWUsage/Models/Bill/Pricing/BillPricing.swift`
- Modify: `cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift` (`activePeriodNow(at:)` delegates to the resolver)
- Create: `cmd/ios-app/PWUsageTests/Fixtures/BillPricingFixtureLoader.swift`
- Test: `cmd/ios-app/PWUsageTests/BillPricingParityTests.swift`

**Interfaces:**
- Produces: `struct ResolvedRatePeriod: Equatable, Sendable { let planName: String; let periodName: String; let buyRate: Double; let sellRate: Double }` with `static let unknown` (`"Unknown"`, `"Unknown"`, 0, 0).
- Produces: `struct RatePeriodResolver { init?(timeline: SiteTariffsTimelineResponse); func period(at instant: Date) -> ResolvedRatePeriod }` — plan chosen by `period(on:)` for the instant's site-local day; holidays from `holidayDates` use weekend windows; `periodName` is the window's `touName.rawValue` (whatever the fixtures show the server emits); no match → `.unknown`.
- Produces: `struct BillUsageBucket: Equatable, Sendable { let planName: String; let periodName: String; let buyRate: Double; let sellRate: Double; var gridWh: Double; var loadWh: Double; var solarWh: Double }` and `enum BillUsageAggregator { static func buckets(days: [EnergyFlowDay], from: Date, to: Date, resolver: RatePeriodResolver) -> [BillUsageBucket] }` — each non-nil slot at `dayStart + i × 300 s`, keyed `[planName, periodName, buyRate, sellRate]`.
- Produces: `enum BillPricing { static func costs(_ buckets: [BillUsageBucket]) -> [Double] }` — port of `priceBillUsage`, grouped by `[planName, periodName]`, results in bucket order.
- Produces: `BillPricingFixture.load(_ name: String) throws -> BillPricingFixture` and `BillPricingFixture.allNames: [String]`.

- [ ] **Step 1: Write failing tests** in `BillPricingParityTests` (parameterised over `BillPricingFixture.allNames`):
  - `currentBillMatchesServer`: grouping buckets by `[planName, periodName]` gives `netGridKwh` and `cost` equal to `expected.currentBill.periods` within 1e-9, and the total equals `estimatedCost` within 1e-9.
  - `deviceTimeZoneDoesNotChangeTheBill`: the same case run with `NSTimeZone.default` set to `Pacific/Auckland` gives identical results (restore it after).
  - `uncoveredWindowPricesAsUnknown`: in `uncovered-window`, the 13:00–14:00 energy lands in the `Unknown`/`Unknown` bucket.
  - `activePeriodNowStillMatches`: existing `activePeriodNow` callers' tests stay green (run `MobileTariffs`-related suites).
- [ ] **Step 2: Run** `./run-tests.sh --quick BillPricingParityTests` — FAIL.
- [ ] **Step 3: Implement** the resolver, aggregator and pricing. Move the season and window matching out of `SiteTariffsTimelineResponse` into the resolver (one place), keeping `activePeriodNow` as a thin caller.
- [ ] **Step 4: Run** the suite, then default `./run-tests.sh` — PASS; lint clean.
- [ ] **Step 5: Commit** `feat(ios): price bill usage on device with server parity fixtures`.

### Task 7: Billing cycle and outlook history on device

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Bill/Pricing/BillingCycle.swift`
- Create: `cmd/ios-app/PWUsage/Models/Bill/Pricing/BillOutlookHistoryBuilder.swift`
- Test: `cmd/ios-app/PWUsageTests/BillingCycleTests.swift`, `cmd/ios-app/PWUsageTests/BillPricingParityTests.swift`

**Interfaces:**
- Produces: `enum BillingCycle { static func current(billingDay: Int, now: Date, timeZone: TimeZone) -> (start: Date, end: Date) }` — port of `getCurrentCycleStart`/`getNextCycleStart` (`cmd/next-app/src/lib/billing-cycle.ts`).
- Produces: `enum BillOutlookHistoryBuilder { static func build(days: [EnergyFlowDay], cycleStart: Date, cycleEnd: Date, now: Date, resolver: RatePeriodResolver, timeZone: TimeZone) -> BillOutlookHistory? }` — port of the `getBillOutlook` day loop and `buildBillOutlookHistory`; a day is `complete` when every slot is non-nil; `tariffTimeline` is filled in Task 8.

- [ ] **Step 1: Write failing tests**: `BillingCycleTests` › `billingDay31InFebruaryMatchesServer` (`cycleStart`/`cycleEnd` equal the `billing-day-31-february` fixture's expected instants), `cycleBoundsUseSiteZoneNotDevice`; parity › `outlookPointsMatchServer` (points' `estimatedCost`, `complete`, buckets within 1e-9; `observedThrough` equal).
- [ ] **Step 2: Run** `./run-tests.sh --quick BillingCycleTests BillPricingParityTests` — FAIL.
- [ ] **Step 3: Implement** both.
- [ ] **Step 4: Run** — PASS; lint clean.
- [ ] **Step 5: Commit** `feat(ios): build billing cycle and outlook history on device`.

### Task 8: Smart Shift load timing on device

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/LoadTiming/Local/MarginalCost.swift` (port of `marginal-cost.ts`)
- Create: `cmd/ios-app/PWUsage/Models/LoadTiming/Local/NextCheaperPeriod.swift` (port of `next-cheaper-period.ts`, including `formatRelativeStart` phrases verbatim)
- Create: `cmd/ios-app/PWUsage/Models/LoadTiming/Local/LoadTimingCalculator.swift` (port of `computeLoadTiming`)
- Create: `cmd/ios-app/PWUsage/Models/LoadTiming/Local/LoadTimingTimelineBuilder.swift` (port of `buildLoadTimingTimeline`, also used for the outlook's `tariffTimeline`)
- Test: `cmd/ios-app/PWUsageTests/BillPricingParityTests.swift`, `cmd/ios-app/PWUsageTests/NextCheaperPeriodTests.swift`

**Interfaces:**
- Consumes: `RatePeriodResolver`, `BillUsageBucket`, `BillPricing.costs`.
- Produces: `enum LoadTimingCalculator { static func compute(buckets: [BillUsageBucket], costs: [Double], resolver: RatePeriodResolver, now: Date, timeZone: TimeZone) -> LoadTiming? }` returning the existing `LoadTiming` contract type (`MobileContracts.swift:233`), `nil` exactly when the server returns `null`.
- Produces: `enum LoadTimingTimelineBuilder { static func segments(resolver: RatePeriodResolver, from: Date, to: Date, now: Date) -> [LoadTimingTariffSegment] }`.

- [ ] **Step 1: Write failing tests**: parity › `loadTimingMatchesServer` (whole `LoadTiming` equal, amounts within 1e-9, phrases exact) and `outlookTariffTimelineMatchesServer`; `NextCheaperPeriodTests` › `phrasesMatchServerAcrossMidnightAndDST` using the fixtures' `now` values.
- [ ] **Step 2: Run** `./run-tests.sh --quick BillPricingParityTests NextCheaperPeriodTests` — FAIL.
- [ ] **Step 3: Implement** the four ports.
- [ ] **Step 4: Run** — PASS; lint clean.
- [ ] **Step 5: Commit** `feat(ios): compute Smart Shift load timing on device`.

### Task 9: Saved rate plan timeline with ETag revalidation

**Files:**
- Modify: `cmd/next-app/src/app/api/site/[id]/tariffs/route.ts` (GET) + `route.test.ts`
- Create: `cmd/ios-app/PWUsage/State/Bill/RatePlanTimelineStore.swift`
- Modify: `cmd/ios-app/PWUsage/Networking/PWUsageAPI+Tariffs.swift` (`fetchTariffTimeline` sends `If-None-Match`, handles 304)
- Modify: `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+Tariffs.swift` (every timeline-returning call saves the result)
- Test: `cmd/ios-app/PWUsageTests/RatePlanTimelineStoreTests.swift`

**Interfaces:**
- Produces (wire): timeline GET sends `ETag: "<sha256 hex of the JSON body>"` and `Cache-Control: private, no-cache`; with a matching `If-None-Match` it answers 304 with no body. Write routes (POST/PATCH/DELETE, refresh, reattribute) keep their bodies and also send the `ETag`.
- Produces: `actor RatePlanTimelineStore { static let shared; func saved(scope: SolarForecastSiteScope) throws -> SavedRatePlanTimeline?; func save(_ timeline: SiteTariffsTimelineResponse, etag: String?, scope: SolarForecastSiteScope) throws; func remove(scope:) throws }` with `struct SavedRatePlanTimeline: Codable, Equatable { let timeline: SiteTariffsTimelineResponse; let etag: String?; let savedAt: Date }`. One file per account and site in Application Support, removed by the existing sign-out cleanup (`SolarSessionCleanup.swift`).
- Produces: `PWUsageAPI.fetchTariffTimeline(siteID:, knownETag: String?) async throws -> TimelineFetch` with `enum TimelineFetch { case unchanged, changed(SiteTariffsTimelineResponse, etag: String?) }`; the existing one-argument call remains for the editor.
- Refresh rule: on foreground and before a local bill build, revalidate with the saved ETag; save on `changed`. Editor responses replace the saved copy immediately.

- [ ] **Step 1: Write failing tests**: vitest › `GET sends an ETag and answers 304 when If-None-Match matches`, `ETag changes when a rate changes`, `write routes return the ETag of their body`; Swift › `savesAndReadsPerScope`, `unchangedKeepsSavedCopy`, `editorResponseReplacesSavedCopy`, `signOutRemovesSavedTimelines`.
- [ ] **Step 2: Run** `npm test -- --run "src/app/api/site/[id]/tariffs/route.test.ts"` and `./run-tests.sh --quick RatePlanTimelineStoreTests` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both — PASS; web lint/tsc and `./lint.sh` clean.
- [ ] **Step 5: Commit** `feat: save the rate plan timeline on device with ETag revalidation`.

### Task 10: Local bill builder

**Files:**
- Create: `cmd/ios-app/PWUsage/State/Bill/LocalBillBuilder.swift`
- Test: `cmd/ios-app/PWUsageTests/LocalBillBuilderTests.swift`

**Interfaces:**
- Consumes: Tasks 4–9 (`timeline` is the saved copy from `RatePlanTimelineStore`; no saved copy → `.notReady(.noTimeline)`).
- Produces: `struct LocalBillBuilder { func build(site: MobileBillResponse.Site, billingDay: Int, timeline: SiteTariffsTimelineResponse?, store: SolarHistoryStore, scope: SolarForecastSiteScope, now: Date) async throws -> LocalBillResult }` with `enum LocalBillResult: Equatable { case ready(MobileBillResponse), notReady(NotReadyReason) }` and `enum NotReadyReason: Equatable { case flowsMissing, noTimeline }`. The response uses `version: 1`, `revision: nil`, `tariffReattribution: timeline.reattribution`, `sources.calculatedAt: now`, `sources.energyDataThrough`: last non-nil slot instant, and currency from `timeline.currency`.
- Produces: `LocalBillBuilder.timelineFingerprint(_ timeline: SiteTariffsTimelineResponse) -> String` (SHA-256 of the encoded periods and holidays) for change detection.

- [ ] **Step 1: Write failing tests**: `buildsReadyResponseMatchingFixture` (a fixture's days in a temp store → `.ready` with `currentBill`, `outlook`, `loadTiming` equal to expected), `notReadyWhenCurrentCycleLacksFlows` (Review Focus 5), `notReadyWithoutTimeline`, `fingerprintChangesWhenARateChanges`.
- [ ] **Step 2: Run** `./run-tests.sh --quick LocalBillBuilderTests` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; lint clean.
- [ ] **Step 5: Commit** `feat(ios): assemble the bill response on device`.

### Task 11: Shadow mode and its report endpoint

**Files:**
- Create: `cmd/next-app/src/app/api/mobile/bill-shadow/route.ts` + `route.test.ts`
- Create: `cmd/ios-app/PWUsage/State/Bill/BillShadowComparison.swift`
- Create: `cmd/ios-app/PWUsage/State/Bill/BillPricingMode.swift`
- Modify: `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+Refresh.swift` (`performBill`, line 256)
- Modify: `cmd/ios-app/PWUsage/Networking/PWUsageAPI.swift` (`reportBillShadow`)
- Test: `cmd/ios-app/PWUsageTests/BillShadowComparisonTests.swift`, `cmd/ios-app/PWUsageTests/DashboardCoordinatorBillShadowTests.swift`

**Interfaces:**
- Produces (wire): `POST /api/mobile/bill-shadow` body `{ siteId, appBuild, cycleStart, server: { estimatedCost, periods: [{ tariffName, periodName, cost }] }, local: { same }, reattributionRunning: boolean }`; auth via `verifySiteAccess`; logs one `console.warn('[bill-shadow]', JSON)` line; answers 204. Rejects bodies over 16 KB or with non-finite amounts (400). No location or flows in the body.
- Produces: `enum BillPricingMode: String { case server, shadow, local }` read from `AppConfiguration` (default `.shadow` in this release).
- Produces: `enum BillShadowComparison { static func differences(server: MobileBillResponse, local: MobileBillResponse, threshold: Double = 0.01) -> BillShadowReport? }`.
- `performBill` in `.shadow`: fetch from the server as today and show it; then build locally; skip the comparison when `tariffReattribution` says running or the local result is `.notReady`; otherwise send the report when `differences` is non-nil, at most once per site per cycle per app launch.

- [ ] **Step 1: Write failing tests**: vitest `bill-shadow/route.test.ts` › `logs a valid report and answers 204`, `rejects non-finite amounts`, `rejects unauthorised sites`; Swift `BillShadowComparisonTests` › `nilWhenWithinOneCent`, `reportsPeriodsOverOneCent`, `reportsAPeriodPresentOnOneSideOnly`; `DashboardCoordinatorBillShadowTests` › `shadowShowsServerBillAndReportsDifference`, `shadowSkipsWhileReattributionRuns`, `shadowSkipsWhenLocalNotReady`, `serverModeNeverBuildsLocally`.
- [ ] **Step 2: Run** `npm test -- --run src/app/api/mobile/bill-shadow/route.test.ts` and `./run-tests.sh --quick BillShadowComparisonTests DashboardCoordinatorBillShadowTests` — FAIL.
- [ ] **Step 3: Implement.** Start `syncFlows` (Task 5) from the same refresh path when flows are missing, so shadow data accumulates without the user opening Panel Health.
- [ ] **Step 4: Run** both — PASS; web lint/tsc and `./lint.sh` clean; default `./run-tests.sh` green.
- [ ] **Step 5: Commit** `feat: compare on-device bill pricing with the server in shadow mode`.

### Task 12: Switch the Bill tab and home screen to local pricing

**Do not start until the user confirms the shadow reports are clean.** Ship Tasks 1–11 first.

**Files:**
- Modify: `cmd/ios-app/PWUsage/State/Bill/BillPricingMode.swift` (default `.local`)
- Modify: `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+Refresh.swift`
- Modify: `cmd/ios-app/PWUsage/State/Home/DashboardCache.swift` (store the local response the same way)
- Test: `cmd/ios-app/PWUsageTests/DashboardCoordinatorBillShadowTests.swift`

**Interfaces:**
- `performBill` in `.local`: build locally; on `.ready`, publish it exactly as a server response is published today (same `bill.response`, cache, timestamps) without calling `bill-summary`; on `.notReady`, fall back to the server path. Reprice when `timelineFingerprint` changes after the Task 9 revalidation.

- [ ] **Step 1: Write failing tests**: `localModeDoesNotCallBillSummary`, `localModeFallsBackWhenNotReady`, `localModeRepricesWhenTimelineFingerprintChanges`.
- [ ] **Step 2: Run** `./run-tests.sh --quick DashboardCoordinatorBillShadowTests` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; default `./run-tests.sh` green; `./lint.sh` clean.
- [ ] **Step 5: Commit** `feat(ios): price the bill on device instead of calling bill-summary`.
