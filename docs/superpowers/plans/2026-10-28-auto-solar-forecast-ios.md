# Auto-configured Solar Forecast — iOS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For beta users without Solcast, fetch a Forecast.Solar forecast on the phone for the server-detected panel layout, correct every provider's forecast (Solcast included) by how it has compared with actual production, and feed the result to Smart Shift unchanged.

**Architecture:** A new `ForecastSolarClient` and `AutomaticSolarForecastStore` sit beside the existing Solcast client and store; the Solcast store is not refactored. `DashboardCoordinator` picks the source per site (Solcast credential → Solcast; else a server layout → automatic; else today's history path). A provider-neutral `SolarForecastHistory` records what each provider forecast for each hour, and `SolarForecastCorrection` scales any batch by hour-of-day ratios from the last 14 days against `/api/mobile/solar-actuals`. A small injectable automatic-store protocol provides the provider seam without moving Solcast credentials or its mature budget machinery. The settings sheet gains a location step and shows the source and detected layout.

**Tech Stack:** Swift 6, SwiftUI, Swift Testing (`@Suite`/`@Test`/`#expect`), CoreLocation, XcodeGen (`project.yml`). From `cmd/ios-app`, tests run with `./run-tests.sh <Suite>` or `./run-tests.sh` for the full bundle.

**Spec:** `docs/superpowers/specs/2026-10-27-auto-solar-forecast-design.md` (server side shipped in #244). Owner decision after the spec: the correction is provider-neutral and applies to Solcast too, subject to Task 1.

## Global Constraints

- Work in `cmd/ios-app`. Run `./run-tests.sh` (full) before finishing. Regenerate the project with `./generate.sh` after adding files or `project.yml` keys.
- Server contracts (already live, version 1):
  - `GET /api/mobile/solar-layout?siteId=` → `{ version: 1, enabled: false }` or `{ version: 1, enabled: true, location: { latitude, longitude } | null, layout: { planes: [{ azimuth, tilt, dcKwp }], acClipKw: number | null, confidence: "high" | "medium", detectedAt: string | null } | null, reason: "needs-location" | "pending" | "not-enough-history" | "low-confidence" | null }`. Azimuth is compass degrees.
  - `POST /api/mobile/solar-layout` body `{ siteId, latitude, longitude }` → 204; 403 when not beta.
  - `GET /api/mobile/solar-actuals?siteId=` → `{ version: 1, enabled: false }` or `{ version: 1, enabled: true, asOf: string, hours: [{ hourStart: string, wh: number, complete: boolean }] }`. Timestamps are ISO-8601; hour starts are UTC, `wh` is energy (not power), `complete` means 12 five-minute samples. The window is the 14 full site-local days before today plus today so far. A disabled response has no `asOf` or `hours`.
  - Both GETs and POST require site access (401 on failure); GETs return 400 for missing `siteId`, POST returns 400 for invalid JSON/coordinates. Responses are private/no-store. No timezone or low-confidence detail (such as `location-mismatch`) is exposed by the layout contract; use the planning context timezone and the generic low-confidence reason.
  - These contracts were checked against `cmd/next-app/src/lib/solar-layout/mobile-contract.ts` and `src/app/api/mobile/solar-actuals/route.ts` during self-review; use synthetic fixtures matching them.
- Forecast.Solar public API: `https://api.forecast.solar/estimate/{lat}/{lon}/{dec}/{az}/{kwp}`; lat/lon with 2 decimals; `dec` = tilt rounded to an integer 0–90; `az` = compass − 180 normalised to −180…180 and rounded to an integer; `kwp` = `dcKwp` with 2 decimals. One request per plane, at most 3 planes.
- Forecast.Solar budget: at most 6 requests per rolling hour per device; on 429 honour both `Retry-After` (seconds or HTTP date) and `message.ratelimit`, using the later reset. If `message.ratelimit` only supplies `period`, `limit` and `remaining`, a zero remaining count defers for `period` seconds from receipt; never interpret it as a reset timestamp. Without a usable reset defer 1 h. Count every started request, including failures, across all sites/accounts; persist reservations and deferral before sending, survive relaunch and sign-out, and never reset budget when a cache/layout changes. Refresh after 3 h; usable for 6 h (same as `SolarForecastStore.foregroundRefreshThreshold` / `recommendationFreshness`).
- Response parsing: `result.watt_hours_period` keys are local time (`YYYY-MM-DD HH:MM:SS`) in `message.info.timezone`; each value is Wh for (previous key, key]. Output must be contiguous `SolarForecastInterval`s from local midnight today to local midnight after tomorrow, with zero-kW intervals for night and gaps. `cautiousPowerKw` stays `nil`.
- Correction: per local hour of day, factor = Σ actual Wh ÷ Σ forecast Wh over the last 14 days, using only hours where the actual is `complete` and both values exist and the forecast is > 50 Wh; clamp to 0.5…1.5; an hour with fewer than 5 qualifying samples uses the all-day ratio (same clamp); no qualifying data → 1.0. The forecast used for a past hour is the latest raw, uncorrected batch fetched before that UTC hour started that fully covers it. Integrate sub-hour intervals to UTC-hour Wh before comparison; never train on corrected output. Use a site-calendar 14-day cutoff ending at `now`, excluding incomplete/future hours. Repeated DST hours are distinct samples grouped by their site-local hour.
- Location: When-In-Use, one fix, rounded to 2 decimals before it leaves the device; only offered for the selected site after "Are you at <site name> now?"; never requested in the background; never re-requested automatically.
- Hide every new UI element and skip every new request when `solar-layout` says `enabled: false` (except that one GET). Beta correction, including Solcast correction, also requires enabled actuals. Copy follows `docs/voice-and-terms.md`; no "Battery Hold", use current names.
- Solcast keys, resource IDs and Solcast behaviour stay exactly as today apart from the beta correction. A present credential with no arrays still shows array selection; a failing connected Solcast stays on its existing history/error path, never silently switches provider.
- Release gate: keep automatic forecasting beta-only until at least 20 scored day-ahead days beat `history_14d_median` on both daily and hourly error; score snow/outage days unchanged. Otherwise try Open-Meteo forecasting in a separate change. Task 1's Solcast check does not satisfy this gate.
- Manual layout entry is out of v1. Follow-up uses a separate `manual_layout` column plus contract `source`; detection must never overwrite it. No new cron or migration in this plan; the server Dev location/cron smoke check and measured egress remain separate server rollout prerequisites. Privacy disclosure already shipped in #244 (`cmd/next-app/src/app/privacy/page.tsx`).
- All file paths in Tasks 2–7 are relative to `cmd/ios-app`. Test doubles that conform to the expanded application API must be updated in Task 2. Never read `.env*` contents or commit `.forecast-compare` data.

## Review Focus

- **Site/account/source changes while a request is suspended** → discard the old completion and clear labels/batches together, with no cross-site history or location post. Tests in Tasks 4, 6 and 7.
- **Relaunch/sign-out or concurrent sites within one rolling hour** → the device still sends at most 6 Forecast.Solar requests and respects the latest reset. Tests in Task 4.
- **Partial/malformed provider data, odd sunrise times and DST** → conserve energy, fill only bounded gaps/night, and reject missing day coverage rather than fabricate a zero tomorrow. Tests in Task 3.
- **Travel, half-hour site offsets and repeated local hours** → integrate forecast energy into the server's UTC-hour buckets before deriving site-local correction. Tests in Task 5.
- **Denied/restricted/stale location or beta role revoked** → stop automatic work and new prompts; keep the history path or existing connected Solcast behavior, without reusing another site's location. Tests in Tasks 2, 6 and 7.

---

### Task 1: Check the correction on past captures (local, no app code)

Decides whether the correction is switched on for Solcast at launch.

**Interfaces:** Produces the evidence and Boolean decision for `SolarForecastCorrection.appliesToSolcast` in Task 5; does not change the Forecast.Solar ship rule.

**Files (outside the repo, never committed):** `/Users/kevm/github/pwusage/.forecast-compare/score.py`

- [ ] **Step 1:** Add sources `solcast_corrected` and `fs_fitted_flat_corrected` to `score.py`: for each scored day, compute the Global Constraints correction using only actuals known before that capture (no target-day leakage), from the previous 14 days of that source's own captures (latest capture before each hour) and the actuals already loaded, apply it to that day's forecast, and score it like the others.
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
  - `enum MobileSolarLayoutResponse: Equatable, Sendable { case disabled; case enabled(location: SolarHomeLocation?, layout: SolarLayout?, reason: MobileSolarLayoutReason?) }` with `struct SolarHomeLocation: Codable, Equatable, Sendable { latitude: Double; longitude: Double }` and `struct SolarLayout: Codable, Equatable, Sendable { planes: [SolarLayoutPlane]; acClipKw: Double?; confidence: SolarLayoutConfidence; detectedAt: Date? }`, `enum SolarLayoutConfidence: String, Codable, Sendable { case high, medium }`.
  - `enum MobileSolarActualsResponse: Decodable, Equatable, Sendable { case disabled; case enabled(asOf: Date, hours: [Hour]) }` with nested `struct Hour: Decodable, Equatable, Sendable { let hourStart: Date; let wh: Double; let complete: Bool }`. Layout response also conforms to `Decodable` with a custom version/enabled discriminator decoder.
  - `@MainActor protocol MobileSolarLayoutDataAPI: Sendable { func fetchSolarLayout(siteID: String) async throws -> MobileSolarLayoutResponse; func postSolarLocation(siteID: String, latitude: Double, longitude: Double) async throws; func fetchSolarActuals(siteID: String) async throws -> MobileSolarActualsResponse }`, implemented by `PWUsageAPI`.

- [ ] **Step 1: Failing tests** — decode `{"version":1,"enabled":false}` → `.disabled`; decode a detected two-plane payload → `.enabled` with planes `[(90, 18, 5.6), (270, 18, 4.0)]`, `confidence .high`; decode `reason:"low-confidence"` with `layout:null`; reject `version: 2` with `PWUsageAPIError.invalidResponse`; decode both disabled actuals and enabled actuals with `complete:false`, reject version 2 for both endpoints, accept `detectedAt:null`; reject invalid/non-finite coordinates, empty or >3-plane layouts, invalid geometry or non-positive clip values; `postSolarLocation` sends JSON with `latitude` and `longitude` rounded to 2 decimals (assert on the captured request body using the existing request-capturing test transport in `PWUsageAPI` tests); accept empty 204 POST without JSON decoding and preserve existing HTTP error mapping for 400/401/403.
- [ ] **Step 2:** `./run-tests.sh -only-testing:PWUsageTests/MobileSolarLayoutTests` → FAIL.
- [ ] **Step 3:** Implement with `MobileContractDecoder.make()` (`Shared/mobile-live-contract.swift`) and `makeURL(path:siteID:)` like `fetchLoadPlanningContext`; POST uses `perform(_:)` to share authenticated transport. Update all `PWUsageApplicationAPI` fakes and compile them in this task.
- [ ] **Step 4:** Repeat Step 2 → PASS.
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
  - `struct ForecastSolarPlaneEstimate: Equatable, Sendable { let timeZone: TimeZone; let wattHoursPeriod: [ForecastSolarPeriod]; let watts: [ForecastSolarPowerPoint]; let dayWattHours: [String: Double] }`; `struct ForecastSolarPeriod: Equatable, Sendable { let end: Date; let wh: Double }`; `struct ForecastSolarPowerPoint: Equatable, Sendable { let at: Date; let watts: Double }`
  - `struct ForecastSolarClient: Sendable { init(transport: (any ForecastSolarTransport)? = nil, timeout: TimeInterval = 30, clock: any SolarForecastClock = SystemSolarForecastClock()); func estimate(location: SolarHomeLocation, plane: SolarLayoutPlane) async throws -> ForecastSolarPlaneEstimate }` — same hardening as `SolcastClient` (ephemeral session, no cookies, redirects rejected, host must be `api.forecast.solar`, bounded timeout); URL per Global Constraints.
  - `enum ForecastSolarForecast { static func intervals(estimates: [ForecastSolarPlaneEstimate], acClipKw: Double?, siteTimeZone: TimeZone, now: Date) throws -> [SolarForecastInterval] }` — one-hour intervals from local midnight today to local midnight after tomorrow in `siteTimeZone`; each period's Wh assigned to the hour(s) it overlaps in proportion; planes summed; clipped to `acClipKw`; throws `SolarForecastError.incompleteCoverage` unless every plane has sorted finite nonnegative periods on both requested local dates, with zero-power sunrise/sunset endpoints in `result.watts` and energy totals matching `result.watt_hours_day` within 1 Wh per day. The sunset period may contain nonzero Wh; preserve it. The first period key per day is a zero-energy sunrise marker; no energy crosses the overnight gap. Reject missing boundary markers, nonzero first periods, duplicate/unresolvable local timestamps, timezone disagreement or mismatched site timezone. Calendar hour boundaries handle DST; reject ambiguous provider keys rather than guessing. Zero-fill gaps only inside a validated day. Energy conservation assertions apply before clipping.
  - `ForecastSolarForecast.forecastSolarAzimuth(compass: Double) -> Int` (static) (90 → −90, 270 → 90, 180 → 0, 0 → 180 or −180 accepted, 350 → 170).

- [ ] **Step 1: Failing tests**
  - URL for `(43.39, -87.87)` and plane `(90, 18.4, 5.6)` is `https://api.forecast.solar/estimate/43.39/-87.87/18/-90/5.60`.
  - Decode a wholly synthetic two-day response with timezone `America/Chicago`, zero-power sunrise/sunset endpoints, zero-energy sunrise periods and nonzero final sunset periods, plus matching daily energy totals; do not copy research captures, coordinates or household metadata into fixtures. Assert exact ordered Wh values and timezone; reject negative/NaN, duplicate keys, invalid timezone, missing boundary markers, mismatched daily totals and mismatched timezone.
  - Intervals: contiguous, 48 one-hour intervals on a normal day pair, 47 across the 2026-03-08 spring-forward and 49 across the 2026-11-01 fall-back in `America/Chicago`; night intervals are 0 kW; total energy equals Σ `watt_hours_period` ÷ 1000 within 0.1%.
  - A zero sunrise marker at `06:45:37` followed by a 300 Wh key at `07:15:37` assigns 143.833 Wh to 06:00 and 156.167 Wh to 07:00 (tolerance 0.001 Wh). The sunrise marker contributes zero energy.
  - Two planes summed; `acClipKw: 3` caps every interval at 3 kW.
  - Only today's data → throws `SolarForecastError.incompleteCoverage`.
  - `siteTimeZone` `America/Chicago` with the device in `Asia/Tokyo` gives the same intervals (set `TimeZone` explicitly, not `.current`).
  - 429 with `Retry-After: 120` → `.rateLimited(retryAfter: now + 120)`; HTTP-date and body-reset variants choose the later deadline; missing reset defers 1 h. Redirect/foreign-host responses are rejected; no cookies/auth/user identifiers are sent.
- [ ] **Step 2:** `./run-tests.sh -only-testing:PWUsageTests/ForecastSolarClientTests` → FAIL.
- [ ] **Step 3:** Implement the Interfaces and Global Constraints above.
- [ ] **Step 4:** Repeat Step 2 → PASS.
- [ ] **Step 5: Commit** — `feat(ios): Forecast.Solar client and interval conversion`

---

### Task 4: Automatic forecast store and forecast history

**Files:**
- Create: `PWUsage/State/AutomaticSolarForecastStore.swift`
- Create: `PWUsage/State/SolarForecastHistory.swift`
- Modify: `PWUsage/State/SolarForecastStore.swift` (record each successful batch into `SolarForecastHistory`; no other change)
- Modify: `PWUsage/PWUsageApp.swift`, `PWUsage/Authentication/MobileAuthService.swift` (sign-out clears both new stores, as for `SolarForecastStore`)
- Test: `PWUsageTests/AutomaticSolarForecastStoreTests.swift`, `PWUsageTests/SolarForecastHistoryTests.swift`, `PWUsageTests/SolarForecastStoreTests.swift`, `PWUsageTests/MobileAuthServiceTests.swift`, `PWUsageTests/PWUsageAppModelTests.swift`

**Interfaces:**
- Consumes: `ForecastSolarClient`, `ForecastSolarForecast.intervals`, `SolarLayout`, `SolarHomeLocation`, `SolarForecastClock`, `SolarForecastBatch`, `SolarForecastRefreshResult`.
- Produces:
  - `enum SolarForecastProvider: String, Codable, Sendable { case solcast, forecastSolar }`
  - `actor SolarForecastHistory { static let shared; func record(provider: SolarForecastProvider, scope: String, intervals: [SolarForecastInterval], fetchedAt: Date) async; func pastForecast(provider: SolarForecastProvider, scope: String, from: Date, to: Date) async -> [Date: Double] /* hour start → Wh, latest fetch before the hour */; func clear() async throws }` — keeps 15 days, persisted to `Application Support/SolarForecast/history.json` with complete file protection. `scope` is the existing `SolarForecastScope.key(accountScopeID, siteID)`; `accountScopeID` already scopes the environment/user. Record raw uncorrected energy only, integrating fully covered UTC hours; latest eligible pre-hour fetch wins even for 30-minute Solcast intervals. History persistence failure is best-effort and must not break existing Solcast refresh behavior.
  - `protocol AutomaticSolarForecastManaging: Sendable { func refresh(scope: String, location: SolarHomeLocation, layout: SolarLayout, siteTimeZone: TimeZone, manual: Bool) async -> SolarForecastRefreshResult; func cachedBatch(scope: String) async -> SolarForecastBatch?; func isRecommendationUsable(scope: String) async -> Bool; func clear() async throws }`, implemented by `actor AutomaticSolarForecastStore` with `static let shared` and injectable transport, clock, history and persistence. Add `func activateAccountScope(_ accountScopeID: String?) async` to the protocol; coordinator/auth wiring invokes it. Batch `credentialID` is `"forecast-solar"` and `resourceIDs` are `[]`; a fingerprint of all planes, clip, nullable `detectedAt`, location and site timezone invalidates the cache; budget per Global Constraints, tracked as persisted device-wide request timestamps and a reset deadline; keep this separate from account caches/history so cleanup cannot replenish quota. Persist protected cache batches/fingerprints across launches and check freshness and coverage on load. Coalesce concurrent same-scope refreshes and reserve the whole plane count atomically; never publish a partial-plane batch. Account deactivation/clear increments a generation and invalidates in-flight writes/publication; on success records into `SolarForecastHistory` with provider `.forecastSolar`.

- [ ] **Step 1: Failing tests**
  - `refresh` with a fake transport makes one request per plane and caches a batch; a second call within 3 h returns `.alreadyFresh` with no request.
  - Seventh request in one rolling hour (manual refreshes) → `.budgetExhausted`, no request sent.
  - 429 `Retry-After: 600` → `.failed(.rateLimited)` and refresh before then is `.deferred`.
  - New `detectedAt`, changed geometry with null `detectedAt`, location or timezone → cache dropped, next refresh fetches.
  - Two sites refreshing concurrently reserve against the same 6-call ledger; relaunch/sign-out preserves attempts and 429 reset, but sign-out removes location caches/history. A persistence failure prevents unrecorded network attempts; in-flight completion after account switch/clear cannot resurrect data.
  - Partial-plane failure publishes no new batch; transient failure keeps a prior matching batch only while usable; an invalidated/expired batch is never returned as usable. Relaunch restores a valid persisted batch.
  - Batch is usable at 5 h 59 m, not at 6 h 01 m.
  - `SolarForecastHistory.pastForecast` returns the value from the fetch at 05:30 for the 09:00 hour when fetches were at 05:30 and 10:00 (latest before the hour start); entries older than 15 days are dropped on record.
  - `SolarForecastStore` records a successful Solcast refresh into history with provider `.solcast` (extend `SolarForecastStoreTests`).
- [ ] **Step 2:** Run `./run-tests.sh AutomaticSolarForecastStoreTests SolarForecastHistoryTests SolarForecastStoreTests` → FAIL for the new behavior.
- [ ] **Step 3:** Implement the Interfaces above, including auth cleanup through the existing injected cleanup mechanism. Propagate cleanup errors as the current sign-out flow does; test that no account data survives a successful cleanup.
- [ ] **Step 4:** Repeat Step 2 → PASS, then `./run-tests.sh MobileAuthServiceTests PWUsageAppModelTests` → PASS.
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
  - `static func derive(pastForecastWh: [Date: Double], actuals: [MobileSolarActualsResponse.Hour], siteTimeZone: TimeZone, now: Date) -> SolarForecastCorrection` — rules in Global Constraints.
  - `func apply(to intervals: [SolarForecastInterval], siteTimeZone: TimeZone, acClipKw: Double?) -> [SolarForecastInterval]` — scales `powerKw` and `cautiousPowerKw` by the factor of the interval start's local hour; re-clips to `acClipKw`.
  - `static let appliesToSolcast: Bool` — value from Task 1.

- [ ] **Step 1: Failing tests**
  - Actual is 80% of forecast in every hour for 14 days → every factor 0.8.
  - Morning hours actual 50% of forecast, afternoon 120% → factors 0.5 and 1.2 for those hours.
  - Actual 3× forecast → clamped to 1.5; actual 0 → 0.5.
  - An hour with 4 qualifying samples uses the all-day factor; no data → `identity`.
  - Hours with `complete: false` or forecast ≤ 50 Wh are ignored.
  - Site `America/Chicago`, device `Asia/Tokyo` → the factor for Chicago's 09:00 hour applies to the interval starting 09:00 Chicago time.
  - `apply` with `acClipKw: 4` never returns more than 4 kW; scale Solcast cautious power by the same factor, preserve nil for Forecast.Solar. For Solcast pass clip nil without an extra layout dependency.
  - Two 30-minute Solcast points integrate to the UTC-hour Wh; use `Asia/Kolkata` to prove local-hour intervals split across UTC buckets correctly. Chicago repeated 01:00 hours remain separate training samples; dates outside the trailing 14 local days, partial forecast hours and future actuals do not train factors. Applying correction twice through refresh/appearance still publishes raw × factor once; history remains raw (Task 6 integration test).
- [ ] **Step 2:** `./run-tests.sh -only-testing:PWUsageTests/SolarForecastCorrectionTests` → FAIL.
- [ ] **Step 3:** Implement the Interfaces and Global Constraints above.
- [ ] **Step 4:** Repeat Step 2 → PASS.
- [ ] **Step 5: Commit** — `feat(ios): provider-neutral solar forecast correction`

---

### Task 6: Source selection and wiring in DashboardCoordinator

**Files:**
- Modify: `PWUsage/State/DashboardCoordinator.swift` (`loadTimingDetailAppeared`, `refreshSolarForecast`, diagnostics)
- Modify: `PWUsage/Models/SmartShiftDiagnostics.swift` (include source and correction factors), `PWUsage/PWUsageApp.swift` (dependency injection); `PWUsage/Views/LoadTimingView.swift`, `PWUsage/Views/LoadTimingForecastPresentation.swift` (provider attribution/error copy), `PWUsage/Views/SmartShiftPresentation.swift` (consumer gates)
- Test: `PWUsageTests/DashboardCoordinatorTests.swift`, `PWUsageTests/SolarForecastCoordinatorTests.swift`

**Interfaces:**
- Consumes: `MobileSolarLayoutDataAPI`, `any AutomaticSolarForecastManaging`, `SolarForecastHistory`, `SolarForecastCorrection`, existing `forecastStore`.
- Produces:
  - `@Published private(set) var solarForecastSource: SolarForecastProvider?` and `@Published private(set) var solarLayoutStatus: MobileSolarLayoutResponse?` on the coordinator.
  - Inject layout API, automatic store, history and clock through the coordinator initializer and wire production instances in `PWUsageApp.swift`. Use `(accountScopeID, siteID)` for every layout/actuals/status cache. On appearance and pull-to-refresh, fetch/check layout status even with Solcast present so beta Solcast correction and settings can work. Cache layout for 6 h only when it is final (`layout` present, `not-enough-history` or `low-confidence`); cache `needs-location` and `pending` for at most 15 min so a newly detected layout is picked up promptly; force revalidation on pull-to-refresh/settings appearance and after a successful location POST (test: POST location → next appearance revalidates and shows `pending`; server then returns a layout → within 15 min the automatic source is published without a manual refresh); network failure means automatic is unavailable, while existing Solcast continues uncorrected.
  - Selection: any Solcast credential reserves precedence (including awaiting arrays or refresh failure); otherwise enabled layout + location → automatic with the same bill/context/site/time-zone gates as Solcast; else existing `.basic` / history path. Capture account/site/source/generation before each await, discard obsolete completions, and clear published batch/source together when switching. Disabled status clears automatic cache/status and skips actuals/automatic requests; it never disables existing Solcast.
  - A single publish helper rebuilds `SolarForecastBatch` from raw store intervals preserving `credentialID`, `resourceIDs`, `fetchedAt`. Obtain the site's timezone from the planning context (layout has none). Derive correction from same-provider history and enabled actuals (cache 1 h; filter by `now`); apply for automatic or eligible beta Solcast. Disabled/failed actuals means identity. Fetch actuals only after beta is established, alongside planning context where possible. Use this helper on appearance and manual refresh; never mutate/cache corrected intervals as raw.
  - Diagnostics uses the selected store and reports provider/factors; do not report the Solcast daily budget as the automatic rolling-hour budget. `solarForecastConnection` remains Solcast connection state; automatic enhancement uses source/batch rather than falsifying `.ready`. Update consumer gates that assume `.ready` means the only usable forecast.

- [ ] **Step 1: Failing tests**
  - No Solcast credential, layout enabled + detected → `solarForecastState == .enhanced`, `solarForecastSource == .forecastSolar`.
  - Solcast connected and layout available → Solcast used; the automatic store receives no refresh.
  - Solcast disconnected after an automatic batch existed → next appearance publishes the automatic batch, never the stale Solcast one; connecting Solcast → next appearance publishes Solcast, never the automatic batch.
  - `enabled: false` without Solcast → no `fetchSolarActuals`, no automatic refresh, `.basic`; with Solcast → existing enhanced path unchanged and uncorrected. Enabled Solcast with `appliesToSolcast == true` fetches actuals and corrects median/cautious power. Empty-array credentials or a failing Solcast never invoke the automatic store.
  - `reason: low-confidence` → `.basic` with history; `solarLayoutStatus` exposes the reason.
  - Correction applied: history 80% → published intervals are 0.8× the store's batch; actuals fetch throws → published intervals equal the store's batch.
  - Suspended site A request completes after selecting B or signing out → no A batch/status/factors published; role revocation on revalidation clears automatic state. Cached actuals/layouts never cross account/environment/site.
  - All forecast consumers, including bill projection and Smart Shift, accept automatic intervals and use history beyond tomorrow; automatic cautious output falls back to median. Attribution appears wherever automatic forecast is shown.
  - Diagnostics text includes `source: forecastSolar` and the 24 hour factors.
- [ ] **Step 2:** Run `./run-tests.sh DashboardCoordinatorTests SolarForecastCoordinatorTests` → FAIL for the new behavior.
- [ ] **Step 3:** Implement the Interfaces and Global Constraints above.
- [ ] **Step 4:** Repeat Step 2 → PASS, then the full `./run-tests.sh`.
- [ ] **Step 5: Commit** — `feat(ios): choose solar forecast source and apply correction`

---

### Task 7: Location step and settings UI

**Files:**
- Create: `PWUsage/State/HomeLocationProvider.swift`
- Modify: `PWUsage/Views/SolarForecastSettingsSheet.swift`, `PWUsage/Views/SolarForecastSettingsStatus.swift`, `PWUsage/Views/SolarForecastPreviews.swift`, `PWUsage/State/DashboardCoordinator.swift` (prompt/location actions), `PWUsage/Views/LoadTimingView.swift` (one-time invitation)
- Modify: `project.yml` (`NSLocationWhenInUseUsageDescription`: "PWUsage uses your home's approximate location once to work out which way your solar panels face.")
- Test: `PWUsageTests/HomeLocationProviderTests.swift`, `PWUsageTests/SolarForecastSettingsStatusTests.swift`

**Interfaces:**
- Consumes: `MobileSolarLayoutDataAPI.postSolarLocation`, `solarForecastSource`, `solarLayoutStatus`.
- Produces:
  - `@MainActor protocol HomeLocationProviding: Sendable { func currentRoundedLocation() async throws -> SolarHomeLocation }`; `enum HomeLocationError: Error { case denied, restricted, unavailable }`; `@MainActor final class DeviceHomeLocationProvider: HomeLocationProviding` (CLLocationManager, When-In-Use, `requestLocation()` once, 30 s timeout, rounds to 2 decimals). Reject fixes older than 60 s, negative accuracy or accuracy worse than 1 km; cancellation/timeout ends delegate work and resumes once. Inject a manager adapter and clock for tests. A fix is posted only if the confirmed account/site is still selected.
  - `SolarForecastSettingsStatus.automaticSummary(response: MobileSolarLayoutResponse, source: SolarForecastProvider?) -> [String]` — ordered summary lines (empty for disabled): source, plane summary, confidence (`"High confidence"` / `"Medium confidence"`) or reason. Use an 8-point compass (205° → southwest). Examples: `"Automatic forecast from Forecast.Solar"`, `"2 panel faces: east-facing about 5.6 kW, west-facing about 4 kW"` (kW to 1 decimal, trailing `.0` dropped), `"We need about 6 weeks of solar history first"`, `"Your production doesn't match a clear panel layout yet"`, `"Waiting for your panel layout to be detected."`.
  - Settings sheet: when enabled, a "Solar Forecast" section above the Solcast section: the summary lines; a "Use my home location" button when `needs-location`, which first asks "Are you at <site name> now?" and then posts; on `denied`/`restricted` an explanation with an "Open Settings" button; a footnote "Forecast by Forecast.Solar." when the automatic source is in use. Show source `"Solcast"` when connected while retaining read-only detection/confidence underneath; Solcast setup remains the alternative below. Always retain a settings location/retry button, even after a prior fix, and invalidate/refetch layout after successful 204 (server returns pending until detection). Do not promise a completion time.
  - Add a one-time Smart Shift invitation for enabled users without Solcast/location. Persist dismissal per account/site; opening settings and inviting must not request permission until the user taps the location action and confirms they are home. Decline/failure never re-prompts automatically. Hide it for disabled users; settings retry remains available.

- [ ] **Step 1: Failing tests**
  - `currentRoundedLocation` with a fake manager returning 43.39321, −87.87154 → 43.39, −87.87.
  - Denied authorization → throws `.denied`, nothing posted (coordinator/settings model test with a fake API).
  - `automaticSummary` for planes `[(90, 18, 5.6), (270, 18, 4.0)]` contains `"2 panel faces: east-facing about 5.6 kW, west-facing about 4 kW"`; one plane `(205, 20, 5.2)` → a summary line `"1 panel face: southwest-facing about 5.2 kW"`; include source/confidence lines; each reason → its sentence; `.disabled` → `[]`.
  - Restricted, unavailable, timeout, stale/inaccurate fix or cancellation → nothing posted, history remains usable; only denied/restricted offers Open Settings. Site changes after confirmation → no post.
  - One-time Smart Shift invitation is beta-only, remains dismissed after relaunch, and settings retry is always available. A successful POST forces a fresh pending layout read; Solcast users still see source and read-only detection, and every automatic forecast surface names Forecast.Solar.
- [ ] **Step 2:** Run `./run-tests.sh HomeLocationProviderTests SolarForecastSettingsStatusTests SolarForecastCoordinatorTests` → FAIL for the new behavior.
- [ ] **Step 3:** Implement; add previews for each state in `SolarForecastPreviews.swift`.
- [ ] **Step 4:** Repeat Step 2 → PASS; `./generate.sh` then the full `./run-tests.sh`.
- [ ] **Step 5:** On-device check list for the owner (in the PR): grant beta role on Dev, open settings, share location, wait for a cron run, confirm the layout sentence and that Smart Shift shows the forecast; deny location and confirm the explanation.
- [ ] **Step 6: Commit** — `feat(ios): home location step and automatic forecast settings`


## Final verification and release handoff

- [ ] From `cmd/ios-app`, run `./generate.sh`, `./run-tests.sh` (must execute nonzero tests) and from the repository root run `swiftlint --strict`; report existing baseline violations separately, add none. The test script builds the app/test targets; preserve `DEVELOPMENT_TEAM: 6HQGHHRK87`.
- [ ] From `cmd/next-app`, run `npm run lint`, `npm test -- --run`, `npm run build`; report any environment-dependent blockers without reading `.env*` contents.
- [ ] Record Task 1 evidence, device checks and the still-pending ≥20-day provider release gate in the implementation PR. Keep rollout beta-only. Confirm the separate server Dev role/location/cron smoke check and measured Supabase egress before expanding the beta. Never commit research data or credentials.

## Plan self-review (2026-10-28)

Completed the writing-plans checklist: spec coverage, step scan, type consistency, five Review Focus cases with owning-task tests, and proportion. Checked all three mobile endpoints against #244's `mobile-contract.ts`, layout route, actuals route and hourly aggregation. Fixed nullable detection timestamps, disabled actuals, Solcast beta correction routing, device-wide persistent quota, raw-history UTC-hour integration, lifecycle races, safe synthetic fixtures, one-time prompt/retry, confidence/attribution and release gates. The existing Solcast store remains intact behind its current protocol; the new injectable automatic-store protocol plus shared intervals/history/correction is the provider seam. Server detection/privacy/egress are already owned by #244 and its rollout; manual entry remains a separate follow-up. No implementation or research scoring is performed by this documentation review.
