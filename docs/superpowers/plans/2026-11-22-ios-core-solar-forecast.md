# `PWUsageCore` SolarForecast Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the remaining pure-Foundation `SolarForecast` and `OpenMeteo` models, networking clients, forecast services, and their 10 unit test suites into `cmd/ios-app/Packages/PWUsageCore` so they run natively on macOS via `./cmd/ios-app/run-core-tests.sh`.

**Architecture:** Extends the existing `PWUsageCore` local Swift Package (`Packages/PWUsageCore/Sources/PWUsageCore/SolarForecast/` and `Packages/PWUsageCore/Tests/PWUsageCoreTests/SolarForecast/`) with zero changes to `Package.swift`, `project.yml`, `.github/workflows/ios.yml`, `.swiftformat`, or `.swiftlint.yml`. Completely orthogonal to Rate Plans (`Models/Bill/`, `State/Bill/`) and Savings (`Models/Savings/`, `State/Savings/`).

**Tech Stack:** Swift 6.0, Swift Package Manager, Swift Testing (`import Testing`), SwiftFormat, SwiftLint (`--strict`).

## Global Constraints

- **Worktree & Branch:** `/Users/kevm/github/pwusage/.worktrees/ios-core-solar-forecast` on branch `feat/ios-core-solar-forecast` (branched off `origin/main`).
- **Orthogonality (strict):** Do **not** touch `Models/Bill/`, `State/Bill/`, `Models/Savings/`, `State/Savings/`, `Views/Bill/`, `Views/Savings/`, `Package.swift`, `project.yml`, or `.github/workflows/ios.yml` unless an import line (`import PWUsageCore`) is required by a caller of a moved `SolarForecast` type.
- **Zero lint violations:** `./cmd/ios-app/lint.sh` must exit 0 after every task. Never add `swiftlint:disable` comments.
- **SwiftLint rules to watch when adding `public`:**
  - `no_extension_access_modifier`: never write `public extension Foo`; put `public` on individual members inside `extension Foo`.
  - `function_parameter_count`: 5 warn / 8 error. Do not add explicit `public init`s with >5 parameters if avoidable; group fields or keep internal where not constructed by `PWUsage`.
  - `trailing_comma`: `.swiftformat` uses `--trailing-commas never`.
- **Swift Testing only:** All tests use `import Testing`, `@Suite`, `@Test`, `#expect`, `#require`. Never introduce `XCTest`.
- **Minimal `public` surface:** Only mark types, properties, methods, and `init`s `public` where referenced from `PWUsage` (or `PWUsageTests`). `PWUsageCoreTests` uses `@testable import PWUsageCore`.
- **iOS-only APIs:** Guard `.completeFileProtection` and `.completeFileProtectionUntilFirstUserAuthentication` in `SolarForecastFile.swift` under `#if os(iOS)` (using `[.atomic]` on macOS, matching `SolarHealthCache.swift`).
- **Keep app-only files in `PWUsage`:** `BackgroundSolarForecastRefresh.swift` (uses `BackgroundTasks`) and app-level coordinator tests (`AutomaticForecastCoordinatorTests`, `AutomaticForecastLifecycleTests`, `AutomaticForecastPresentationTests`, `BackgroundSolarForecastTests`, `SolarForecastCoordinatorTests`, `SolarForecastSettingsStatusTests`) stay in `PWUsage` / `PWUsageTests`.

---

## Task 1: Move Pure `SolarForecast` Models & Migrate 4 Model Test Suites

**Files:**
- Move to `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/SolarForecast/`:
  - `PWUsage/Models/Solar/MobileSolarHistory.swift`
  - `PWUsage/Models/Solar/MobileSolarHistoryFill.swift`
  - `PWUsage/Models/Solar/OpenMeteoWeather.swift`
  - `PWUsage/Models/Solar/SiteLocalDays.swift`
  - `PWUsage/Models/Solar/SmartShiftForecastSource.swift`
  - `PWUsage/Models/Solar/SolarForecast.swift`
  - `PWUsage/Models/Solar/SolarForecastCorrection.swift`
  - `PWUsage/Models/Solar/SolarForecastProvider.swift`
  - `PWUsage/Models/Solar/SolarForecastStoreModels.swift`
