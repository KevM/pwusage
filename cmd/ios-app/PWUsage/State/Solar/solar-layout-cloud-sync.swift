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
    private let store: SolarLayoutRecordStore
    private let transport: SolarCloudTransport?
    private let files: SolarCloudSyncFiles
    private var systemFields: [String: Data] = [:]
    private var pendingScopes: Set<SolarForecastSiteScope>
    private var phase: Phase = .inactive
    private var engine: Engine = .offline
    private var phaseWaiters: [CheckedContinuation<Void, Never>] = []
    private var onRemoteRecordApplied: (@Sendable (SolarForecastSiteScope, SolarCloudSession) -> Void)?

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
    private func releaseEngine(_ token: SolarCloudEngineToken) {
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
    private func session(owning token: SolarCloudEngineToken) -> SolarCloudSession? {
        guard case .active(let session) = phase, session.isValid,
              case .running(let current, _, _) = engine, current == token else { return nil }
        return session
    }

    private func runningEngine(_ token: SolarCloudEngineToken) -> (any SolarCloudEngine)? {
        guard session(owning: token) != nil, case .running(_, let cloud, _) = engine else { return nil }
        return cloud
    }

    // MARK: - Local changes

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

    private func sendChanges(_ token: SolarCloudEngineToken) async {
        guard let cloud = runningEngine(token) else { return }
        try? await cloud.sendChanges()
    }

    private func fetchChanges(_ token: SolarCloudEngineToken) async {
        guard let cloud = runningEngine(token) else { return }
        try? await cloud.fetchChanges()
    }

    // MARK: - Engine events

    func handle(_ event: CKSyncEngine.Event, token: SolarCloudEngineToken) async {
        guard session(owning: token) != nil else { return }
        switch event {
        case .stateUpdate(let update):
            saveState(update.stateSerialization)
        case .accountChange(let change):
            await handleAccountChange(change.changeType, token: token)
        case .fetchedRecordZoneChanges(let fetched):
            await applyFetchedRecords(fetched.modifications.map(\.record), token: token)
        case .sentDatabaseChanges(let sent):
            if sent.savedZones.contains(where: { $0.zoneID == SolarLayoutCloudRecordSerializer.zoneID }) {
                files.hasSavedZone = true
            }
        case .sentRecordZoneChanges(let sent):
            await handleSentRecords(sent, token: token)
        default:
            break
        }
    }

    private func handleAccountChange(
        _ type: CKSyncEngine.Event.AccountChange.ChangeType, token: SolarCloudEngineToken
    ) async {
        switch type {
        case .signOut, .switchAccounts:
            // Losing iCloud is not an app sign-out: keep the session and its offline work.
            releaseEngine(token)
        case .signIn:
            Task { await self.fetchChanges(token) }
        @unknown default:
            break
        }
    }

    /// Remote records apply only while `token` owns a running engine; the store
    /// revalidates the same token at its write boundary.
    func applyFetchedRecords(_ records: [CKRecord], token: SolarCloudEngineToken) async {
        for record in records {
            guard session(owning: token) != nil else { return }
            saveSystemFields(for: record)
            guard let (scope, remote) = SolarLayoutCloudRecordSerializer.parseRecord(record),
                  let outcome = try? await store.applyRemoteRecord(remote, scope: scope, from: self, engine: token)
            else { continue }
            guard let session = session(owning: token) else { return }
            outcome.appliedScopes.forEach { onRemoteRecordApplied?($0, session) }
        }
    }

    private func handleSentRecords(
        _ sent: CKSyncEngine.Event.SentRecordZoneChanges, token: SolarCloudEngineToken
    ) async {
        for record in sent.savedRecords {
            guard session(owning: token) != nil else { return }
            saveSystemFields(for: record)
            if let (scope, _) = SolarLayoutCloudRecordSerializer.parseRecord(record), pendingScopes.contains(scope) {
                pendingScopes.remove(scope)
                try? files.savePendingScopes(pendingScopes)
            }
        }
        var shouldResend = false
        for failure in sent.failedRecordSaves {
            let retried = await retryFailedSave(failure, token: token)
            shouldResend = shouldResend || retried
        }
        guard shouldResend, session(owning: token) != nil else { return }
        Task { await self.sendChanges(token) }
    }

    private func retryFailedSave(
        _ failure: CKSyncEngine.Event.SentRecordZoneChanges.FailedRecordSave, token: SolarCloudEngineToken
    ) async -> Bool {
        guard runningEngine(token) != nil else { return false }
        let error = failure.error
        if error.code == .zoneNotFound || error.code == .userDeletedZone {
            files.hasSavedZone = false
            runningEngine(token)?.saveZoneIfNeeded(alreadySaved: false)
        } else if error.code == .serverRecordChanged, let serverRecord = error.serverRecord {
            saveSystemFields(for: serverRecord)
            if let (scope, remote) = SolarLayoutCloudRecordSerializer.parseRecord(serverRecord),
               let outcome = try? await store.applyRemoteRecord(remote, scope: scope, from: self, engine: token),
               let session = session(owning: token) {
                outcome.appliedScopes.forEach { onRemoteRecordApplied?($0, session) }
            }
        } else {
            return false
        }
        guard let cloud = runningEngine(token) else { return false }
        cloud.addPendingSaves([failure.record.recordID])
        return true
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

    private func saveSystemFields(for record: CKRecord) {
        systemFields[record.recordID.recordName] = SolarLayoutCloudRecordSystemFields.encode(record)
        try? files.saveSystemFields(systemFields)
    }

    /// The upload queue is kept until a save is confirmed, not cleared on state updates:
    /// a serialization can predate saves added after it. Re-adding an already pending
    /// save when the next engine starts is harmless.
    private func saveState(_ serialization: CKSyncEngine.State.Serialization) {
        try? files.saveState(serialization)
    }
}
