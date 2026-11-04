import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Solar layout session cleanup")
struct SolarLayoutSessionCleanupTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "site")
    private let remote = SolarLayoutRecord(
        location: SolarHomeLocation(latitude: 43, longitude: -87, source: .device),
        locationSetAt: Date(timeIntervalSince1970: 100)
    )

    @Test("Cloud synchronization stops before local layout records are deleted")
    func cloudStopsBeforeRecordsAreRemoved() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let recordsFolder = folder.appendingPathComponent("records")
        let records = SolarLayoutRecordStore(directory: recordsFolder) { nil }
        let sync = try cloudSync(store: records, folder: folder)
        _ = try await records.applyRemoteRecord(remote, scope: scope)
        await records.setOnBindingChange { [remote, scope] in
            // Represents an already-dispatched application completing while stop detaches the store.
            _ = try? await records.applyRemoteRecord(remote, scope: scope)
        }
        let cleanup = SolarSessionCleanup(
            historyStore: SolarHistoryStore(directory: folder.appendingPathComponent("history")),
            layoutRecordStore: records, cloudSync: sync
        )

        try await cleanup.signOut()

        let reloaded = SolarLayoutRecordStore(directory: recordsFolder) { nil }
        #expect(try await reloaded.record(scope: scope) == nil)
        #expect(!FileManager.default.fileExists(atPath: recordsFolder.path))
    }

    @Test("Sign-out forgets history onboarding progress, day ledgers and Tesla throttles")
    func signOutRemovesOnboardingProgress() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let records = SolarLayoutRecordStore(directory: folder.appendingPathComponent("records")) { nil }
        let onboarding = SiteHistoryOnboardingStore(directory: folder.appendingPathComponent("onboarding"))
        try await onboarding.save(SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02"), scope: scope)
        try await onboarding.setThrottle(Date(timeIntervalSince1970: 200), accountScopeID: scope.accountScopeID)
        let ledgers = SiteHistoryDayLedgerStore(directory: folder.appendingPathComponent("onboarding"))
        try await ledgers.save(SiteHistoryDayLedger(days: ["2026-11-01": .clear]), scope: scope)
        let cleanup = SolarSessionCleanup(
            historyStore: SolarHistoryStore(directory: folder.appendingPathComponent("history")),
            layoutRecordStore: records, cloudSync: try cloudSync(store: records, folder: folder),
            onboardingStore: onboarding, dayLedgerStore: ledgers
        )

        try await cleanup.signOut()

        let reloaded = SiteHistoryOnboardingStore(directory: folder.appendingPathComponent("onboarding"))
        #expect(try await reloaded.progress(scope: scope) == nil)
        #expect(try await reloaded.throttle(accountScopeID: scope.accountScopeID) == nil)
        let reloadedLedgers = SiteHistoryDayLedgerStore(directory: folder.appendingPathComponent("onboarding"))
        #expect(try await reloadedLedgers.ledger(scope: scope) == nil)
    }

    nonisolated private func cloudSync(store: SolarLayoutRecordStore, folder: URL) throws -> SolarLayoutCloudSync {
        let defaults = try #require(UserDefaults(suiteName: "SolarCleanup.\(UUID().uuidString)"))
        return SolarLayoutCloudSync(
            store: store, userDefaults: defaults,
            stateURL: folder.appendingPathComponent("state.json"),
            systemFieldsURL: folder.appendingPathComponent("fields.json"),
            pendingScopesURL: folder.appendingPathComponent("pending.json")
        )
    }

    enum Supersession: CaseIterable, Sendable { case stopped, restarted, replaced, signedOut }

    @Test("Obsolete remote applications cannot recreate cleared layouts", arguments: Supersession.allCases)
    func obsoleteRemoteApplicationIsRejected(_ supersession: Supersession) async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let records = SolarLayoutRecordStore(directory: folder) { nil }
        let source = NoopLayoutSync()
        let session = SolarCloudSession(accountScopeID: "account")
        let token = SolarCloudEngineToken()
        await records.bind(session, to: source)
        session.attach(token)
        session.detach(token)
        try await records.removeAll()
        switch supersession {
        case .stopped: break
        case .restarted: session.attach(SolarCloudEngineToken())
        case .replaced:
            let replacement = NoopLayoutSync()
            let next = SolarCloudSession(accountScopeID: "account")
            await records.bind(next, to: replacement)
            next.attach(token)
        case .signedOut:
            session.revoke()
            await records.close()
        }

        await #expect(throws: CancellationError.self) {
            try await records.applyRemoteRecord(remote, scope: scope, from: source, engine: token)
        }
        #expect(try await records.record(scope: scope) == nil)
        #expect(!FileManager.default.fileExists(atPath: folder.path))
    }

    @Test("Current synchronization can apply remote layouts")
    func currentRemoteApplicationIsAccepted() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let records = SolarLayoutRecordStore(directory: folder) { nil }
        let source = NoopLayoutSync()
        let session = SolarCloudSession(accountScopeID: "account")
        let token = SolarCloudEngineToken()
        await records.bind(session, to: source)
        session.attach(token)

        let outcome = try await records.applyRemoteRecord(remote, scope: scope, from: source, engine: token)

        #expect(outcome.record == remote)
        #expect(try await records.record(scope: scope) == remote)
    }

    @Test("Local layout writes from an ended session are rejected before touching disk")
    func endedSessionLocalWriteIsRejected() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let records = SolarLayoutRecordStore(directory: folder) { nil }
        let session = SolarCloudSession(accountScopeID: "account")
        await records.bind(session, to: NoopLayoutSync())
        try await records.setLocation(remote.location ?? .lifecycleHome, scope: scope)
        try await records.removeAll()

        session.revoke()

        await #expect(throws: CancellationError.self) {
            try await records.setLocation(.lifecycleHome, scope: scope)
        }
        #expect(!FileManager.default.fileExists(atPath: folder.path))
    }
}

private actor NoopLayoutSync: SolarLayoutSyncing {
    func recordChanged(_ scope: SolarForecastSiteScope, session: SolarCloudSession) {}
}
