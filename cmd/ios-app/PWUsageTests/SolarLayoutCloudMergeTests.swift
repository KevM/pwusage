import CloudKit
import Foundation
import os
@testable import PWUsage
import Testing

private final class MockSolarLayoutSync: SolarLayoutSyncing, Sendable {
    private let lock = OSAllocatedUnfairLock(initialState: [SolarForecastSiteScope]())

    var changedScopes: [SolarForecastSiteScope] {
        lock.withLock { $0 }
    }

    func recordChanged(_ scope: SolarForecastSiteScope) async {
        lock.withLock { $0.append(scope) }
    }

    func clear() {
        lock.withLock { $0.removeAll() }
    }
}

@Suite("Solar Layout Cloud Merge")
struct SolarLayoutCloudMergeTests {
    private let locA = SolarHomeLocation(latitude: 37.77, longitude: -122.41, source: .device)
    private let locB = SolarHomeLocation(latitude: 40.71, longitude: -74.00, source: .device)

    @Test("Nil local takes remote directly when result matches location")
    func nilLocalTakesRemote() {
        let date = Date(timeIntervalSince1970: 100)
        let remote = SolarLayoutRecord(
            location: locA,
            locationSetAt: date,
            result: makeResult(.detected),
            detectedAt: date,
            attemptedAt: date,
            detectorVersion: 1,
            resultLocation: locA
        )
        let merged = SolarLayoutCloudMerge.merge(local: nil, remote: remote)
        #expect(merged.location == locA)
        #expect(merged.locationSetAt == date)
        #expect(merged.result?.status == .detected)
        #expect(merged.detectorVersion == 1)
        #expect(merged.resultLocation == locA)
    }

    @Test("Nil local drops remote result when result location does not match")
    func nilLocalDropsMismatchedRemoteResult() {
        let date = Date(timeIntervalSince1970: 100)
        let remote = SolarLayoutRecord(
            location: locA,
            locationSetAt: date,
            result: makeResult(.detected),
            detectedAt: date,
            attemptedAt: date,
            detectorVersion: 1,
            resultLocation: locB
        )
        let merged = SolarLayoutCloudMerge.merge(local: nil, remote: remote)
        #expect(merged.location == locA)
        #expect(merged.locationSetAt == date)
        #expect(merged.result == nil)
        #expect(merged.resultLocation == nil)
    }

    @Test("Newer locationSetAt wins")
    func newerLocationSetAtWins() {
        let oldDate = Date(timeIntervalSince1970: 100)
        let newDate = Date(timeIntervalSince1970: 200)

        let localOld = SolarLayoutRecord(location: locA, locationSetAt: oldDate)
        let remoteNew = SolarLayoutRecord(location: locB, locationSetAt: newDate)
        let mergedRemoteWins = SolarLayoutCloudMerge.merge(local: localOld, remote: remoteNew)
        #expect(mergedRemoteWins.location == locB)
        #expect(mergedRemoteWins.locationSetAt == newDate)

        let localNew = SolarLayoutRecord(location: locA, locationSetAt: newDate)
        let remoteOld = SolarLayoutRecord(location: locB, locationSetAt: oldDate)
        let mergedLocalWins = SolarLayoutCloudMerge.merge(local: localNew, remote: remoteOld)
        #expect(mergedLocalWins.location == locA)
        #expect(mergedLocalWins.locationSetAt == newDate)
    }

    @Test("Remote result for old location is dropped")
    func remoteResultForOldLocationDropped() {
        let oldDate = Date(timeIntervalSince1970: 100)
        let newDate = Date(timeIntervalSince1970: 200)

        let localNew = SolarLayoutRecord(location: locB, locationSetAt: newDate)
        let remoteOld = SolarLayoutRecord(
            location: locA,
            locationSetAt: oldDate,
            result: makeResult(.detected),
            detectedAt: oldDate,
            attemptedAt: oldDate,
            detectorVersion: 1,
            resultLocation: locA
        )
        let merged = SolarLayoutCloudMerge.merge(local: localNew, remote: remoteOld)
        #expect(merged.location == locB)
        #expect(merged.result == nil)
        #expect(merged.resultLocation == nil)
    }

