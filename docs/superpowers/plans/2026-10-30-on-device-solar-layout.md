# On-device Solar Layout Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect each site's solar panel layout on the phone from its own day records, keep the home location on the user's devices only (synced through their private iCloud), and remove `SiteSolarLayout`, the `detect-solar-layouts` cron and the layout/actuals endpoints from the server.

**Architecture:** The TypeScript detector (`cmd/next-app/src/lib/solar-layout/`) is ported to Swift and held to it by JSON fixtures the TypeScript writes once. The server keeps day records, tariffs and billing (ROI needs history on the server) and gains one read-only endpoint that serves a site's 5-minute solar samples from `EnergyDayArchive`. The phone caches a year of those samples, runs detection in the foreground or a background processing task, derives the 14-day hourly actuals itself, and syncs only the layout result and rounded location through CloudKit.

**Tech Stack:** Swift (iOS 18, no third-party packages), BackgroundTasks, CloudKit `CKSyncEngine`; Next.js App Router route + Vitest on the server.

**Spec:** No separate spec. Design decided with the owner on 2026-10-30, recorded in "Design decisions" below. Builds on [the auto solar forecast spec](../specs/2026-10-27-auto-solar-forecast-design.md), the [server plan](./2026-10-27-auto-solar-forecast-server.md) (detector, parity gate) and the [Open-Meteo plan](../../plans/2026-10-30-open-meteo-provider.md) (on-device array modelling).

## Design decisions

- Detection runs on the phone, in Swift. Not JavaScriptCore.
- The server stores no home location and no layout. It keeps `EnergyDayArchive`, tariffs, billing and TRMNL as they are.
- History source: the existing day records, via a new `GET /api/mobile/solar-history`. No new server-side history cache.
- The phone derives what `/api/mobile/solar-actuals` serves today from the same cached samples.
- Multiple devices: the layout result and location sync through the user's CloudKit private database, location fields in `encryptedValues`. Different Apple IDs in one household each detect on their own (deterministic on the same history).
- Everything stays gated by the `solar-forecast-beta` role, now enforced by the history endpoint.
- The UI keeps consuming `MobileSolarLayoutResponse`; the phone builds it locally instead of decoding it from the server, so views and their tests do not change.

## Global Constraints

- iOS deployment target 18.0; no new Swift packages. Swift file names are kebab-case like their neighbours (`mobile-solar-layout.swift`).
- Locations are rounded to 2 decimals (`roundCoordinate` semantics) before being stored anywhere, CloudKit included. A finer fix is never persisted.
- `/api/mobile/solar-history` reads the database only: no Tesla calls. Pages of at most 92 days. `Cache-Control: private, no-store, max-age=0` like the other mobile routes.
- Hobby caps functions at 60 s; the new route needs no `maxDuration` override.
- Migrations are idempotent (`IF EXISTS`, guarded `cron.unschedule`).
- Detector constants are copied, not re-derived: `SOLAR_LAYOUT_DETECTOR_VERSION` becomes `SolarLayoutDetector.version = 2` (a new runtime is a new version), `MIN_HISTORY_DAYS = 42`, `DERATE = 0.85`, `LOCATION_MISMATCH_DEGREES = 3`, history window 365 days.
- Where TypeScript stores `Float32Array`, Swift stores `Float`; elsewhere `Double`. `seededRng` must be bit-for-bit identical.
- `cmd/next-app`: `npm run lint`, `npm run build`, `npm test` pass. `cmd/ios-app`: `PWUSAGE_TEST_TIMEOUT_SECONDS=1200 ./run-tests.sh` passes.

## Review Focus

1. **DST days.** A day record on a clock-change day has 276 or 300 slots. History decoding, the hourly actuals and `toSeries` must keep every slot at its real UTC time (Task 6, Task 7 tests).
2. **Account or site switch mid-sync or mid-detection.** A sync or detection started for one account scope must never write into another's store or publish its status (Task 9, Task 10 tests).
3. **Location changed during detection.** A result computed for the old location is discarded, as the server does today (`saveResult` location guard) (Task 9 test).
4. **Background task expiry.** The expiration handler cancels detection; the record stays due and nothing half-written is saved (Task 9 test).
5. **First run after the switch.** There is no server migration (the owner is the only beta user and shares the location again once). With no local record the status is needs-location, never a stale layout, and nothing automatic is requested (Task 8 test).

