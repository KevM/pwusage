import Foundation
@testable import PWUsage
import Testing

/// Session-level rows of the lifecycle acceptance matrix: local-save notifications,
/// durable recovery, and the sign-out cleanup barrier.
/// See docs/plans/2026-11-01-solar-cloud-lifecycle-spec.md.
@MainActor
@Suite("Solar cloud session lifecycle")
struct SolarCloudSessionLifecycleTests {
    private let account = "account-a"

    private func scope(_ site: String, account: String = "account-a") -> SolarForecastSiteScope {
        SolarForecastSiteScope(accountScopeID: account, siteID: site)
    }

    enum Replacement: CaseIterable, Sendable { case none, sameAccount, otherAccount }

    @Test("A local-save notification released after sign-out recreates nothing", arguments: Replacement.allCases)
    func notificationAfterSignOutIsRejected(_ replacement: Replacement) async throws {
        let transport = FakeSolarCloudTransport()
        let harness = try SolarCloudLifecycleHarness(transport: transport.transport)
        defer { harness.removeFiles() }
        let old = harness.sync.issueSession(accountScopeID: account)
        await harness.sync.start(session: old)
        let oldEngine = try #require(transport.engines.first)
        let gate = LifecycleGate()
        let relay = DelayedSyncRelay(forwardingTo: harness.sync, gate: gate)
        await harness.records.bind(old, to: relay)
        let oldScope = scope("site-old")
        try await harness.records.setLocation(.lifecycleHome, scope: oldScope)
        try await eventually { gate.isHolding }

        old.revoke()
        try await harness.sessionCleanup().signOut()
        var replacementScopes: Set<SolarForecastSiteScope> = []
        if replacement != .none {
            let nextAccount = replacement == .sameAccount ? account : "account-b"
            let next = harness.sync.issueSession(accountScopeID: nextAccount)
            #expect(await harness.sync.activate(next) == .active)
            let nextScope = scope("site-new", account: nextAccount)
            try await harness.records.setLocation(.lifecycleOther, scope: nextScope)
            replacementScopes = [nextScope]
            try await eventuallyAsync { await harness.sync.pendingUploadScopes == replacementScopes }
        }
        gate.release()
        try await eventuallyAsync { await relay.delivered == 1 }

        #expect(try await harness.freshRecord(oldScope) == nil)
        #expect(await harness.sync.pendingUploadScopes == replacementScopes)
        #expect(try harness.persistedPendingScopes() == replacementScopes)
        #expect(!oldEngine.pendingSaves.contains(SolarLayoutCloudRecordSerializer.recordID(for: oldScope)))
        #expect(oldEngine.counts.sends == 0)
        if let nextScope = replacementScopes.first {
            #expect(try await harness.freshRecord(nextScope)?.location == .lifecycleOther)
        } else {
            #expect(!FileManager.default.fileExists(atPath: harness.recordsFolder.path))
            #expect(!FileManager.default.fileExists(atPath: harness.pendingURL.path))
        }
    }

    @Test("A delayed local-save notification for the current session is accepted and uploaded")
    func currentNotificationIsAccepted() async throws {
        let transport = FakeSolarCloudTransport()
        let harness = try SolarCloudLifecycleHarness(transport: transport.transport)
        defer { harness.removeFiles() }
        let session = harness.sync.issueSession(accountScopeID: account)
        await harness.sync.start(session: session)
        let engine = try #require(transport.engines.first)
        let gate = LifecycleGate()
        await harness.records.bind(session, to: DelayedSyncRelay(forwardingTo: harness.sync, gate: gate))
        let saved = scope("site-a")
        try await harness.records.setLocation(.lifecycleHome, scope: saved)
        try await eventually { gate.isHolding }

        gate.release()

        try await eventuallyAsync { await harness.sync.pendingUploadScopes == [saved] }
        #expect(try harness.persistedPendingScopes() == [saved])
        #expect(engine.pendingSaves.contains(SolarLayoutCloudRecordSerializer.recordID(for: saved)))
        try await eventually { engine.counts.sends == 1 }
        #expect(await harness.records.unsyncedScopes(for: session).isEmpty)
    }

