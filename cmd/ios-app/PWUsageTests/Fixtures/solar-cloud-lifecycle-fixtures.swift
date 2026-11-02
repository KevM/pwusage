import CloudKit
import Foundation
import os
@testable import PWUsage

/// Suspends the first `limit` arrivals at a boundary until released. Later arrivals pass,
/// so cleanup that crosses the same boundary cannot deadlock behind a held test step.
@MainActor
final class LifecycleGate {
    private(set) var arrivals = 0
    private var limit: Int
    private var held: [CheckedContinuation<Void, Never>] = []

    init(holding limit: Int = 1) {
        self.limit = limit
    }

    var isHolding: Bool { !held.isEmpty }

    func pass() async {
        arrivals += 1
        guard limit > 0 else { return }
        limit -= 1
        await withCheckedContinuation { held.append($0) }
    }

    func release() {
        limit = 0
        let waiting = held
        held.removeAll()
        waiting.forEach { $0.resume() }
    }
}

/// Mirrors CKSyncEngine's guard against awaiting an engine call from inside one of its
/// delegate callbacks. Task locals carry the callback context into child tasks, not detached ones.
enum FakeEngineCallback {
    @TaskLocal static var isActive = false
}

final class FakeSolarCloudEngine: SolarCloudEngine {
    struct Counts: Equatable {
        var fetches = 0
        var sends = 0
        var cancels = 0
        /// Fetches or sends made from inside a delegate callback; CloudKit traps on these.
        var callbackViolations = 0
    }

    private let state = OSAllocatedUnfairLock(initialState: (saves: [CKRecord.ID](), counts: Counts()))
    private let fetchGate: LifecycleGate?
    /// Weak, as `CKSyncEngine.Configuration` holds its delegate.
    nonisolated(unsafe) private(set) weak var delegate: (any CKSyncEngineDelegate)?

    init(fetchGate: LifecycleGate?, delegate: any CKSyncEngineDelegate) {
        self.fetchGate = fetchGate
        self.delegate = delegate
    }

    var pendingSaves: [CKRecord.ID] { state.withLock { $0.saves } }
    var counts: Counts { state.withLock { $0.counts } }

    func saveZoneIfNeeded(alreadySaved: Bool) {}

    func addPendingSaves(_ recordIDs: [CKRecord.ID]) {
        state.withLock { $0.saves.append(contentsOf: recordIDs) }
    }

    func fetchChanges() async throws {
        let inCallback = FakeEngineCallback.isActive
        state.withLock {
            $0.counts.fetches += 1
            if inCallback { $0.counts.callbackViolations += 1 }
        }
        if let fetchGate { await fetchGate.pass() }
    }

    func sendChanges() async throws {
        let inCallback = FakeEngineCallback.isActive
        state.withLock {
            $0.counts.sends += 1
            if inCallback { $0.counts.callbackViolations += 1 }
        }
    }

    func cancelOperations() async {
        state.withLock { $0.counts.cancels += 1 }
    }
}

/// A controllable CloudKit transport. Gates suspend account lookup and fetches.
final class FakeSolarCloudTransport: Sendable {
    private let state = OSAllocatedUnfairLock(
        initialState: (status: CKAccountStatus.available, lookups: 0, engines: [FakeSolarCloudEngine]())
    )
    let lookupGate: LifecycleGate?
    let fetchGate: LifecycleGate?

    init(lookupGate: LifecycleGate? = nil, fetchGate: LifecycleGate? = nil) {
        self.lookupGate = lookupGate
        self.fetchGate = fetchGate
    }

    var lookups: Int { state.withLock { $0.lookups } }
    var engines: [FakeSolarCloudEngine] { state.withLock { $0.engines } }

    func setStatus(_ status: CKAccountStatus) {
        state.withLock { $0.status = status }
    }

    var transport: SolarCloudTransport {
        SolarCloudTransport(
            accountStatus: { [self] in
                let status = state.withLock { state in
                    state.lookups += 1
                    return state.status
                }
                if let lookupGate { await lookupGate.pass() }
                return status
            },
            makeEngine: { [self] _, delegate in
                let engine = FakeSolarCloudEngine(fetchGate: fetchGate, delegate: delegate)
                state.withLock { $0.engines.append(engine) }
                return engine
            }
        )
    }
}