- Create: `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/SolarForecast/SolarForecastUnavailableCause.swift` (extracted from `PWUsage/Models/DashboardContracts.swift:68-78`)
- Modify: `cmd/ios-app/PWUsage/Models/DashboardContracts.swift` (remove `SolarForecastUnavailableCause` declaration, add `import PWUsageCore`)
- Move to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/SolarForecast/`:
  - `PWUsageTests/OpenMeteoArrayModelTests.swift`
  - `PWUsageTests/SiteLocalDaysTests.swift`
  - `PWUsageTests/SolarForecastTests.swift`
  - `PWUsageTests/SolarForecastCorrectionTests.swift`
- Modify: `PWUsage/**/*.swift` and `PWUsageTests/**/*.swift` callers referencing moved types (add `import PWUsageCore`)

**Interfaces:**
- Consumes: Existing `PWUsageCore` (`SolarLayout`, `SolarHealth`, `SharedModels.SolarForecastSiteScope`).
- Produces: Public `SolarForecast`, `SolarForecastInterval`, `SolarForecastCorrection`, `SolarForecastProviding`, `SolarForecastClock`, `SolarForecastFileStoring`, `SolarForecastUnavailableCause`, `SmartShiftForecastSource`, `OpenMeteoWeather`, `SiteLocalDays`, `MobileSolarHistoryDay`, `MobileSolarHistoryDataAPI`, `MobileSolarHistoryFill`, and `SolarForecastStoreModels` types.

- [ ] **Step 1: Extract `SolarForecastUnavailableCause` from `DashboardContracts.swift`**

Create `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/SolarForecast/SolarForecastUnavailableCause.swift`:

```swift
public enum SolarForecastUnavailableCause: Equatable, Sendable {
    case unauthorized
    case rateLimited
    case requestFailed
    case unknownResource
    case invalidForecast
    case storageFailure
    case cleanupFailure
    case budgetExhausted
    case deferred
}
```

Remove the duplicate `enum SolarForecastUnavailableCause` from `cmd/ios-app/PWUsage/Models/DashboardContracts.swift` (lines 68–78) and add `import PWUsageCore` to `DashboardContracts.swift`.

- [ ] **Step 2: Move all 9 files from `PWUsage/Models/Solar/` into `Packages/PWUsageCore/Sources/PWUsageCore/SolarForecast/`**

Use `git mv` for all 9 files. Remove redundant `import PWUsageCore` lines inside files that are now part of `PWUsageCore`. Add minimal `public` modifiers (types, properties, methods, explicit `public init`s) for symbols referenced by `PWUsage` and `PWUsageTests`. Add `import PWUsageCore` to `PWUsage` callers.

- [ ] **Step 3: Move the 4 pure model test suites into `Packages/PWUsageCore/Tests/PWUsageCoreTests/SolarForecast/`**

Use `git mv` for:
- `OpenMeteoArrayModelTests.swift`
- `SiteLocalDaysTests.swift`
- `SolarForecastTests.swift`
- `SolarForecastCorrectionTests.swift`

Replace `@testable import PWUsage` with `@testable import PWUsageCore` (and remove duplicate `import PWUsageCore`).
*(Note: `SolarForecastCorrectionTests.swift` references `SolarProviderFixture` — if it only uses a small helper from `SolarForecastProviderFixtures.swift`, copy/share the needed helper into `Packages/PWUsageCore/Tests/PWUsageCoreTests/Support/SolarForecastTestSupport.swift` now so Task 1 compiles cleanly on its own.)*

- [ ] **Step 4: Verify `run-core-tests.sh`, `lint.sh`, and iOS `build-for-testing`**

Run:
```bash
./cmd/ios-app/run-core-tests.sh
./cmd/ios-app/lint.sh
cd cmd/ios-app && xcodegen generate && xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO build-for-testing
```
Expected: All `PWUsageCoreTests` pass on macOS, `iOS lint: clean`, and `PWUsage` + `PWUsageTests` compile cleanly.

- [ ] **Step 5: Commit**

```bash
git add cmd/ios-app/Packages/PWUsageCore cmd/ios-app/PWUsage cmd/ios-app/PWUsageTests
git commit -m "refactor(ios): move SolarForecast models and tests into PWUsageCore"
```

---

## Task 2: Move Open-Meteo Networking Clients & Migrate 2 Networking Test Suites

**Files:**
- Move to `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/SolarForecast/`:
  - `PWUsage/Networking/RedirectRejectingDelegate.swift`
  - `PWUsage/Networking/Solar/OpenMeteoClient.swift`
  - `PWUsage/Networking/Solar/OpenMeteoWeatherArchive.swift`
- Move to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/SolarForecast/`:
  - `PWUsageTests/OpenMeteoClientTests.swift`
  - `PWUsageTests/OpenMeteoArchiveTests.swift`