    @Test("Saves made offline or before notification survive a restart and are enqueued", arguments: [true, false])
    func offlineSaveIsRecoveredAfterRestart(notified: Bool) async throws {
        let first = try SolarCloudLifecycleHarness()
        defer { first.removeFiles() }
        let saved = scope("site-a")
        if notified {
            // Authorized and offline: the notification is accepted into the durable queue.
            let session = first.sync.issueSession(accountScopeID: account)
            #expect(await first.sync.activate(session) == .active)
            try await first.records.setLocation(.lifecycleHome, scope: saved)
            try await eventually { (try? first.persistedPendingScopes()) == [saved] }
        } else {
            // Committed before any session bound: only the write-ahead marker exists.
            try await first.records.setLocation(.lifecycleHome, scope: saved)
            #expect(FileManager.default.fileExists(atPath: first.unsyncedURL.path))
        }

        let transport = FakeSolarCloudTransport()
        let restarted = try SolarCloudLifecycleHarness(transport: transport.transport, folder: first.folder)
        await restarted.sync.start(session: restarted.sync.issueSession(accountScopeID: account))

        let engine = try #require(transport.engines.first)
        #expect(engine.pendingSaves.contains(SolarLayoutCloudRecordSerializer.recordID(for: saved)))
        #expect(try restarted.persistedPendingScopes() == [saved])
        #expect(try await restarted.freshRecord(saved)?.location == .lifecycleHome)
    }

    @Test("Another account's unsynced markers are not recovered into this session")
    func otherAccountMarkersAreNotRecovered() async throws {
        let first = try SolarCloudLifecycleHarness()
        defer { first.removeFiles() }
        try await first.records.setLocation(.lifecycleHome, scope: scope("site-a"))

        let transport = FakeSolarCloudTransport()
        let restarted = try SolarCloudLifecycleHarness(transport: transport.transport, folder: first.folder)
        await restarted.sync.start(session: restarted.sync.issueSession(accountScopeID: "account-b"))

        let engine = try #require(transport.engines.first)
        #expect(engine.pendingSaves.isEmpty)
        #expect(await restarted.sync.pendingUploadScopes.isEmpty)
    }

    @Test("Activating the current session again keeps its engine and pending work")
    func repeatedActivationIsIdempotent() async throws {
        let transport = FakeSolarCloudTransport()
        let harness = try SolarCloudLifecycleHarness(transport: transport.transport)
        defer { harness.removeFiles() }
        let session = harness.sync.issueSession(accountScopeID: account)
        await harness.sync.start(session: session)
        try await harness.records.setLocation(.lifecycleHome, scope: scope("site-a"))
        try await eventuallyAsync { await harness.sync.pendingUploadScopes.count == 1 }
        let token = await harness.sync.currentEngineToken

        #expect(await harness.sync.activate(session) == .active)
        await harness.sync.start(session: session)

        #expect(await harness.sync.currentEngineToken == token)
        #expect(await harness.sync.pendingUploadScopes == [scope("site-a")])
        #expect(transport.engines.count == 1)
        #expect(await harness.records.hasEngine)
    }

    @Test("A replacement cannot write until the old session's cleanup barrier resolves", arguments: [true, false])
    func replacementWaitsForCleanupBarrier(sameAccount: Bool) async throws {
        let harness = try SolarCloudLifecycleHarness()
        defer { harness.removeFiles() }
        let old = harness.sync.issueSession(accountScopeID: account)
        #expect(await harness.sync.activate(old) == .active)
        let oldScope = scope("site-old")
        try await harness.records.setLocation(.lifecycleHome, scope: oldScope)
        let gate = LifecycleGate()
        let records = harness.records
        let ending = Task {
            try await harness.sync.endSession {
                await gate.pass()
                try await records.removeAll()
            }
        }
        try await eventually { gate.isHolding }

        let nextAccount = sameAccount ? account : "account-b"
        let next = harness.sync.issueSession(accountScopeID: nextAccount)
        let probe = CompletionProbe()
        let activation = Task {
            let result = await harness.sync.activate(next)
            probe.complete()
            return result
        }
        let nextScope = scope("site-new", account: nextAccount)
        await #expect(throws: CancellationError.self) {
            try await records.setLocation(.lifecycleOther, scope: nextScope)
        }
        try await staysTrue { !probe.isComplete }

