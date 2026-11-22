# Design: Extract Pure-Logic iOS Core into a macOS-Testable Swift Package (`PWUsageCore`)

**Date**: 2026-11-22
**Author**: Kevin Miller & Antigravity
**Status**: Proposed

## Problem Statement

All 253 test files in `cmd/ios-app/PWUsageTests` currently live in a single iOS unit-test bundle hosted by the `PWUsage` app target. Even pure-Swift / Foundation math suites (solar layout detection, 10-year solar health backtests, and bill/tariff pricing) require:

1. Building the entire `PWUsage` iOS app and `PWUsageWidgets` extension for iOS Simulator.
2. Booting an iOS Simulator (which routinely takes 2–10+ minutes cold on GitHub Actions `macos-15` runners).
3. Installing and launching the `PWUsage` app host process inside the simulator, with parallel test execution disabled for stability.
4. Building the entire app with `-O` (`--full`) on `main` and detector-touching PRs so the heavy compute suites finish within CI timeouts, which in turn forces `main` to run a second `--build-only` Debug pass to keep PR caches warm.

Extracting the heaviest pure-Foundation compute engines into a local Swift Package (`PWUsageCore`) lets their tests run natively on macOS via `swift test` — in parallel, with `-c release` when needed, and with zero simulator overhead.

## Goals

1. **Create a local Swift Package (`cmd/ios-app/Packages/PWUsageCore`)** targeting `.iOS(.v18)` and `.macOS(.v15)` under Swift 6.0, with a single library target (`PWUsageCore`) designed to grow incrementally.
2. **Extract the three heavy compute domains** (`SolarLayout`, `SolarHealth`, `BillPricing`) and their minimal pure-value dependencies, moving all 5 slow suites from `cmd/ios-app/quick-test-skips.txt` plus all unit/parity/backtest suites for those domains into `PWUsageCoreTests`.
3. **Run `PWUsageCoreTests` natively on macOS in CI** via a new parallel `core-tests` job in `.github/workflows/ios.yml` with its own `.build` cache, independent of ongoing DerivedData cache and parallel simulator boot work.
4. **Eliminate the need for `-O` (`--full`) simulator builds** once the heavy compute suites run in `PWUsageCoreTests`, allowing `main` and PRs to share a single fast Debug simulator build.
5. **Maintain zero lint/format/dead-code regressions** across `./cmd/ios-app/lint.sh`, `./cmd/ios-app/test-run-tests.sh`, `./cmd/ios-app/run-tests.sh`, and `./cmd/ios-app/periphery.sh`.

## Non-Goals

- Moving `PWUsage/Views/`, `PWUsage/App/`, `PWUsage/Authentication/`, `PWUsageWidgets/`, or `Shared/` into the package.
- Moving app-coupled `PWUsage/State/` coordinators, CloudKit sync, or `BGTaskScheduler` runners in this phase.
- Skipping the iOS Simulator job on PRs (both jobs run in parallel on every PR; path-gating the simulator job is a separate future decision).
- Linux CI support (`PWUsageCore` uses Apple frameworks such as `CryptoKit` and runs on macOS).

---

## Architecture & Extraction Boundary

### Package Location & Manifest

Create `cmd/ios-app/Packages/PWUsageCore/Package.swift`:

- `swift-tools-version: 6.0`
- Platforms: `.iOS(.v18)`, `.macOS(.v15)`
- Products: `.library(name: "PWUsageCore", targets: ["PWUsageCore"])`
- Targets:
  - `.target(name: "PWUsageCore")`
  - `.testTarget(name: "PWUsageCoreTests", dependencies: ["PWUsageCore"], resources: [.copy("Fixtures")])`

### Source Organization (`Sources/PWUsageCore/`)

Organize `PWUsageCore` into four folders matching the domain boundaries:

1. **`SolarLayout/`**
   - All 10 files from `PWUsage/Models/Solar/LayoutDetection/`
   - `PWUsage/Models/Solar/SolarPosition.swift`
   - `PWUsage/Models/Solar/MobileSolarLayout.swift`

