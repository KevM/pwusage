# `PWUsageCore` LoadTiming Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the pure-Foundation `LoadTiming` / Smart Shift models, `EnergyFlowProjection`, `LoadProfileStore`, and their 13 unit and property-based test suites into `cmd/ios-app/Packages/PWUsageCore` so they run natively on macOS via `./cmd/ios-app/run-core-tests.sh`.

**Architecture:** Extends the existing `PWUsageCore` local Swift Package (`Packages/PWUsageCore/Sources/PWUsageCore/LoadTiming/` and `Packages/PWUsageCore/Tests/PWUsageCoreTests/LoadTiming/`) with zero changes to `Package.swift`, `project.yml`, `.github/workflows/ios.yml`, `.swiftformat`, or `.swiftlint.yml`. Completely orthogonal to Rate Plans (`Models/Bill/`, `State/Bill/`) and Savings (`Models/Savings/`, `State/Savings/`).

**Tech Stack:** Swift 6.0, Swift Package Manager, Foundation + Combine (both native on macOS), Swift Testing (`import Testing`), SwiftFormat, SwiftLint (`--strict`).

## Global Constraints

- **Worktree & Branch:** `/Users/kevm/github/pwusage/.worktrees/ios-core-load-timing` on branch `feat/ios-core-load-timing` (branched off `origin/main` at `fb6dba65`).
- **Orthogonality (strict):** Do **not** touch `Models/Bill/`, `State/Bill/`, `Models/Savings/`, `State/Savings/`, `Views/Bill/`, `Views/Savings/`, `Package.swift`, `project.yml`, or `.github/workflows/ios.yml` unless a single `import PWUsageCore` line is required by a caller of a moved `LoadTiming` type.
- **Zero lint violations:** `./cmd/ios-app/lint.sh` must exit 0 after every task. Never add `swiftlint:disable` comments.
- **SwiftLint rules to watch when adding `public`:**
  - `no_extension_access_modifier`: never write `public extension Foo`; put `public` on individual members inside `extension Foo`.
  - `function_parameter_count`: 5 warn / 8 error. Do not add explicit `public init`s with >5 parameters if avoidable; group fields or keep internal where not constructed by `PWUsage`.
  - `trailing_comma`: `.swiftformat` uses `--trailing-commas never`.
- **Swift Testing only:** All tests use `import Testing`, `@Suite`, `@Test`, `#expect`, `#require`. Never introduce `XCTest`.
- **Minimal `public` surface:** Only mark types, properties, methods, and `init`s `public` where referenced from `PWUsage` (or `PWUsageTests`). `PWUsageCoreTests` uses `@testable import PWUsageCore`.
- **Keep View/UI-coupled files in `PWUsage` / `PWUsageTests`:**
  - Keep `SmartShiftDiagnostics.swift` (references `DashboardContracts.swift`) and `SmartShiftDiagnosticsTests.swift` in `PWUsage` / `PWUsageTests`.
  - Keep `JobGlyphsTests.swift` (imports `UIKit` to check SF Symbols), `JobTemplatesTests.swift` (tests `Views/LoadTiming/` `ProfileDraft`), and all `SmartShiftPresentationTests*`, `SmartShiftBarGeometryTests`, `SmartShiftSkySweepTests`, `SmartShiftGlanceableTests`, `SmartShiftSelectionTests`, `LoadTimingViewTests`, `CarSummaryPresentationTests` in `PWUsageTests`.

---

## Task 1: Move `EnergyFlowProjection`, `LoadProfile`, `LoadProfileStore`, and Job/Car Value Models + Migrate 5 Test Suites

**Files:**
- Move to `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/LoadTiming/`:
  - `PWUsage/Models/EnergyFlowProjection.swift`
  - `PWUsage/Models/LoadTiming/Array+PartitionPoint.swift`
  - `PWUsage/Models/LoadTiming/CarChargeSource.swift`
  - `PWUsage/Models/LoadTiming/CarChargeSteps.swift`
  - `PWUsage/Models/LoadTiming/JobGlyphs.swift`
  - `PWUsage/Models/LoadTiming/JobTemplates.swift`
  - `PWUsage/Models/LoadTiming/LoadProfile.swift`
  - `PWUsage/State/LoadTiming/LoadProfileStore.swift`