        gate.release()
        try await ending.value
        #expect(await activation.value == .active)
        try await records.setLocation(.lifecycleOther, scope: nextScope)
        #expect(try await harness.freshRecord(oldScope) == nil)
        #expect(try await harness.freshRecord(nextScope)?.location == .lifecycleOther)
    }

    @Test("A failed cleanup step still runs the rest, blocks replacement writes, and can be retried")
    func failedCleanupBlocksReplacementUntilRetried() async throws {
        let harness = try SolarCloudLifecycleHarness()
        defer { harness.removeFiles() }
        let old = harness.sync.issueSession(accountScopeID: account)
        #expect(await harness.sync.activate(old) == .active)
        let oldScope = scope("site-old")
        try await harness.records.setLocation(.lifecycleHome, scope: oldScope)
        try await eventually { (try? harness.persistedPendingScopes()) == [oldScope] }
        let forecastStore = FakeSolcastStore()
        await forecastStore.setSignOutError(LifecycleCleanupFailure())
        let cleanup = harness.sessionCleanup(forecastStore: forecastStore)
        let gate = LifecycleGate()
        await harness.records.setOnBindingChange { await gate.pass() }
        old.revoke()
        let ending = Task { try await cleanup.signOut() }
        try await eventually { gate.isHolding }
        let next = harness.sync.issueSession(accountScopeID: account)
        let activation = Task { await harness.sync.activate(next) }

        gate.release()

        await #expect(throws: LifecycleCleanupFailure.self) { try await ending.value }
        #expect(await activation.value == .cleanupRequired)
        #expect(try await harness.freshRecord(oldScope) == nil)
        #expect(!FileManager.default.fileExists(atPath: harness.pendingURL.path))
        #expect(await harness.records.isWritable == false)
        await #expect(throws: CancellationError.self) {
            try await harness.records.setLocation(.lifecycleOther, scope: scope("site-new"))
        }

        await forecastStore.setSignOutError(nil)
        try await cleanup.signOut()
        let retried = harness.sync.issueSession(accountScopeID: account)
        #expect(next.isValid == false)
        #expect(await harness.sync.activate(retried) == .active)
        try await harness.records.setLocation(.lifecycleOther, scope: scope("site-new"))
        #expect(try await harness.freshRecord(scope("site-new"))?.location == .lifecycleOther)
    }

    @Test("A concurrent activation of the same session returns only after the store is bound")
    func joinedActivationWaitsForBinding() async throws {
        let harness = try SolarCloudLifecycleHarness()
        defer { harness.removeFiles() }
        try await harness.sessionCleanup().signOut()
        #expect(await harness.records.isWritable == false)
        let gate = LifecycleGate()
        await harness.records.setOnBindingChange { await gate.pass() }
        let session = harness.sync.issueSession(accountScopeID: account)
        let first = Task { await harness.sync.activate(session) }
        try await eventually { gate.isHolding }
        let probe = CompletionProbe()
        let joined = Task {
            let result = await harness.sync.activate(session)
            probe.complete()
            return result
        }
        try await staysTrue { !probe.isComplete }

        gate.release()

        #expect(await joined.value == .active)
        #expect(await first.value == .active)
        #expect(await harness.records.isWritable)
    }

    @Test("A save landing between reading and acknowledging markers keeps its marker")
    func acknowledgementKeepsNewerSave() async throws {
        let harness = try SolarCloudLifecycleHarness()
        defer { harness.removeFiles() }
        let session = SolarCloudSession(accountScopeID: account)
        await harness.records.bind(session, to: NoopSync())
        let saved = scope("site-a")
        try await harness.records.setLocation(.lifecycleHome, scope: saved)
        let read = await harness.records.unsyncedMarkers(for: session)

        try await harness.records.setLocation(.lifecycleOther, scope: saved)
        await harness.records.acknowledge(read, for: session)

        #expect(await harness.records.unsyncedScopes(for: session) == [saved])
        await harness.records.acknowledge(await harness.records.unsyncedMarkers(for: session), for: session)
        #expect(await harness.records.unsyncedScopes(for: session).isEmpty)
    }

    @Test("An unreadable unsynced-marker file does not block local saves")
    func corruptMarkerFileDoesNotBlockSaves() async throws {
        let harness = try SolarCloudLifecycleHarness()
        defer { harness.removeFiles() }
        try FileManager.default.createDirectory(at: harness.folder, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: harness.unsyncedURL)

        try await harness.records.setLocation(.lifecycleHome, scope: scope("site-a"))

        let session = harness.sync.issueSession(accountScopeID: account)
        #expect(await harness.sync.activate(session) == .active)
        #expect(await harness.sync.pendingUploadScopes == [scope("site-a")])
    }

    @Test("Concurrent sign-outs join one cleanup barrier")
    func repeatedEndJoinsOneBarrier() async throws {
        let harness = try SolarCloudLifecycleHarness()
        defer { harness.removeFiles() }
        let session = harness.sync.issueSession(accountScopeID: account)
        #expect(await harness.sync.activate(session) == .active)
        let gate = LifecycleGate()
        let probe = CleanupCounter()
        let cleanup: @MainActor @Sendable () async throws -> Void = {
            probe.count += 1
            await gate.pass()
        }
        let first = Task { try await harness.sync.endSession(cleanup: cleanup) }
        try await eventually { gate.isHolding }
        let second = Task { try await harness.sync.endSession(cleanup: cleanup) }
        try await staysTrue { probe.count == 1 }

        gate.release()
        try await first.value
        try await second.value

        #expect(probe.count == 1)
        #expect(session.isValid == false)
    }
}

private actor NoopSync: SolarLayoutSyncing {
    func recordChanged(_ scope: SolarForecastSiteScope, session: SolarCloudSession) {}
}

@MainActor
private final class CleanupCounter {
    var count = 0
}
