# Clear iCloud Solar Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add debug support in Solar System Settings to clear iCloud and local state for solar layout and home location so developers can test onboarding as a new user.

**Architecture:** Extend `SolarCloudEngine` and `CKSyncEngine` with record deletion capabilities; implement `deleteRecord(scope:)` in `SolarLayoutCloudSync` to purge CloudKit records and local files in `SolarLayoutRecordStore`; wire a debug button in `SiteHistoryDebugSection` via `SiteHistoryDebugActions` and `PWUsageAppModel`.

**Tech Stack:** Swift, SwiftUI, CloudKit, CKSyncEngine, Swift Testing (`import Testing`).

## Global Constraints
- SwiftLint strict budget: Line length ≤ 120 chars; function body ≤ 50 lines; file length ≤ 400 lines.
- No force-unwrapping (`!`).
- Swift Testing (`@Suite`, `@Test`, `#expect`, `#require`), no legacy `XCTest`.
- Run `format.sh` after Swift edits.

---

### Task 1: Deletion Support in `SolarCloudEngine` Protocol & Transport

**Files:**
- Modify: `cmd/ios-app/PWUsage/State/Solar/solar-cloud-transport.swift`
- Modify: `cmd/ios-app/PWUsageTests/Fixtures/solar-cloud-lifecycle-fixtures.swift`

**Interfaces:**
- Produces: `SolarCloudEngine.addPendingDeletions([CKRecord.ID])`

- [ ] **Step 1: Update `SolarCloudEngine` protocol and `CloudKitSolarEngine`**
In `solar-cloud-transport.swift`:
```swift
protocol SolarCloudEngine: AnyObject, Sendable {
    func saveZoneIfNeeded(alreadySaved: Bool)
    func addPendingSaves(_ recordIDs: [CKRecord.ID])
    func addPendingDeletions(_ recordIDs: [CKRecord.ID])
    func fetchChanges() async throws
    func sendChanges() async throws
    func cancelOperations() async
}
```
In `CloudKitSolarEngine`:
```swift
func addPendingDeletions(_ recordIDs: [CKRecord.ID]) {
    guard !recordIDs.isEmpty else { return }
    engine.state.add(pendingRecordZoneChanges: recordIDs.map { .deleteRecord($0) })
}
```

- [ ] **Step 2: Update mock `ControllableCloudEngine` in test fixtures**
In `solar-cloud-lifecycle-fixtures.swift`:
Add `pendingDeletions: [CKRecord.ID] = []` and `func addPendingDeletions(_ recordIDs: [CKRecord.ID])` to `ControllableCloudEngine`.

---

### Task 2: Unsynced Marker Cleanup in `SolarLayoutRecordStore`

**Files:**
- Modify: `cmd/ios-app/PWUsage/State/Solar/solar-layout-record-store.swift`
- Test: `cmd/ios-app/PWUsageTests/SolarLayoutRecordStoreTests.swift`

- [ ] **Step 1: Write failing test in `SolarLayoutRecordStoreTests.swift`**
Verify `remove(scope:)` removes the record and also removes its unsynced marker from `unsyncedMarkers`.

- [ ] **Step 2: Update `SolarLayoutRecordStore.remove(scope:)`**
In `solar-layout-record-store.swift`:
```swift
func remove(scope: SolarForecastSiteScope) throws {
    cache.removeValue(forKey: scope)
    try removeFile(fileURL(scope))
    var markers = loadUnsynced()
    if markers.removeValue(forKey: scope) != nil {
        try? saveUnsynced(markers)
    }
}
```

- [ ] **Step 3: Run test and verify it passes**

---

### Task 3: CloudKit Deletion in `SolarLayoutCloudSync`

**Files:**
- Modify: `cmd/ios-app/PWUsage/State/Solar/solar-layout-cloud-sync.swift`
- Test: `cmd/ios-app/PWUsageTests/SolarLayoutCloudSyncTests.swift`

- [ ] **Step 1: Write failing test in `SolarLayoutCloudSyncTests.swift`**
Test that `deleteRecord(scope:)` calls `store.remove(scope:)`, clears pending scopes and system fields, and enqueues `addPendingDeletions` on the engine.
Test that incoming `fetched.deletions` in `handle(_ event:token:)` invokes `store.remove(scope:)`.

