import CloudKit
import Foundation

/// The CloudKit surface the lifecycle owner drives, so lifecycle tests can suspend
/// account lookup and fetches without an iCloud account.
protocol SolarCloudEngine: AnyObject, Sendable {
    func saveZoneIfNeeded(alreadySaved: Bool)
    func addPendingSaves(_ recordIDs: [CKRecord.ID])
    func fetchChanges() async throws
    func sendChanges() async throws
    /// CloudKit documents cancellation as asynchronous: operations already in flight,
    /// including submitted uploads, may still finish after this returns. Callers never
    /// treat it as transport quiescence; local tokens fence everything it may deliver.
    func cancelOperations() async
}

struct SolarCloudTransport: Sendable {
    var accountStatus: @Sendable () async throws -> CKAccountStatus
    var makeEngine: @Sendable (CKSyncEngine.State.Serialization?, any CKSyncEngineDelegate) -> any SolarCloudEngine

    /// Nil for an unsigned build, where CloudKit traps without entitlements.
    static func live(containerIdentifier: String, fileManager: FileManager = .default) -> SolarCloudTransport? {
        let signature = Bundle.main.bundleURL.appendingPathComponent("_CodeSignature").path
        guard fileManager.fileExists(atPath: signature) else { return nil }
        return SolarCloudTransport(
            accountStatus: { try await CKContainer(identifier: containerIdentifier).accountStatus() },
            makeEngine: { state, delegate in
                let configuration = CKSyncEngine.Configuration(
                    database: CKContainer(identifier: containerIdentifier).privateCloudDatabase,
                    stateSerialization: state,
                    delegate: delegate
                )
                return CloudKitSolarEngine(CKSyncEngine(configuration))
            }
        )
    }
}

private final class CloudKitSolarEngine: SolarCloudEngine {
    private let engine: CKSyncEngine

    init(_ engine: CKSyncEngine) {
        self.engine = engine
    }

    func saveZoneIfNeeded(alreadySaved: Bool) {
        let zoneID = SolarLayoutCloudRecordSerializer.zoneID
        let isPending = engine.state.pendingDatabaseChanges.contains { change in
            if case .saveZone(let zone) = change { return zone.zoneID == zoneID }
            return false
        }
        guard !alreadySaved, !isPending else { return }
        engine.state.add(pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: zoneID))])
    }

    func addPendingSaves(_ recordIDs: [CKRecord.ID]) {
        guard !recordIDs.isEmpty else { return }
        engine.state.add(pendingRecordZoneChanges: recordIDs.map { .saveRecord($0) })
    }

    func fetchChanges() async throws { try await engine.fetchChanges() }
    func sendChanges() async throws { try await engine.sendChanges() }
    func cancelOperations() async { await engine.cancelOperations() }
}

/// Carries the engine token of the attempt that created it, so every delegate event
/// and record request is checked against current ownership.
final class SolarCloudEngineDelegate: CKSyncEngineDelegate {
    private let owner: SolarLayoutCloudSync
    private let token: SolarCloudEngineToken

    init(owner: SolarLayoutCloudSync, token: SolarCloudEngineToken) {
        self.owner = owner
        self.token = token
    }

    func handleEvent(_ event: CKSyncEngine.Event, syncEngine: CKSyncEngine) async {
        await owner.handle(event, token: token)
    }

    func nextRecordZoneChangeBatch(
        _ context: CKSyncEngine.SendChangesContext, syncEngine: CKSyncEngine
    ) async -> CKSyncEngine.RecordZoneChangeBatch? {
        let pending = syncEngine.state.pendingRecordZoneChanges
        return await owner.nextRecordZoneChangeBatch(pending: pending, token: token)
    }
}