2. **`SolarHealth/`**
   - All 11 files from `PWUsage/Models/Solar/Health/`
   - `PWUsage/State/Solar/ManualSolarLayout.swift` and `PWUsage/State/Solar/ManualSolarLayout+Model.swift` (pure value types; `ManualSolarLayout+Editing.swift` stays in `PWUsage/State/Solar/`)
   - `PWUsage/State/Solar/SolarHealthCache.swift`, updated to guard `.completeFileProtectionUntilFirstUserAuthentication` under `#if os(iOS)` (using `[.atomic]` on macOS)
   - `PWUsage/State/Solar/SolarHealthPass.swift` containing `version`, `Context`, and pure `compute(...)`
   - **App-side split:** Move `SolarHealthPass.run(scope:history:record:cache:now:)` into `PWUsage/State/Solar/SolarHealthPass+Run.swift` as an `extension SolarHealthPass` so `SolarHistoryStore`, `SolarLayoutRecord`, and `SolarHealthWeatherStore` remain in the app target.

3. **`BillPricing/`**
   - All 5 files from `PWUsage/Models/Bill/Pricing/` (`BillPricing.swift`, `BillingCycle.swift`, `BillUsageAggregator.swift`, `RatePeriodResolver.swift`, `BillOutlookHistoryBuilder.swift`)
   - `PWUsage/Models/LoadTiming/Local/LoadTimingTimelineBuilder.swift`

4. **`SharedModels/`** (minimal pure-value structs split out of app-coupled files)
   - `EnergyFlowDay.swift` — extracted from `PWUsage/State/Solar/SolarHistoryStore+Flows.swift`
   - `SolarForecastSiteScope.swift` — extracted from `PWUsage/Models/Solar/SolarForecastProvider.swift`
   - `SolarHealthWeather.swift` — extracted from `PWUsage/Networking/Solar/OpenMeteoWeatherArchive.swift`
   - `TariffTimelineDTOs.swift` — pure tariff pricing inputs/DTOs (`SiteTariffsTimelineResponse`, `TariffPeriodDTO`, `TariffSeasonInput`, `TimePeriodWindowInput`, `ActiveTariffPeriodMatch`, and their nested value types) split from `PWUsage/Models/Bill/MobileTariffs.swift`, leaving `PWUsageAPIError`- and selection/review-coupled types in the app
   - `BillOutlookModels.swift` — pure value types used by `BillOutlookHistoryBuilder` (`BillOutlook`, `BillOutlookBucket`, `BillOutlookHistory`, `BillOutlookPeriod`, `BillOutlookPoint`, `BillOutlookTariff`) and `LoadTimingTimelineModels.swift` (`LoadTimingTariffSegment`, `NextCheaperPeriod`), leaving forecast-estimator extensions on `BillOutlook` in `PWUsage/Models/Bill/BillOutlook.swift`

### Xcode Project Integration (`cmd/ios-app/project.yml`)

Register the local package in `project.yml`:

```yaml
packages:
  PWUsageCore:
    path: Packages/PWUsageCore
```

Add `- package: PWUsageCore` under `targets.PWUsage.dependencies` (and under `PWUsageWidgets.dependencies` only if any `Shared/` file references a moved type). App files that use extracted types add `import PWUsageCore`. Preserve `DEVELOPMENT_TEAM: 6HQGHHRK87` and all existing scheme/config settings.

### Access Control & SwiftLint Compliance

- Mark types, properties, methods, and explicit `init(...)` declarations `public` **only** where consumed by `PWUsage` (or `PWUsageWidgets`). Keep internal helpers `internal`; `PWUsageCoreTests` imports `@testable import PWUsageCore`.
- Follow `.swiftlint.yml` strictly with zero `swiftlint:disable` comments:
  - **`no_extension_access_modifier`:** Never write `public extension Foo`; place `public` on each member inside `extension Foo`.
  - **`function_parameter_count` (5 warn / 8 error):** Where a moved struct previously relied on a synthesized `internal` memberwise initializer with >5 parameters and the app constructs it directly, group related fields into a small value type or use defaults/builders rather than suppressing the rule.