    @Test("Valid local result for winning location is retained over newer remote result for obsolete location")
    func validLocalResultRetainedOverNewerObsoleteRemoteResult() {
        let tOld = Date(timeIntervalSince1970: 50)
        let t100 = Date(timeIntervalSince1970: 100)
        let t110 = Date(timeIntervalSince1970: 110)

        let local = SolarLayoutRecord(
            location: locB,
            locationSetAt: t100,
            result: makeResult(.detected),
            detectedAt: t100,
            attemptedAt: t100,
            detectorVersion: 1,
            resultLocation: locB
        )
        let remote = SolarLayoutRecord(
            location: locA,
            locationSetAt: tOld,
            result: makeResult(.detected),
            detectedAt: t110,
            attemptedAt: t110,
            detectorVersion: 2,
            resultLocation: locA
        )
        let merged = SolarLayoutCloudMerge.merge(local: local, remote: remote)
        #expect(merged.location == locB)
        #expect(merged.locationSetAt == t100)
        #expect(merged.result?.status == .detected)
        #expect(merged.detectorVersion == 1)
        #expect(merged.attemptedAt == t100)
        #expect(merged.resultLocation == locB)
    }

    @Test("Local result kept if location unchanged")
    func localResultKeptIfLocationUnchanged() {
        let date1 = Date(timeIntervalSince1970: 100)
        let date2 = Date(timeIntervalSince1970: 200)

        let local = SolarLayoutRecord(
            location: locA,
            locationSetAt: date1,
            result: makeResult(.detected),
            detectedAt: date1,
            attemptedAt: date1,
            detectorVersion: 1,
            resultLocation: locA
        )
        let remote = SolarLayoutRecord(location: locA, locationSetAt: date2)
        let merged = SolarLayoutCloudMerge.merge(local: local, remote: remote)
        #expect(merged.location == locA)
        #expect(merged.result?.status == .detected)
        #expect(merged.resultLocation == locA)
    }

    @Test("Higher detectorVersion wins")
    func higherDetectorVersionWins() {
        let date1 = Date(timeIntervalSince1970: 100)
        let date2 = Date(timeIntervalSince1970: 200)

        let localV1 = SolarLayoutRecord(
            location: locA,
            locationSetAt: date1,
            result: makeResult(.detected),
            detectedAt: date2,
            attemptedAt: date2,
            detectorVersion: 1,
            resultLocation: locA
        )
        let remoteV2 = SolarLayoutRecord(
            location: locA,
            locationSetAt: date1,
            result: makeResult(.lowConfidence),
            detectedAt: date1,
            attemptedAt: date1,
            detectorVersion: 2,
            resultLocation: locA
        )
        let merged = SolarLayoutCloudMerge.merge(local: localV1, remote: remoteV2)
        #expect(merged.detectorVersion == 2)
        #expect(merged.result?.status == .lowConfidence)
    }

    @Test("Newer attemptedAt wins when detectorVersion is equal")
    func newerAttemptedAtWins() {
        let date1 = Date(timeIntervalSince1970: 100)
        let date2 = Date(timeIntervalSince1970: 200)

        let localOld = SolarLayoutRecord(
            location: locA,
            locationSetAt: date1,
            result: makeResult(.notEnoughHistory),
            detectedAt: date1,
            attemptedAt: date1,
            detectorVersion: 1,
            resultLocation: locA
        )
        let remoteNew = SolarLayoutRecord(
            location: locA,
            locationSetAt: date1,
            result: makeResult(.detected),
            detectedAt: date2,
            attemptedAt: date2,
            detectorVersion: 1,
            resultLocation: locA
        )
        let merged = SolarLayoutCloudMerge.merge(local: localOld, remote: remoteNew)
        #expect(merged.result?.status == .detected)
        #expect(merged.attemptedAt == date2)
    }

