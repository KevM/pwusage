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

    @Test("Offline record changes are persisted, retained across restarts, and cleared by sign-out")
    @MainActor
    func offlineRecordChangesRetained() async throws {
        let harness = try SolarCloudLifecycleHarness()
        defer { harness.removeFiles() }
        let session = harness.sync.issueSession(accountScopeID: "acc-1")
        #expect(await harness.sync.activate(session) == .active)
        let scope1 = SolarForecastSiteScope(accountScopeID: "acc-1", siteID: "site-1")
        let scope2 = SolarForecastSiteScope(accountScopeID: "acc-1", siteID: "site-2")
        try await harness.records.setLocation(locA, scope: scope1)
        try await harness.records.setLocation(locB, scope: scope2)
        try await eventually { (try? harness.persistedPendingScopes()) == [scope1, scope2] }

        let restarted = try SolarCloudLifecycleHarness(folder: harness.folder)
        #expect(await restarted.sync.pendingUploadScopes == [scope1, scope2])
        try await restarted.sessionCleanup().signOut()
        #expect(!FileManager.default.fileExists(atPath: harness.pendingURL.path))
    }

    @Test("Stopping the engine during account lookup leaves it detached")
    @MainActor
    func stopInvalidatesInFlightStart() async throws {
        let gate = LifecycleGate()
        let transport = FakeSolarCloudTransport(lookupGate: gate)
        let harness = try SolarCloudLifecycleHarness(transport: transport.transport)
        defer { harness.removeFiles() }
        let session = harness.sync.issueSession(accountScopeID: "acc-1")
        let starting = Task { await harness.sync.start(session: session) }
        try await eventually { gate.isHolding }
        #expect(await harness.records.hasEngine)

        await harness.sync.stopEngine()
        gate.release()
        await starting.value

        #expect(await harness.sync.isStarted == false)
        #expect(await harness.records.hasEngine == false)
        #expect(transport.engines.isEmpty)
    }

    @Test("A start requested during account lookup coalesces with the attempt in progress")
    @MainActor
    func concurrentStartCallsDoNotInvalidateStartup() async throws {
        let gate = LifecycleGate()
        let transport = FakeSolarCloudTransport(lookupGate: gate)
        let harness = try SolarCloudLifecycleHarness(transport: transport.transport)
        defer { harness.removeFiles() }
        let session = harness.sync.issueSession(accountScopeID: "acc-1")
        let starting = Task { await harness.sync.start(session: session) }
        try await eventually { gate.isHolding }

        await harness.sync.start(session: session)
        gate.release()
        await starting.value

        #expect(await harness.sync.isStarted)
        #expect(await harness.records.hasEngine)
        #expect(transport.lookups == 1)
        #expect(transport.engines.count == 1)
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
        let session = model.adoptSolarCloudSession(accountScopeID: "account-a")
        let previousFetchCount = harness.api.historyFetches.count
        harness.api.holdHistory = true
        defer { harness.api.resumeHistory() }
        let selectedScope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")
        let runTask = Task { await harness.runner.runIfDue(scope: selectedScope) }
        try await eventually { harness.api.historyFetches.count > previousFetchCount }

        await model.solarLayoutRecordChanged(scope, from: session)
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
        let session = model.adoptSolarCloudSession(accountScopeID: "account-a")

        await model.solarLayoutRecordChanged(scope, from: session)

        let record = try await harness.records.record(scope: scope)
        #expect(record?.result?.status == .detected)
    }

    @Test("A cloud callback queued before sign-out starts no detection afterwards")
    @MainActor
    func queuedCallbackAfterSignOutIsIgnored() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        try await harness.setPending()
        let model = try cloudSyncModel(harness: harness)
        model.coordinator = harness.coordinator
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")
        let session = model.adoptSolarCloudSession(accountScopeID: "account-a")
        let fetches = harness.api.historyFetches.count

        model.teardownCoordinator()
        try await model.solarSessionCleanup.signOut()
        await model.solarLayoutRecordChanged(scope, from: session)

        #expect(harness.api.historyFetches.count == fetches)
        #expect(try await harness.records.record(scope: scope)?.result?.status != .detected)
    }

    @Test("Authorized session publishes while optional cloud account lookup is suspended", arguments: [false, true])
    @MainActor
    func authorizationDoesNotWaitForCloud(cached: Bool) async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        let gate = LifecycleGate()
        let transport = FakeSolarCloudTransport(lookupGate: gate)
        let site = MobileSite(id: "site-a", name: "Home", utility: "Test")
        let cacheURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: cacheURL) }
        let cache = cached ? DashboardCache(fileURL: cacheURL) : nil
        cache?.storeSites([site])
        let model = try cloudSyncModel(harness: harness, transport: transport, cache: cache)
        if cached {
            #expect(model.screenState == .signedIn && model.coordinator != nil)
        }

        await model.installAuthorizedSites([site], generation: model.claimSiteInstall())
        try await eventually { gate.isHolding }

        #expect(model.sessionVerified && model.screenState == .signedIn && model.coordinator != nil)
        #expect(await model.solarCloudSync.isStarted == false)
        gate.release()
        try await eventuallyAsync { await model.solarCloudSync.isStarted }
        #expect(transport.lookups == 1)
    }

    @Test("Sign-out before queued startup reaches the actor begins no attachment or lookup", arguments: [true, false])
    @MainActor
    func endBeforeQueuedStartup(signsOut: Bool) async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        let transport = FakeSolarCloudTransport()
        let model = try cloudSyncModel(harness: harness, transport: transport)
        _ = model.ensureAccountScopeID()

        model.startSolarCloudSync()
        if signsOut {
            model.teardownCoordinator()
            try await model.solarSessionCleanup.signOut()
            try await staysTrue { transport.lookups == 0 }
            #expect(await harness.records.hasEngine == false)
        } else {
            try await eventuallyAsync { await model.solarCloudSync.isStarted }
            #expect(transport.lookups == 1)
            #expect(await harness.records.hasEngine)
        }
    }

    @Test("A failed sign-out cleanup is retried at authorization and keeps solar writes closed until it succeeds")
    @MainActor
    func failedCleanupIsRetriedAtAuthorization() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        let gate = CleanupForecastService.CleanupGate()
        let forecastService = CleanupForecastService(gate: gate)
        let model = try cloudSyncModel(harness: harness, forecastService: forecastService)
        let site = MobileSite(id: "site-a", name: "Home", utility: "Test")
        await model.installAuthorizedSites([site], generation: model.claimSiteInstall())
        #expect(await harness.records.isWritable)
        gate.shouldFail = true
        await model.signOut()
        #expect(model.signInMessage?.contains("Could not clear local solar forecast data") == true)

        await model.installAuthorizedSites([site], generation: model.claimSiteInstall())

        #expect(model.screenState == .signedIn && model.coordinator != nil)
        #expect(model.signInMessage?.contains("Could not clear local solar forecast data") == true)
        #expect(await harness.records.isWritable == false)

        gate.shouldFail = false
        await model.installAuthorizedSites([site], generation: model.claimSiteInstall())

        #expect(await harness.records.isWritable)
        let scope = SolarForecastSiteScope(accountScopeID: try #require(model.accountScopeID), siteID: "site-a")
        try await harness.records.setLocation(.lifecycleHome, scope: scope)
    }

    @Test("Foregrounding an authorized session restarts synchronization left offline")
    @MainActor
    func foregroundRestartsOfflineSync() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        let transport = FakeSolarCloudTransport()
        transport.setStatus(.noAccount)
        let model = try cloudSyncModel(harness: harness, transport: transport)
        let site = MobileSite(id: "site-a", name: "Home", utility: "Test")
        await model.installAuthorizedSites([site], generation: model.claimSiteInstall())
        try await eventually { transport.lookups == 1 && model.solarCloudStartup == nil }
        #expect(await model.solarCloudSync.isStarted == false)

        transport.setStatus(.available)
        model.scenePhaseChanged(isActive: true)
        try await eventuallyAsync { await model.solarCloudSync.isStarted }

        model.scenePhaseChanged(isActive: false)
        model.scenePhaseChanged(isActive: true)
        try await eventually { model.solarCloudStartup == nil }
        #expect(transport.lookups == 2)
        #expect(transport.engines.count == 1)
    }

    @Test("Foregrounding without a verified session starts no synchronization")
    @MainActor
    func foregroundWithoutSessionDoesNotStart() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        let transport = FakeSolarCloudTransport()
        let model = try cloudSyncModel(harness: harness, transport: transport)
        _ = model.ensureAccountScopeID()

        model.scenePhaseChanged(isActive: true)

        try await staysTrue { transport.lookups == 0 }
        #expect(model.solarCloudStartup == nil)
    }

    @Test("Cancelled queued startup cannot attach after sign-out")
    @MainActor
    func cancelledStartupDoesNotAttach() async throws {
        let transport = FakeSolarCloudTransport()
        let harness = try SolarCloudLifecycleHarness(transport: transport.transport)
        defer { harness.removeFiles() }
        let session = harness.sync.issueSession(accountScopeID: "acc-1")
        let task = Task { await harness.sync.start(session: session) }
        task.cancel()
        await task.value
        #expect(await harness.records.hasEngine == false)
        #expect(transport.lookups == 0)
    }

    @MainActor
    private func cloudSyncModel(
        harness: AutomaticForecastHarness, transport: FakeSolarCloudTransport? = nil, cache: DashboardCache? = nil,
        forecastService: (any SolarForecastServing)? = nil
    ) throws -> PWUsageAppModel {
        let defaults = try #require(UserDefaults(suiteName: "CloudSyncTests.\(UUID().uuidString)"))
        defaults.set("account-a", forKey: PWUsageAppModel.accountScopeDefaultsKey)
        defaults.set("site-a", forKey: PWUsageAppModel.selectedSiteDefaultsKey)
        return PWUsageAppModel(
            configuration: try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true),
            api: CloudSyncTestAppAPI(historyAPI: harness.api),
            userDefaults: defaults,
            forecastService: forecastService,
            cache: cache,
            solarHistory: harness.historyStore,
            solarRecords: harness.records,
            solarRunner: harness.runner,
            solarCloudSync: try isolatedSync(records: harness.records, transport: transport?.transport)
        )
    }

    private nonisolated func isolatedSync(
        records: SolarLayoutRecordStore, transport: SolarCloudTransport?
    ) throws -> SolarLayoutCloudSync {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        return SolarLayoutCloudSync(
            store: records,
            userDefaults: try #require(UserDefaults(suiteName: "CloudSyncState.\(folder.lastPathComponent)")),
            stateURL: folder.appendingPathComponent("state.json"),
            systemFieldsURL: folder.appendingPathComponent("fields.json"),
            pendingScopesURL: folder.appendingPathComponent("pending.json"),
            transport: transport
        )
    }
}

private actor CleanupForecastService: SolarForecastServing {
    final class CleanupGate: @unchecked Sendable { var shouldFail = false }
    let gate: CleanupGate
    init(gate: CleanupGate) { self.gate = gate }
    nonisolated var automaticDescriptor: SolarForecastProviderDescriptor? { nil }
    nonisolated func descriptor(for id: SolarForecastProviderID) -> SolarForecastProviderDescriptor? { nil }
    func activateAccountScope(_ accountScopeID: String?) async {}
    func publicationAttempt(
        for request: SolarForecastRequest, actuals: [MobileSolarActualsHour]?
    ) async -> SolarForecastPublicationAttempt {
        SolarForecastPublicationAttempt(publication: nil, providerID: nil, outcome: .unavailable, diagnostic: nil)
    }
    func clearAccountData() async throws {
        if gate.shouldFail { throw LifecycleCleanupFailure() }
    }
}
@MainActor
private final class CloudSyncTestAppAPI: PWUsageApplicationAPI {
    let historyAPI: AutomaticForecastAPISpy

    init(historyAPI: AutomaticForecastAPISpy) { self.historyAPI = historyAPI }

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