- Exclude `cmd/ios-app/Packages/PWUsageCore/.build` in both `.swiftformat` (`--exclude`) and `.swiftlint.yml` (`excluded:`) so SPM build artifacts are never formatted or linted, while `Sources/` and `Tests/` inside `Packages/PWUsageCore` remain covered by `./cmd/ios-app/lint.sh`.
- `.periphery.yml` already sets `retain_public: true` and scans `PWUsage` and `PWUsageWidgets`, so public package APIs do not create false positives.

---

## Testing Design

### Test Migration (`Tests/PWUsageCoreTests/`)

Move the pure test suites and their support files out of `cmd/ios-app/PWUsageTests/` into `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/`:

- **All 5 suites from `quick-test-skips.txt`:**
  - `SolarLayoutDetectorFixtureParityTests` (in `SolarLayoutResearchParityTests.swift` / detector parity files)
  - `SolarLayoutClearDaysParityTests`
  - `SolarHealthPassTests.swift`
  - `SolarHealthPassCacheTests.swift`
  - `SolarHealthClassifierPassTests.swift`
- **All remaining pure suites for the 3 domains:**
  - Solar Layout: `SolarLayoutDetectorTests.swift`, `SolarLayoutClearDaysTests.swift`, `SolarLayoutFitTests.swift`, `SolarLayoutReadinessTests.swift`, `SolarLayoutResearchParityTests.swift`, `SolarLayoutSelectionTests.swift`, `SolarLayoutSunPOATests.swift`, `MobileSolarLayoutTests.swift`
  - Solar Health: `SolarHealthBaselineTests.swift`, `SolarHealthBaselineTests+Score.swift`, `SolarHealthClassifierTests.swift`, `SolarHealthClassifierTests+Baseline.swift`, `SolarHealthClassifierAgingTests.swift`, `SolarHealthModelTests.swift`, `SolarHealthReferenceTests.swift`, `ManualSolarLayoutModelTests.swift`, `DegradationBacktest/*`
  - Bill Pricing: `BillPricingParityTests.swift`, `BillingCycleTests.swift`, `RatePeriodResolverTests.swift`
  - Support helpers: `SyntheticSolarSite.swift`, `BillPricingFixtureLoader.swift`, `SolarLayoutFixtureLoader.swift`

App-coupled tests (`SolarLayoutCloudSyncTests*`, `SolarLayoutCloudMergeTests`, `SolarLayoutDetectionRunner*`, `SolarLayoutRecordStoreTests`, `SolarLayoutSessionCleanupTests`, `SolarHealthScorePresentationTests`, `BillOutlookPresentationTests`, `BillOutlookProjectionCacheTests`, `BillOutlookTests`, `ManualSolarLayoutEditingTests`) remain in `PWUsageTests`.

### Fixtures (`Bundle.module`)

Move `PWUsageTests/Fixtures/SolarLayout/` and `PWUsageTests/Fixtures/BillPricing/` into `Packages/PWUsageCore/Tests/PWUsageCoreTests/Fixtures/`. Update `BillPricingFixtureLoader.load(_:)` and `SolarLayoutFixtureLoader.load(_:)` to resolve URLs from `Bundle.module` (searching the subdirectory `Fixtures/BillPricing` or `Fixtures/SolarLayout`), preserving the loud `LoadError.missingResource` failure if a fixture is missing.

### Local Runner Script (`cmd/ios-app/run-core-tests.sh`)

Add a small executable wrapper script `cmd/ios-app/run-core-tests.sh`:

- `./cmd/ios-app/run-core-tests.sh` — runs `swift test --package-path Packages/PWUsageCore` (Debug, fast everyday loop).
- `./cmd/ios-app/run-core-tests.sh --release` — runs `swift test -c release --package-path Packages/PWUsageCore` (optimized native execution for heavy math/backtest suites).
- `./cmd/ios-app/run-core-tests.sh --full` — runs `-c release` with `PWUSAGE_SOLAR_SLOW_PARITY=1` exported so opt-in year-fixture parity suites execute.
- Supports optional Swift Testing `--filter <pattern>` pass-through for single-suite runs.