    @Test("Coordinate rounding verified")
    func coordinateRoundingVerified() {
        let unrounded = SolarHomeLocation(latitude: 37.12345, longitude: -122.56789, source: .device)
        let date = Date(timeIntervalSince1970: 100)
        let remote = SolarLayoutRecord(
            location: unrounded,
            locationSetAt: date,
            result: makeResult(.detected),
            detectedAt: date,
            attemptedAt: date,
            detectorVersion: 1,
            resultLocation: unrounded
        )
        let merged = SolarLayoutCloudMerge.merge(local: nil, remote: remote)
        #expect(merged.location?.latitude == 37.12)
        #expect(merged.location?.longitude == -122.57)
        #expect(merged.resultLocation?.latitude == 37.12)
        #expect(merged.resultLocation?.longitude == -122.57)
    }

    @Test("Record serialization and deserialization round trip")
    func recordSerializationRoundTrip() throws {
        let scope = SolarForecastSiteScope(accountScopeID: "acc-prod", siteID: "site-123")
        let date = Date(timeIntervalSince1970: 1000)
        let original = SolarLayoutRecord(
            location: locA,
            locationSetAt: date,
            result: makeResult(.detected),
            detectedAt: date,
            attemptedAt: date,
            detectorVersion: 1,
            resultLocation: locA
        )

        let record = SolarLayoutCloudRecordSerializer.makeRecord(from: original, scope: scope)
        #expect(record.recordID.recordName == "acc-prod.site-123")
        #expect(record["accountScopeID"] as? String == "acc-prod")
        #expect(record["siteID"] as? String == "site-123")
        #expect(record["detectedAt"] as? Date == date)
        #expect(record["attemptedAt"] as? Date == date)
        #expect(record["detectorVersion"] as? Int == 1)
        #expect(record.encryptedValues["latitude"] as? Double == 37.77)
        #expect(record.encryptedValues["longitude"] as? Double == -122.41)
        #expect(record.encryptedValues["source"] as? String == "device")
        #expect(record.encryptedValues["locationSetAt"] as? Date == date)

        let parsed = try #require(SolarLayoutCloudRecordSerializer.parseRecord(record))
        #expect(parsed.scope == scope)
        #expect(parsed.record == original)
    }

    @Test("Record serialization round trip preserves distinct location and resultLocation")
    func recordSerializationRoundTripWithDistinctLocations() throws {
        let scope = SolarForecastSiteScope(accountScopeID: "acc-prod", siteID: "site-123")
        let date = Date(timeIntervalSince1970: 1000)
        let original = SolarLayoutRecord(
            location: locA,
            locationSetAt: date,
            result: makeResult(.detected),
            detectedAt: date,
            attemptedAt: date,
            detectorVersion: 1,
            resultLocation: locB
        )

        let record = SolarLayoutCloudRecordSerializer.makeRecord(from: original, scope: scope)
        #expect(record.encryptedValues["resultLatitude"] as? Double == 40.71)
        #expect(record.encryptedValues["resultLongitude"] as? Double == -74.00)
        #expect(record.encryptedValues["resultSource"] as? String == "device")

        let parsed = try #require(SolarLayoutCloudRecordSerializer.parseRecord(record))
        #expect(parsed.scope == scope)
        #expect(parsed.record.location == locA)
        #expect(parsed.record.resultLocation == locB)
        #expect(parsed.record == original)
    }

