import CloudKit
import Foundation

enum SolarLayoutCloudMerge {
    static func merge(local: SolarLayoutRecord?, remote: SolarLayoutRecord) -> SolarLayoutRecord {
        let winningLoc = winningLocation(local: local, remote: remote)
        let localCand = validateResult(candidate(for: local), for: winningLoc.location)
        let remoteCand = validateResult(candidate(for: remote), for: winningLoc.location)
        let validated = winningCandidate(local: localCand, remote: remoteCand)
        return SolarLayoutRecord(
            location: winningLoc.location,
            locationSetAt: winningLoc.locationSetAt,
            result: validated?.result,
            detectedAt: validated?.detectedAt,
            attemptedAt: validated?.attemptedAt,
            detectorVersion: validated?.detectorVersion,
            resultLocation: validated?.resultLocation
        )
    }

    private static func winningLocation(
        local: SolarLayoutRecord?, remote: SolarLayoutRecord
    ) -> (location: SolarHomeLocation?, locationSetAt: Date?) {
        let localLoc = local?.location?.rounded
        let localDate = local?.locationSetAt
        let remoteLoc = remote.location?.rounded
        let remoteDate = remote.locationSetAt

        guard let localLoc else { return (remoteLoc, remoteDate) }
        guard let remoteLoc else { return (localLoc, localDate) }

        if let remoteDate, let localDate {
            return remoteDate > localDate ? (remoteLoc, remoteDate) : (localLoc, localDate)
        }
        return remoteDate != nil ? (remoteLoc, remoteDate) : (localLoc, localDate)
    }

    private struct ResultCandidate {
        let result: DetectedSolarLayout
        let detectedAt: Date?
        let attemptedAt: Date?
        let detectorVersion: Int?
        let resultLocation: SolarHomeLocation?
    }

    private static func candidate(for record: SolarLayoutRecord?) -> ResultCandidate? {
        guard let record, let result = record.result else { return nil }
        return ResultCandidate(
            result: result,
            detectedAt: record.detectedAt,
            attemptedAt: record.attemptedAt,
            detectorVersion: record.detectorVersion,
            resultLocation: record.resultLocation?.rounded
        )
    }

    private static func validateResult(
        _ candidate: ResultCandidate?, for location: SolarHomeLocation?
    ) -> ResultCandidate? {
        guard let candidate,
              let location,
              solarLocationsShareCoordinates(candidate.resultLocation, location) else {
            return nil
        }
        return candidate
    }

    private static func winningCandidate(
        local: ResultCandidate?, remote: ResultCandidate?
    ) -> ResultCandidate? {
        guard let local else { return remote }
        guard let remote else { return local }

        let localV = local.detectorVersion ?? 0
        let remoteV = remote.detectorVersion ?? 0
        if remoteV > localV { return remote }
        if localV > remoteV { return local }

        if let rAttempt = remote.attemptedAt, let lAttempt = local.attemptedAt {
            return rAttempt > lAttempt ? remote : local
        }
        return remote.attemptedAt != nil ? remote : local
    }
}

protocol SolarLayoutSyncing: AnyObject, Sendable {
    func recordChanged(_ scope: SolarForecastSiteScope) async
}

enum SolarLayoutCloudRecordSerializer {
    static let zoneID = CKRecordZone.ID(zoneName: "SolarLayout", ownerName: CKCurrentUserDefaultName)
    static let recordType = "SolarLayoutRecord"

    static func recordID(for scope: SolarForecastSiteScope, zoneID: CKRecordZone.ID = zoneID) -> CKRecord.ID {
        CKRecord.ID(recordName: "\(scope.accountScopeID).\(scope.siteID)", zoneID: zoneID)
    }

    static func makeRecord(
        from layoutRecord: SolarLayoutRecord,
        scope: SolarForecastSiteScope,
        zoneID: CKRecordZone.ID = zoneID
    ) -> CKRecord {
        let recID = recordID(for: scope, zoneID: zoneID)
        let record = CKRecord(recordType: recordType, recordID: recID)
        record["accountScopeID"] = scope.accountScopeID as CKRecordValue
        record["siteID"] = scope.siteID as CKRecordValue

        applyLocation(layoutRecord.location?.rounded, to: record)
        record.encryptedValues["locationSetAt"] = layoutRecord.locationSetAt as CKRecordValue?

        record["result"] = layoutRecord.result.flatMap { (try? JSONEncoder().encode($0)) as CKRecordValue? }
        record["detectedAt"] = layoutRecord.detectedAt as CKRecordValue?
        record["attemptedAt"] = layoutRecord.attemptedAt as CKRecordValue?
        record["detectorVersion"] = layoutRecord.detectorVersion as CKRecordValue?
        applyResultLocation(layoutRecord.resultLocation?.rounded, to: record)

        return record
    }