/// Delays delivery of a local-save notification while forwarding the captured session.
actor DelayedSyncRelay: SolarLayoutSyncing {
    private let target: any SolarLayoutSyncing
    private let gate: LifecycleGate
    private(set) var delivered = 0

    init(forwardingTo target: any SolarLayoutSyncing, gate: LifecycleGate) {
        self.target = target
        self.gate = gate
    }

    func recordChanged(_ scope: SolarForecastSiteScope, session: SolarCloudSession) async {
        await gate.pass()
        await target.recordChanged(scope, session: session)
        delivered += 1
    }
}

struct LifecycleCleanupFailure: Error {}

/// One synchronization owner and record store over a temporary folder. Disk assertions
/// go through a fresh store or the file system, never the instance under test.
struct SolarCloudLifecycleHarness {
    let folder: URL
    let records: SolarLayoutRecordStore
    let sync: SolarLayoutCloudSync

    var recordsFolder: URL { folder.appendingPathComponent("records") }
    var pendingURL: URL { folder.appendingPathComponent("pending.json") }
    var unsyncedURL: URL { folder.appendingPathComponent("records-unsynced.json") }

    /// Pass the folder of an earlier harness to model a process restart over the same files.
    init(
        transport: SolarCloudTransport? = nil,
        folder: URL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    ) throws {
        guard let defaults = UserDefaults(suiteName: "SolarCloudLifecycle.\(folder.lastPathComponent)") else {
            throw MissingDefaults()
        }
        self.folder = folder
        records = SolarLayoutRecordStore(directory: folder.appendingPathComponent("records")) { nil }
        sync = SolarLayoutCloudSync(
            store: records, userDefaults: defaults,
            stateURL: folder.appendingPathComponent("state.json"),
            systemFieldsURL: folder.appendingPathComponent("fields.json"),
            pendingScopesURL: folder.appendingPathComponent("pending.json"),
            transport: transport
        )
    }

    /// The production sign-out cleanup over this harness's stores.
    @MainActor
    func sessionCleanup() -> SolarSessionCleanup {
        SolarSessionCleanup(
            historyStore: SolarHistoryStore(directory: folder.appendingPathComponent("history")),
            layoutRecordStore: records, cloudSync: sync
        )
    }

    func freshRecord(_ scope: SolarForecastSiteScope) async throws -> SolarLayoutRecord? {
        try await SolarLayoutRecordStore(directory: recordsFolder) { nil }.record(scope: scope)
    }

    func persistedPendingScopes() throws -> Set<SolarForecastSiteScope> {
        guard FileManager.default.fileExists(atPath: pendingURL.path) else { return [] }
        return try Set(JSONDecoder().decode([SolarForecastSiteScope].self, from: Data(contentsOf: pendingURL)))
    }

    func removeFiles() {
        try? FileManager.default.removeItem(at: folder)
    }
}

private struct MissingDefaults: Error {}

extension SolarHomeLocation {
    static let lifecycleHome = SolarHomeLocation(latitude: 43.39, longitude: -87.88, source: .device)
    static let lifecycleOther = SolarHomeLocation(latitude: 40.71, longitude: -74.0, source: .device)
}

extension SolarLayoutRecord {
    static let lifecycleRemote = SolarLayoutRecord(
        location: .lifecycleHome, locationSetAt: Date(timeIntervalSince1970: 100)
    )
}

func lifecycleCloudRecord(_ scope: SolarForecastSiteScope) -> CKRecord {
    SolarLayoutCloudRecordSerializer.makeRecord(from: .lifecycleRemote, scope: scope, systemFieldsData: nil)
}

/// `eventually` for conditions that read actor state.
@MainActor
func eventuallyAsync(
    timeout: Duration = .seconds(2),
    _ condition: @MainActor () async -> Bool
) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if await condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    if await condition() { return }
    throw WaitTimeout(message: "Timed out after \(timeout) waiting for condition")
}

/// Records completion of work a test expects to stay suspended.
@MainActor
final class CompletionProbe {
    private(set) var isComplete = false
    func complete() { isComplete = true }
}