### Simulator Runner Cleanup (`cmd/ios-app/quick-test-skips.txt` & `run-tests.sh`)

- Remove the 5 migrated suites from `cmd/ios-app/quick-test-skips.txt`, leaving it completely empty (0 bytes — `run-tests.sh` passes every non-empty line directly to `-skip-testing:` and does not strip `#` comments).
- Update `cmd/ios-app/test-run-tests.sh` if any assertion assumes `quick-test-skips.txt` is non-empty.

---

## CI Workflow Design (`.github/workflows/ios.yml`)

### New Parallel `core-tests` Job

Add a standalone `core-tests` job to `.github/workflows/ios.yml` that runs in parallel with the existing `test` (simulator) job:

- `if: github.event_name != 'pull_request' || github.event.pull_request.draft == false`
- `runs-on: macos-15`
- `timeout-minutes: 30`
- Steps:
  1. `actions/checkout@v7.0.1` (`fetch-depth: 0` so change detection for slow parity works on PRs)
  2. `sudo xcode-select -s /Applications/Xcode_26.3.app`
  3. Cache `cmd/ios-app/Packages/PWUsageCore/.build` keyed by `ios-core-build-${{ runner.os }}-${{ hashFiles('cmd/ios-app/Packages/PWUsageCore/Package.swift') }}-${{ github.sha }}` with prefix restore key `ios-core-build-${{ runner.os }}-${{ hashFiles('cmd/ios-app/Packages/PWUsageCore/Package.swift') }}-`
  4. Run `./cmd/ios-app/run-core-tests.sh --full` on `main`, `workflow_dispatch`, or PRs touching `Packages/PWUsageCore/Sources/PWUsageCore/SolarLayout/**` or `Packages/PWUsageCore/Tests/PWUsageCoreTests/Fixtures/SolarLayout/**`; otherwise run `./cmd/ios-app/run-core-tests.sh --release`.

### Simulator Job Coordination & Merge Safety

Because a separate effort is concurrently updating DerivedData caching and parallel simulator boot in `ios.yml` / `run-tests.sh`:

- **Do not modify** the simulator job's DerivedData cache keys, `restore-git-mtimes.py` step, or simulator boot logic while that PR is in flight.
- **Target end-state for the simulator job** (apply directly if the cache PR has already merged, or as an immediate follow-up cleanup):
  - Remove `PWUSAGE_DETECTOR_PARITY` / `--auto` promotion to `-O` (`--full`) from the simulator job so both `main` and PRs run the same fast Debug simulator test suite.
  - Remove the `main`-only `Clear optimized build products` + `Build Debug tests for pull requests` (`--build-only`) dual-cache steps, since `main` now produces the exact Debug cache PRs consume.

---

## Documentation Updates

- Update `cmd/ios-app/AGENTS.md` (Tests section) to document `./cmd/ios-app/run-core-tests.sh` (`--release`, `--full`, filter usage) alongside `./cmd/ios-app/run-tests.sh`.
- Update `cmd/ios-app/ARCHITECTURE.md` (Folder contract & Commands) to document `Packages/PWUsageCore/` and the boundary rule (pure Foundation models/engines live in `PWUsageCore`; app/UI/widget/store orchestration lives in `PWUsage`).

---

## Verification Plan

Before marking the implementation complete:

1. `./cmd/ios-app/run-core-tests.sh` passes (Debug).
2. `./cmd/ios-app/run-core-tests.sh --full` passes (Release + `PWUSAGE_SOLAR_SLOW_PARITY=1`, verifying all 5 migrated slow suites and both fixture loaders run cleanly on macOS).
3. `./cmd/ios-app/lint.sh` passes with zero SwiftFormat or SwiftLint violations.
4. `./cmd/ios-app/test-run-tests.sh` passes.
5. `./cmd/ios-app/run-tests.sh` passes (confirming `PWUsage` generates via XcodeGen, compiles against `PWUsageCore`, and passes all remaining simulator tests).
6. `./cmd/ios-app/periphery.sh` (if `periphery` is installed locally) reports no new dead-code regressions.