    static func parseRecord(
        _ record: CKRecord
    ) -> (scope: SolarForecastSiteScope, record: SolarLayoutRecord)? {
        guard let scope = parseScope(record) else { return nil }
        let location = parseLocation(in: record)
        let locationSetAt = record.encryptedValues["locationSetAt"] as? Date

        let result = (record["result"] as? Data).flatMap {
            try? JSONDecoder().decode(DetectedSolarLayout.self, from: $0)
        }
        let detectedAt = record["detectedAt"] as? Date
        let attemptedAt = record["attemptedAt"] as? Date
        let detectorVersion = record["detectorVersion"] as? Int
        let resultLocation = parseLocation("result", in: record) ?? (result != nil ? location : nil)

        let layoutRecord = SolarLayoutRecord(
            location: location,
            locationSetAt: locationSetAt,
            result: result,
            detectedAt: detectedAt,
            attemptedAt: attemptedAt,
            detectorVersion: detectorVersion,
            resultLocation: resultLocation
        )
        return (scope, layoutRecord)
    }

    private static func applyLocation(_ location: SolarHomeLocation?, to record: CKRecord) {
        record.encryptedValues["latitude"] = location?.latitude as CKRecordValue?
        record.encryptedValues["longitude"] = location?.longitude as CKRecordValue?
        record.encryptedValues["source"] = location?.source.rawValue as CKRecordValue?
    }

    private static func applyResultLocation(_ location: SolarHomeLocation?, to record: CKRecord) {
        record.encryptedValues["resultLatitude"] = location?.latitude as CKRecordValue?
        record.encryptedValues["resultLongitude"] = location?.longitude as CKRecordValue?
        record.encryptedValues["resultSource"] = location?.source.rawValue as CKRecordValue?
    }

    private static func parseScope(_ record: CKRecord) -> SolarForecastSiteScope? {
        if let account = record["accountScopeID"] as? String,
           let site = record["siteID"] as? String,
           !account.isEmpty, !site.isEmpty {
            return SolarForecastSiteScope(accountScopeID: account, siteID: site)
        }
        let parts = record.recordID.recordName.split(separator: ".", maxSplits: 1)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        return SolarForecastSiteScope(accountScopeID: String(parts[0]), siteID: String(parts[1]))
    }

    private static func parseLocation(_ prefix: String = "", in record: CKRecord) -> SolarHomeLocation? {
        let latKey = prefix.isEmpty ? "latitude" : "\(prefix)Latitude"
        let lonKey = prefix.isEmpty ? "longitude" : "\(prefix)Longitude"
        let srcKey = prefix.isEmpty ? "source" : "\(prefix)Source"
        guard let lat = record.encryptedValues[latKey] as? Double,
              let lon = record.encryptedValues[lonKey] as? Double else { return nil }
        let srcStr = record.encryptedValues[srcKey] as? String
        let source = srcStr.flatMap(SolarLocationSource.init(rawValue:)) ?? .device
        let loc = SolarHomeLocation(latitude: lat, longitude: lon, source: source)
        return loc.isValid ? loc.rounded : nil
    }
}

