# Remove Solcast as Solar Forecasting Provider Implementation Plan

For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Solcast and all user-managed API key infrastructure from pwusage, leaving a purely automatic solar forecasting pipeline powered by detected panel layout and Open-Meteo (falling back to historical baseline patterns when no layout is available).

**Architecture:** Deletes the Solcast client, Keychain credential store, and the daily-budget store. Simplifies SolarForecastService and DashboardCoordinator to route directly to the automatic provider without credential-based branching. Updates Settings UI to show only the automatic forecast status and home location picker. Updates Demo mode with a mock publication and cleans up legacy storage on launch.

**Tech Stack:** Swift 6.0, SwiftUI, Swift Testing (`import Testing`), XcodeGen, TypeScript/Node.

## Global Constraints
- Target iOS 18.0.
- Swift Testing (`import Testing`, `@Suite`, `@Test`, `#expect`) must be used for all iOS unit tests; no XCTest.
- SwiftLint budgets: Line length ≤ 120 chars; file length ≤ 400 (warn)/500 (err); type body ≤ 350 (warn)/450 (err); function body ≤ 50 (warn)/100 (err); cyclomatic complexity ≤ 10 (warn)/20 (err). Run `cmd/ios-app/format.sh` after edits.
- Run tests via `cmd/ios-app/run-tests.sh` (or `./run-tests.sh --quick`).
- Run `cd cmd/next-app && npm run lint && npm run build` to ensure repository integrity.

---

### Task 1: Remove Solcast Models, Client, and Provider

**Files:**
- Delete: `cmd/ios-app/PWUsage/Networking/Solar/solcast-client.swift`
- Delete: `cmd/ios-app/PWUsage/State/Solar/solcast-forecast-provider.swift`
- Modify: `cmd/ios-app/PWUsage/Models/Solar/solar-forecast.swift:3-154,180-234`
- Modify: `cmd/ios-app/PWUsage/Models/Solar/solar-forecast-provider.swift:8,13-18`
- Modify: `cmd/ios-app/PWUsage/Models/Solar/solar-forecast-correction.swift:18-21`
- Delete: `cmd/ios-app/PWUsageTests/SolcastClientTests.swift`
- Delete: `cmd/ios-app/PWUsageTests/SolcastCaptureTests.swift`

- [ ] Step 1: Delete `solcast-client.swift` and `solcast-forecast-provider.swift`
- [ ] Step 2: Clean up `solar-forecast.swift` (Remove `SolcastSite`, `SolcastSitesResponse`, `SolcastForecastResponse`, `SolcastForecastPoint`, `SolcastTimestamp`, `SolcastPeriod`, `SolarForecast.combine(...)`. Preserve `SolarForecastInterval`, `SolarForecastError`, and `SolarForecast.energy(...)`.)
- [ ] Step 3: Update `solar-forecast-provider.swift` (Remove `static let solcast = SolarForecastProviderID(rawValue: "solcast")`, remove `case credential` from `SolarForecastProviderRequirement`.)
- [ ] Step 4: Update `solar-forecast-correction.swift` (Remove `static let appliesToSolcast = false`.)
- [ ] Step 5: Delete Solcast tests (`SolcastClientTests.swift`, `SolcastCaptureTests.swift`.)
- [ ] Step 6: Commit changes

---

### Task 2: Remove Solcast Storage Subsystem & Keychain Store

**Files:**
- Delete: `cmd/ios-app/PWUsage/Authentication/SolcastCredentialStore.swift`
- Delete: `cmd/ios-app/PWUsage/State/Solar/solar-forecast-store.swift`
- Delete: `cmd/ios-app/PWUsage/State/Solar/solar-forecast-store-discovery.swift`
- Delete: `cmd/ios-app/PWUsage/State/Solar/solar-forecast-store-mutations.swift`
- Delete: `cmd/ios-app/PWUsage/State/Solar/solar-forecast-store-budget.swift`
- Delete: `cmd/ios-app/PWUsage/State/Solar/solar-forecast-store-refresh.swift`
- Delete: `cmd/ios-app/PWUsage/State/Solar/solar-forecast-store-persistence.swift`
- Delete: `cmd/ios-app/PWUsage/State/Solar/device-solar-forecast-persistence.swift`
- Modify: `cmd/ios-app/PWUsage/Models/Solar/solar-forecast-store-models.swift`
- Delete: `cmd/ios-app/PWUsageTests/SolarForecastStoreTests.swift`
- Delete: `cmd/ios-app/PWUsageTests/SolarForecastStoreHistoryTests.swift`
- Delete: `cmd/ios-app/PWUsageTests/SolarForecastStorageRaceTests.swift`
- Delete: `cmd/ios-app/PWUsageTests/SolarForecastArraySelectionTests.swift`

- [ ] Step 1: Delete `SolcastCredentialStore.swift` and store implementation files
- [ ] Step 2: Clean up `solar-forecast-store-models.swift` (Delete `SolarForecastCredential`, `SolarForecastBatch`, `SolarForecastBudget`, `SolarForecastPersistedState`, `SolarForecastPersistence`, `SolarForecastRefreshFailure`, `SolarForecastRefreshResult`, and `SolarForecastManaging`. Preserve `SolarForecastClock` and `SystemSolarForecastClock`.)
- [ ] Step 3: Delete store unit tests
- [ ] Step 4: Commit changes