**Rollout:** the owner is the only `solar-forecast-beta` user (2026-10-30). Nothing waits on other testers: Phase D starts as soon as the owner's phone runs the Task 10 build. The beta role gate stays for future testers.

---

## Phase A: Swift detector (no behaviour change)

### Task 1: Fixture exporter

**Files:**
- Create: `cmd/next-app/scripts/solar-layout-fixtures.ts`
- Create: `cmd/ios-app/PWUsageTests/Fixtures/SolarLayout/*.json` (generated, committed)
- Modify: `cmd/next-app/scripts/solar-layout-reference/README.md` (one paragraph on the fixtures)

**Interfaces:**
- Produces: fixture files, one per case, shaped as:

```ts
type SolarLayoutFixture = {
    name: string;
    input: { latitude: number; longitude: number; timeZone: string; start: string /* ISO, first slot */; stepMinutes: 5;
             solarWh: string /* base64 little-endian Float32, NaN = missing */ };
    stages: {
        sun: { timestamp: string; apparentZenith: number; elevation: number; azimuth: number; dniExtra: number; ghi: number; dni: number; dhi: number }[]; // 48 evenly spaced daylight slots
        poa: { planes: { azimuth: number; tilt: number; effectiveKw: number }[]; kw: number[] }; // modelKw at the same 48 slots for a fixed east/west pair
        selection: { producingDays: number; clearDays: number; selectedRows: number; clipKw: number | null; shading: ShadeSegment[] };
        fit: { planeCount: 1 | 2 | 3; cvNrmse: Record<'1' | '2' | '3', number>; bestPlanes: { azimuth: number; tilt: number; effectiveKw: number }[] } | null;
    };
    result: SolarLayoutResult;
};
```

Cases (reuse `synthetic.ts` and the parameters in `detect.test.ts`): `east-west-year` (365 days, seed 7, cloudyFraction 0.5), `south-shaded-100d` (the low-confidence case, seed 11), `east-west-30d` (not enough history, seed 3), `south-clipped-year` (single south plane with an AC clip below DC size). Each file under ~500 KB.

- [ ] **Step 1:** Write `solar-layout-fixtures.ts`. It calls the exported stage functions from `src/lib/solar-layout/` directly; export any helper it needs (no logic changes). Usage: `npx tsx scripts/solar-layout-fixtures.ts --out ../ios-app/PWUsageTests/Fixtures/SolarLayout`.
- [ ] **Step 2:** Run it twice and check the output is byte-identical (`git diff --stat` empty on the second run). Detection is seeded, so a difference is a bug.
- [ ] **Step 3:** `npm run lint && npm test` in `cmd/next-app`. Expected: pass.
- [ ] **Step 4:** Commit: `test(solar): export detector fixtures for the Swift port`.

### Task 2: Sun and plane-of-array model in Swift

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Solar/LayoutDetection/layout-sun.swift` (port of `sun.ts`)
- Create: `cmd/ios-app/PWUsage/Models/Solar/LayoutDetection/layout-poa.swift` (port of `poa.ts`)
- Create: `cmd/ios-app/PWUsageTests/Fixtures/solar-layout-fixture-loader.swift`
- Test: `cmd/ios-app/PWUsageTests/SolarLayoutSunPOATests.swift`

**Interfaces:**
- Consumes: Task 1 fixtures; existing `SolarPosition.at(_:latitude:longitude:)` (it already matches the detector's geometry; reuse it for zenith/azimuth/DNI-extra rather than porting that part again).
- Produces:
  - `struct SolarLayoutFixture: Decodable` + `static func load(_ name: String) throws -> SolarLayoutFixture` (decodes the base64 Float32 into `[Float]`).
  - `struct LayoutSunSample { apparentZenith, elevation, azimuth, dniExtra, ghi, dni, dhi: Double; ambientFactor: Double }` and `func layoutSun(at: Date, latitude: Double, longitude: Double) -> LayoutSunSample`.
  - `enum LayoutPOA { static let maxTilt: Double; static func modelKw(sun: LayoutSunSample, planes: [LayoutPlane]) -> Double }`, `struct LayoutPlane { azimuth, tilt, effectiveKw: Double }`.

- [ ] **Step 1: Write the failing test.** `testSunMatchesFixture` and `testPOAMatchesFixture` for every fixture: each field within `1e-9` relative (or `1e-9` absolute near zero) of `stages.sun` / `stages.poa`.
- [ ] **Step 2:** `./run-tests.sh PWUsageTests/SolarLayoutSunPOATests`. Expected: FAIL (types not defined).
- [ ] **Step 3:** Implement the two files. Confirm the fixture JSON is bundled into the test target (XcodeGen copies non-source files under `PWUsageTests`; if not, add it as a resource in `project.yml`).
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ios): port solar layout sun and POA model`.

