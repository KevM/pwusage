import CloudKit
import Foundation
@testable import PWUsage
import Testing

@Suite("Solar Layout Cloud Sync")
struct SolarLayoutCloudSyncTests {
    private let locA = SolarHomeLocation(latitude: 37.77, longitude: -122.41, source: .device)
    private let locB = SolarHomeLocation(latitude: 40.71, longitude: -74.00, source: .device)

    @Test("System fields encode and decode preserves record identity")
    func systemFieldsEncodeDecode() throws {
        let zoneID = SolarLayoutCloudRecordSerializer.zoneID
        let recID = CKRecord.ID(recordName: "test-acc.test-site", zoneID: zoneID)
        let record = CKRecord(recordType: SolarLayoutCloudRecordSerializer.recordType, recordID: recID)
        record["accountScopeID"] = "test-acc" as CKRecordValue

        let data = SolarLayoutCloudRecordSystemFields.encode(record)
        #expect(!data.isEmpty)

        let decoded = try #require(SolarLayoutCloudRecordSystemFields.decode(from: data))
        #expect(decoded.recordID == recID)
        #expect(decoded.recordType == SolarLayoutCloudRecordSerializer.recordType)
        // System fields do not encode app-level keys and values:
        #expect(decoded["accountScopeID"] == nil)
    }

    @Test("makeRecord with system fields preserves record identity while updating values")
    func makeRecordWithSystemFields() throws {
        let scope = SolarForecastSiteScope(accountScopeID: "acc-1", siteID: "site-1")
        let recID = SolarLayoutCloudRecordSerializer.recordID(for: scope)
        let baseRecord = CKRecord(recordType: SolarLayoutCloudRecordSerializer.recordType, recordID: recID)
        let systemData = SolarLayoutCloudRecordSystemFields.encode(baseRecord)

        let date = Date(timeIntervalSince1970: 1000)
        let layoutRecord = SolarLayoutRecord(
            location: locA,
            locationSetAt: date,
            result: nil,
            detectedAt: nil,
            attemptedAt: nil,
            detectorVersion: nil,
            resultLocation: nil
        )

        let populated = SolarLayoutCloudRecordSerializer.makeRecord(
            from: layoutRecord,
            scope: scope,
            systemFieldsData: systemData
        )
        #expect(populated.recordID == recID)
        #expect(populated.encryptedValues["latitude"] as? Double == 37.77)
        #expect(populated.encryptedValues["longitude"] as? Double == -122.41)
        #expect(populated["result"] == nil)

        let parsed = try #require(SolarLayoutCloudRecordSerializer.parseRecord(populated))
        #expect(parsed.scope == scope)
        #expect(parsed.record == layoutRecord)
    }

    @Test("Corrupted system fields fallback to fresh record")
    func corruptedSystemFieldsFallback() throws {
        let scope = SolarForecastSiteScope(accountScopeID: "acc-1", siteID: "site-1")
        let corruptedData = Data([0x00, 0x01, 0x02, 0x03])
        let layoutRecord = SolarLayoutRecord(location: locA)

        let record = SolarLayoutCloudRecordSerializer.makeRecord(
            from: layoutRecord,
            scope: scope,
            systemFieldsData: corruptedData
        )
        #expect(record.recordID == SolarLayoutCloudRecordSerializer.recordID(for: scope))
        let parsed = try #require(SolarLayoutCloudRecordSerializer.parseRecord(record))
        #expect(parsed.record.location == locA)
    }

    @Test("Offline record changes are persisted and retained across restarts")
    func offlineRecordChangesRetained() async throws {
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let scopesURL = tempDir.appendingPathComponent("pending-scopes.json")
        let sync = SolarLayoutCloudSync(
            pendingScopesURL: scopesURL
        )
        let scope1 = SolarForecastSiteScope(accountScopeID: "acc-1", siteID: "site-1")
        let scope2 = SolarForecastSiteScope(accountScopeID: "acc-1", siteID: "site-2")

        // recordChanged called while stopped
        await sync.recordChanged(scope1)
        await sync.recordChanged(scope2)

        #expect(FileManager.default.fileExists(atPath: scopesURL.path))

        // New instance restores pending scopes from disk
        let syncRestarted = SolarLayoutCloudSync(
            pendingScopesURL: scopesURL
        )
        // Calling stop/clear removes persisted state
        await syncRestarted.stop()
        #expect(!FileManager.default.fileExists(atPath: scopesURL.path))
    }

    @Test("Stop invalidates in-flight start and cleans up store sync")
    func stopInvalidatesInFlightStart() async throws {
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = SolarLayoutRecordStore(directory: tempDir)
        let sync = SolarLayoutCloudSync(
            store: store,
            pendingScopesURL: tempDir.appendingPathComponent("pending.json")
        )
        await store.setOnSetSync {
            await sync.stop()
        }
        await sync.start()
        let isStarted = await sync.isStarted
        let hasSync = await store.hasSync
        #expect(!isStarted)
        #expect(!hasSync)
    }

    @Test("Concurrent start calls do not invalidate in-flight startup")
    func concurrentStartCallsDoNotInvalidateStartup() async throws {
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = SolarLayoutRecordStore(directory: tempDir)
        let sync = SolarLayoutCloudSync(
            store: store,
            pendingScopesURL: tempDir.appendingPathComponent("pending.json")
        )
        await store.setOnSetSync {
            await sync.start()
        }
        await sync.start()
        let hasSync = await store.hasSync
        #expect(hasSync)
    }

