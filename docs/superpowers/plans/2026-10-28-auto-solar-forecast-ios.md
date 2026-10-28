# Auto-configured Solar Forecast — iOS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For beta users without Solcast, fetch a Forecast.Solar forecast on the phone for the server-detected panel layout, correct every provider's forecast (Solcast included) by how it has compared with actual production, and feed the result to Smart Shift unchanged.

**Architecture:** A new `ForecastSolarClient` and `AutomaticSolarForecastStore` sit beside the existing Solcast client and store; the Solcast store is not refactored. `DashboardCoordinator` picks the source per site (Solcast credential → Solcast; else a server layout → automatic; else today's history path). A provider-neutral `SolarForecastHistory` records what each provider forecast for each hour, and `SolarForecastCorrection` scales any batch by hour-of-day ratios from the last 14 days against `/api/mobile/solar-actuals`. The settings sheet gains a location step and shows the source and detected layout.

**Tech Stack:** Swift 6, SwiftUI, Swift Testing (`@Suite`/`@Test`/`#expect`), CoreLocation, XcodeGen (`project.yml`). Tests run with `cmd/ios-app/run-tests.sh [-only-testing:PWUsageTests/<Suite>]`.

**Spec:** `docs/superpowers/specs/2026-10-27-auto-solar-forecast-design.md` (server side shipped in #244). Owner decision after the spec: the correction is provider-neutral and applies to Solcast too, subject to Task 1.

## Global Constraints

- Work in `cmd/ios-app`. Run `./run-tests.sh` (full) before finishing. Regenerate the project with `./generate.sh` after adding files or `project.yml` keys.
- Server contracts (already live, version 1):
  - `GET /api/mobile/solar-layout?siteId=` → `{ version: 1, enabled: false }` or `{ version: 1, enabled: true, location: { latitude, longitude } | null, layout: { planes: [{ azimuth, tilt, dcKwp }], acClipKw: number | null, confidence: "high" | "medium", detectedAt } | null, reason: "needs-location" | "pending" | "not-enough-history" | "low-confidence" | null }`. Azimuth is compass degrees.
  - `POST /api/mobile/solar-layout` body `{ siteId, latitude, longitude }` → 204; 403 when not beta.
  - `GET /api/mobile/solar-actuals?siteId=` → `{ version: 1, asOf, hours: [{ hourStart, wh, complete }] }` (UTC hour starts).
  - Confirm the exact JSON keys against `cmd/next-app/src/lib/solar-layout/mobile-contract.ts` and `src/app/api/mobile/solar-actuals/route.ts` before writing decoders.
- Forecast.Solar public API: `https://api.forecast.solar/estimate/{lat}/{lon}/{dec}/{az}/{kwp}`; lat/lon with 2 decimals; `dec` = tilt rounded to an integer 0–90; `az` = compass − 180 normalised to −180…180 and rounded to an integer; `kwp` = `dcKwp` with 2 decimals. One request per plane, at most 3 planes.
- Forecast.Solar budget: at most 6 requests per rolling hour per device; on 429 honour `Retry-After` and do not retry before it. Refresh after 3 h; usable for 6 h (same as `SolarForecastStore.foregroundRefreshThreshold` / `recommendationFreshness`).
- Response parsing: `result.watt_hours_period` keys are local time (`YYYY-MM-DD HH:MM:SS`) in `message.info.timezone`; each value is Wh for (previous key, key]. Output must be contiguous `SolarForecastInterval`s from local midnight today to local midnight after tomorrow, with zero-kW intervals for night and gaps. `cautiousPowerKw` stays `nil`.
- Correction: per local hour of day, factor = Σ actual Wh ÷ Σ forecast Wh over the last 14 days, using only hours where the actual is `complete` and both values exist and the forecast is > 50 Wh; clamp to 0.5…1.5; an hour with fewer than 5 qualifying samples uses the all-day ratio (same clamp); no qualifying data → 1.0. The forecast used for a past hour is the latest one fetched before that hour started.
- Location: When-In-Use, one fix, rounded to 2 decimals before it leaves the device; only offered for the selected site after "Are you at <site name> now?"; never requested in the background; never re-requested automatically.
- Hide every new UI element and skip every new request when `solar-layout` says `enabled: false` (except that one GET). Copy follows the app's voice guide (`docs/` — search for "voice guide"); no "Battery Hold", use current names.
- Solcast keys, resource IDs and Solcast behaviour stay exactly as today apart from the correction.

## Review Focus

- **User sets up Solcast after using the automatic forecast (or disconnects Solcast)** → the source switches on the next appearance with no stale automatic batch shown under the Solcast label and vice versa. Test in Task 6.
- **Forecast.Solar returns only today (late evening) or a day with sunrise/sunset at odd minutes** → still contiguous through local midnight after tomorrow or rejected as `incompleteCoverage`, never a gap Smart Shift trips on. Test in Task 3.
- **Phone in a different time zone from the site (travelling)** → intervals and hour-of-day correction use the site's zone from the layout/planning context, not the device's. Test in Tasks 3 and 5.
- **Location permission denied, restricted, or the fix fails** → the settings row explains and offers Settings; nothing is posted; Smart Shift keeps the history path. Test in Task 7.
- **A layout with an inverter limit lower than the summed plane forecast** → summed kW is clipped to `acClipKw` before correction, and correction never pushes a value above `acClipKw`. Test in Tasks 3 and 5.

---

### Task 1: Check the correction on past captures (local, no app code)

Decides whether the correction is switched on for Solcast at launch.

**Files (outside the repo, never committed):** `/Users/kevm/github/pwusage/.forecast-compare/score.py`

- [ ] **Step 1:** Add sources `solcast_corrected` and `fs_fitted_flat_corrected` to `score.py`: for each scored day, compute the Global Constraints correction from the previous 14 days of that source's own captures (latest capture before each hour) and the actuals already loaded, apply it to that day's forecast, and score it like the others.
- [ ] **Step 2:** Run `/Users/kevm/github/pwusage/.forecast-compare/venv/bin/python /Users/kevm/github/pwusage/.forecast-compare/score.py` and record the day-ahead summary rows for `solcast`, `solcast_corrected`, `fs_fitted_flat`, `fs_fitted_flat_corrected`, `history_14d_median` in the PR description, with the number of scored days.
- [ ] **Step 3:** Set `SolarForecastCorrection.appliesToSolcast` (Task 5) to `true` only if `solcast_corrected` beats `solcast` on both daily and hourly error; otherwise `false` and say so in the PR. Fewer than 10 scored days → `false` with a TODO.md note to revisit.

---

### Task 2: Mobile API for layout, location and actuals

**Files:**
- Create: `PWUsage/Models/MobileSolarLayout.swift`
- Modify: `PWUsage/Networking/PWUsageAPI.swift`, `PWUsage/State/DashboardCoordinator.swift` (protocol declaration only), `PWUsage/PWUsageApp.swift` (`PWUsageApplicationAPI` adds the new protocol)
- Test: `PWUsageTests/MobileSolarLayoutTests.swift`

**Interfaces:**
- Produces:
  - `struct SolarLayoutPlane: Codable, Equatable, Sendable { let azimuth: Double; let tilt: Double; let dcKwp: Double }`
  - `enum MobileSolarLayoutReason: String, Codable, Sendable { case needsLocation = "needs-location", pending, notEnoughHistory = "not-enough-history", lowConfidence = "low-confidence" }`
  - `enum MobileSolarLayoutResponse: Equatable, Sendable { case disabled; case enabled(location: SolarHomeLocation?, layout: SolarLayout?, reason: MobileSolarLayoutReason?) }` with `struct SolarHomeLocation { latitude: Double; longitude: Double }` and `struct SolarLayout { planes: [SolarLayoutPlane]; acClipKw: Double?; confidence: SolarLayoutConfidence; detectedAt: Date }`, `enum SolarLayoutConfidence: String { case high, medium }`.
  - `struct MobileSolarActualsResponse: Decodable, Equatable, Sendable { let asOf: Date; let hours: [Hour] }`, `struct Hour { let hourStart: Date; let wh: Double; let complete: Bool }`.
  - `@MainActor protocol MobileSolarLayoutDataAPI: Sendable { func fetchSolarLayout(siteID: String) async throws -> MobileSolarLayoutResponse; func postSolarLocation(siteID: String, latitude: Double, longitude: Double) async throws; func fetchSolarActuals(siteID: String) async throws -> MobileSolarActualsResponse }`, implemented by `PWUsageAPI`.

- [ ] **Step 1: Failing tests** — decode `{"version":1,"enabled":false}` → `.disabled`; decode a detected two-plane payload → `.enabled` with planes `[(90, 18, 5.6), (270, 18, 4.0)]`, `confidence .high`; decode `reason:"low-confidence"` with `layout:null`; reject `version: 2` with `PWUsageAPIError.invalidResponse`; decode actuals with `complete:false`; `postSolarLocation` sends JSON with `latitude` and `longitude` rounded to 2 decimals (assert on the captured request body using the existing request-capturing test transport in `PWUsageAPI` tests).
- [ ] **Step 2:** `./run-tests.sh -only-testing:PWUsageTests/MobileSolarLayoutTests` → FAIL.
- [ ] **Step 3:** Implement with `MobileContractDecoder` and `makeURL(path:siteID:)` like `fetchLoadPlanningContext`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(ios): mobile solar layout, location and actuals API`

---

### Task 3: Forecast.Solar client and interval conversion

**Files:**
- Create: `PWUsage/Networking/ForecastSolarClient.swift`
- Create: `PWUsage/Models/ForecastSolarForecast.swift`
- Test: `PWUsageTests/ForecastSolarClientTests.swift`

**Interfaces:**
- Consumes: `SolarLayoutPlane`, `SolarHomeLocation`, `SolarForecastInterval`, `SolarForecastError`.
- Produces:
  - `protocol ForecastSolarTransport: Sendable { func data(for request: URLRequest) async throws -> (Data, URLResponse) }`
  - `enum ForecastSolarClientError: Error, Equatable { case transportFailure, invalidResponse, decodingFailure, rateLimited(retryAfter: Date?), httpStatus(Int) }`
  - `struct ForecastSolarPlaneEstimate: Equatable, Sendable { let timeZone: TimeZone; let wattHoursPeriod: [(end: Date, wh: Double)] }` (Equatable by value)
  - `struct ForecastSolarClient: Sendable { init(transport: (any ForecastSolarTransport)? = nil, timeout: TimeInterval = 30); func estimate(location: SolarHomeLocation, plane: SolarLayoutPlane) async throws -> ForecastSolarPlaneEstimate }` — same hardening as `SolcastClient` (ephemeral session, no cookies, redirects rejected, host must be `api.forecast.solar`, bounded timeout); URL per Global Constraints.
  - `enum ForecastSolarForecast { static func intervals(estimates: [ForecastSolarPlaneEstimate], acClipKw: Double?, siteTimeZone: TimeZone, now: Date) throws -> [SolarForecastInterval] }` — one-hour intervals from local midnight today to local midnight after tomorrow in `siteTimeZone`; each period's Wh assigned to the hour(s) it overlaps in proportion; planes summed; clipped to `acClipKw`; throws `.incompleteCoverage` if any plane lacks tomorrow's last daylight period.
  - `static func forecastSolarAzimuth(compass: Double) -> Int` (90 → −90, 270 → 90, 180 → 0, 0 → 180 or −180 accepted, 350 → 170).

- [ ] **Step 1: Failing tests**
  - URL for `(43.39, -87.87)` and plane `(90, 18.4, 5.6)` is `https://api.forecast.solar/estimate/43.39/-87.87/18/-90/5.60`.
  - Decoding a captured response (use `/Users/kevm/github/pwusage/.forecast-compare/captures/20261024T103515Z.json`'s `fs_true_east_west` first plane as a fixture; copy only that plane's `response` JSON into the test, it contains no personal data beyond the rounded location — replace lat/lon/place with 40.00/-100.00/"Test" first).
  - Intervals: contiguous, 48 one-hour intervals on a normal day pair, 49 across the 2026-11-01 fall-back in `America/Chicago`; night intervals are 0 kW; total energy equals Σ `watt_hours_period` ÷ 1000 within 0.1%.
  - A sunrise key at `07:15:37` splits its Wh between the 06:00 and 07:00 hours in proportion to overlap.
  - Two planes summed; `acClipKw: 3` caps every interval at 3 kW.
  - Only today's data → throws `SolarForecastError.incompleteCoverage`.
  - `siteTimeZone` `America/Chicago` with the device in `Asia/Tokyo` gives the same intervals (set `TimeZone` explicitly, not `.current`).
  - 429 with `Retry-After: 120` → `.rateLimited(retryAfter: now + 120)`.
- [ ] **Step 2:** `./run-tests.sh -only-testing:PWUsageTests/ForecastSolarClientTests` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(ios): Forecast.Solar client and interval conversion`

---

### Task 4: Automatic forecast store and forecast history

**Files:**
- Create: `PWUsage/State/AutomaticSolarForecastStore.swift`
- Create: `PWUsage/State/SolarForecastHistory.swift`
- Modify: `PWUsage/State/SolarForecastStore.swift` (record each successful batch into `SolarForecastHistory`; no other change)
- Modify: `PWUsage/PWUsageApp.swift`, `PWUsage/Authentication/MobileAuthService.swift` (sign-out clears both new stores, as for `SolarForecastStore`)
- Test: `PWUsageTests/AutomaticSolarForecastStoreTests.swift`, `PWUsageTests/SolarForecastHistoryTests.swift`

**Interfaces:**
- Consumes: `ForecastSolarClient`, `ForecastSolarForecast.intervals`, `SolarLayout`, `SolarHomeLocation`, `SolarForecastClock`, `SolarForecastBatch`, `SolarForecastRefreshResult`.
- Produces:
  - `enum SolarForecastProvider: String, Codable, Sendable { case solcast, forecastSolar }`
  - `actor SolarForecastHistory { static let shared; func record(provider: SolarForecastProvider, scope: String, intervals: [SolarForecastInterval], fetchedAt: Date) async; func pastForecast(provider: SolarForecastProvider, scope: String, from: Date, to: Date) async -> [Date: Double] /* hour start → Wh, latest fetch before the hour */; func clear() async }` — keeps 15 days, persisted to `Application Support/SolarForecast/history.json` with complete file protection.
  - `actor AutomaticSolarForecastStore { static let shared; func refresh(scope: String, location: SolarHomeLocation, layout: SolarLayout, siteTimeZone: TimeZone, manual: Bool) async -> SolarForecastRefreshResult; func cachedBatch(scope: String) async -> SolarForecastBatch?; func isRecommendationUsable(scope: String) async -> Bool; func clear() async }` — batch `credentialID` is `"forecast-solar"` and `resourceIDs` are `[]`; a changed layout (`detectedAt`) or location invalidates the cache; budget per Global Constraints, tracked as request timestamps; on success records into `SolarForecastHistory` with provider `.forecastSolar`.

- [ ] **Step 1: Failing tests**
  - `refresh` with a fake transport makes one request per plane and caches a batch; a second call within 3 h returns `.alreadyFresh` with no request.
  - Seventh request in one rolling hour (manual refreshes) → `.budgetExhausted`, no request sent.
  - 429 `Retry-After: 600` → `.failed(.rateLimited)` and refresh before then is `.deferred`.
  - New `detectedAt` → cache dropped, next refresh fetches.
  - Batch is usable at 5 h 59 m, not at 6 h 01 m.
  - `SolarForecastHistory.pastForecast` returns the value from the fetch at 05:30 for the 09:00 hour when fetches were at 05:30 and 10:00 (latest before the hour start); entries older than 15 days are dropped on record.
  - `SolarForecastStore` records a successful Solcast refresh into history with provider `.solcast` (extend `SolarForecastStoreTests`).
- [ ] **Step 2:** Run the three suites → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(ios): automatic Forecast.Solar store and provider-neutral forecast history`

---

### Task 5: Provider-neutral correction

**Files:**
- Create: `PWUsage/Models/SolarForecastCorrection.swift`
- Test: `PWUsageTests/SolarForecastCorrectionTests.swift`

**Interfaces:**
- Consumes: `SolarForecastInterval`, `MobileSolarActualsResponse`, `SolarForecastHistory.pastForecast` output (`[Date: Double]`).
- Produces:
  - `struct SolarForecastCorrection: Equatable, Sendable { let hourFactors: [Int: Double] /* local hour 0–23 */; let fallbackFactor: Double; static let identity }`
  - `static func derive(pastForecastWh: [Date: Double], actuals: [MobileSolarActualsResponse.Hour], siteTimeZone: TimeZone) -> SolarForecastCorrection` — rules in Global Constraints.
  - `func apply(to intervals: [SolarForecastInterval], siteTimeZone: TimeZone, acClipKw: Double?) -> [SolarForecastInterval]` — scales `powerKw` and `cautiousPowerKw` by the factor of the interval start's local hour; re-clips to `acClipKw`.
  - `static let appliesToSolcast: Bool` — value from Task 1.

- [ ] **Step 1: Failing tests**
  - Actual is 80% of forecast in every hour for 14 days → every factor 0.8.
  - Morning hours actual 50% of forecast, afternoon 120% → factors 0.5 and 1.2 for those hours.
  - Actual 3× forecast → clamped to 1.5; actual 0 → 0.5.
  - An hour with 4 qualifying samples uses the all-day factor; no data → `identity`.
  - Hours with `complete: false` or forecast ≤ 50 Wh are ignored.
  - Site `America/Chicago`, device `Asia/Tokyo` → the factor for Chicago's 09:00 hour applies to the interval starting 09:00 Chicago time.
  - `apply` with `acClipKw: 4` never returns more than 4 kW.
- [ ] **Step 2:** `./run-tests.sh -only-testing:PWUsageTests/SolarForecastCorrectionTests` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(ios): provider-neutral solar forecast correction`

---

### Task 6: Source selection and wiring in DashboardCoordinator

**Files:**
- Modify: `PWUsage/State/DashboardCoordinator.swift` (`loadTimingDetailAppeared`, `refreshSolarForecast`, diagnostics)
- Modify: `PWUsage/Models/SmartShiftDiagnostics.swift` (include source and correction factors)
- Test: `PWUsageTests/DashboardCoordinatorTests.swift`, `PWUsageTests/SolarForecastCoordinatorTests.swift`

**Interfaces:**
- Consumes: `MobileSolarLayoutDataAPI`, `AutomaticSolarForecastStore`, `SolarForecastHistory`, `SolarForecastCorrection`, existing `forecastStore`.
- Produces:
  - `@Published private(set) var solarForecastSource: SolarForecastProvider?` and `@Published private(set) var solarLayoutStatus: MobileSolarLayoutResponse?` on the coordinator.
  - Selection, per appearance and pull-to-refresh: Solcast credential with arrays → existing path; else `fetchSolarLayout` → `.enabled` with a layout and location → automatic path using `AutomaticSolarForecastStore` with the same bill/context/site/time-zone gates as the Solcast path; else the existing `.basic` / history path. The layout response is cached per site for 6 h.
  - Before `solarForecastBatch = batch`: derive the correction from `SolarForecastHistory.pastForecast` (provider of the batch, last 14 days) and `fetchSolarActuals` (fetched alongside the planning context, cached per site for 1 h), and apply it when the provider is `.forecastSolar`, or `.solcast` and `SolarForecastCorrection.appliesToSolcast`. A failed actuals fetch means `identity`, never a failed enhancement.

- [ ] **Step 1: Failing tests**
  - No Solcast credential, layout enabled + detected → `solarForecastState == .enhanced`, `solarForecastSource == .forecastSolar`.
  - Solcast connected and layout available → Solcast used; the automatic store receives no refresh.
  - Solcast disconnected after an automatic batch existed → next appearance publishes the automatic batch, never the stale Solcast one; connecting Solcast → next appearance publishes Solcast, never the automatic batch.
  - `enabled: false` → no `fetchSolarActuals`, no automatic refresh, `.basic`.
  - `reason: low-confidence` → `.basic` with history; `solarLayoutStatus` exposes the reason.
  - Correction applied: history 80% → published intervals are 0.8× the store's batch; actuals fetch throws → published intervals equal the store's batch.
  - Diagnostics text includes `source: forecastSolar` and the 24 hour factors.
- [ ] **Step 2:** Run both suites → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS, then the full `./run-tests.sh`.
- [ ] **Step 5: Commit** — `feat(ios): choose solar forecast source and apply correction`

---

### Task 7: Location step and settings UI

**Files:**
- Create: `PWUsage/State/HomeLocationProvider.swift`
- Modify: `PWUsage/Views/SolarForecastSettingsSheet.swift`, `PWUsage/Views/SolarForecastSettingsStatus.swift`, `PWUsage/Views/SolarForecastPreviews.swift`
- Modify: `project.yml` (`NSLocationWhenInUseUsageDescription`: "PWUsage uses your home's approximate location once to work out which way your solar panels face.")
- Test: `PWUsageTests/HomeLocationProviderTests.swift`, `PWUsageTests/SolarForecastSettingsStatusTests.swift`

**Interfaces:**
- Consumes: `MobileSolarLayoutDataAPI.postSolarLocation`, `solarForecastSource`, `solarLayoutStatus`.
- Produces:
  - `protocol HomeLocationProviding: Sendable { func currentRoundedLocation() async throws -> SolarHomeLocation }`; `enum HomeLocationError: Error { case denied, restricted, unavailable }`; `final class DeviceHomeLocationProvider: HomeLocationProviding` (CLLocationManager, When-In-Use, `requestLocation()` once, 30 s timeout, rounds to 2 decimals).
  - `SolarForecastSettingsStatus.automaticSummary(response: MobileSolarLayoutResponse, source: SolarForecastProvider?) -> String?` — plain-language lines, e.g. `"Automatic forecast from Forecast.Solar"`, `"2 panel faces: east-facing about 5.6 kW, west-facing about 4 kW"` (compass words from 8-point rose; kW to 1 decimal, trailing `.0` dropped), `"We need about 6 weeks of solar history first"`, `"Your production doesn't match a clear panel layout yet"`, `"Waiting for your layout. This can take a few hours."`.
  - Settings sheet: when enabled and Solcast is not connected, an "Automatic forecast" section above the Solcast section: the summary lines; a "Use my home location" button when `needs-location`, which first asks "Are you at <site name> now?" and then posts; on `denied`/`restricted` an explanation with an "Open Settings" button; a footnote "Forecast by Forecast.Solar." when the automatic source is in use. Solcast section unchanged below it.

- [ ] **Step 1: Failing tests**
  - `currentRoundedLocation` with a fake manager returning 43.39321, −87.87154 → 43.39, −87.87.
  - Denied authorization → throws `.denied`, nothing posted (coordinator/settings model test with a fake API).
  - `automaticSummary` for planes `[(90, 18, 5.6), (270, 18, 4.0)]` → `"2 panel faces: east-facing about 5.6 kW, west-facing about 4 kW"`; one plane `(205, 20, 5.2)` → `"1 panel face: south-southwest-facing about 5.2 kW"`; each reason → its sentence; `.disabled` → `nil`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; add previews for each state in `SolarForecastPreviews.swift`.
- [ ] **Step 4:** Run → PASS; `./generate.sh` then the full `./run-tests.sh`.
- [ ] **Step 5:** On-device check list for the owner (in the PR): grant beta role on Dev, open settings, share location, wait for a cron run, confirm the layout sentence and that Smart Shift shows the forecast; deny location and confirm the explanation.
- [ ] **Step 6: Commit** — `feat(ios): home location step and automatic forecast settings`