### Task 3: Selection (series, clear days, clip, shading)

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Solar/LayoutDetection/layout-selection.swift` (port of `selection.ts`)
- Test: `cmd/ios-app/PWUsageTests/SolarLayoutSelectionTests.swift`

**Interfaces:**
- Consumes: Task 2.
- Produces: `struct LayoutSeries`, `func layoutSeries(samples: [(timestamp: Date, solarWh: Double)], latitude:, longitude:, timeZone: TimeZone) -> LayoutSeries` (port of `toSeries`), plus Swift ports of `envelopeClear`, `detectClip`, `learnShade`, `flatRuns`, `smoothness`, `median`, `quantile` and `ShadeMask`/`ShadeSegment` with the same names in lowerCamelCase.

- [ ] **Step 1: Failing test.** `testSelectionMatchesFixture`: `producingDays`, `clearDays`, `selectedRows` exact; `clipKw` within 1e-6; `shading` segments equal. Add `testSeriesKeepsDSTSlots`: a synthetic 300-slot fall-back day maps every slot to a distinct UTC time and the right local day.
- [ ] **Step 2:** Run `PWUsageTests/SolarLayoutSelectionTests`. Expected: FAIL.
- [ ] **Step 3:** Implement. Use `Calendar` with the site `TimeZone` for local days where TypeScript uses Temporal.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ios): port solar layout clear-day selection`.

### Task 4: Fit (grid search, refine, plane count, bootstrap)

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Solar/LayoutDetection/layout-fit.swift` (port of `fit.ts`)
- Test: `cmd/ios-app/PWUsageTests/SolarLayoutFitTests.swift`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: Swift ports of `seededRng`, `fitRows`, `subsetRows`, `gridColumns` (returns `[[Float]]`), `groupGrams`, `fitFromGram`, `fitMaskGroup`, `planeCountFromRows`, `bootstrapRows`, `toPlanes`, `azimuthRange90`, all taking `checkCancellation: () throws -> Void` where TypeScript takes `checkDeadline`.

- [ ] **Step 1: Failing tests.** `testSeededRngMatchesTypeScript`: the first 10 values for seed 7 equal the TypeScript values bit-for-bit (paste them from a one-off `npx tsx -e` run into the test). `testFitMatchesFixture`: `planeCount` exact, `cvNrmse` within 1e-6, `bestPlanes` azimuth/tilt within 0.01°, `effectiveKw` within 0.1%.
- [ ] **Step 2:** Run `PWUsageTests/SolarLayoutFitTests`. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep the TypeScript loop order and accumulation order: floating-point sums must be done in the same order to stay within tolerance.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ios): port solar layout fitting`.