---

### Task 3: Simplify SolarForecastService and DashboardCoordinator

**Files:**
- Modify: `cmd/ios-app/PWUsage/State/Solar/solar-forecast-service.swift`
- Modify: `cmd/ios-app/PWUsage/State/Home/dashboard-coordinator-solar.swift`
- Modify: `cmd/ios-app/PWUsage/State/Home/dashboard-coordinator-automatic-forecast.swift`
- Modify: `cmd/ios-app/PWUsage/State/Home/dashboard-coordinator.swift`
- Modify: `cmd/ios-app/PWUsage/App/pwusage-app-model.swift`
- Modify: `cmd/ios-app/PWUsage/App/pwusage-app.swift`
- Modify: `cmd/ios-app/PWUsageTests/SolarForecastServiceTests.swift`
- Modify: `cmd/ios-app/PWUsageTests/SolarForecastCoordinatorTests.swift`

- [ ] Step 1: Simplify `SolarForecastService` (Remove `correctsCredentialProviders`, remove credential looping in `select(_:)`, update `publicationAttempt(for:actuals:)`.)
- [ ] Step 2: Simplify `DashboardCoordinator` (Remove `forecastStore` property, delete legacy manual methods, streamline `refreshSolarForecast(manual:)`, simplify `forecastConnectionForConsumers`.)
- [ ] Step 3: Update `PWUsageAppModel` and `PWUsageApp`
- [ ] Step 4: Update coordinator & service unit tests
- [ ] Step 5: Verify tests pass (`cd cmd/ios-app && ./run-tests.sh SolarForecastServiceTests SolarForecastCoordinatorTests`)
- [ ] Step 6: Commit changes

---

### Task 4: Streamline Settings UI and Diagnostics

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/Solar/solar-forecast-settings-view.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Solar/solar-forecast-settings-status.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Solar/solar-forecast-automatic-summary.swift`
- Modify: `cmd/ios-app/PWUsage/Models/SmartShiftDiagnostics.swift`
- Modify: `cmd/ios-app/PWUsageTests/SolarForecastSettingsStatusTests.swift`
- Modify: `cmd/ios-app/PWUsageTests/SmartShiftDiagnosticsTests.swift`

- [ ] Step 1: Simplify `solar-forecast-settings-view.swift`
- [ ] Step 2: Clean up `solar-forecast-settings-status.swift` & summary
- [ ] Step 3: Update `SmartShiftDiagnostics.swift`
- [ ] Step 4: Update settings and diagnostics unit tests
- [ ] Step 5: Verify tests pass (`cd cmd/ios-app && ./run-tests.sh SolarForecastSettingsStatusTests SmartShiftDiagnosticsTests`)
- [ ] Step 6: Commit changes

---

### Task 5: Demo Mode and App Launch Maintenance

**Files:**
- Modify: `cmd/ios-app/PWUsage/Demo/demo-forecast-store.swift`
- Modify: `cmd/ios-app/PWUsage/Demo/demo-session.swift`
- Modify: `cmd/ios-app/PWUsage/Authentication/app-launch-maintenance.swift`
- Modify: `cmd/ios-app/PWUsage/App/pwusage-app.swift`
- Modify: `cmd/ios-app/PWUsageTests/DemoSessionTests.swift`
- Modify: `cmd/ios-app/PWUsageTests/app-launch-maintenance-tests.swift`

- [ ] Step 1: Refactor `DemoForecastStore.swift` & `demo-session.swift`
- [ ] Step 2: Update `AppLaunchMaintenance.swift`
- [ ] Step 3: Update Demo and Launch Maintenance tests
- [ ] Step 4: Verify tests pass (`cd cmd/ios-app && ./run-tests.sh DemoSessionTests app-launch-maintenance-tests`)
- [ ] Step 5: Commit changes

---

### Task 6: Repository Cleanup, Documentation, and Project Regeneration

**Files:**
- Delete: `cmd/next-app/scripts/solcast-forecast-capture.ts`
- Modify: `.gitignore`
- Modify: `cmd/ios-app/README.md`
- Regenerate: `cmd/ios-app/PWUsage.xcodeproj` via `cmd/ios-app/generate.sh`

- [ ] Step 1: Delete `solcast-forecast-capture.ts`
- [ ] Step 2: Clean up `.gitignore`
- [ ] Step 3: Update `cmd/ios-app/README.md`
- [ ] Step 4: Regenerate Xcode project
- [ ] Step 5: Commit changes

---

### Task 7: Full Verification & Code Quality Gates

**Files:** All modified files.

- [ ] Step 1: Swift Formatting (`cmd/ios-app/format.sh`)
- [ ] Step 2: SwiftLint Verification (`swiftlint lint cmd/ios-app --strict --baseline .swiftlint-baseline.json`)
- [ ] Step 3: Run Native iOS Tests (`cmd/ios-app/run-tests.sh --quick`)
- [ ] Step 4: Run Next.js Checks (`cd cmd/next-app && npm run lint && npm run build`)
- [ ] Step 5: Final Git Status & Clean Commit
