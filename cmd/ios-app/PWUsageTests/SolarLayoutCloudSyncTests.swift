import CloudKit
import Foundation
@testable import PWUsage
import Testing

@Suite("Solar Layout Cloud Sync")
struct SolarLayoutCloudSyncTests {
    private let locA = SolarHomeLocation(latitude: 37.77, longitude: -122.41, source: .device)
    private let locB = SolarHomeLocation(latitude: 40.71, longitude: -74.00, source: .device)

    @Test("System fields encode and decode preserves record identity")
    func systemFieldsEncodeDecode() throws {
        let zoneID = SolarLayoutCloudRecordSerializer.zoneID
        let recID = CKRecord.ID(recordName: "test-acc.test-site", zoneID: zoneID)
        let record = CKRecord(recordType: SolarLayoutCloudRecordSerializer.recordType, recordID: recID)
        record["accountScopeID"] = "test-acc" as CKRecordValue

        let data = SolarLayoutCloudRecordSystemFields.encode(record)
        #expect(!data.isEmpty)

        let decoded = try #require(SolarLayoutCloudRecordSystemFields.decode(from: data))
        #expect(decoded.recordID == recID)
        #expect(decoded.recordType == SolarLayoutCloudRecordSerializer.recordType)
        // System fields do not encode app-level keys and values:
        #expect(decoded["accountScopeID"] == nil)
    }

    @Test("makeRecord with system fields preserves record identity while updating values")
    func makeRecordWithSystemFields() throws {
        let scope = SolarForecastSiteScope(accountScopeID: "acc-1", siteID: "site-1")
        let recID = SolarLayoutCloudRecordSerializer.recordID(for: scope)
        let baseRecord = CKRecord(recordType: SolarLayoutCloudRecordSerializer.recordType, recordID: recID)
        let systemData = SolarLayoutCloudRecordSystemFields.encode(baseRecord)

        let date = Date(timeIntervalSince1970: 1000)
        let layoutRecord = SolarLayoutRecord(
            location: locA,
            locationSetAt: date,
            result: nil,
            detectedAt: nil,
            attemptedAt: nil,
            detectorVersion: nil,
            resultLocation: nil
        )

        let populated = SolarLayoutCloudRecordSerializer.makeRecord(
            from: layoutRecord,
            scope: scope,
            systemFieldsData: systemData
        )
        #expect(populated.recordID == recID)
        #expect(populated.encryptedValues["latitude"] as? Double == 37.77)
        #expect(populated.encryptedValues["longitude"] as? Double == -122.41)
        #expect(populated["result"] == nil)

        let parsed = try #require(SolarLayoutCloudRecordSerializer.parseRecord(populated))
        #expect(parsed.scope == scope)
        #expect(parsed.record == layoutRecord)
    }

    @Test("Corrupted system fields fallback to fresh record")
    func corruptedSystemFieldsFallback() throws {
        let scope = SolarForecastSiteScope(accountScopeID: "acc-1", siteID: "site-1")
        let corruptedData = Data([0x00, 0x01, 0x02, 0x03])
        let layoutRecord = SolarLayoutRecord(location: locA)

        let record = SolarLayoutCloudRecordSerializer.makeRecord(
            from: layoutRecord,
            scope: scope,
            systemFieldsData: corruptedData
        )
        #expect(record.recordID == SolarLayoutCloudRecordSerializer.recordID(for: scope))
        let parsed = try #require(SolarLayoutCloudRecordSerializer.parseRecord(record))
        #expect(parsed.record.location == locA)
    }
}