### Task 5: Detector entry point, end-to-end parity, device timing

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Solar/LayoutDetection/solar-layout-detector.swift` (port of `detect.ts`)
- Test: `cmd/ios-app/PWUsageTests/SolarLayoutDetectorTests.swift`
- Test: `cmd/ios-app/PWUsageTests/SolarLayoutResearchParityTests.swift`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:

```swift
struct DetectedSolarLayout: Codable, Equatable, Sendable {
    enum Status: String, Codable, Sendable { case detected, lowConfidence = "low-confidence", notEnoughHistory = "not-enough-history", failed }
    let status: Status
    let confidence: String?        // "high" | "medium" | "low"
    let reasons: [String]
    let planes: [Plane]            // azimuth, tilt, dcKwp, effectiveKw, azimuthRange90, tiltRange90
    let acClipKw: Double?
    let historyDays: Int
    let clearDays: Int
    let firstDay: String?
    let lastDay: String?
}
enum SolarLayoutDetector {
    static let version = 2
    static func detect(samples: [(timestamp: Date, solarWh: Double)], latitude: Double, longitude: Double,
                       timeZone: TimeZone, checkCancellation: () throws -> Void) throws -> DetectedSolarLayout
    /// The layout the forecast may use: only detected with high or medium confidence (mirrors `toMobileSolarLayout`).
    static func forecastLayout(_ result: DetectedSolarLayout, detectedAt: Date) -> SolarLayout?
}
```

`shading` is not carried: nothing on the phone uses it.

- [ ] **Step 1: Failing tests.** `testResultMatchesFixture` per fixture: `status`, `confidence`, `reasons`, plane count, `historyDays`, `clearDays`, `firstDay`, `lastDay` exact; azimuth/tilt within 0.5°; `dcKwp`, `effectiveKw`, `acClipKw` within 1%. `testYearOfZerosIsNotEnoughHistory` (generated in Swift). `testCancellationStopsDetection`: a `checkCancellation` that throws on its 3rd call makes `detect` throw `CancellationError`. `testForecastLayoutRejectsLowConfidence`.
- [ ] **Step 2:** Run `PWUsageTests/SolarLayoutDetectorTests`. Expected: FAIL.
- [ ] **Step 3:** Implement. `SolarLayoutResearchParityTests` reads `site-*.csv` + `inputs.json` from `PWUSAGE_SOLAR_PARITY_DIR` (same format as `scripts/solar-layout-parity.ts`), writes `<site>.swift.json` beside each, and is skipped (`XCTSkip`) when the variable is unset. Research data never enters the repo.
- [ ] **Step 4:** Rerun. Expected: PASS (research test skipped).
- [ ] **Step 5: Device timing.** Run `east-west-year` on a physical iPhone (a Release-configuration timing test, or a temporary debug button) and record the time in this plan under Task 5. If it exceeds 30 s, stop and raise it with the owner before Phase C. A background processing task has minutes, but foreground detection is only acceptable if it is short.
  - Recorded 2026-10-30. Mac, `swiftc -O` (Release-like): `east-west-year` took 6.17 s, `south-clipped-year` 5.79 s, and the full results match the TypeScript fixture results. iOS Simulator Debug: 582 s, because the test build is unoptimized; the year fixtures therefore run only behind `TEST_RUNNER_PWUSAGE_SOLAR_SLOW_PARITY=1`. **Still open (owner):** time it on a physical iPhone in a Release build before Phase C.
- [ ] **Step 6:** Commit: `feat(ios): port solar layout detector with fixture parity`.

## Phase B: History endpoint (server)

### Task 6: `GET /api/mobile/solar-history`

**Files:**
- Modify: `cmd/next-app/src/lib/prototypes/compact-history-store.ts` (add `readSolarDays`)
- Create: `cmd/next-app/src/app/api/mobile/solar-history/route.ts`
- Test: `cmd/next-app/src/app/api/mobile/solar-history/route.test.ts`, plus a store test next to the existing `CompactHistoryStore` tests

**Interfaces:**
- Produces:

```ts
// CompactHistoryStore
readSolarDays(siteId: string, from: Date, end: Date, changedSince: Date | null, limit: number):
    Promise<{ dayStart: Date; status: DayRecordStatus | null; fetchedAt: Date | null; samples: { timestamp: Date; solarWh: number }[] }[]>;

// Response, version 1
type MobileSolarHistory =
    | { version: 1; enabled: false }
    | { version: 1; enabled: true; timeZone: string;
        days: { day: string /* site-local YYYY-MM-DD */; dayStart: string /* ISO */; status: 'open' | 'complete' | 'gapped' | 'empty';
                fetchedAt: string | null; solarWh: (number | null)[] /* slot i = dayStart + 5i min, Wh rounded to 0.1, null = missing */ }[];
        nextFrom: string | null };
