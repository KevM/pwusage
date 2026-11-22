# `PWUsageCore` Swift Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the pure-Foundation compute engines (`SolarLayout`, `SolarHealth`, `BillPricing`) and their unit/parity/backtest suites into a local macOS-testable Swift Package (`cmd/ios-app/Packages/PWUsageCore`) and run them natively on macOS in CI via `swift test`.

**Architecture:** One local Swift Package (`PWUsageCore`) with a single library target (`PWUsageCore`) and one Swift Testing target (`PWUsageCoreTests`) bundling JSON fixtures via `Bundle.module`. Minimal pure-value structs (`EnergyFlowDay`, `SolarForecastSiteScope`, `SolarHealthWeather`, tariff timeline DTOs, bill outlook history types) are split out of app-coupled files so networking, stores, and UI remain in `PWUsage`. A standalone parallel `core-tests` job in `.github/workflows/ios.yml` runs `swift test` natively on macOS without conflicting with concurrent DerivedData cache / parallel simulator boot work.

**Tech Stack:** Swift 6.0, Swift Package Manager, Swift Testing (`import Testing`), XcodeGen (`project.yml`), SwiftFormat, SwiftLint (`--strict`), GitHub Actions (`macos-15`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-11-22-ios-core-swift-package-design.md`
- **Swift & Platforms:** `swift-tools-version: 6.0`; platforms `.iOS(.v18)` and `.macOS(.v15)`.
- **Device signing:** Preserve `DEVELOPMENT_TEAM: 6HQGHHRK87` in `cmd/ios-app/project.yml`.
- **Zero lint violations:** `./cmd/ios-app/lint.sh` must exit 0 after every task. Never add `swiftlint:disable` comments.
- **SwiftLint gotchas when adding `public`:**
  - `no_extension_access_modifier` is enabled: **never** write `public extension Foo`; write `extension Foo { public func ... }`.
  - `function_parameter_count` warns at 6+ parameters: if an explicit `public init(...)` has >5 parameters, group fields into a small value struct or adjust the constructor cleanly rather than suppressing the rule.
  - `trailing_comma`: `.swiftformat` sets `--trailing-commas never`. Do not leave trailing commas in multiline collection literals.
- **Swift Testing only:** All tests use `import Testing`, `@Suite`, `@Test`, `#expect`, `#require`. Never introduce `XCTest`.
- **Minimal `public` surface:** Only mark types, properties, methods, and `init`s `public` when referenced from `PWUsage` (or `PWUsageWidgets`). `PWUsageCoreTests` uses `@testable import PWUsageCore`.
- **Merge safety with concurrent CI work:** Do **not** modify the existing `test` (simulator) job's DerivedData cache keys, `restore-git-mtimes.py` step, or simulator boot logic in `.github/workflows/ios.yml`.

---

## Task 1: Scaffold `Packages/PWUsageCore`, Wire XcodeGen & Linter Excludes, Add `run-core-tests.sh`

**Files:**
- Create: `cmd/ios-app/Packages/PWUsageCore/Package.swift`
- Create: `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/PWUsageCore.swift`
- Create: `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/PWUsageCoreSmokeTests.swift`
- Create: `cmd/ios-app/run-core-tests.sh`
- Modify: `cmd/ios-app/project.yml`
- Modify: `.swiftformat`
- Modify: `.swiftlint.yml`

**Interfaces:**
- Produces: Local Swift Package `PWUsageCore` linked by `PWUsage` target in `project.yml`, plus `./cmd/ios-app/run-core-tests.sh` (`--release`, `--full`, `--filter`).

- [ ] **Step 1: Create `Package.swift` and minimal target files**

Create `cmd/ios-app/Packages/PWUsageCore/Package.swift`:

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PWUsageCore",
    platforms: [
        .iOS(.v18),
        .macOS(.v15)
    ],
    products: [
        .library(
            name: "PWUsageCore",
            targets: ["PWUsageCore"]
        )
    ],
    targets: [
        .target(
            name: "PWUsageCore"
        ),
        .testTarget(
            name: "PWUsageCoreTests",
            dependencies: ["PWUsageCore"]
        )
    ]
)
```

*(Note: `resources: [.copy("Fixtures")]` is added in Task 3 once the `Fixtures/` folder exists, because SPM errors if a declared resource directory does not exist yet.)*

Create `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/PWUsageCore.swift`:

```swift
/// Namespace marker for the platform-independent PWUsage core compute package.
public enum PWUsageCoreModule {}
```

Create `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/PWUsageCoreSmokeTests.swift`:

```swift
@testable import PWUsageCore
import Testing

