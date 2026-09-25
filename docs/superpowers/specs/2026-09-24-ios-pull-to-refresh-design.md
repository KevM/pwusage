# iOS App Pull-to-Refresh Design

## Overview
Adds native pull-to-refresh support to the PWUsage iOS application in both the primary Dashboard view and the Bill details view.

## Motivation & Goals
Users expect to be able to drag down on the dashboard or bill view to trigger an immediate data refresh rather than waiting for background polling timers (5 minutes for live power readings, 30 minutes for bill estimates).

## Architecture & Components

### 1. `DashboardCoordinator` Extensions
Located in `cmd/ios-app/PWUsage/State/DashboardCoordinator.swift`.

- **`refreshAll(force: Bool = true) async`**:
  - Guards against `requiresSignIn` state.
  - If `force: true`, bypasses `isDue` elapsed interval checks for both `live` and `bill`.
  - In-flight coalescing: If `liveTask` is already executing, awaits it; otherwise initiates `performLive(siteID:generation:)`. Once live completes (and assuming site generation remains current and sign-in is not required), awaits any active `billTask` or initiates `performBill(siteID:generation:)`.
  - Refactors existing `refreshDue() async` to call `refreshAll(force: false)`.

- **`refreshBill(force: Bool = true) async`**:
  - Guards against `requiresSignIn` state.
  - If `force: true`, bypasses `isDue` elapsed interval checks for `bill`.
  - If `billTask` is already running, awaits it; otherwise initiates `performBill(siteID:generation:)` and awaits completion.

### 2. View Integration
- **`DashboardView` (`cmd/ios-app/PWUsage/Views/DashboardView.swift`)**:
  - Attaches `.refreshable` to the root `ScrollView`:
    ```swift
    .refreshable {
        await coordinator.refreshAll()
    }
    ```
- **`BillView` (`cmd/ios-app/PWUsage/Views/BillView.swift`)**:
  - Attaches `.refreshable` to the root `ScrollView`:
    ```swift
    .refreshable {
        await coordinator.refreshBill()
    }
    ```

### 3. Error Handling & State Consistency
- Errors during refresh update endpoint availability banners as they currently do (`isUnavailable = true`).
- If a refresh encounters HTTP 401 (`PWUsageAPIError.signInRequired`), coordinator transitions to `requiresSignIn = true` and halts polling/refresh.
- If the user changes site during an active pull-to-refresh, `siteGeneration` increment cancels the previous tasks and prevents stale data from updating the newly selected site.

## Verification & Testing
- **Unit Tests (`cmd/ios-app/PWUsageTests/DashboardCoordinatorTests.swift`)**:
  - `refreshAll(force: true)` immediately triggers both live and bill fetches even when intervals are not due.
  - `refreshBill(force: true)` triggers bill fetch without triggering live fetch.
  - Concurrent `refreshAll()` or `refreshBill()` calls reuse the same in-flight task without duplicate requests.
  - `refreshAll()` and `refreshBill()` early-return without network calls when `requiresSignIn` is true.
- **Harness & App Tests**:
  - Verify all Swift Testing suites pass via `cmd/ios-app/run-tests.sh`.
  - Verify test runner harness passes via `cmd/ios-app/test-run-tests.sh`.