```

Query: `siteId` (required), `from` (site-local `YYYY-MM-DD`, required, not earlier than 400 days before today; otherwise 400), `changedSince` (optional ISO; only days whose `fetched_at` is later). Ordered by `day_start`, at most 92 days per page; `nextFrom` is the day after the last one returned when more remain. `solarWh` length is the day's real slot count (276/288/300).

- [ ] **Step 1: Failing tests.** 400 without `siteId`/`from`; 401 when `verifySiteAccess` fails; `{ enabled: false }` without the beta role; paging returns 92 days plus `nextFrom`, then the rest with `nextFrom: null`; `changedSince` excludes older `fetched_at`; a fall-back DST day has 300 slots; a missing slot is `null`; `from` 401 days back gives HTTP 400; response sets the no-store header.
- [ ] **Step 2:** `npm test -- src/app/api/mobile/solar-history`. Expected: FAIL.
- [ ] **Step 3:** Implement `readSolarDays` by reusing the store's existing day-record decoding (decode only the solar channel), then the route, structured like `src/app/api/mobile/solar-actuals/route.ts`.
- [ ] **Step 4:** Rerun, then `npm run lint && npm run build`. Expected: PASS.
- [ ] **Step 5: Egress check.** On the Dev DB, measure one year's first sync (sum of response sizes and query bytes) for the Harrison site and note it in the PR, per the cron egress practice.
- [ ] **Step 6:** Commit, push, open the PR: `feat(api): serve solar day history to the phone`.

## Phase C: iOS wiring

### Task 7: Solar history store and hourly actuals

**Files:**
- Create: `cmd/ios-app/PWUsage/State/Solar/solar-history-store.swift`
- Modify: `cmd/ios-app/PWUsage/Networking/PWUsageAPI.swift` (add `fetchSolarHistory`)
- Create: `cmd/ios-app/PWUsage/Models/Solar/mobile-solar-history.swift`
- Test: `cmd/ios-app/PWUsageTests/SolarHistoryStoreTests.swift`

**Interfaces:**
- Consumes: Task 6 contract; existing `SolarForecastSiteScope`, `MobileSolarActualsHour`.
- Produces:
  - `enum MobileSolarHistoryResponse: Decodable { case disabled; case enabled(timeZone: TimeZone, days: [Day], nextFrom: String?) }`.
  - `func fetchSolarHistory(siteID: String, from: String, changedSince: Date?) async throws -> MobileSolarHistoryResponse` on `PWUsageAPI`.
  - `actor SolarHistoryStore` persisted in `Application Support/SolarHistory/` (one file per scope, named by a SHA-256 of the scope like `DeviceSolarForecastPersistence`), with:
    - `func sync(scope: SolarForecastSiteScope, api: SolarHistoryFetching, now: Date) async throws -> SolarHistorySyncResult` (`.disabled` or `.synced(timeZone:)`). First sync uses `from = today − 365` and no `changedSince`; later syncs pass the newest `fetchedAt` held. Follows `nextFrom`, replaces returned days, prunes days older than 400.
    - `func samples(scope:) -> [(timestamp: Date, solarWh: Double)]`, `func lastDay(scope:) -> String?`.
    - `func hourlyActuals(scope:, now: Date) -> [MobileSolarActualsHour]` (Swift port of `hourlySolarWh` + `solarActualsWindow`: 14 local days plus today, UTC hours, `complete` only with 12 valid slots).
    - `func remove(scope:)` and `func removeAll()`, called wherever the app clears account data on sign-out.

- [ ] **Step 1: Failing tests.** First sync follows paging; incremental sync sends `changedSince` and replaces a day whose record changed; pruning drops day 401; `.disabled` clears the scope's file; `hourlyActuals` matches the cases in `hourly-actuals.test.ts` (copy their inputs and expectations); a DST day maps to the right UTC hours; sign-out removes every file.
- [ ] **Step 2:** `./run-tests.sh PWUsageTests/SolarHistoryStoreTests`. Expected: FAIL.
- [ ] **Step 3:** Implement. Store samples as `Float` per slot plus `dayStart`, not as timestamp pairs (about 1.3 MB/year per site).
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ios): cache solar day history on device`.