- Create/Update: `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/Support/SolarForecastTestSupport.swift` (add `OpenMeteoHarness` if used by `OpenMeteoClientTests` / `OpenMeteoArchiveTests`)
- Modify: `PWUsage/**/*.swift` and `PWUsageTests/**/*.swift` callers referencing `RedirectRejectingDelegate`, `OpenMeteoClient`, or `OpenMeteoWeatherArchive` (add `import PWUsageCore`)

**Interfaces:**
- Consumes: `SolarForecast` models from Task 1 (`OpenMeteoWeather`, `SiteLocalDays`) and `SharedModels.SolarHealthWeather`.
- Produces: Public `RedirectRejectingDelegate`, `OpenMeteoClient`, `OpenMeteoClientError`, `OpenMeteoWeatherArchive`.

- [ ] **Step 1: Move `RedirectRejectingDelegate.swift`, `OpenMeteoClient.swift`, and `OpenMeteoWeatherArchive.swift`**

Use `git mv` into `Packages/PWUsageCore/Sources/PWUsageCore/SolarForecast/`. Remove `import PWUsageCore` inside these files. Mark `RedirectRejectingDelegate` (including `public override init()`), `OpenMeteoClient`, `OpenMeteoClientError`, and `OpenMeteoWeatherArchive` members `public` as required by `PWUsage` callers (`PWUsageAPI`, `OpenMeteoProvider`, `SolarHealthWeatherStore`, etc.). Add `import PWUsageCore` to `PWUsage` callers.

- [ ] **Step 2: Move `OpenMeteoClientTests.swift` and `OpenMeteoArchiveTests.swift` into `PWUsageCoreTests/SolarForecast/`**

Use `git mv`, replace `@testable import PWUsage` with `@testable import PWUsageCore`, and ensure `OpenMeteoHarness` is available in `Packages/PWUsageCore/Tests/PWUsageCoreTests/Support/SolarForecastTestSupport.swift`.
*(Keep `PWUsageTests/Fixtures/SolarForecastProviderFixtures.swift` intact for the 4 remaining app-level tests in `PWUsageTests`: `AutomaticForecastPresentationTests`, `BackgroundSolarForecastTests`, `AutomaticForecastCoordinatorFixtures`, and `PreviewFixtureTests`.)*

- [ ] **Step 3: Verify `run-core-tests.sh`, `lint.sh`, and iOS `build-for-testing`**

Run:
```bash
./cmd/ios-app/run-core-tests.sh
./cmd/ios-app/lint.sh
cd cmd/ios-app && xcodegen generate && xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO build-for-testing
```
Expected: All `PWUsageCoreTests` pass on macOS, `iOS lint: clean`, and `PWUsage` + `PWUsageTests` compile cleanly.

- [ ] **Step 4: Commit**

```bash
git add cmd/ios-app/Packages/PWUsageCore cmd/ios-app/PWUsage cmd/ios-app/PWUsageTests
git commit -m "refactor(ios): move OpenMeteo networking and tests into PWUsageCore"
```

---

## Task 3: Move `SolarForecast` State & Provider Services and Migrate 4 Service Test Suites

**Files:**
- Move to `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/SolarForecast/`:
  - `PWUsage/State/Solar/OpenMeteoProvider.swift`
  - `PWUsage/State/Solar/SolarForecastFile.swift`
  - `PWUsage/State/Solar/SolarForecastAutomaticCache.swift`
  - `PWUsage/State/Solar/SolarForecastHistory.swift`
  - `PWUsage/State/Solar/SolarForecastRequestLedger.swift`
  - `PWUsage/State/Solar/SolarForecastService.swift`
