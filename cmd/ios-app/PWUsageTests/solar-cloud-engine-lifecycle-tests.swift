import CloudKit
import Foundation
@testable import PWUsage
import Testing

/// Engine-level rows of the lifecycle acceptance matrix: suspended startup, engine-only
/// restart, outgoing record reads, and concurrent start/stop requests.
/// See docs/plans/2026-11-01-solar-cloud-lifecycle-spec.md.
@MainActor
@Suite("Solar cloud engine lifecycle")
struct SolarCloudEngineLifecycleTests {
    private let account = "account-a"
    private let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")

    /// Engine attachment itself is synchronous within the actor turn, so the binding
    /// boundary is the record store bind performed by activation.
    enum Boundary: CaseIterable, Sendable { case storeBinding, accountLookup, fetch }

    @Test(
        "Startup suspended at a boundary cannot publish after sign-out",
        arguments: Boundary.allCases, [true, false]
    )
    func suspendedStartupAfterSignOut(at boundary: Boundary, signsOut: Bool) async throws {
        let gate = LifecycleGate()
        let transport = FakeSolarCloudTransport(
            lookupGate: boundary == .accountLookup ? gate : nil,
            fetchGate: boundary == .fetch ? gate : nil
        )
        let harness = try SolarCloudLifecycleHarness(transport: transport.transport)
        defer { harness.removeFiles() }
        let session = harness.sync.issueSession(accountScopeID: account)
        if boundary == .storeBinding {
            await harness.records.setOnBindingChange { await gate.pass() }
        } else {
            #expect(await harness.sync.activate(session) == .active)
        }
        let starting = Task { await harness.sync.start(session: session) }
        try await eventually { gate.isHolding }
        let pausedToken = await harness.sync.currentEngineToken

        if signsOut {
            session.revoke()
            try await harness.sessionCleanup().signOut()
        }
        gate.release()
        await starting.value
        let token: SolarCloudEngineToken
        if signsOut {
            // The paused attempt's token; a pause before any attempt existed has none to replay.
            token = pausedToken ?? SolarCloudEngineToken()
        } else {
            token = try #require(await harness.sync.currentEngineToken)
        }
        await harness.sync.applyFetchedRecords([lifecycleCloudRecord(scope)], token: token)

        if signsOut {
            #expect(await harness.sync.isStarted == false)
            #expect(await harness.records.hasEngine == false)
            #expect(try await harness.freshRecord(scope) == nil)
            #expect(!FileManager.default.fileExists(atPath: harness.recordsFolder.path))
            #expect(!FileManager.default.fileExists(atPath: harness.pendingURL.path))
            if boundary == .fetch {
                let engine = try #require(transport.engines.first)
                try await eventually { engine.counts.cancels == 1 }
            } else {
                #expect(transport.engines.isEmpty)
            }
            #expect(transport.lookups == (boundary == .storeBinding ? 0 : 1))
        } else {
            #expect(await harness.sync.isStarted)
            #expect(await harness.records.hasEngine)
            if let pausedToken { #expect(pausedToken == token) }
            #expect(try await harness.freshRecord(scope)?.location == .lifecycleHome)
        }
    }

    @Test("An obsolete startup resumed after a stop and replacement start leaves only the replacement attached")
    func resumedObsoleteStartupKeepsReplacementBinding() async throws {
        let gate = LifecycleGate()
        let transport = FakeSolarCloudTransport(lookupGate: gate)
        let harness = try SolarCloudLifecycleHarness(transport: transport.transport)
        defer { harness.removeFiles() }
        let session = harness.sync.issueSession(accountScopeID: account)
        #expect(await harness.sync.activate(session) == .active)
        let obsolete = Task { await harness.sync.start(session: session) }
        try await eventually { gate.isHolding }
        let oldToken = try #require(await harness.sync.currentEngineToken)

        await harness.sync.stopEngine()
        await harness.sync.start(session: session)
        let newToken = try #require(await harness.sync.currentEngineToken)
        gate.release()
        await obsolete.value

        #expect(newToken != oldToken)
        #expect(await harness.sync.currentEngineToken == newToken)
        #expect(await harness.sync.isStarted)
        #expect(await harness.records.hasEngine)
        #expect(transport.engines.count == 1)
        await #expect(throws: CancellationError.self) {
            try await harness.records.applyRemoteRecord(
                .lifecycleRemote, scope: scope, from: harness.sync, engine: oldToken
            )
        }
        _ = try await harness.records.applyRemoteRecord(
            .lifecycleRemote, scope: scope, from: harness.sync, engine: newToken
        )
        #expect(try await harness.freshRecord(scope)?.location == .lifecycleHome)
    }

    enum Supersession: CaseIterable, Sendable { case engineRestart, signOut }