### Task 8: Local layout record

**Files:**
- Create: `cmd/ios-app/PWUsage/State/Solar/solar-layout-record-store.swift`
- Test: `cmd/ios-app/PWUsageTests/SolarLayoutRecordStoreTests.swift`

**Interfaces:**
- Consumes: Task 5 `DetectedSolarLayout`; existing `SolarHomeLocation`, `MobileSolarLayoutResponse`.
- Produces:

```swift
struct SolarLayoutRecord: Codable, Equatable, Sendable {
    var location: SolarHomeLocation?
    var locationSetAt: Date?
    var result: DetectedSolarLayout?
    var detectedAt: Date?
    var attemptedAt: Date?
    var detectorVersion: Int?
    /// The status the UI consumes. `historyEnabled == false` → `.disabled`; no location → needs-location;
    /// no result for this location and detector version → pending; otherwise detected / not-enough-history / low-confidence.
    func response(historyEnabled: Bool) -> MobileSolarLayoutResponse
}
actor SolarLayoutRecordStore {
    func record(scope: SolarForecastSiteScope) -> SolarLayoutRecord?
    func setLocation(_ location: SolarHomeLocation, scope:, at: Date)   // rounds to 2 decimals; clears result if it moved
    func saveResult(_ result: DetectedSolarLayout, scope:, for location: SolarHomeLocation, at: Date) -> Bool // false if location changed
    func remove(scope:); func removeAll()
}
```

`MobileSolarLayoutResponse` needs a memberwise way to build `.enabled(...)` and `SolarLayout` needs its existing init; no change to its decoding.

- [ ] **Step 1: Failing tests.** `response` for each state; `setLocation` with an unrounded value stores 2 decimals; moving the location clears the result, while the same rounded location keeps it; `saveResult` for a stale location returns false and saves nothing; no record gives needs-location (or `.disabled` when history is disabled).
- [ ] **Step 2:** Run `PWUsageTests/SolarLayoutRecordStoreTests`. Expected: FAIL.
- [ ] **Step 3:** Implement with the same file persistence pattern as Task 7 (`Application Support/SolarLayout/`).
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ios): keep solar layout and home location on device`.

### Task 9: Detection runner and background task

**Files:**
- Create: `cmd/ios-app/PWUsage/State/Solar/solar-layout-detection-runner.swift`
- Create: `cmd/ios-app/PWUsage/State/Solar/background-solar-layout-detection.swift`
- Modify: `cmd/ios-app/PWUsage/Info.plist` (`BGTaskSchedulerPermittedIdentifiers` += `fm.rodeo.pwusage.solar-layout-detect`)
- Modify: the app's background task registration next to `BackgroundSolarForecastRefresh`
- Test: `cmd/ios-app/PWUsageTests/SolarLayoutDetectionRunnerTests.swift`

**Interfaces:**
- Consumes: Tasks 5, 7, 8.
- Produces:

```swift
enum SolarLayoutDetectionSchedule {
    /// Due when there is a location and: no result, a detector version other than `SolarLayoutDetector.version`,
    /// or the cadence has elapsed since `attemptedAt`: 30 days for detected / low-confidence,
    /// 24 hours for not-enough-history / failed (the server's cadence today).
    static func isDue(_ record: SolarLayoutRecord, now: Date) -> Bool
    static func nextDue(_ record: SolarLayoutRecord) -> Date?
}
@MainActor final class SolarLayoutDetectionRunner {
    init(history: SolarHistoryStore, records: SolarLayoutRecordStore, api: SolarHistoryFetching,
         detect: @escaping @Sendable ([(timestamp: Date, solarWh: Double)], Double, Double, TimeZone, () throws -> Void) throws -> DetectedSolarLayout,
         now: @escaping () -> Date)   // production passes SolarLayoutDetector.detect
    /// Syncs history, then detects off the main actor at `.utility` priority if due. Returns the updated record,
    /// or nil if cancelled, disabled or the scope changed. A thrown detection error saves status `.failed`.
    func runIfDue(scope: SolarForecastSiteScope) async -> SolarLayoutRecord?
    func cancel()
    var onRecordChanged: ((SolarForecastSiteScope) -> Void)?
}
```

The background task is a `BGProcessingTaskRequest` with `requiresNetworkConnectivity = true`, `requiresExternalPower = false`, `earliestBeginDate = nextDue`, submitted whenever a record is saved or the app goes to the background with a due record. Its expiration handler calls `runner.cancel()`.

- [ ] **Step 1: Failing tests.** `isDue` for each cadence and for a version bump from 1 to 2; `runIfDue` saves a result and calls `onRecordChanged`; a location change during detection discards the result (`saveResult` false) and leaves the record due; `cancel()` during detection saves nothing and leaves the record due; a scope switch while detecting doesn't publish; a detect error records `.failed` with `attemptedAt`; `.disabled` history stops without detecting.
- [ ] **Step 2:** Run `PWUsageTests/SolarLayoutDetectionRunnerTests`. Expected: FAIL.
- [ ] **Step 3:** Implement. Detection runs in a `Task.detached(priority: .utility)` whose `checkCancellation` is `Task.checkCancellation`.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ios): run solar layout detection on device`.

