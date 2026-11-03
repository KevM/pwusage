import CloudKit
import Foundation

extension SolarLayoutCloudSync {
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
            await applyFetchedDeletions(fetched.deletions, token: token)
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

    func handleAccountChange(
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

    func applyFetchedDeletions(
        _ deletions: [CKDatabase.RecordZoneChange.Deletion], token: SolarCloudEngineToken
    ) async {
        for deletion in deletions {
            guard session(owning: token) != nil else { return }
            systemFields.removeValue(forKey: deletion.recordID.recordName)
            try? files.saveSystemFields(systemFields)
            let parts = deletion.recordID.recordName.split(separator: ".", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let scope = SolarForecastSiteScope(accountScopeID: String(parts[0]), siteID: String(parts[1]))
            try? await store.remove(scope: scope)
            if let session = session(owning: token) {
                onRemoteRecordApplied?(scope, session)
            }
        }
    }

    func handleSentRecords(
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

    func retryFailedSave(
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
}