    @Test("An outgoing record read resumed after its engine is superseded returns nothing",
          arguments: Supersession.allCases)
    func supersededOutgoingReadReturnsNil(_ supersession: Supersession) async throws {
        let transport = FakeSolarCloudTransport()
        let harness = try SolarCloudLifecycleHarness(transport: transport.transport)
        defer { harness.removeFiles() }
        let session = harness.sync.issueSession(accountScopeID: account)
        await harness.sync.start(session: session)
        try await harness.records.setLocation(.lifecycleHome, scope: scope)
        let oldToken = try #require(await harness.sync.currentEngineToken)
        let recordID = SolarLayoutCloudRecordSerializer.recordID(for: scope)
        let gate = LifecycleGate()
        await harness.records.setOnUploadRead { await gate.pass() }
        let read = Task { await harness.sync.makeRecord(for: recordID, token: oldToken) }
        try await eventually { gate.isHolding }

        switch supersession {
        case .engineRestart:
            await harness.sync.stopEngine()
            await harness.sync.start(session: session)
        case .signOut:
            session.revoke()
            try await harness.sessionCleanup().signOut()
        }
        gate.release()

        #expect(await read.value == nil)
        if supersession == .engineRestart {
            let current = try #require(await harness.sync.currentEngineToken)
            let record = try #require(await harness.sync.makeRecord(for: recordID, token: current))
            #expect(SolarLayoutCloudRecordSerializer.parseRecord(record)?.record.location == .lifecycleHome)
        }
    }

    @Test("Concurrent starts and stops coalesce without orphaned attachments", arguments: [false, true])
    func concurrentStartsAndStopsCoalesce(signsOut: Bool) async throws {
        let transport = FakeSolarCloudTransport()
        let harness = try SolarCloudLifecycleHarness(transport: transport.transport)
        defer { harness.removeFiles() }
        let session = harness.sync.issueSession(accountScopeID: account)
        let sync = harness.sync
        await withTaskGroup(of: Void.self) { group in
            for index in 0 ..< 40 {
                group.addTask {
                    if index.isMultiple(of: 3) {
                        await sync.stopEngine()
                    } else {
                        await sync.start(session: session)
                    }
                }
            }
        }
        await sync.start(session: session)
        if signsOut {
            session.revoke()
            try await harness.sessionCleanup().signOut()
        }

        let engines = transport.engines
        #expect(!engines.isEmpty)
        #expect(engines.count <= 27)
        if signsOut {
            #expect(await sync.isStarted == false)
            #expect(await harness.records.hasEngine == false)
            try await eventually { engines.allSatisfy { $0.counts.cancels == 1 } }
        } else {
            let token = try #require(await sync.currentEngineToken)
            #expect(await sync.isStarted)
            #expect(await harness.records.hasEngine)
            _ = try await harness.records.applyRemoteRecord(.lifecycleRemote, scope: scope, from: sync, engine: token)
            try await eventually { engines.dropLast().allSatisfy { $0.counts.cancels == 1 } }
            #expect(engines.last?.counts.cancels == 0)
        }
    }

    @Test("A running engine keeps its delegate alive, since CKSyncEngine holds it weakly")
    func runningEngineRetainsDelegate() async throws {
        let transport = FakeSolarCloudTransport()
        let harness = try SolarCloudLifecycleHarness(transport: transport.transport)
        defer { harness.removeFiles() }
        let session = harness.sync.issueSession(accountScopeID: account)
        await harness.sync.start(session: session)

        let engine = try #require(transport.engines.first)
        #expect(await harness.sync.isStarted)
        #expect(engine.delegate != nil)
    }

    @Test("Unavailable iCloud leaves the session offline with pending work for a later start")
    func unavailableCloudKeepsPendingWork() async throws {
        let transport = FakeSolarCloudTransport()
        transport.setStatus(.noAccount)
        let harness = try SolarCloudLifecycleHarness(transport: transport.transport)
        defer { harness.removeFiles() }
        let session = harness.sync.issueSession(accountScopeID: account)
        await harness.sync.start(session: session)
        try await harness.records.setLocation(.lifecycleHome, scope: scope)
        try await eventually { (try? harness.persistedPendingScopes()) == [scope] }

        #expect(await harness.sync.isStarted == false)
        #expect(await harness.records.hasEngine == false)
        #expect(transport.lookups == 1)
        #expect(transport.engines.isEmpty)

        transport.setStatus(.available)
        await harness.sync.start(session: session)
        await harness.sync.stopEngine()
        await harness.sync.start(session: session)

        let recordID = SolarLayoutCloudRecordSerializer.recordID(for: scope)
        #expect(transport.engines.count == 2)
        #expect(transport.engines.allSatisfy { $0.pendingSaves.contains(recordID) })
        #expect(await harness.sync.pendingUploadScopes == [scope])
        #expect(await harness.records.isWritable)
    }
}