@Suite("PWUsageCore smoke")
struct PWUsageCoreSmokeTests {
    @Test("Package module is importable on macOS")
    func moduleImports() {
        #expect(String(describing: PWUsageCoreModule.self) == "PWUsageCoreModule")
    }
}
```

- [ ] **Step 2: Create `cmd/ios-app/run-core-tests.sh`**

Create `cmd/ios-app/run-core-tests.sh` and `chmod +x cmd/ios-app/run-core-tests.sh`:

```bash
#!/usr/bin/env bash
# Usage: ./run-core-tests.sh [--release | --full] [--filter <pattern>] [extra swift test args...]
#   (no flag)  Debug build, runs all default PWUsageCoreTests natively on macOS.
#   --release  Optimized (-c release) build for fast numeric/backtest execution.
#   --full     Optimized (-c release) build with PWUSAGE_SOLAR_SLOW_PARITY=1 enabled.
set -euo pipefail

cd "$(dirname "$0")"

config="debug"
slow_parity="${PWUSAGE_SOLAR_SLOW_PARITY:-}"
extra_args=()

while (($# > 0)); do
    case "$1" in
        --release)
            config="release"
            shift
            ;;
        --full)
            config="release"
            slow_parity="1"
            shift
            ;;
        *)
            extra_args+=("$1")
            shift
            ;;
    esac
done