- [ ] **Step 2: Implement `deleteRecord(scope:)` and handle deletions in `SolarLayoutCloudSync`**
Implement:
```swift
func deleteRecord(scope: SolarForecastSiteScope) async throws {
    let recordID = SolarLayoutCloudRecordSerializer.recordID(for: scope)
    pendingScopes.remove(scope)
    try? files.savePendingScopes(pendingScopes)
    systemFields.removeValue(forKey: recordID.recordName)
    try? files.saveSystemFields(systemFields)
    try await store.remove(scope: scope)
    guard let token = engine.token, let cloud = runningEngine(token) else { return }
    cloud.addPendingDeletions([recordID])
    await sendChanges(token)
}
```
In `handle(_ event: CKSyncEngine.Event, token:)`:
```swift
case .fetchedRecordZoneChanges(let fetched):
    await applyFetchedRecords(fetched.modifications.map(\.record), token: token)
    await applyFetchedDeletions(fetched.deletions, token: token)
```
Add `applyFetchedDeletions`:
```swift
func applyFetchedDeletions(
    _ deletions: [CKSyncEngine.Event.FetchedRecordZoneChanges.Deletion], token: SolarCloudEngineToken
) async {
    for deletion in deletions {
        guard session(owning: token) != nil else { return }
        systemFields.removeValue(forKey: deletion.recordID.recordName)
        let parts = deletion.recordID.recordName.split(separator: ".", maxSplits: 1)
        guard parts.count == 2 else { continue }
        let scope = SolarForecastSiteScope(accountScopeID: String(parts[0]), siteID: String(parts[1]))
        try? await store.remove(scope: scope)
    }
}
```

- [ ] **Step 3: Run tests and verify they pass**

---

### Task 4: App Model & UI Debug Actions

**Files:**
- Modify: `cmd/ios-app/PWUsage/State/Solar/site-history-debug.swift`
- Test: `cmd/ios-app/PWUsageTests/PWUsageAppModelHistoryOnboardingTests.swift`

- [ ] **Step 1: Write test for clearing layout in `PWUsageAppModelHistoryOnboardingTests.swift`**
Verify `model.clearSiteLayoutInCloud()` deletes the record and triggers status update to `.needsLocation`.

- [ ] **Step 2: Add `clearSiteLayoutInCloud()` and wire `SiteHistoryDebugActions`**
In `site-history-debug.swift`:
Add `clearCloudLayout` closure to `SiteHistoryDebugActions`.
Add `clearSiteLayoutInCloud()` to `PWUsageAppModel`:
```swift
func clearSiteLayoutInCloud() async {
    guard let accountScopeID, let selectedSiteID else { return }
    let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: selectedSiteID)
    try? await solarCloudSync.deleteRecord(scope: scope)
    coordinator?.invalidateSolarLayout()
    await historyOnboarding?.refreshStatus()
    updateHistoryOnboarding()
}
```
In `SiteHistoryDebugSection`:
Add state `@State private var isConfirmingCloudClear = false` and `@State private var isClearingCloud = false`.
Add destructive button:
```swift
Button("Clear iCloud Layout & Location", role: .destructive) { isConfirmingCloudClear = true }
    .disabled(isClearingCloud)
    .confirmationDialog("Clear solar layout and home location in iCloud?",
                        isPresented: $isConfirmingCloudClear, titleVisibility: .visible) {
        Button("Clear iCloud & Device State", role: .destructive) {
            isClearingCloud = true
            Task {
                await actions.clearCloudLayout()
                isClearingCloud = false
            }
        }
        Button("Cancel", role: .cancel) {}
    } message: {
        Text("Removes your saved home location and detected solar layout from iCloud and this device. "
            + "Onboarding will ask for your location again.")
    }
```

- [ ] **Step 3: Run test and verify it passes**

---

### Task 5: Formatting, Linting & Full Quick Test Suite

- [ ] **Step 1: Run SwiftFormat**
`cmd/ios-app/format.sh`

- [ ] **Step 2: Run SwiftLint**
`swiftlint lint cmd/ios-app --strict --baseline .swiftlint-baseline.json`

- [ ] **Step 3: Run unit tests**
`cmd/ios-app/run-tests.sh --quick PWUsageTests`