actor SolarLayoutCloudSync: SolarLayoutSyncing {
    static let shared = SolarLayoutCloudSync()

    private let containerIdentifier: String
    private let store: SolarLayoutRecordStore
    private let fileManager: FileManager
    private let userDefaults: UserDefaults
    private let stateURL: URL
    private var container: CKContainer?
    private var database: CKDatabase?
    private var syncEngine: CKSyncEngine?
    private var isStarted = false
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
        stateURL: URL? = nil
    ) {
        self.containerIdentifier = containerIdentifier
        self.store = store
        self.fileManager = fileManager
        self.userDefaults = userDefaults
        self.stateURL = stateURL ?? {
            let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? fileManager.temporaryDirectory
            return appSupport.appendingPathComponent("SolarLayout", isDirectory: true)
                .appendingPathComponent("sync-engine-state.json")
        }()
    }

    func start() async {
        guard !isStarted else { return }
        await store.setSync(self)
        guard fileManager.fileExists(
            atPath: Bundle.main.bundleURL.appendingPathComponent("_CodeSignature").path
        ) else {
            return
        }
        do {
            let container = CKContainer(identifier: containerIdentifier)
            let status = try await container.accountStatus()
            guard status == .available else { return }
            self.container = container
            self.database = container.privateCloudDatabase
            isStarted = true
            let state = loadState()
            let delegate = SyncEngineDelegate(owner: self)
            let config = CKSyncEngine.Configuration(
                database: container.privateCloudDatabase,
                stateSerialization: state,
                delegate: delegate
            )
            let engine = CKSyncEngine(config)
            self.syncEngine = engine
            ensureZoneSaved(engine: engine)
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
        isStarted = false
        syncEngine = nil
        container = nil
        database = nil
        await store.setSync(nil)
        clearState()
    }

    func recordChanged(_ scope: SolarForecastSiteScope) async {
        guard isStarted, let syncEngine else { return }
        let recordID = SolarLayoutCloudRecordSerializer.recordID(for: scope)
        syncEngine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID)])
        do {
            try await syncEngine.sendChanges()
        } catch {
            // Stay local-only gracefully
        }
    }

    fileprivate func handleEvent(_ event: CKSyncEngine.Event, syncEngine: CKSyncEngine) async {
        switch event {
        case .stateUpdate(let update):
            saveState(update.stateSerialization)
        case .accountChange(let accountEvent):
            await handleAccountChange(accountEvent.changeType, syncEngine: syncEngine)
        case .fetchedRecordZoneChanges(let fetched):
            await handleFetchedChanges(fetched.modifications.map(\.record))
        case .sentDatabaseChanges(let sent):
            handleSentDatabaseChanges(sent)
        default:
            break
        }
    }

    private func handleSentDatabaseChanges(_ sent: CKSyncEngine.Event.SentDatabaseChanges) {
        if sent.savedZones.contains(where: { $0.zoneID == SolarLayoutCloudRecordSerializer.zoneID }) {
            hasSavedZone = true
        }
    }

    fileprivate func nextRecordZoneChangeBatch(
        _ context: CKSyncEngine.SendChangesContext, syncEngine: CKSyncEngine
    ) async -> CKSyncEngine.RecordZoneChangeBatch? {
        await CKSyncEngine.RecordZoneChangeBatch(
            pendingChanges: syncEngine.state.pendingRecordZoneChanges
        ) { [weak self, store] recordID async in
            guard let self else { return nil }
            return await self.makeRecordForEngine(recordID: recordID, store: store)
        }
    }

    private func makeRecordForEngine(recordID: CKRecord.ID, store: SolarLayoutRecordStore) async -> CKRecord? {
        let parts = recordID.recordName.split(separator: ".", maxSplits: 1)
        guard parts.count == 2 else { return nil }
        let scope = SolarForecastSiteScope(accountScopeID: String(parts[0]), siteID: String(parts[1]))
        guard let local = try? await store.record(scope: scope) else { return nil }
        return SolarLayoutCloudRecordSerializer.makeRecord(from: local, scope: scope, zoneID: recordID.zoneID)
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

    private func handleFetchedChanges(_ modifications: [CKRecord]) async {
        for record in modifications {
            guard let (scope, remoteRecord) = SolarLayoutCloudRecordSerializer.parseRecord(record) else { continue }
            _ = try? await store.applyRemoteRecord(remoteRecord, scope: scope)
            onRemoteRecordApplied?(scope)
        }
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

    private func clearState() {
        userDefaults.removeObject(forKey: "pwusage.solarLayoutZoneSaved")
        try? fileManager.removeItem(at: stateURL)
    }
}

private final class SyncEngineDelegate: CKSyncEngineDelegate, Sendable {
    private let owner: SolarLayoutCloudSync

    init(owner: SolarLayoutCloudSync) {
        self.owner = owner
    }

    func handleEvent(_ event: CKSyncEngine.Event, syncEngine: CKSyncEngine) async {
        await owner.handleEvent(event, syncEngine: syncEngine)
    }

    func nextRecordZoneChangeBatch(
        _ context: CKSyncEngine.SendChangesContext, syncEngine: CKSyncEngine
    ) async -> CKSyncEngine.RecordZoneChangeBatch? {
        await owner.nextRecordZoneChangeBatch(context, syncEngine: syncEngine)
    }
}