cmd=(swift test --package-path Packages/PWUsageCore -c "$config")
if ((${#extra_args[@]} > 0)); then
    cmd+=("${extra_args[@]}")
fi

if [[ "$slow_parity" == "1" ]]; then
    PWUSAGE_SOLAR_SLOW_PARITY=1 "${cmd[@]}"
else
    "${cmd[@]}"
fi
```

- [ ] **Step 3: Exclude `Packages/PWUsageCore/.build` in `.swiftformat` and `.swiftlint.yml`**

In `.swiftformat`, update `--exclude` to:
```text
--exclude cmd/ios-app/PWUsageScreenshots/SnapshotHelper.swift,cmd/ios-app/Packages/PWUsageCore/.build
```

In `.swiftlint.yml`, add `- cmd/ios-app/Packages/PWUsageCore/.build` under `excluded:`:
```yaml
excluded:
  - cmd/ios-app/build
  - cmd/ios-app/PWUsage.xcodeproj
  - cmd/ios-app/.build
  - cmd/ios-app/Packages/PWUsageCore/.build
  # Vendored from fastlane (`fastlane snapshot init`); keep it byte-identical for upgrades.
  - cmd/ios-app/PWUsageScreenshots/SnapshotHelper.swift
```

- [ ] **Step 4: Wire `PWUsageCore` into `cmd/ios-app/project.yml`**

Add top-level `packages:` in `cmd/ios-app/project.yml` (before `targets:`):

```yaml
packages:
  PWUsageCore:
    path: Packages/PWUsageCore
```

Add `- package: PWUsageCore` to `targets.PWUsage.dependencies`:

```yaml
    dependencies:
      - target: PWUsageWidgets
        embed: true
      - package: PWUsageCore
```

- [ ] **Step 5: Verify package tests, lint, and XcodeGen build**

Run:
```bash
./cmd/ios-app/run-core-tests.sh
./cmd/ios-app/lint.sh
cd cmd/ios-app && xcodegen generate && xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO build
```
Expected: `PWUsageCoreSmokeTests` passes, `iOS lint: clean`, iOS Simulator build succeeds.

- [ ] **Step 6: Commit**

```bash
git add .swiftformat .swiftlint.yml cmd/ios-app/project.yml cmd/ios-app/run-core-tests.sh cmd/ios-app/Packages/PWUsageCore
git commit -m "chore(ios): scaffold PWUsageCore local Swift package"
```

---

## Task 2: Extract `SharedModels` Pure Value Types

**Files:**
- Create: `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/SharedModels/EnergyFlowDay.swift`
- Create: `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/SharedModels/SolarForecastSiteScope.swift`
- Create: `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/SharedModels/SolarHealthWeather.swift`
- Create: `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/SharedModels/LoadTimingTimelineModels.swift`
- Create: `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/SharedModels/BillOutlookModels.swift`
- Create: `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/SharedModels/TariffTimelineDTOs.swift`
- Modify: `cmd/ios-app/PWUsage/State/Solar/SolarHistoryStore+Flows.swift`
- Modify: `cmd/ios-app/PWUsage/Models/Solar/SolarForecastProvider.swift`
- Modify: `cmd/ios-app/PWUsage/Networking/Solar/OpenMeteoWeatherArchive.swift`
- Modify: `cmd/ios-app/PWUsage/Models/MobileContracts.swift`
- Modify: `cmd/ios-app/PWUsage/Models/Bill/BillOutlook.swift`
- Modify: `cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift`
- Modify: any `cmd/ios-app/PWUsage/**/*.swift` and `cmd/ios-app/PWUsageTests/**/*.swift` files that reference these moved types (add `import PWUsageCore`)

**Interfaces:**
- Produces: Public `Sendable` / `Codable` / `Equatable` value types `EnergyFlowDay`, `SolarForecastSiteScope`, `SolarHealthWeather`, `LoadTimingTariffSegment`, `NextCheaperPeriod`, `BillOutlookBucket`, `BillOutlookPeriod`, `BillOutlookPoint`, `BillOutlookTariff`, `BillOutlookHistory`, `TimePeriodWindowInput`, `TariffSeasonInput`, `TariffUpdatedByDTO`, `TariffPeriodDTO`, `TeslaSyncAttemptDTO`, `TeslaSyncDTO`, `ActiveTariffPeriodMatch`, `SiteBatteryDTO`, `SiteTariffsTimelineResponse`.

- [ ] **Step 1: Move the 3 single-struct value types into `SharedModels/`**

1. Extract `struct EnergyFlowDay` (and its pure methods/properties) from `cmd/ios-app/PWUsage/State/Solar/SolarHistoryStore+Flows.swift` (starting at line 24) into `Packages/PWUsageCore/Sources/PWUsageCore/SharedModels/EnergyFlowDay.swift`. Mark the struct, properties, methods, and an explicit `public init(...)` as `public`. Add `import PWUsageCore` to `SolarHistoryStore+Flows.swift`.
2. Extract `struct SolarForecastSiteScope` from `cmd/ios-app/PWUsage/Models/Solar/SolarForecastProvider.swift` (starting at line 32) into `Packages/PWUsageCore/Sources/PWUsageCore/SharedModels/SolarForecastSiteScope.swift`. Mark `public` with explicit `public init(accountScopeID: String, siteID: String)`. Add `import PWUsageCore` to `SolarForecastProvider.swift`.
3. Extract `struct SolarHealthWeather` from `cmd/ios-app/PWUsage/Networking/Solar/OpenMeteoWeatherArchive.swift` (starting at line 3) into `Packages/PWUsageCore/Sources/PWUsageCore/SharedModels/SolarHealthWeather.swift`. Mark `public` with explicit `public init(...)`. Add `import PWUsageCore` to `OpenMeteoWeatherArchive.swift`.

- [ ] **Step 2: Move `LoadTimingTariffSegment`, `NextCheaperPeriod`, and `BillOutlook` history value types**

1. Extract `LoadTimingTariffSegment` and `NextCheaperPeriod` from `cmd/ios-app/PWUsage/Models/MobileContracts.swift` (lines 312–355) into `Packages/PWUsageCore/Sources/PWUsageCore/SharedModels/LoadTimingTimelineModels.swift` with `public` access and explicit `public init(...)`. Add `import PWUsageCore` to `MobileContracts.swift`.
2. Extract `BillOutlookBucket`, `BillOutlookPeriod`, `BillOutlookPoint`, `BillOutlookTariff`, and `BillOutlookHistory` from `cmd/ios-app/PWUsage/Models/Bill/BillOutlook.swift` (lines 3–55) into `Packages/PWUsageCore/Sources/PWUsageCore/SharedModels/BillOutlookModels.swift` with `public` access and explicit `public init(...)`. Leave forecast-projection types/extensions in `PWUsage/Models/Bill/BillOutlook.swift` and add `import PWUsageCore`.

- [ ] **Step 3: Split pure tariff timeline DTOs out of `MobileTariffs.swift`**

Move the pure tariff timeline value types from `cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift` (lines 61–258: `TimePeriodWindowInput`, `TariffSeasonInput`, `TariffUpdatedByDTO`, `TariffPeriodDTO`, `TeslaSyncAttemptDTO`, `TeslaSyncDTO`, `ActiveTariffPeriodMatch`, `SiteBatteryDTO`, `SiteTariffsTimelineResponse`, plus any tiny nested enums/structs they reference that don't depend on `PWUsageAPIError` or `Shared/MobileLiveContract.swift`) into `Packages/PWUsageCore/Sources/PWUsageCore/SharedModels/TariffTimelineDTOs.swift`.
- Keep any extension on `SiteTariffsTimelineResponse` that calls `RatePeriodResolver` in `PWUsage/Models/Bill/MobileTariffs.swift` for now (it will move with `RatePeriodResolver` in Task 5).
- Keep any field or extension that references `PWUsageAPIError`, `ReattributionStatusDTO`, or `SiteRateCountryDTO` in `PWUsage/Models/Bill/MobileTariffs.swift`. If `SiteTariffsTimelineResponse` or `TariffPeriodDTO` has a small pure-Foundation nested DTO from `RatePlanHistoryDTO.swift` / `RatePlanReviewDTO.swift` / `RatePlanSelection.swift` (like `RatePlanKind` or `ExportRateProvenance`), move that small pure enum into `TariffTimelineDTOs.swift` too rather than breaking `Codable` compatibility.
- Add `import PWUsageCore` to `MobileTariffs.swift` and any `PWUsage/` / `PWUsageTests/` files that reference the moved types.

- [ ] **Step 4: Build both `PWUsageCore` and `PWUsage` and run lint**

Run:
```bash
./cmd/ios-app/run-core-tests.sh
./cmd/ios-app/lint.sh
cd cmd/ios-app && xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO build-for-testing
```
Expected: `PWUsageCore` tests pass, `iOS lint: clean`, `PWUsage` and `PWUsageTests` compile cleanly with zero warnings/errors.

- [ ] **Step 5: Commit**

```bash
git add cmd/ios-app/Packages/PWUsageCore cmd/ios-app/PWUsage cmd/ios-app/PWUsageTests
git commit -m "refactor(ios): extract SharedModels value types into PWUsageCore"
```

---

## Task 3: Extract `SolarLayout` Engine and Migrate Its Tests & Fixtures

**Files:**
- Move to `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/SolarLayout/`:
  - `PWUsage/Models/Solar/LayoutDetection/*.swift` (all 10 files)
  - `PWUsage/Models/Solar/SolarPosition.swift`
  - `PWUsage/Models/Solar/MobileSolarLayout.swift`
- Move to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/Fixtures/SolarLayout/`:
  - `PWUsageTests/Fixtures/SolarLayout/*` (all JSON fixtures)
- Move to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/Support/`:
  - `PWUsageTests/Fixtures/SolarLayoutFixtureLoader.swift`
  - `PWUsageTests/Fixtures/SyntheticSolarSite.swift`
- Move to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/SolarLayout/`:
  - `PWUsageTests/SolarLayoutDetectorTests.swift`
  - `PWUsageTests/SolarLayoutClearDaysTests.swift`
  - `PWUsageTests/SolarLayoutFitTests.swift`
  - `PWUsageTests/SolarLayoutReadinessTests.swift`
  - `PWUsageTests/SolarLayoutResearchParityTests.swift`
  - `PWUsageTests/SolarLayoutSelectionTests.swift`
  - `PWUsageTests/SolarLayoutSunPOATests.swift`
  - `PWUsageTests/MobileSolarLayoutTests.swift`
- Modify: `cmd/ios-app/Packages/PWUsageCore/Package.swift` (add `resources: [.copy("Fixtures")]`)
- Modify: `cmd/ios-app/PWUsage/**/*.swift` and remaining `PWUsageTests/**/*.swift` (add `import PWUsageCore` where needed)

**Interfaces:**
- Consumes: `SharedModels` from Task 2.
- Produces: Public `SolarLayoutDetector`, `DetectedSolarLayout`, `SolarLayout`, `SolarLayoutConfidence`, `SolarLayoutPlane`, `SolarPosition`, `SolarLayoutReadiness`, `LayoutPOA`, `LayoutFit`, `LayoutSelection`, `LayoutSunSample`, and `SolarLayoutFixture` loader via `Bundle.module`.

- [ ] **Step 1: Move `SolarLayout` sources into `Packages/PWUsageCore/Sources/PWUsageCore/SolarLayout/`**

Use `git mv` for all 12 source files. Add minimal `public` modifiers (types, properties, methods, explicit `public init`s) for symbols referenced from `PWUsage` (remember: never `public extension`, put `public` on individual members). Add `import PWUsageCore` to `PWUsage` files that reference them.

- [ ] **Step 2: Enable `Fixtures` resource bundling in `Package.swift` and move fixtures + loader**

Update `testTarget` in `cmd/ios-app/Packages/PWUsageCore/Package.swift`:
```swift
        .testTarget(
            name: "PWUsageCoreTests",
            dependencies: ["PWUsageCore"],
            resources: [
                .copy("Fixtures")
            ]
        )
```

Move `cmd/ios-app/PWUsageTests/Fixtures/SolarLayout` to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/Fixtures/SolarLayout`.
Move `SolarLayoutFixtureLoader.swift` and `SyntheticSolarSite.swift` to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/Support/`.

In `SolarLayoutFixtureLoader.swift`, replace `Bundle(for: FixtureBundleToken.self)` with `Bundle.module` and delete the unused `FixtureBundleToken`:
```swift
        guard let url = Bundle.module.url(
            forResource: name,
            withExtension: "json",
            subdirectory: "Fixtures/SolarLayout"
        ) else {
            throw LoadError.missingResource(name)
        }
```
*(If any remaining test in `PWUsageTests` still references `SyntheticSolarSite` before Task 4 completes, keep a copy or move `SyntheticSolarSite.swift` in Task 4 — check with `grep -rn SyntheticSolarSite cmd/ios-app/PWUsageTests/` first!)*

- [ ] **Step 3: Move the 8 `SolarLayout` test files and update imports**

Move the 8 test files into `Packages/PWUsageCore/Tests/PWUsageCoreTests/SolarLayout/`. Replace `@testable import PWUsage` with `@testable import PWUsageCore` in each moved test file.

- [ ] **Step 4: Run macOS package tests (including `--full`), lint, and iOS `build-for-testing`**

Run:
```bash
./cmd/ios-app/run-core-tests.sh --full
./cmd/ios-app/lint.sh
cd cmd/ios-app && xcodegen generate && xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO build-for-testing
```
Expected: All `SolarLayout*` unit and slow year-fixture parity suites pass natively on macOS, `iOS lint: clean`, and `PWUsage` + `PWUsageTests` compile cleanly.

- [ ] **Step 5: Commit**

```bash
git add cmd/ios-app/Packages/PWUsageCore cmd/ios-app/PWUsage cmd/ios-app/PWUsageTests
git commit -m "refactor(ios): move SolarLayout engine and tests into PWUsageCore"
```

---

## Task 4: Extract `SolarHealth` Engine (Split `SolarHealthPass+Run.swift`) and Migrate Its Tests

**Files:**
- Move to `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/SolarHealth/`:
  - `PWUsage/Models/Solar/Health/*.swift` (all 11 files)
  - `PWUsage/State/Solar/ManualSolarLayout.swift`
  - `PWUsage/State/Solar/ManualSolarLayout+Model.swift`
  - `PWUsage/State/Solar/SolarHealthCache.swift`
  - `PWUsage/State/Solar/SolarHealthPass.swift` (pure `version`, `Context`, `compute(...)`)
- Create: `cmd/ios-app/PWUsage/State/Solar/SolarHealthPass+Run.swift` (`extension SolarHealthPass { static func run(...) }`)
- Move to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/SolarHealth/`:
  - `PWUsageTests/SolarHealthBaselineTests.swift`
  - `PWUsageTests/SolarHealthBaselineTests+Score.swift`
  - `PWUsageTests/SolarHealthClassifierTests.swift`
  - `PWUsageTests/SolarHealthClassifierTests+Baseline.swift`
  - `PWUsageTests/SolarHealthClassifierAgingTests.swift`
  - `PWUsageTests/SolarHealthClassifierPassTests.swift`
  - `PWUsageTests/SolarHealthModelTests.swift`
  - `PWUsageTests/SolarHealthPassCacheTests.swift`
  - `PWUsageTests/SolarHealthPassTests.swift`
  - `PWUsageTests/SolarHealthReferenceTests.swift`
  - `PWUsageTests/ManualSolarLayoutModelTests.swift`
  - `PWUsageTests/DegradationBacktest/*.swift` (all 6 files)

**Interfaces:**
- Consumes: `SharedModels` (`SolarForecastSiteScope`, `SolarHealthWeather`) and `SolarLayout` (`SolarPosition`, `DetectedSolarLayout`, `SolarLayout`, `SolarLayoutPlane`) from Tasks 2–3.
- Produces: Public `SolarHealthPass` (`version`, `Context`, `compute(...)`), `SolarHealthCache`, `SolarHealthResult`, `SolarHealthYear`, `SolarHealthYearFit`, `SolarHealthReference`, `SolarHealthBaseline`, `SolarHealthClassifier`, `SolarHealthFindings`, `ManualSolarLayout`, `ManualSolarSystem`, `ManualSolarFace`.

- [ ] **Step 1: Split `SolarHealthPass.run(...)` into `PWUsage/State/Solar/SolarHealthPass+Run.swift`**

Create `cmd/ios-app/PWUsage/State/Solar/SolarHealthPass+Run.swift` containing `import Foundation`, `import PWUsageCore`, and `extension SolarHealthPass { static func run(scope:history:record:cache:now:) async throws -> SolarHealthResult? { ... } }` (moved verbatim from `SolarHealthPass.swift` lines 11–39). Remove `run(...)` from `SolarHealthPass.swift`.

- [ ] **Step 2: Guard iOS-only file protection in `SolarHealthCache.swift`**

In `SolarHealthCache.swift` inside `store(_:scope:)`, replace the `.write(to:options:)` call with:

```swift
        #if os(iOS)
            let writeOptions: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        #else
            let writeOptions: Data.WritingOptions = [.atomic]
        #endif
        try encoder.encode(year).write(to: file(year.year, scope: scope), options: writeOptions)
```

- [ ] **Step 3: Move the 15 `SolarHealth` source files into `Packages/PWUsageCore/Sources/PWUsageCore/SolarHealth/`**

Use `git mv`, add minimal `public` modifiers for app-consumed APIs, and add `import PWUsageCore` to `PWUsage` files referencing them (including `ManualSolarLayout+Editing.swift`, `SolarHealthModel.swift`, `SolarHealthWeatherStore.swift`, and `SolarHealthScorePresentation*`).

- [ ] **Step 4: Move the `SolarHealth` and `DegradationBacktest` test files into `PWUsageCoreTests`**

Move all 11 `SolarHealth*` / `ManualSolarLayoutModelTests` files plus the `DegradationBacktest/` folder into `Packages/PWUsageCore/Tests/PWUsageCoreTests/SolarHealth/` (and `DegradationBacktest/`). Replace `@testable import PWUsage` with `@testable import PWUsageCore` in every moved test file.

- [ ] **Step 5: Run macOS package tests (`--full`), lint, and iOS `build-for-testing`**

Run:
```bash
./cmd/ios-app/run-core-tests.sh --full
./cmd/ios-app/lint.sh
cd cmd/ios-app && xcodegen generate && xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO build-for-testing
```
Expected: All `SolarHealth*`, `SolarHealthPass*`, and `DegradationBacktest*` suites (including the 10-year budget test under `PWUSAGE_SOLAR_SLOW_PARITY=1`) pass natively on macOS, `iOS lint: clean`, and `PWUsage` + `PWUsageTests` compile cleanly.

- [ ] **Step 6: Commit**

```bash
git add cmd/ios-app/Packages/PWUsageCore cmd/ios-app/PWUsage cmd/ios-app/PWUsageTests
git commit -m "refactor(ios): move SolarHealth engine and backtests into PWUsageCore"
```

---

## Task 5: Extract `BillPricing` Engine and Migrate Its Tests & Fixtures

**Files:**
- Move to `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/BillPricing/`:
  - `PWUsage/Models/Bill/Pricing/BillPricing.swift`
  - `PWUsage/Models/Bill/Pricing/BillingCycle.swift`
  - `PWUsage/Models/Bill/Pricing/BillUsageAggregator.swift`
  - `PWUsage/Models/Bill/Pricing/RatePeriodResolver.swift`
  - `PWUsage/Models/Bill/Pricing/BillOutlookHistoryBuilder.swift`
  - `PWUsage/Models/LoadTiming/Local/LoadTimingTimelineBuilder.swift`
- Move to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/Fixtures/BillPricing/`:
  - `PWUsageTests/Fixtures/BillPricing/*` (all 10 JSON fixtures)
- Move to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/Support/`:
  - `PWUsageTests/Fixtures/BillPricingFixtureLoader.swift`
- Move to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/BillPricing/`:
  - `PWUsageTests/BillPricingParityTests.swift`
  - `PWUsageTests/BillingCycleTests.swift`
  - `PWUsageTests/RatePeriodResolverTests.swift`
- Modify: `cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift` (move pure `RatePeriodResolver` helper extensions on `SiteTariffsTimelineResponse` into `PWUsageCore` if they only depend on `PWUsageCore` types)
- Modify: `cmd/ios-app/PWUsage/**/*.swift` and remaining `PWUsageTests/**/*.swift` (add `import PWUsageCore` where needed)

**Interfaces:**
- Consumes: `SharedModels` (`EnergyFlowDay`, `TariffTimelineDTOs`, `BillOutlookModels`, `LoadTimingTimelineModels`) from Task 2.
- Produces: Public `BillPricing`, `BillingCycle`, `BillUsageAggregator`, `RatePeriodResolver`, `BillOutlookHistoryBuilder`, `LoadTimingTimelineBuilder`, and `BillPricingFixture` loader via `Bundle.module`.

- [ ] **Step 1: Move the 6 `BillPricing` + `LoadTimingTimelineBuilder` source files into `Packages/PWUsageCore/Sources/PWUsageCore/BillPricing/`**

Use `git mv`, add minimal `public` modifiers for symbols consumed by `PWUsage`, and add `import PWUsageCore` to `PWUsage` callers. Remove the placeholder `Sources/PWUsageCore/PWUsageCore.swift` and `Tests/PWUsageCoreTests/PWUsageCoreSmokeTests.swift` now that real sources and tests live in the package.

- [ ] **Step 2: Move `Fixtures/BillPricing` and update `BillPricingFixtureLoader.swift` to `Bundle.module`**

Move `cmd/ios-app/PWUsageTests/Fixtures/BillPricing` to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/Fixtures/BillPricing`.
Move `BillPricingFixtureLoader.swift` to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/Support/BillPricingFixtureLoader.swift`.

In `BillPricingFixtureLoader.swift`, replace `@testable import PWUsage` with `@testable import PWUsageCore`, replace `Bundle(for: BillPricingFixtureToken.self)` with `Bundle.module`, and delete `BillPricingFixtureToken`:
```swift
        guard let url = Bundle.module.url(
            forResource: name,
            withExtension: "json",
            subdirectory: "Fixtures/BillPricing"
        ) else {
            throw LoadError.missingResource(name)
        }
```

- [ ] **Step 3: Move the 3 `BillPricing` test files and update imports**

Move `BillPricingParityTests.swift`, `BillingCycleTests.swift`, and `RatePeriodResolverTests.swift` into `Packages/PWUsageCore/Tests/PWUsageCoreTests/BillPricing/`. Replace `@testable import PWUsage` with `@testable import PWUsageCore`.

- [ ] **Step 4: Run macOS package tests, lint, and iOS `build-for-testing`**

Run:
```bash
./cmd/ios-app/run-core-tests.sh --release
./cmd/ios-app/lint.sh
cd cmd/ios-app && xcodegen generate && xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO build-for-testing
```
Expected: All `PWUsageCoreTests` (SolarLayout + SolarHealth + BillPricing) pass on macOS, `iOS lint: clean`, and `PWUsage` + `PWUsageTests` compile cleanly.

- [ ] **Step 5: Commit**

```bash
git add cmd/ios-app/Packages/PWUsageCore cmd/ios-app/PWUsage cmd/ios-app/PWUsageTests
git commit -m "refactor(ios): move BillPricing engine and parity tests into PWUsageCore"
```

---

## Task 6: Empty `quick-test-skips.txt`, Wire `core-tests` in CI, Update Docs & Full Verification

**Files:**
- Modify: `cmd/ios-app/quick-test-skips.txt` (truncate to 0 bytes)
- Modify: `cmd/ios-app/test-run-tests.sh` (only if any assertion assumes `quick-test-skips.txt` is non-empty)
- Modify: `.github/workflows/ios.yml` (add independent parallel `core-tests` job; leave existing `test` job's cache and simulator boot lines untouched for merge safety)
- Modify: `cmd/ios-app/AGENTS.md`
- Modify: `cmd/ios-app/ARCHITECTURE.md`

**Interfaces:**
- Consumes: `cmd/ios-app/run-core-tests.sh` and `cmd/ios-app/Packages/PWUsageCore` from Tasks 1–5.
- Produces: Parallel macOS `core-tests` CI job, clean 0-byte `quick-test-skips.txt`, and updated agent/architecture docs.

- [ ] **Step 1: Truncate `cmd/ios-app/quick-test-skips.txt` to 0 bytes and verify `test-run-tests.sh`**

```bash
: > cmd/ios-app/quick-test-skips.txt
./cmd/ios-app/test-run-tests.sh
```
If `test-run-tests.sh` asserts that `--quick` passes `-skip-testing:` flags from `quick-test-skips.txt`, update that test case to verify `--quick` handles an empty `quick-test-skips.txt` cleanly (passing no `-skip-testing:` args) and still skips lines when the file is non-empty.

- [ ] **Step 2: Add the parallel `core-tests` job to `.github/workflows/ios.yml`**

Add a new `core-tests` job under `jobs:` in `.github/workflows/ios.yml` (do not alter the existing `test` job's DerivedData cache or simulator boot steps):

```yaml
  core-tests:
    name: Run Core Package Tests (macOS)
    if: github.event_name != 'pull_request' || github.event.pull_request.draft == false
    runs-on: macos-15
    timeout-minutes: 30

    defaults:
      run:
        working-directory: ./cmd/ios-app

    steps:
      - name: Checkout code
        uses: actions/checkout@v7.0.1
        with:
          fetch-depth: 0

      - name: Select Xcode
        run: sudo xcode-select -s /Applications/Xcode_26.3.app

      - name: Cache PWUsageCore build
        uses: actions/cache@v6.1.0
        with:
          path: cmd/ios-app/Packages/PWUsageCore/.build
          key: ios-core-build-${{ runner.os }}-${{ hashFiles('cmd/ios-app/Packages/PWUsageCore/Package.swift') }}-${{ github.sha }}
          restore-keys: |
            ios-core-build-${{ runner.os }}-${{ hashFiles('cmd/ios-app/Packages/PWUsageCore/Package.swift') }}-

      - name: Run PWUsageCore Tests
        env:
          EVENT_NAME: ${{ github.event_name }}
          BASE_REF: ${{ github.base_ref }}
        run: |
          mode="--release"
          if [[ "$EVENT_NAME" != "pull_request" ]]; then
            mode="--full"
          elif git diff --name-only "origin/${BASE_REF}...HEAD" -- \
            Packages/PWUsageCore/Sources/PWUsageCore/SolarLayout \
            Packages/PWUsageCore/Tests/PWUsageCoreTests/Fixtures/SolarLayout \
            | grep -q .; then
            mode="--full"
          fi
          ./run-core-tests.sh "$mode"
```

- [ ] **Step 3: Update `cmd/ios-app/AGENTS.md` and `cmd/ios-app/ARCHITECTURE.md`**

- In `cmd/ios-app/AGENTS.md` under `## Tests`, document `./cmd/ios-app/run-core-tests.sh` (`--release`, `--full`, `--filter`) for pure-logic tests in `Packages/PWUsageCore`, alongside `./cmd/ios-app/run-tests.sh` for simulator tests.
- In `cmd/ios-app/ARCHITECTURE.md` under `## Folder contract` and `## Commands`, add `Packages/PWUsageCore/` (pure-Foundation compute engines tested natively on macOS) and `./run-core-tests.sh`.

- [ ] **Step 4: Run the full verification suite**

Run every verification command and confirm zero failures:
```bash
./cmd/ios-app/run-core-tests.sh
./cmd/ios-app/run-core-tests.sh --full
./cmd/ios-app/lint.sh
./cmd/ios-app/test-run-tests.sh
./cmd/ios-app/run-tests.sh
```
If `periphery` is installed locally, also run `./cmd/ios-app/periphery.sh`.

- [ ] **Step 5: Commit**

```bash
git add cmd/ios-app/quick-test-skips.txt cmd/ios-app/test-run-tests.sh .github/workflows/ios.yml cmd/ios-app/AGENTS.md cmd/ios-app/ARCHITECTURE.md
git commit -m "ci(ios): run PWUsageCore tests natively on macOS in parallel"
```

---

## Follow-Up Cleanup (After Concurrent GHA Cache PR Merges)

Once the concurrent PR fixing GHA DerivedData caching and parallel simulator boot lands on `main`, open a tiny cleanup PR in `.github/workflows/ios.yml` to:
1. Remove `PWUSAGE_DETECTOR_PARITY` / `--auto` promotion to `-O` (`--full`) from the simulator `test` job (since all 5 slow parity/health suites now run in `core-tests`).
2. Remove the `main`-only `Clear optimized build products` + `Build Debug tests for pull requests` (`--build-only`) dual-cache steps so `main` and PRs share one Debug DerivedData cache.
