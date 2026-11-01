import CloudKit
import Foundation

protocol SolarLayoutSyncing: AnyObject, Sendable {
    func recordChanged(_ scope: SolarForecastSiteScope) async
}

actor SolarLayoutCloudSync: SolarLayoutSyncing {
    static let shared = SolarLayoutCloudSync()

    private let containerIdentifier: String
    private let store: SolarLayoutRecordStore
    private let fileManager: FileManager
    private let userDefaults: UserDefaults
    private let stateURL: URL
    private let systemFieldsURL: URL
    private let pendingScopesURL: URL
    private var systemFields: [String: Data] = [:]
    private var pendingOfflineScopes: Set<SolarForecastSiteScope> = []
    private var container: CKContainer?
    private var database: CKDatabase?
    private var syncEngine: CKSyncEngine?
    private(set) var isStarted = false
    private var lifecycleGeneration = 0
    private var onRemoteRecordApplied: (@Sendable (SolarForecastSiteScope) -> Void)?

    private var hasSavedZone: Bool {
        get { userDefaults.bool(forKey: "pwusage.solarLayoutZoneSaved") }
        set { userDefaults.set(newValue, forKey: "pwusage.solarLayoutZoneSaved") }
    }

    init(
        containerIdentifier: String = "iCloud.fm.rodeo.pwusage",
        store: SolarLayoutRecordStore = .shared,
        fileManager: FileManager = .default,
        userDefaults: UserDefaults = .standard,
        stateURL: URL? = nil,
        systemFieldsURL: URL? = nil,
        pendingScopesURL: URL? = nil
    ) {
        self.containerIdentifier = containerIdentifier
        self.store = store
        self.fileManager = fileManager
        self.userDefaults = userDefaults
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        let baseDir = appSupport.appendingPathComponent("SolarLayout", isDirectory: true)
        self.stateURL = stateURL ?? baseDir.appendingPathComponent("sync-engine-state.json")
        self.systemFieldsURL = systemFieldsURL ?? baseDir.appendingPathComponent("system-fields.json")
        let scopesURL = pendingScopesURL ?? baseDir.appendingPathComponent("pending-scopes.json")
        self.pendingScopesURL = scopesURL
        self.pendingOfflineScopes = Self.loadPendingScopes(from: scopesURL, fileManager: fileManager)
    }

    func start() async {
        guard !isStarted else { return }
        lifecycleGeneration += 1
        let generation = lifecycleGeneration
        await store.setSync(self)
        guard generation == lifecycleGeneration else {
            await store.setSync(nil)
            return
        }
        guard fileManager.fileExists(
            atPath: Bundle.main.bundleURL.appendingPathComponent("_CodeSignature").path
        ) else {
            return
        }
        do {
            systemFields = loadSystemFields()
            let container = CKContainer(identifier: containerIdentifier)
            let status = try await container.accountStatus()
            guard generation == lifecycleGeneration else { return }
            guard status == .available else { return }
            self.container = container
            self.database = container.privateCloudDatabase
            isStarted = true
            let state = loadState()
            let delegate = SyncEngineDelegate(owner: self, generation: generation)
            let config = CKSyncEngine.Configuration(
                database: container.privateCloudDatabase,
                stateSerialization: state,
                delegate: delegate
            )
            let engine = CKSyncEngine(config)
            self.syncEngine = engine
            ensureZoneSaved(engine: engine)
            enqueuePendingOfflineScopes(engine: engine)
            guard generation == lifecycleGeneration else { return }
            try await engine.fetchChanges()
        } catch {
            // Stay local-only gracefully
        }
    }

    private func ensureZoneSaved(engine: CKSyncEngine) {
        let zoneID = SolarLayoutCloudRecordSerializer.zoneID
        let isPending = engine.state.pendingDatabaseChanges.contains { change in
            if case .saveZone(let zone) = change {
                return zone.zoneID == zoneID
            }
            return false
        }
        guard !hasSavedZone, !isPending else { return }
        let zone = CKRecordZone(zoneID: zoneID)
        engine.state.add(pendingDatabaseChanges: [.saveZone(zone)])
    }

    func setOnRemoteRecordApplied(_ handler: (@Sendable (SolarForecastSiteScope) -> Void)?) {
        onRemoteRecordApplied = handler
    }

    func stop() async {
        lifecycleGeneration += 1
        isStarted = false
        syncEngine = nil
        container = nil
        database = nil
        await store.setSync(nil)
        clearState()
    }

    func recordChanged(_ scope: SolarForecastSiteScope) async {
        guard isStarted, let syncEngine else {
            pendingOfflineScopes.insert(scope)
            persistPendingScopes()
            return
        }
        let recordID = SolarLayoutCloudRecordSerializer.recordID(for: scope)
        syncEngine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID)])
        do {
            try await syncEngine.sendChanges()
        } catch {
            // Stay local-only gracefully
        }
    }

    func isCurrentEngine(_ engine: CKSyncEngine, generation: Int) -> Bool {
        isStarted && lifecycleGeneration == generation && engine === syncEngine
    }

    fileprivate func handleEvent(
        _ event: CKSyncEngine.Event, syncEngine: CKSyncEngine, generation: Int
    ) async {
        guard isCurrentEngine(syncEngine, generation: generation) else { return }
        switch event {
        case .stateUpdate(let update):
            saveState(update.stateSerialization)
        case .accountChange(let accountEvent):
            await handleAccountChange(accountEvent.changeType, syncEngine: syncEngine)
        case .fetchedRecordZoneChanges(let fetched):
            await handleFetchedChanges(
                fetched.modifications.map(\.record), syncEngine: syncEngine, generation: generation
            )
        case .sentDatabaseChanges(let sent):
            handleSentDatabaseChanges(sent)
        case .sentRecordZoneChanges(let sent):
            await handleSentRecordZoneChanges(sent, syncEngine: syncEngine, generation: generation)
        default:
            break
        }
    }

    private func handleSentDatabaseChanges(_ sent: CKSyncEngine.Event.SentDatabaseChanges) {
        if sent.savedZones.contains(where: { $0.zoneID == SolarLayoutCloudRecordSerializer.zoneID }) {
            hasSavedZone = true
        }
    }

    private func handleSentRecordZoneChanges(
        _ sent: CKSyncEngine.Event.SentRecordZoneChanges,
        syncEngine: CKSyncEngine,
        generation: Int
    ) async {
        for record in sent.savedRecords {
            guard isCurrentEngine(syncEngine, generation: generation) else { return }
            saveSystemFields(for: record)
        }
        var shouldResend = false
        for failure in sent.failedRecordSaves {
            guard isCurrentEngine(syncEngine, generation: generation) else { return }
            guard let ckError = failure.error as? CKError,
                  ckError.code == .serverRecordChanged,
                  let serverRecord = ckError.serverRecord else { continue }
            saveSystemFields(for: serverRecord)
            if let (scope, remoteRecord) = SolarLayoutCloudRecordSerializer.parseRecord(serverRecord),
               let outcome = try? await store.applyRemoteRecord(remoteRecord, scope: scope) {
                guard isCurrentEngine(syncEngine, generation: generation) else { return }
                outcome.appliedScopes.forEach { onRemoteRecordApplied?($0) }
            }
            syncEngine.state.add(pendingRecordZoneChanges: [.saveRecord(failure.record.recordID)])
            shouldResend = true
        }
        guard isCurrentEngine(syncEngine, generation: generation) else { return }
        if shouldResend {
            Task.detached { [syncEngine] in
                do {
                    try await syncEngine.sendChanges()
                } catch {
                    // Stay local-only gracefully
                }
            }
        }
    }

    fileprivate func nextRecordZoneChangeBatch(
        _ context: CKSyncEngine.SendChangesContext, syncEngine: CKSyncEngine, generation: Int
    ) async -> CKSyncEngine.RecordZoneChangeBatch? {
        guard isCurrentEngine(syncEngine, generation: generation) else { return nil }
        return await CKSyncEngine.RecordZoneChangeBatch(
            pendingChanges: syncEngine.state.pendingRecordZoneChanges
        ) { [weak self, store] recordID async in
            guard let self, await self.isCurrentEngine(syncEngine, generation: generation) else { return nil }
            return await self.makeRecordForEngine(recordID: recordID, store: store)
        }
    }

    private func makeRecordForEngine(recordID: CKRecord.ID, store: SolarLayoutRecordStore) async -> CKRecord? {
        let parts = recordID.recordName.split(separator: ".", maxSplits: 1)
        guard parts.count == 2 else { return nil }
        let scope = SolarForecastSiteScope(accountScopeID: String(parts[0]), siteID: String(parts[1]))
        guard let local = try? await store.record(scope: scope) else { return nil }
        let fields = systemFields[recordID.recordName]
        return SolarLayoutCloudRecordSerializer.makeRecord(
            from: local,
            scope: scope,
            zoneID: recordID.zoneID,
            systemFieldsData: fields
        )
    }

    private func handleAccountChange(
        _ type: CKSyncEngine.Event.AccountChange.ChangeType, syncEngine: CKSyncEngine
    ) async {
        switch type {
        case .signOut, .switchAccounts:
            await stop()
        case .signIn:
            Task.detached { [syncEngine] in
                do {
                    try await syncEngine.fetchChanges()
                } catch {
                    // Stay local-only gracefully
                }
            }
        @unknown default:
            break
        }
    }

    private func handleFetchedChanges(
        _ modifications: [CKRecord], syncEngine: CKSyncEngine, generation: Int
    ) async {
        for record in modifications {
            guard isCurrentEngine(syncEngine, generation: generation) else { return }
            saveSystemFields(for: record)
            guard let (scope, remoteRecord) = SolarLayoutCloudRecordSerializer.parseRecord(record),
                  let outcome = try? await store.applyRemoteRecord(remoteRecord, scope: scope) else { continue }
            guard isCurrentEngine(syncEngine, generation: generation) else { return }
            outcome.appliedScopes.forEach { onRemoteRecordApplied?($0) }
        }
    }

    private func saveSystemFields(for record: CKRecord) {
        systemFields[record.recordID.recordName] = SolarLayoutCloudRecordSystemFields.encode(record)
        persistSystemFields()
    }

    private func persistSystemFields() {
        do {
            try fileManager.createDirectory(
                at: systemFieldsURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let data = try JSONEncoder().encode(systemFields)
            try data.write(to: systemFieldsURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            // Stay local-only gracefully
        }
    }

    private func loadSystemFields() -> [String: Data] {
        guard fileManager.fileExists(atPath: systemFieldsURL.path),
              let data = try? Data(contentsOf: systemFieldsURL),
              let decoded = try? JSONDecoder().decode([String: Data].self, from: data) else {
            return [:]
        }
        return decoded
    }

    private func saveState(_ serialization: CKSyncEngine.State.Serialization) {
        do {
            try fileManager.createDirectory(at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(serialization)
            try data.write(to: stateURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            // Stay local-only gracefully
        }
    }

    private func loadState() -> CKSyncEngine.State.Serialization? {
        guard fileManager.fileExists(atPath: stateURL.path) else { return nil }
        guard let data = try? Data(contentsOf: stateURL) else { return nil }
        return try? JSONDecoder().decode(CKSyncEngine.State.Serialization.self, from: data)
    }

    private func enqueuePendingOfflineScopes(engine: CKSyncEngine) {
        guard !pendingOfflineScopes.isEmpty else { return }
        let changes: [CKSyncEngine.PendingRecordZoneChange] = pendingOfflineScopes.map { scope in
            .saveRecord(SolarLayoutCloudRecordSerializer.recordID(for: scope))
        }
        engine.state.add(pendingRecordZoneChanges: changes)
        pendingOfflineScopes.removeAll()
        persistPendingScopes()
    }

    private func persistPendingScopes() {
        do {
            try fileManager.createDirectory(
                at: pendingScopesURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let data = try JSONEncoder().encode(Array(pendingOfflineScopes))
            try data.write(
                to: pendingScopesURL,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
        } catch {
            // Stay local-only gracefully
        }
    }

    private static func loadPendingScopes(from url: URL, fileManager: FileManager) -> Set<SolarForecastSiteScope> {
        guard fileManager.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([SolarForecastSiteScope].self, from: data) else {
            return []
        }
        return Set(decoded)
    }

    private func clearState() {
        userDefaults.removeObject(forKey: "pwusage.solarLayoutZoneSaved")
        systemFields.removeAll()
        pendingOfflineScopes.removeAll()
        try? fileManager.removeItem(at: stateURL)
        try? fileManager.removeItem(at: systemFieldsURL)
        try? fileManager.removeItem(at: pendingScopesURL)
    }
}

private final class SyncEngineDelegate: CKSyncEngineDelegate, Sendable {
    private let owner: SolarLayoutCloudSync
    private let generation: Int

    init(owner: SolarLayoutCloudSync, generation: Int) {
        self.owner = owner
        self.generation = generation
    }

    func handleEvent(_ event: CKSyncEngine.Event, syncEngine: CKSyncEngine) async {
        await owner.handleEvent(event, syncEngine: syncEngine, generation: generation)
    }

    func nextRecordZoneChangeBatch(
        _ context: CKSyncEngine.SendChangesContext, syncEngine: CKSyncEngine
    ) async -> CKSyncEngine.RecordZoneChangeBatch? {
        await owner.nextRecordZoneChangeBatch(context, syncEngine: syncEngine, generation: generation)
    }
}
