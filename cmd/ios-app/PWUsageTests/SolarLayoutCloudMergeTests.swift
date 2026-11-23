import CloudKit
import Foundation
import os
@testable import PWUsage
import PWUsageCore
import Testing

private final class MockSolarLayoutSync: SolarLayoutSyncing, Sendable {
    private let lock = OSAllocatedUnfairLock(initialState: [SolarForecastSiteScope]())

    var changedScopes: [SolarForecastSiteScope] {
        lock.withLock { $0 }
    }

    func recordChanged(_ scope: SolarForecastSiteScope, session: SolarCloudSession) async {
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
        await store.bind(SolarCloudSession(accountScopeID: "test-acc"), to: mockSync)

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