- Move to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/LoadTiming/`:
  - `PWUsageTests/CarChargeSourceTests.swift`
  - `PWUsageTests/CarChargeStepsTests.swift`
  - `PWUsageTests/LoadProfileStoreTests.swift`
  - `PWUsageTests/LoadProfileStoreTests+Cars.swift`
  - `PWUsageTests/LoadProfileStoreTests+Templates.swift`
- Modify: `PWUsage/**/*.swift` and `PWUsageTests/**/*.swift` callers referencing moved types (add `import PWUsageCore`)

**Interfaces:**
- Consumes: Existing `PWUsageCore` (`SolarForecast`, `BillPricing`, `SharedModels`).
- Produces: Public `EnergyFlowProjection`, `CarChargeSource`, `CarChargeSteps`, `JobGlyphs`, `JobTemplates`, `LoadProfile`, `LoadProfileStore`, and `Array.partitionPoint(where:)`.

- [ ] **Step 1: Move the 8 source files into `Packages/PWUsageCore/Sources/PWUsageCore/LoadTiming/`**

Use `git mv` for all 8 files. Remove redundant `import PWUsageCore` inside `EnergyFlowProjection.swift`. Add minimal `public` modifiers (types, properties, methods, explicit `public init`s) for symbols consumed by `PWUsage` and `PWUsageTests` (including `JobGlyphsTests`, `JobTemplatesTests`, `Views/LoadTiming/*`, and `DashboardCoordinator*`). Add `import PWUsageCore` to `PWUsage` callers.

- [ ] **Step 2: Move the 5 test files into `Packages/PWUsageCore/Tests/PWUsageCoreTests/LoadTiming/`**

Use `git mv` for:
- `CarChargeSourceTests.swift`
- `CarChargeStepsTests.swift`
- `LoadProfileStoreTests.swift`
- `LoadProfileStoreTests+Cars.swift`
- `LoadProfileStoreTests+Templates.swift`

Replace `@testable import PWUsage` with `@testable import PWUsageCore` in each moved test file.

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
git commit -m "refactor(ios): move LoadProfile, EnergyFlowProjection, and car/job models into PWUsageCore"
```

---

## Task 2: Move `LoadTimingEstimator` & `LoadTimingForecastEstimator` (+ Extensions) and Migrate 7 Estimator Test Suites

**Files:**
- Move to `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/LoadTiming/`:
  - `PWUsage/Models/LoadTiming/LoadTimingEstimator.swift`
  - `PWUsage/Models/LoadTiming/LoadTimingForecastEstimator.swift`
  - `PWUsage/Models/LoadTiming/LoadTimingForecastEstimator+Evaluate.swift`
  - `PWUsage/Models/LoadTiming/LoadTimingForecastEstimator+Model.swift`
  - `PWUsage/Models/LoadTiming/LoadTimingForecastEstimator+Plan.swift`
  - `PWUsage/Models/LoadTiming/LoadTimingForecastEstimator+Projection.swift`
  - `PWUsage/Models/LoadTiming/LoadTimingForecastEstimator+Selection.swift`
- Move to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/LoadTiming/`:
  - `PWUsageTests/LoadTimingEstimatorTests.swift`
  - `PWUsageTests/LoadTimingForecastEstimatorTests.swift`
  - `PWUsageTests/LoadTimingForecastEstimatorTests+BillDate.swift`
  - `PWUsageTests/LoadTimingForecastEstimatorTests+HistorySafety.swift`
  - `PWUsageTests/LoadTimingForecastEstimatorTests+Horizon.swift`
  - `PWUsageTests/LoadTimingForecastEstimatorTests+Projection.swift`
  - `PWUsageTests/LoadTimingForecastEstimatorTests+Safety.swift`
- Modify: `PWUsage/**/*.swift` and `PWUsageTests/**/*.swift` callers (add `import PWUsageCore`)

**Interfaces:**
- Consumes: `EnergyFlowProjection`, `LoadProfile`, `Array.partitionPoint(where:)` from Task 1, plus `SolarForecast` and `BillPricing` already in `PWUsageCore`.
- Produces: Public `LoadTimingEstimator`, `LoadTimingForecastEstimator`, `PlanningContext`, and all estimator evaluation/selection/projection types used by `Views/LoadTiming/` and `PWUsage/Models/Bill/BillOutlook.swift`.

- [ ] **Step 1: Move the 7 estimator source files into `Packages/PWUsageCore/Sources/PWUsageCore/LoadTiming/`**

Use `git mv` for all 7 files. Remove redundant `import PWUsageCore` inside them. Add minimal `public` modifiers (remember: never `public extension`; put `public` on individual members inside each `extension LoadTimingForecastEstimator`). Add `import PWUsageCore` to any `PWUsage` caller that does not already import it.

- [ ] **Step 2: Move the 7 estimator test files into `Packages/PWUsageCore/Tests/PWUsageCoreTests/LoadTiming/`**

Use `git mv` for all 7 `LoadTiming*EstimatorTests*.swift` files. Replace `@testable import PWUsage` with `@testable import PWUsageCore` (and remove duplicate `import PWUsageCore`).

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
git commit -m "refactor(ios): move LoadTimingEstimator and LoadTimingForecastEstimator into PWUsageCore"
```