    @Test("Scope routing handles plain fields and recordName fallback")
    func scopeRouting() throws {
        let zoneID = SolarLayoutCloudRecordSerializer.zoneID
        let withFields = CKRecord(
            recordType: SolarLayoutCloudRecordSerializer.recordType,
            recordID: CKRecord.ID(recordName: "fallbackAcc.fallbackSite", zoneID: zoneID)
        )
        withFields["accountScopeID"] = "fieldAcc" as CKRecordValue
        withFields["siteID"] = "fieldSite" as CKRecordValue
        let parsedWithFields = try #require(SolarLayoutCloudRecordSerializer.parseRecord(withFields))
        #expect(parsedWithFields.scope == SolarForecastSiteScope(accountScopeID: "fieldAcc", siteID: "fieldSite"))

        let withoutFields = CKRecord(
            recordType: SolarLayoutCloudRecordSerializer.recordType,
            recordID: CKRecord.ID(recordName: "fallbackAcc.fallbackSite", zoneID: zoneID)
        )
        let parsedFallback = try #require(SolarLayoutCloudRecordSerializer.parseRecord(withoutFields))
        #expect(parsedFallback.scope == SolarForecastSiteScope(accountScopeID: "fallbackAcc", siteID: "fallbackSite"))

        let invalid = CKRecord(
            recordType: SolarLayoutCloudRecordSerializer.recordType,
            recordID: CKRecord.ID(recordName: "noDotInName", zoneID: zoneID)
        )
        #expect(SolarLayoutCloudRecordSerializer.parseRecord(invalid) == nil)
    }

    @Test("Store notifies sync on local write and avoids echo loop on remote apply")
    @MainActor
    func storeSyncWiringAndEchoLoopPrevention() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = SolarLayoutRecordStore(directory: folder)
        let mockSync = MockSolarLayoutSync()
        await store.setSync(mockSync)

        let scope = SolarForecastSiteScope(accountScopeID: "test-acc", siteID: "test-site")
        try await store.setLocation(locA, scope: scope)
        try await eventually { mockSync.changedScopes == [scope] }

        mockSync.clear()
        let remote = SolarLayoutRecord(
            location: locA,
            locationSetAt: Date(timeIntervalSince1970: 500),
            result: makeResult(.detected),
            detectedAt: Date(timeIntervalSince1970: 500),
            attemptedAt: Date(timeIntervalSince1970: 500),
            detectorVersion: 1,
            resultLocation: locA
        )
        let outcome = try await store.applyRemoteRecord(remote, scope: scope)
        #expect(outcome.record.result?.status == .detected)
        #expect(outcome.appliedScopes == [scope])

        try await staysTrue { mockSync.changedScopes.isEmpty }
        #expect(try await store.record(scope: scope)?.result?.status == .detected)

        try await store.removeAll()
    }

    @Test("Store applies remote record to both source scope and active account scope if different")
    func storeAppliesRemoteRecordToActiveScope() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = SolarLayoutRecordStore(directory: folder) { "local-active-acc" }

        let remoteScope = SolarForecastSiteScope(accountScopeID: "remote-device-acc", siteID: "site-1")
        let activeScope = SolarForecastSiteScope(accountScopeID: "local-active-acc", siteID: "site-1")

        let remoteRecord = SolarLayoutRecord(
            location: locA,
            locationSetAt: Date(timeIntervalSince1970: 500),
            result: makeResult(.detected),
            detectedAt: Date(timeIntervalSince1970: 500),
            attemptedAt: Date(timeIntervalSince1970: 500),
            detectorVersion: 1,
            resultLocation: locA
        )

        let outcome = try await store.applyRemoteRecord(remoteRecord, scope: remoteScope)
        #expect(outcome.appliedScopes == [remoteScope, activeScope])

        let remoteSaved = try await store.record(scope: remoteScope)
        #expect(remoteSaved?.result?.status == .detected)

        let activeSaved = try await store.record(scope: activeScope)
        #expect(activeSaved?.result?.status == .detected)
        #expect(activeSaved?.location == locA)

        try await store.removeAll()
    }

    private func makeResult(_ status: DetectedSolarLayout.Status) -> DetectedSolarLayout {
        let plane = DetectedSolarLayout.Plane(
            azimuth: 180, tilt: 30, dcKwp: 5, effectiveKw: 4.25,
            azimuthRange90: [175, 185], tiltRange90: [25, 35]
        )
        return DetectedSolarLayout(
            status: status, confidence: status == .detected ? "high" : nil,
            reasons: [], planes: status == .detected ? [plane] : [], acClipKw: nil,
            historyDays: 90, clearDays: 30, firstDay: nil, lastDay: nil
        )
    }
}
