import CloudKit
import Foundation

protocol SolarLayoutSyncing: AnyObject, Sendable {
    /// `session` is the authority captured when the save committed, never the current one.
    func recordChanged(_ scope: SolarForecastSiteScope, session: SolarCloudSession) async
}

/// The single owner of solar layout synchronization lifetime. It separates three
/// identities: the persisted account scope, the in-process session authority, and the
/// engine token of one CloudKit attempt. Every continuation after a suspension proves
/// ownership through `owns(_:)` or `session(owning:)` before it mutates anything.
/// See docs/plans/2026-11-01-solar-cloud-lifecycle-spec.md.
actor SolarLayoutCloudSync: SolarLayoutSyncing {
    static let shared = SolarLayoutCloudSync()

    private enum Phase {
        case inactive
        /// Binding the record store and recovering unsynced saves; joiners wait.
        case activating(SolarCloudSession, Task<Void, Never>)
        case active(SolarCloudSession)
        case ending(Task<Void, any Error>)
        case cleanupFailed
    }

    /// Engine states within an active session. `offline` is authorized and keeps pending work.
    private enum Engine {
        case offline
        case starting(SolarCloudEngineToken)
        case running(SolarCloudEngineToken, any SolarCloudEngine, SolarCloudEngineDelegate)

        var token: SolarCloudEngineToken? {
            switch self {
            case .offline: nil
            case .starting(let token), .running(let token, _, _): token
            }
        }
    }

    nonisolated let sessions = SolarCloudSessionIssuer()
    let store: SolarLayoutRecordStore
    private let transport: SolarCloudTransport?
    let files: SolarCloudSyncFiles
    var systemFields: [String: Data] = [:]
    var pendingScopes: Set<SolarForecastSiteScope>
    private var phase: Phase = .inactive
    private var engine: Engine = .offline
    private var phaseWaiters: [CheckedContinuation<Void, Never>] = []
    var onRemoteRecordApplied: (@Sendable (SolarForecastSiteScope, SolarCloudSession) -> Void)?

    init(
        store: SolarLayoutRecordStore = .shared,
        fileManager: FileManager = .default,
        userDefaults: UserDefaults = .standard,
        stateURL: URL? = nil,
        systemFieldsURL: URL? = nil,
        pendingScopesURL: URL? = nil,
        transport: SolarCloudTransport? = .live(containerIdentifier: "iCloud.fm.rodeo.pwusage")
    ) {
        self.store = store
        self.transport = transport
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        let baseDir = appSupport.appendingPathComponent("SolarLayout", isDirectory: true)
        files = SolarCloudSyncFiles(
            fileManager: fileManager,
            userDefaults: userDefaults,
            stateURL: stateURL ?? baseDir.appendingPathComponent("sync-engine-state.json"),
            systemFieldsURL: systemFieldsURL ?? baseDir.appendingPathComponent("system-fields.json"),
            pendingScopesURL: pendingScopesURL ?? baseDir.appendingPathComponent("pending-scopes.json")
        )
        pendingScopes = files.loadPendingScopes()
    }

    var isStarted: Bool {
        if case .running = engine { return true }
        return false
    }

    var currentEngineToken: SolarCloudEngineToken? { engine.token }
    var pendingUploadScopes: Set<SolarForecastSiteScope> { pendingScopes }

    nonisolated func issueSession(accountScopeID: String) -> SolarCloudSession {
        sessions.issue(accountScopeID: accountScopeID)
    }

    func setOnRemoteRecordApplied(_ handler: (@Sendable (SolarForecastSiteScope, SolarCloudSession) -> Void)?) {
        onRemoteRecordApplied = handler
    }

    // MARK: - Session lifecycle

    /// Idempotent for the current session. A replacement waits for the previous
    /// session's cleanup barrier, then binds the record store and recovers local
    /// saves whose notifications never arrived, including from an earlier process.
    func activate(_ requested: SolarCloudSession) async -> SolarCloudActivation {
        while true {
            guard requested.isValid else { return .rejected }
            switch phase {
            case .ending(let barrier):
                _ = await barrier.result
            case .cleanupFailed:
                return .cleanupRequired
            case .activating(let current, let binding) where current === requested:
                await binding.value
            case .active(let current) where current === requested:
                return .active
            case .activating(let current, _) where current.isValid, .active(let current) where current.isValid:
                return .rejected
            case .activating, .active:
                // Revoked by app teardown; its sign-out cleanup is on the way.
                await withCheckedContinuation { phaseWaiters.append($0) }
            case .inactive:
                let binding = Task { await self.bind(requested) }
                transition(to: .activating(requested, binding))
                await binding.value
            }
        }
    }

    /// Publishes `.active` only after the store is bound, then recovers unsynced saves.
    private func bind(_ session: SolarCloudSession) async {
        await store.bind(session, to: self)
        guard session.isValid, case .activating(let current, _) = phase, current === session else { return }
        transition(to: .active(session))
        await reconcileLocalChanges(for: session)
    }

    /// Ends the session: revokes every issued session and the engine before the first
    /// suspension, then runs destructive cleanup exactly once. Concurrent requests join
    /// the barrier. After a failure, nothing may activate until a later call retries.
    /// This is the account-wide sign-out wipe, so it is deliberately not token-scoped.
    func endSession(cleanup: @escaping @MainActor @Sendable () async throws -> Void) async throws {
        sessions.revokeAll()
        if case .ending(let barrier) = phase { return try await barrier.value }
        abandonEngine()
        let barrier = Task { try await self.clearSession(cleanup) }
        transition(to: .ending(barrier))
        try await barrier.value
    }

    private func clearSession(_ cleanup: @MainActor @Sendable () async throws -> Void) async throws {
        await store.close()
        var firstError: (any Error)?
        systemFields.removeAll()
        pendingScopes.removeAll()
        do { try files.removeAll() } catch { firstError = error }
        do { try await cleanup() } catch { firstError = firstError ?? error }
        transition(to: firstError == nil ? .inactive : .cleanupFailed)
        if let firstError { throw firstError }
    }

    private func transition(to next: Phase) {
        phase = next
        let waiters = phaseWaiters
        phaseWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    private func owns(_ session: SolarCloudSession) -> Bool {
        guard session.isValid, case .active(let current) = phase else { return false }
        return current === session
    }

    // MARK: - Engine lifecycle

    /// Starts one CloudKit attempt for the session. Concurrent requests coalesce on the
    /// attempt in progress; a failed attempt returns to authorized offline for retry.
    func start(session requested: SolarCloudSession) async {
        guard !Task.isCancelled, requested.isValid else { return }
        guard await activate(requested) == .active, !Task.isCancelled, owns(requested) else { return }
        guard case .offline = engine, let transport else { return }
        let token = SolarCloudEngineToken()
        engine = .starting(token)
        requested.attach(token)
        do {
            let status = try await transport.accountStatus()
            guard isStarting(token, for: requested), status == .available else { return releaseEngine(token) }
        } catch {
            return releaseEngine(token)
        }
        systemFields = files.loadSystemFields()
        let delegate = SolarCloudEngineDelegate(owner: self, token: token)
        let cloud = transport.makeEngine(files.loadState(), delegate)
        engine = .running(token, cloud, delegate)
        cloud.saveZoneIfNeeded(alreadySaved: files.hasSavedZone)
        cloud.addPendingSaves(pendingScopes.map { SolarLayoutCloudRecordSerializer.recordID(for: $0) })
        // CKSyncEngine retries failed fetches itself; the attempt stays running.
        try? await cloud.fetchChanges()
    }

    /// Ends the current CloudKit attempt only. The session and its pending changes remain.
    func stopEngine() {
        guard let token = engine.token else { return }
        releaseEngine(token)
    }

    private func isStarting(_ token: SolarCloudEngineToken, for session: SolarCloudSession) -> Bool {
        guard !Task.isCancelled, owns(session), case .starting(let current) = engine else { return false }
        return current == token
    }

    /// Token-scoped, so an old attempt resuming late cannot release its replacement.
    func releaseEngine(_ token: SolarCloudEngineToken) {
        guard engine.token == token else { return }
        abandonEngine()
    }

    /// Synchronous, so engine authority changes within one actor turn. Local cleanup
    /// never waits on transport cancellation.
    private func abandonEngine() {
        if case .active(let session) = phase, let token = engine.token {
            session.detach(token)
        }
        if case .running(_, let cloud, _) = engine {
            Task { await cloud.cancelOperations() }
        }
        engine = .offline
    }

    /// The session that owns a running attempt, or nil once the token is obsolete.
    func session(owning token: SolarCloudEngineToken) -> SolarCloudSession? {
        guard case .active(let session) = phase, session.isValid,
              case .running(let current, _, _) = engine, current == token else { return nil }
        return session
    }

    func runningEngine(_ token: SolarCloudEngineToken) -> (any SolarCloudEngine)? {
        guard session(owning: token) != nil, case .running(_, let cloud, _) = engine else { return nil }
        return cloud
    }

    // MARK: - Local changes

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

    func recordChanged(_ scope: SolarForecastSiteScope, session origin: SolarCloudSession) async {
        guard owns(origin), scope.accountScopeID == origin.accountScopeID else { return }
        await reconcileLocalChanges(for: origin)
        guard owns(origin), let token = engine.token else { return }
        await sendChanges(token)
    }

    /// Accepts the store's durable unsynced markers into the persisted upload queue,
    /// then acknowledges them. A crash between the two steps only repeats an upload.
    private func reconcileLocalChanges(for session: SolarCloudSession) async {
        guard owns(session) else { return }
        let markers = await store.unsyncedMarkers(for: session)
        let unsynced = Set(markers.keys)
        guard owns(session), !unsynced.isEmpty else { return }
        let accepted = pendingScopes.union(unsynced)
        do { try files.savePendingScopes(accepted) } catch { return }
        pendingScopes = accepted
        if case .running(_, let cloud, _) = engine {
            cloud.addPendingSaves(unsynced.map { SolarLayoutCloudRecordSerializer.recordID(for: $0) })
        }
        await store.acknowledge(markers, for: session)
    }

    /// Detached: CKSyncEngine traps on engine calls made from inside its delegate callbacks.
    func sendChanges(_ token: SolarCloudEngineToken) async {
        guard let cloud = runningEngine(token) else { return }
        await Task.detached { try? await cloud.sendChanges() }.value
    }

    func fetchChanges(_ token: SolarCloudEngineToken) async {
        guard let cloud = runningEngine(token) else { return }
        await Task.detached { try? await cloud.fetchChanges() }.value
    }

    // MARK: - Outgoing records

    func nextRecordZoneChangeBatch(
        pending: [CKSyncEngine.PendingRecordZoneChange], token: SolarCloudEngineToken
    ) async -> CKSyncEngine.RecordZoneChangeBatch? {
        guard session(owning: token) != nil else { return nil }
        return await CKSyncEngine.RecordZoneChangeBatch(pendingChanges: pending) { [weak self] recordID in
            await self?.makeRecord(for: recordID, token: token)
        }
    }

    /// Checked before the store read and again after it, before reading system fields.
    /// Serialization is synchronous, so no third check is needed. A record already
    /// handed to CloudKit cannot be retracted by any later check.
    func makeRecord(for recordID: CKRecord.ID, token: SolarCloudEngineToken) async -> CKRecord? {
        guard let owner = session(owning: token) else { return nil }
        let parts = recordID.recordName.split(separator: ".", maxSplits: 1)
        guard parts.count == 2 else { return nil }
        let scope = SolarForecastSiteScope(accountScopeID: String(parts[0]), siteID: String(parts[1]))
        guard let local = try? await store.recordForUpload(scope: scope),
              session(owning: token) === owner else { return nil }
        return SolarLayoutCloudRecordSerializer.makeRecord(
            from: local, scope: scope, zoneID: recordID.zoneID, systemFieldsData: systemFields[recordID.recordName])
    }

    // MARK: - Metadata

    func saveSystemFields(for record: CKRecord) {
        systemFields[record.recordID.recordName] = SolarLayoutCloudRecordSystemFields.encode(record)
        try? files.saveSystemFields(systemFields)
    }

    /// The upload queue is kept until a save is confirmed, not cleared on state updates:
    /// a serialization can predate saves added after it. Re-adding an already pending
    /// save when the next engine starts is harmless.
    func saveState(_ serialization: CKSyncEngine.State.Serialization) {
        try? files.saveState(serialization)
    }
}
