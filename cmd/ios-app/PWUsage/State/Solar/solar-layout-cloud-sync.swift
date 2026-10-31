import CloudKit
import Foundation

enum SolarLayoutCloudMerge {
    static func merge(local: SolarLayoutRecord?, remote: SolarLayoutRecord) -> SolarLayoutRecord {
        let location = winningLocation(local: local, remote: remote)
        let candidate = winningResultCandidate(local: local, remote: remote)
        let validated = validateResult(candidate, for: location.location)
        return SolarLayoutRecord(
            location: location.location,
            locationSetAt: location.locationSetAt,
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
            if remoteDate > localDate {
                return (remoteLoc, remoteDate)
            }
            return (localLoc, localDate)
        }
        if remoteDate != nil {
            return (remoteLoc, remoteDate)
        }
        return (localLoc, localDate)
    }

    private struct ResultCandidate {
        let result: DetectedSolarLayout?
        let detectedAt: Date?
        let attemptedAt: Date?
        let detectorVersion: Int?
        let resultLocation: SolarHomeLocation?
    }

    private static func winningResultCandidate(
        local: SolarLayoutRecord?, remote: SolarLayoutRecord
    ) -> ResultCandidate? {
        let localCand = local?.result.map {
            ResultCandidate(
                result: $0,
                detectedAt: local?.detectedAt,
                attemptedAt: local?.attemptedAt,
                detectorVersion: local?.detectorVersion,
                resultLocation: local?.resultLocation?.rounded
            )
        }
        let remoteCand = remote.result.map {
            ResultCandidate(
                result: $0,
                detectedAt: remote.detectedAt,
                attemptedAt: remote.attemptedAt,
                detectorVersion: remote.detectorVersion,
                resultLocation: remote.resultLocation?.rounded
            )
        }
        guard let localCand else { return remoteCand }
        guard let remoteCand else { return localCand }

        let localV = localCand.detectorVersion ?? 0
        let remoteV = remoteCand.detectorVersion ?? 0
        if remoteV > localV { return remoteCand }
        if localV > remoteV { return localCand }

        if let rAttempt = remoteCand.attemptedAt, let lAttempt = localCand.attemptedAt {
            if rAttempt > lAttempt { return remoteCand }
            return localCand
        }
        if remoteCand.attemptedAt != nil { return remoteCand }
        return localCand
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

        if let result = layoutRecord.result {
            record["result"] = (try? JSONEncoder().encode(result)) as CKRecordValue?
        } else {
            record["result"] = nil
        }
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
        let location = parseLocation(record)
        let locationSetAt = record.encryptedValues["locationSetAt"] as? Date

        let result: DetectedSolarLayout?
        if let resultData = record["result"] as? Data {
            result = try? JSONDecoder().decode(DetectedSolarLayout.self, from: resultData)
        } else {
            result = nil
        }
        let detectedAt = record["detectedAt"] as? Date
        let attemptedAt = record["attemptedAt"] as? Date
        let detectorVersion = record["detectorVersion"] as? Int
        let resultLocation = parseResultLocation(record) ?? (result != nil ? location : nil)

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
        if let location {
            record.encryptedValues["latitude"] = location.latitude as CKRecordValue
            record.encryptedValues["longitude"] = location.longitude as CKRecordValue
            record.encryptedValues["source"] = location.source.rawValue as CKRecordValue
        } else {
            record.encryptedValues["latitude"] = nil
            record.encryptedValues["longitude"] = nil
            record.encryptedValues["source"] = nil
        }
    }

    private static func applyResultLocation(_ location: SolarHomeLocation?, to record: CKRecord) {
        if let location {
            record.encryptedValues["resultLatitude"] = location.latitude as CKRecordValue
            record.encryptedValues["resultLongitude"] = location.longitude as CKRecordValue
            record.encryptedValues["resultSource"] = location.source.rawValue as CKRecordValue
        } else {
            record.encryptedValues["resultLatitude"] = nil
            record.encryptedValues["resultLongitude"] = nil
            record.encryptedValues["resultSource"] = nil
        }
    }

    private static func parseScope(_ record: CKRecord) -> SolarForecastSiteScope? {
        if let account = record["accountScopeID"] as? String,
           let site = record["siteID"] as? String,
           !account.isEmpty, !site.isEmpty {
            return SolarForecastSiteScope(accountScopeID: account, siteID: site)
        }
        let name = record.recordID.recordName
        let parts = name.split(separator: ".", maxSplits: 1)
        guard parts.count == 2 else { return nil }
        let account = String(parts[0])
        let site = String(parts[1])
        guard !account.isEmpty, !site.isEmpty else { return nil }
        return SolarForecastSiteScope(accountScopeID: account, siteID: site)
    }

    private static func parseLocation(_ record: CKRecord) -> SolarHomeLocation? {
        guard let lat = record.encryptedValues["latitude"] as? Double,
              let lon = record.encryptedValues["longitude"] as? Double else { return nil }
        let srcStr = record.encryptedValues["source"] as? String
        let source = srcStr.flatMap(SolarLocationSource.init(rawValue:)) ?? .device
        let loc = SolarHomeLocation(latitude: lat, longitude: lon, source: source)
        return loc.isValid ? loc.rounded : nil
    }

    private static func parseResultLocation(_ record: CKRecord) -> SolarHomeLocation? {
        guard let lat = record.encryptedValues["resultLatitude"] as? Double,
              let lon = record.encryptedValues["resultLongitude"] as? Double else { return nil }
        let srcStr = record.encryptedValues["resultSource"] as? String
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
    private let stateURL: URL
    private var container: CKContainer?
    private var database: CKDatabase?
    private var syncEngine: CKSyncEngine?
    private var isStarted = false

    init(
        containerIdentifier: String = "iCloud.fm.rodeo.pwusage",
        store: SolarLayoutRecordStore = .shared,
        fileManager: FileManager = .default,
        stateURL: URL? = nil
    ) {
        self.containerIdentifier = containerIdentifier
        self.store = store
        self.fileManager = fileManager
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
            let zone = CKRecordZone(zoneName: "SolarLayout")
            engine.state.add(pendingDatabaseChanges: [.saveZone(zone)])
            try await engine.fetchChanges()
        } catch {
            // Stay local-only gracefully
        }
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
        default:
            break
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
            do {
                try await syncEngine.fetchChanges()
            } catch {
                // Stay local-only gracefully
            }
        @unknown default:
            break
        }
    }

    private func handleFetchedChanges(_ modifications: [CKRecord]) async {
        for record in modifications {
            guard let (scope, remoteRecord) = SolarLayoutCloudRecordSerializer.parseRecord(record) else { continue }
            _ = try? await store.applyRemoteRecord(remoteRecord, scope: scope)
        }
    }

    private func saveState(_ serialization: CKSyncEngine.State.Serialization) {
        do {
            try fileManager.createDirectory(at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(serialization)
            try data.write(to: stateURL, options: [.atomic, .completeFileProtection])
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