    @Test("Unrelated remote records do not cancel selected-site detection", arguments: [false, true])
    @MainActor
    func unrelatedRemoteRecordDoesNotCancelSelectedSiteDetection(otherAccount: Bool) async throws {
        let scope = SolarForecastSiteScope(
            accountScopeID: otherAccount ? "other-account" : "account-a",
            siteID: otherAccount ? "site-a" : "site-b"
        )
        let harness = await AutomaticForecastHarness(seedDetected: false)
        try await harness.setPending()
        _ = try await harness.historyStore.sync(scope: scope, api: harness.api, now: harness.api.now)
        let model = try cloudSyncModel(harness: harness)
        let previousFetchCount = harness.api.historyFetches.count
        harness.api.holdHistory = true
        defer { harness.api.resumeHistory() }
        let selectedScope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")
        let runTask = Task { await harness.runner.runIfDue(scope: selectedScope) }
        try await eventually { harness.api.historyFetches.count > previousFetchCount }

        await model.solarLayoutRecordChanged(scope)
        harness.api.resumeHistory()
        let completed = await runTask.value
        #expect(completed?.result?.status == .detected)
    }

    @Test("Selected-site remote updates start detection", arguments: [false, true])
    @MainActor
    func selectedRemoteRecordStartsDetection(hasCoordinator: Bool) async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        try await harness.setPending()
        let model = try cloudSyncModel(harness: harness)
        if hasCoordinator {
            model.coordinator = harness.coordinator
            model.userDefaults.set("site-b", forKey: PWUsageAppModel.selectedSiteDefaultsKey)
        }
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")

        await model.solarLayoutRecordChanged(scope)

        let record = try await harness.records.record(scope: scope)
        #expect(record?.result?.status == .detected)
    }

    @Test("Authorized session publishes while optional cloud startup is suspended")
    @MainActor
    func authorizationDoesNotWaitForCloud() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        let model = try cloudSyncModel(harness: harness)
        let gate = CloudStartupGate()
        await harness.records.setOnSetSync { await gate.pause() }
        let installation = Task {
            await model.installAuthorizedSites(
                [MobileSite(id: "site-a", name: "Home", utility: "Test")], generation: model.claimSiteInstall()
            )
        }
        try await eventually { gate.entered }
        let published = model.sessionVerified && model.screenState == .signedIn && model.coordinator != nil
        model.teardownCoordinator()
        await model.solarCloudSync.stop()
        gate.resume()
        await installation.value
        #expect(published)
        #expect(await harness.records.hasSync == false)
        #expect(await model.solarCloudSync.isStarted == false)
    }

    @Test("Cancelled queued startup cannot attach after sign-out")
    @MainActor
    func cancelledStartupDoesNotAttach() async {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let records = SolarLayoutRecordStore(directory: folder)
        let sync = SolarLayoutCloudSync(store: records)
        let task = Task { await sync.start() }
        task.cancel()
        await task.value
        #expect(await records.hasSync == false)
    }

    @MainActor
    private func cloudSyncModel(harness: AutomaticForecastHarness) throws -> PWUsageAppModel {
        let defaults = try #require(UserDefaults(suiteName: "CloudSyncTests.\(UUID().uuidString)"))
        defaults.set("account-a", forKey: PWUsageAppModel.accountScopeDefaultsKey)
        defaults.set("site-a", forKey: PWUsageAppModel.selectedSiteDefaultsKey)
        return PWUsageAppModel(
            configuration: try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true),
            api: CloudSyncTestAppAPI(historyAPI: harness.api),
            userDefaults: defaults,
            solarHistory: harness.historyStore,
            solarRecords: harness.records,
            solarRunner: harness.runner,
            solarCloudSync: SolarLayoutCloudSync(store: harness.records)
        )
    }
}

@MainActor
private final class CloudSyncTestAppAPI: PWUsageApplicationAPI {
    let historyAPI: AutomaticForecastAPISpy

    init(historyAPI: AutomaticForecastAPISpy) {
        self.historyAPI = historyAPI
    }

    func fetchSites() async throws -> [MobileSite] { [MobileSite(id: "site-a", name: "Home", utility: "Test")] }
    func fetchLive(siteID: String) async throws -> MobileLiveResponse { throw PWUsageAPIError.invalidResponse }
    func fetchBill(siteID: String) async throws -> MobileBillResponse { throw PWUsageAPIError.invalidResponse }
    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        try await historyAPI.fetchLoadPlanningContext(siteID: siteID)
    }
    func fetchSolarHistory(
        siteID: String, from: String, changedSince: Date?
    ) async throws -> MobileSolarHistoryResponse {
        try await historyAPI.fetchSolarHistory(siteID: siteID, from: from, changedSince: changedSince)
    }
    func exchangeSession(_ exchange: MobileSessionExchange) async throws {}
    func logout() async throws {}
    func clearSiteAuthCookie() async {}
}

@MainActor
private final class CloudStartupGate {
    var entered = false
    private var continuation: CheckedContinuation<Void, Never>?

    func pause() async {
        entered = true
        await withCheckedContinuation { continuation = $0 }
    }

    func resume() {
        continuation?.resume()
        continuation = nil
    }
}