---

## Task 3: Migrate `SmartShiftPropertyTests` & `SmartShiftScenario` into `PWUsageCoreTests`

**Files:**
- Move to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/Support/`:
  - `PWUsageTests/Fixtures/SmartShiftScenario.swift`
- Move to `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/LoadTiming/`:
  - `PWUsageTests/SmartShiftPropertyTests.swift`
- Modify: `cmd/ios-app/PWUsageTests/Fixtures/README.md` (update path reference for `SmartShiftScenario.swift` if present)

**Interfaces:**
- Consumes: `LoadTimingForecastEstimator` and `EnergyFlowProjection` from Tasks 1–2.
- Produces: Native macOS property-based Smart Shift tests (supports `PWUSAGE_FUZZ_STRESS=1` / `PWUSAGE_FUZZ_SEED=<seed>` directly via `./cmd/ios-app/run-core-tests.sh --filter SmartShiftPropertyTests`).

- [ ] **Step 1: Move `SmartShiftScenario.swift` and `SmartShiftPropertyTests.swift`**

Use `git mv` for both files. Replace `@testable import PWUsage` with `@testable import PWUsageCore` (and remove duplicate `import PWUsageCore`). Update `cmd/ios-app/PWUsageTests/Fixtures/README.md` if it mentions `SmartShiftScenario.swift`.

- [ ] **Step 2: Verify `SmartShiftPropertyTests` on macOS, `lint.sh`, and iOS `build-for-testing`**

Run:
```bash
./cmd/ios-app/run-core-tests.sh --filter SmartShiftPropertyTests
./cmd/ios-app/lint.sh
cd cmd/ios-app && xcodegen generate && xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO build-for-testing
```
Expected: `SmartShiftPropertyTests` passes natively on macOS, `iOS lint: clean`, and `PWUsage` + `PWUsageTests` compile cleanly.

- [ ] **Step 3: Commit**

```bash
git add cmd/ios-app/Packages/PWUsageCore cmd/ios-app/PWUsageTests
git commit -m "refactor(ios): move SmartShiftPropertyTests into PWUsageCoreTests"
```

---

## Task 4: Update Docs & Run Full End-to-End Verification

**Files:**
- Modify: `cmd/ios-app/AGENTS.md`
- Modify: `cmd/ios-app/ARCHITECTURE.md`

**Interfaces:**
- Consumes: Completed `LoadTiming` extraction from Tasks 1–3.
- Produces: Accurate docs listing `LoadTiming` in `PWUsageCore` and verified green test runs.

- [ ] **Step 1: Update `cmd/ios-app/AGENTS.md` and `cmd/ios-app/ARCHITECTURE.md`**

- In `cmd/ios-app/AGENTS.md` under `## Tests`, add `LoadTiming` to the list of pure-Foundation suites in `Packages/PWUsageCore` (`SolarLayout`, `SolarHealth`, `SolarForecast`, `BillPricing`, `LoadTiming`).
- In `cmd/ios-app/ARCHITECTURE.md` under `## Folder contract`, add `LoadTiming` to the `Packages/PWUsageCore/` line.

- [ ] **Step 2: Run full verification suite and orthogonality check**

Run every check and confirm zero failures:
```bash
./cmd/ios-app/run-core-tests.sh
./cmd/ios-app/lint.sh
./cmd/ios-app/test-run-tests.sh
./cmd/ios-app/run-tests.sh
```
Check for accidental overlap with Rate Plans / Savings or build config:
```bash
git diff --name-only origin/main..HEAD | grep -E '(Models|State|Views)/(Bill|Savings)/|Package\.swift|project\.yml|\.github/workflows/ios\.yml' || echo "clean: no unexpected overlap"
```
*(Note: `Models/Bill/BillOutlook.swift` already imports `PWUsageCore`; if any `Bill/` or `Savings/` file required only a 1-line `import PWUsageCore`, confirm it is a 1-line import only.)*

- [ ] **Step 3: Commit**

```bash
git add cmd/ios-app/AGENTS.md cmd/ios-app/ARCHITECTURE.md
git commit -m "docs(ios): list LoadTiming in PWUsageCore package docs"
```