- Move to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/SolarForecast/`:
  - `PWUsageTests/OpenMeteoProviderTests.swift`
  - `PWUsageTests/SolarForecastHistoryTests.swift`
  - `PWUsageTests/SolarForecastProviderTests.swift`
  - `PWUsageTests/SolarForecastServiceTests.swift`
- Update: `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/Support/SolarForecastTestSupport.swift` (ensure `SolarProviderFixture`, `MutableSolarClock`, `InMemorySolarFile`, `SyntheticForecastProvider` are present)
- Modify: `PWUsage/**/*.swift` and `PWUsageTests/**/*.swift` callers (add `import PWUsageCore`)

**Interfaces:**
- Consumes: `SolarForecast` models & Open-Meteo networking from Tasks 1–2.
- Produces: Public `OpenMeteoProvider`, `SolarForecastFile`, `SolarForecastAutomaticCache`, `SolarForecastHistory`, `SolarForecastRequestLedger`, `SolarForecastService`.

- [ ] **Step 1: Guard iOS-only file protection in `SolarForecastFile.swift`**

In `SolarForecastFile.swift`, wrap every use of `.completeFileProtection` and `.completeFileProtectionUntilFirstUserAuthentication` under `#if os(iOS)` (falling back to `[.atomic]` on macOS), matching the pattern in `Packages/PWUsageCore/Sources/PWUsageCore/SolarHealth/SolarHealthCache.swift`.

- [ ] **Step 2: Move all 6 service/state files into `Packages/PWUsageCore/Sources/PWUsageCore/SolarForecast/`**

Use `git mv`, remove internal `import PWUsageCore` lines, add minimal `public` modifiers for symbols consumed by `PWUsage` (coordinators, `BackgroundSolarForecastRefresh`, `DemoForecastStore`, `PWUsageAppModel`), and add `import PWUsageCore` to `PWUsage` callers.

- [ ] **Step 3: Move the 4 service/provider test suites into `PWUsageCoreTests/SolarForecast/`**

Use `git mv` for:
- `OpenMeteoProviderTests.swift`
- `SolarForecastHistoryTests.swift`
- `SolarForecastProviderTests.swift`
- `SolarForecastServiceTests.swift`

Replace `@testable import PWUsage` with `@testable import PWUsageCore` (and remove duplicate `import PWUsageCore`).

- [ ] **Step 4: Verify `run-core-tests.sh`, `lint.sh`, and iOS `build-for-testing`**

Run:
```bash
./cmd/ios-app/run-core-tests.sh
./cmd/ios-app/lint.sh
cd cmd/ios-app && xcodegen generate && xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO build-for-testing
```
Expected: All `PWUsageCoreTests` (previous 145 tests + all 10 newly migrated suites) pass natively on macOS, `iOS lint: clean`, and `PWUsage` + `PWUsageTests` compile cleanly.

- [ ] **Step 5: Commit**

```bash
git add cmd/ios-app/Packages/PWUsageCore cmd/ios-app/PWUsage cmd/ios-app/PWUsageTests
git commit -m "refactor(ios): move SolarForecast services and tests into PWUsageCore"
```

---

## Task 4: Update Docs & Run Full End-to-End Verification

**Files:**
- Modify: `cmd/ios-app/AGENTS.md`
- Modify: `cmd/ios-app/ARCHITECTURE.md`

**Interfaces:**
- Consumes: Completed `SolarForecast` extraction from Tasks 1–3.
- Produces: Accurate docs listing `SolarForecast` in `PWUsageCore` and verified green test runs.

- [ ] **Step 1: Update `cmd/ios-app/AGENTS.md` and `cmd/ios-app/ARCHITECTURE.md`**

- In `cmd/ios-app/AGENTS.md` under `## Tests`, add `SolarForecast` to the list of pure-Foundation suites in `Packages/PWUsageCore` (`SolarLayout`, `SolarHealth`, `SolarForecast`, `BillPricing`).
- In `cmd/ios-app/ARCHITECTURE.md` under `## Folder contract`, add `SolarForecast` to the `Packages/PWUsageCore/` line.

- [ ] **Step 2: Run full verification suite**

Run every check and confirm zero failures:
```bash
./cmd/ios-app/run-core-tests.sh
./cmd/ios-app/lint.sh
./cmd/ios-app/test-run-tests.sh
./cmd/ios-app/run-tests.sh
```
Also verify no Rate Plans or Savings files were accidentally modified:
```bash
git diff --name-only origin/main..HEAD | grep -E '(Models|State|Views)/(Bill|Savings)/' || echo "clean: no Bill/Savings overlap"
```

- [ ] **Step 3: Commit**

```bash
git add cmd/ios-app/AGENTS.md cmd/ios-app/ARCHITECTURE.md
git commit -m "docs(ios): list SolarForecast in PWUsageCore package docs"
```
