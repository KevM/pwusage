import CloudKit
import Foundation

enum SolarLayoutCloudRecordSystemFields {
    static func encode(_ record: CKRecord) -> Data {
        let archiver = NSKeyedArchiver(requiringSecureCoding: true)
        record.encodeSystemFields(with: archiver)
        archiver.finishEncoding()
        return archiver.encodedData
    }

    static func decode(from data: Data) -> CKRecord? {
        guard let unarchiver = try? NSKeyedUnarchiver(forReadingFrom: data) else { return nil }
        unarchiver.requiresSecureCoding = true
        return CKRecord(coder: unarchiver)
    }
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
        zoneID: CKRecordZone.ID = zoneID,
        systemFieldsData: Data? = nil
    ) -> CKRecord {
        let recID = recordID(for: scope, zoneID: zoneID)
        let record: CKRecord
        if let systemFieldsData, let decoded = SolarLayoutCloudRecordSystemFields.decode(from: systemFieldsData) {
            record = decoded
        } else {
            record = CKRecord(recordType: recordType, recordID: recID)
        }
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