### Task 10: Coordinator switch-over

**Files:**
- Modify: `cmd/ios-app/PWUsage/State/Home/dashboard-coordinator-solar-layout.swift`, `dashboard-coordinator-home-location.swift`, `dashboard-coordinator-solar.swift`, `dashboard-coordinator-automatic-forecast.swift`, `dashboard-coordinator.swift`
- Modify: `cmd/ios-app/PWUsage/App/pwusage-app-model-background-forecast.swift` (background forecast reads the local record and history)
- Delete: `cmd/ios-app/PWUsage/State/Solar/solar-layout-revalidation.swift` once no polling remains
- Modify tests: `AutomaticForecastCoordinatorTests`, `AutomaticForecastLifecycleTests`, `SolarLocationCoordinatorTests`, `BackgroundSolarForecastTests` and their fixtures

**Interfaces:**
- Consumes: Tasks 7–9.
- Produces: `solarLayoutLookup(siteID:operation:)` keeps its signature and return type. It reads the local record, starts `runner.runIfDue` in the background, and returns `record.response(historyEnabled:)`. The runner's `onRecordChanged` replaces the revalidation timer: it calls `invalidateSolarLayout()` and reloads when the scope is still selected. `shareHomeLocation` calls `records.setLocation` instead of `postSolarLocation`, then `runIfDue`. Solar actuals come from `history.hourlyActuals`.

- [ ] **Step 1: Update failing tests first.** Replace the stubbed `fetchSolarLayout`/`fetchSolarActuals`/`postSolarLocation` with stub stores and a stub runner. Keep every existing behavioural assertion (statuses shown, nothing automatic when disabled, account switch clears state). Add: sharing a location never calls the network except the history sync; the transitional "pending" status updates when the runner finishes, with no timer.
- [ ] **Step 2:** `./run-tests.sh`. Expected: the updated tests FAIL.
- [ ] **Step 3:** Implement. Remove `fetchSolarLayout`, `postSolarLocation` and `fetchSolarActuals` from `PWUsageAPI` and their response types that nothing else uses.
- [ ] **Step 4:** `PWUSAGE_TEST_TIMEOUT_SECONDS=1200 ./run-tests.sh`. Expected: PASS.
- [ ] **Step 5: Simulator check.** With a beta account on the Dev server: fresh install → share location → status goes pending → detected without leaving the screen; relaunch shows it from disk with no layout request in the server logs.
- [ ] **Step 6:** Commit, push, open the PR: `feat(ios): detect solar layout on device`. The wrap-up gives the worktree path and the `open …/PWUsage.xcodeproj` command for the on-device check.

### Task 11: iCloud sync of the layout record

**Files:**
- Create: `cmd/ios-app/PWUsage/State/Solar/solar-layout-cloud-sync.swift`
- Modify: `cmd/ios-app/PWUsage/PWUsage.entitlements`, `cmd/ios-app/project.yml` (iCloud container `iCloud.fm.rodeo.pwusage`, CloudKit service; app target only)
- Test: `cmd/ios-app/PWUsageTests/SolarLayoutCloudMergeTests.swift`

