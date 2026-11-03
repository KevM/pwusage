# Design: Clear iCloud State for Solar Layout and Home Location in Debug Settings

## Goal
Enable developers to test the iOS solar onboarding flow as a brand new user by providing a debug action in Solar System Settings that completely clears the saved home location and solar layout both in iCloud (CloudKit) and locally on the device.

## Architecture & Data Flow

### 1. CloudKit Transport & Engine (`solar-cloud-transport.swift`)
- Extend `SolarCloudEngine` protocol:
  ```swift
  func addPendingDeletions(_ recordIDs: [CKRecord.ID])
  ```
- In `CloudKitSolarEngine`:
  ```swift
  func addPendingDeletions(_ recordIDs: [CKRecord.ID]) {
      guard !recordIDs.isEmpty else { return }
      engine.state.add(pendingRecordZoneChanges: recordIDs.map { .deleteRecord($0) })
  }
  ```
- Update mock/test engines (e.g. `ControllableCloudEngine` in tests) to support `addPendingDeletions`.

### 2. Record Store (`solar-layout-record-store.swift`)
- Enhance `remove(scope: SolarForecastSiteScope)`:
  - Remove from in-memory `cache`.
  - Remove record file from disk if present.
  - Remove pending unsynced marker for `scope` from `loadUnsynced()` and persist `saveUnsynced(remaining)` so that stale upload markers do not trigger future uploads.

### 3. Cloud Sync (`solar-layout-cloud-sync.swift`)
- Add `func deleteRecord(scope: SolarForecastSiteScope) async throws`:
  - Determine `recordID` via `SolarLayoutCloudRecordSerializer.recordID(for: scope)`.
  - Remove `scope` from `pendingScopes` and persist to `files.savePendingScopes`.
  - Remove `systemFields[recordID.recordName]` and persist to `files.saveSystemFields`.
  - Call `store.remove(scope: scope)`.
  - If engine is running: call `cloud.addPendingDeletions([recordID])` and trigger `sendChanges(token)`.
- In `handle(_ event: CKSyncEngine.Event, token: SolarCloudEngineToken)`:
  - In `.fetchedRecordZoneChanges(let fetched)`:
    - Iterate through `fetched.deletions`: parse `recordID` into scope, call `try? await store.remove(scope: scope)`.
  - In `.sentRecordZoneChanges(let sent)`:
    - If `sent.failedRecordDeletions` has errors (or retry needed), log or handle as appropriate.

### 4. App Model & Debug Actions (`site-history-debug.swift`)
- Extend `SiteHistoryDebugActions`:
  ```swift
  struct SiteHistoryDebugActions {
      let scope: SolarForecastSiteScope
      let reset: @MainActor () async -> Void
      let clearCloudLayout: @MainActor () async -> Void
      let refresh: @MainActor () async -> Void
  }
  ```
- In `PWUsageAppModel`:
  - Implement `func clearSiteLayoutInCloud() async`:
    - Identify current scope `SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: selectedSiteID)`.
    - Call `try? await cloudSync.deleteRecord(scope: scope)`.
    - Invalidate coordinator solar layout (`coordinator?.invalidateSolarLayout()`).
    - Refresh onboarding and layout status (`await historyOnboarding?.refreshStatus()`, `updateHistoryOnboarding()`).

### 5. UI (`SiteHistoryDebugSection` in `site-history-debug.swift`)
- Add a new button in `SiteHistoryDebugSection`:
  - `Button("Clear iCloud Layout & Location", role: .destructive)`
  - Confirmation dialog with title: `"Clear solar layout and home location in iCloud?"`
  - Message: `"Removes your saved home location and detected solar layout from iCloud and this device. Onboarding will ask for your location again."`
  - Buttons: `"Clear iCloud & Device State"` (destructive) and `"Cancel"`.

## Testing Strategy
1. **Unit Tests in `SolarLayoutCloudSyncTests.swift`**:
   - Verify `deleteRecord(scope:)` enqueues pending deletion in `SolarCloudEngine` and triggers `sendChanges`.
   - Verify `deleteRecord(scope:)` cleans up pending scopes and system fields.
   - Verify `deleteRecord(scope:)` deletes local file in `SolarLayoutRecordStore`.
   - Verify remote fetched deletion cleans up local record in `SolarLayoutRecordStore`.
2. **App Model Integration Tests in `PWUsageAppModelHistoryOnboardingTests.swift`**:
   - Verify invoking `actions.clearCloudLayout()` clears the saved layout/location and resets status to `.needsLocation`.
3. **Build & Lint Verification**:
   - Run `format.sh`.
   - Run `swiftlint lint cmd/ios-app --strict --baseline .swiftlint-baseline.json`.
   - Run `./run-tests.sh --quick PWUsageTests`.