**Interfaces:**
- Consumes: Task 8.
- Produces:
  - `enum SolarLayoutCloudMerge { static func merge(local: SolarLayoutRecord?, remote: SolarLayoutRecord) -> SolarLayoutRecord }`. Location: newer `locationSetAt` wins. Result: higher `detectorVersion` wins, then newer `attemptedAt`, and only if it was computed for the merged location (otherwise dropped, leaving the record due).
  - `actor SolarLayoutCloudSync` on `CKSyncEngine`, private database, zone `SolarLayout`, record type `SolarLayoutRecord`, record name = site ID. Latitude, longitude, location source and `locationSetAt` go in `encryptedValues`; the result goes as JSON data. Started after sign-in, stopped and its state cleared on sign-out. No iCloud account means local only, with no error shown.

- [ ] **Step 1: Failing tests** for `merge`: each precedence rule above, a remote result for an old location is dropped, nil local takes the remote.
- [ ] **Step 2:** Run `PWUsageTests/SolarLayoutCloudMergeTests`. Expected: FAIL.
- [ ] **Step 3:** Implement `merge`, then the sync engine. `SolarLayoutRecordStore` calls `sync.recordChanged(scope)` after every write and applies fetched records through `merge`.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Owner step.** Create the iCloud container in the Apple Developer portal and add it to the app ID. Then on two devices signed into the same Apple ID, check that a location shared on one shows a detected layout on the other without the location prompt.
- [ ] **Step 6:** Commit: `feat(ios): sync solar layout across devices through iCloud`.

## Phase D: Server removal

Start once the owner's phone runs a build with Task 10. An older build would get 404s, decode them as `invalidResponse` and fall back to history-based behaviour.

### Task 12: Remove server layout detection and storage

**Files:**
- Create: `cmd/next-app/db-migrations/<timestamp>_drop_site_solar_layout.sql`
- Delete: `src/app/api/cron/detect-solar-layouts/`, `src/app/api/mobile/solar-layout/`, `src/app/api/mobile/solar-actuals/`, `src/lib/solar-layout-repo.ts`(+test), `src/lib/solar-layout/` (whole folder), `scripts/solar-layout-parity.ts`, `scripts/solar-layout-postgres.test.ts`, `scripts/test-solar-layout-postgres.sh`, `scripts/solar-layout-fixtures.ts`
- Modify: `src/lib/solar-beta-admin-repo.ts`, `src/app/api/admin/solar-beta/route.ts`(+test), `src/app/admin/SolarBetaManager.tsx` (keep the role toggle; drop location seeding and layout columns)
- Modify: `src/app/privacy/page.tsx`, `CLAUDE.md` (Key Data Models: remove `SiteSolarLayout`), `TODO.md`, the auto solar forecast spec (dated note pointing here), `scripts/solar-layout-reference/README.md` (parity now runs against the Swift port via `PWUSAGE_SOLAR_PARITY_DIR`)

Migration body:

```sql
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
       AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'detect-solar-layouts-trigger') THEN
        PERFORM cron.unschedule('detect-solar-layouts-trigger');
    END IF;
END $$;
DROP TABLE IF EXISTS "SiteSolarLayout";
```

- [ ] **Step 1:** `grep -rn "SiteSolarLayout\|solar-layout\|solar-actuals\|detect-solar-layouts" cmd/next-app docs .github` and list every hit. Each one is either deleted here or is history (old migrations and plans stay).
- [ ] **Step 2:** Make the deletions and edits. The privacy copy says the home location stays on the user's devices and their private iCloud, and is sent rounded to Open-Meteo only.
- [ ] **Step 3:** `npm run lint && npm run build && npm test` in `cmd/next-app`; `PWUSAGE_TEST_TIMEOUT_SECONDS=1200 ./run-tests.sh` in `cmd/ios-app`. Expected: PASS. The PR's migration test against the Dev copy passes, and running it twice is a no-op.
- [ ] **Step 4:** Commit, push, open the PR: `chore(solar): remove server-side layout detection`.
