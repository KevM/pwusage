import CryptoKit
import Foundation

struct SolarLayoutRecord: Codable, Equatable, Sendable {
    var location: SolarHomeLocation?
    var locationSetAt: Date?
    var result: DetectedSolarLayout?
    var detectedAt: Date?
    var attemptedAt: Date?
    var detectorVersion: Int?
    var resultLocation: SolarHomeLocation?

    func response(historyEnabled: Bool) -> MobileSolarLayoutResponse {
        guard historyEnabled else { return .disabled }
        guard let location else { return .enabled(location: nil, layout: nil, reason: .needsLocation) }
        guard let result, let detectedAt, detectorVersion == SolarLayoutDetector.version,
              solarLocationsShareCoordinates(resultLocation, location) else {
            return .enabled(location: location, layout: nil, reason: .pending)
        }
        switch result.status {
        case .notEnoughHistory:
            return .enabled(location: location, layout: nil, reason: .notEnoughHistory)
        case .lowConfidence:
            return .enabled(location: location, layout: nil, reason: .lowConfidence)
        case .failed:
            return .enabled(location: location, layout: nil, reason: .pending)
        case .detected:
            guard let layout = SolarLayoutDetector.forecastLayout(result, detectedAt: detectedAt) else {
                return .enabled(location: location, layout: nil, reason: .pending)
            }
            return .enabled(location: location, layout: layout, reason: nil)
        }
    }
}

actor SolarLayoutRecordStore {
    static let shared = SolarLayoutRecordStore()

    private let directory: URL
    private let fileManager: FileManager
    private let activeAccountScopeProvider: @Sendable () -> String?
    private var cache: [SolarForecastSiteScope: SolarLayoutRecord] = [:]
    private var sync: (any SolarLayoutSyncing)?

    init(
        fileManager: FileManager = .default,
        directory: URL? = nil,
        activeAccountScopeProvider: @escaping @Sendable () -> String? = {
            UserDefaults.standard.string(forKey: PWUsageAppModel.accountScopeDefaultsKey)
        }
    ) {
        self.fileManager = fileManager
        self.activeAccountScopeProvider = activeAccountScopeProvider
        self.directory = directory ?? (fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory).appendingPathComponent("SolarLayout", isDirectory: true)
    }

    func setSync(_ sync: (any SolarLayoutSyncing)?) {
        self.sync = sync
    }

    func record(scope: SolarForecastSiteScope) throws -> SolarLayoutRecord? {
        if let record = cache[scope] { return record }
        guard fileManager.fileExists(atPath: fileURL(scope).path) else { return nil }
        let record = try JSONDecoder().decode(SolarLayoutRecord.self, from: Data(contentsOf: fileURL(scope)))
        cache[scope] = record
        return record
    }

    func response(scope: SolarForecastSiteScope, historyEnabled: Bool) throws -> MobileSolarLayoutResponse {
        guard historyEnabled else { return .disabled }
        guard let record = try record(scope: scope) else {
            return .enabled(location: nil, layout: nil, reason: .needsLocation)
        }
        return record.response(historyEnabled: true)
    }

    func setLocation(_ location: SolarHomeLocation, scope: SolarForecastSiteScope, at date: Date = .now) throws {
        let rounded = Self.rounded(location)
        var value = try record(scope: scope) ?? SolarLayoutRecord(
            location: nil, locationSetAt: nil, result: nil, detectedAt: nil,
            attemptedAt: nil, detectorVersion: nil, resultLocation: nil)
        if !solarLocationsShareCoordinates(value.location, rounded) {
            value.result = nil
            value.detectedAt = nil
            value.attemptedAt = nil
            value.detectorVersion = nil
            value.resultLocation = nil
        }
        value.location = rounded
        value.locationSetAt = date
        try save(value, scope: scope)
        notifySync(scope)
    }

    @discardableResult
    func saveResult(
        _ result: DetectedSolarLayout, scope: SolarForecastSiteScope, for location: SolarHomeLocation, at date: Date
    ) throws -> Bool {
        guard var value = try record(scope: scope),
              solarLocationsShareCoordinates(value.location, Self.rounded(location)) else {
            return false
        }
        value.result = result
        value.detectedAt = date
        value.attemptedAt = date
        value.detectorVersion = SolarLayoutDetector.version
        value.resultLocation = value.location
        try save(value, scope: scope)
        notifySync(scope)
        return true
    }

    @discardableResult
    func saveFailure(
        scope: SolarForecastSiteScope, for location: SolarHomeLocation, at date: Date
    ) throws -> Bool {
        guard var value = try record(scope: scope),
              solarLocationsShareCoordinates(value.location, Self.rounded(location)) else {
            return false
        }
        let failed = DetectedSolarLayout(status: .failed, confidence: nil, reasons: [], planes: [], acClipKw: nil,
                                         historyDays: 0, clearDays: 0, firstDay: nil, lastDay: nil)
        value.result = failed
        value.detectedAt = date
        value.attemptedAt = date
        value.detectorVersion = SolarLayoutDetector.version
        value.resultLocation = value.location
        try save(value, scope: scope)
        notifySync(scope)
        return true
    }

    @discardableResult
    func applyRemoteRecord(_ remote: SolarLayoutRecord, scope: SolarForecastSiteScope) throws -> SolarLayoutRecord {
        let merged = try mergeAndSave(remote, scope: scope)
        applyToActiveScopeIfNeeded(remote, sourceScope: scope)
        return merged
    }

    @discardableResult
    private func mergeAndSave(_ remote: SolarLayoutRecord, scope: SolarForecastSiteScope) throws -> SolarLayoutRecord {
        let local = try record(scope: scope)
        let merged = SolarLayoutCloudMerge.merge(local: local, remote: remote)
        if merged != local {
            try save(merged, scope: scope)
        }
        return merged
    }

    private func applyToActiveScopeIfNeeded(_ remote: SolarLayoutRecord, sourceScope: SolarForecastSiteScope) {
        guard let activeAccount = activeAccountScopeProvider(),
              !activeAccount.isEmpty,
              activeAccount != sourceScope.accountScopeID else { return }
        let activeScope = SolarForecastSiteScope(accountScopeID: activeAccount, siteID: sourceScope.siteID)
        _ = try? mergeAndSave(remote, scope: activeScope)
    }

    private func notifySync(_ scope: SolarForecastSiteScope) {
        guard let sync else { return }
        Task { [sync] in
            await sync.recordChanged(scope)
        }
    }

    func remove(scope: SolarForecastSiteScope) throws {
        cache.removeValue(forKey: scope)
        try removeFile(fileURL(scope))
    }

    func removeAll() throws {
        cache.removeAll()
        guard fileManager.fileExists(atPath: directory.path) else { return }
        try fileManager.removeItem(at: directory)
    }

    private func save(_ record: SolarLayoutRecord, scope: SolarForecastSiteScope) throws {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        var directoryValues = URLResourceValues()
        directoryValues.isExcludedFromBackup = true
        var protectedDirectory = directory
        try protectedDirectory.setResourceValues(directoryValues)
        try fileManager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: directory.path)
        let url = fileURL(scope)
        try JSONEncoder().encode(record).write(to: url, options: [.atomic, .completeFileProtection])
        // Atomic replacement has committed. Keep memory aligned with disk even if
        // applying protection or backup metadata below fails.
        cache[scope] = record
        try fileManager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
        var fileValues = URLResourceValues()
        fileValues.isExcludedFromBackup = true
        var protectedFile = url
        try protectedFile.setResourceValues(fileValues)
    }

    private func removeFile(_ url: URL) throws {
        do { try fileManager.removeItem(at: url) } catch let error as CocoaError where error.code == .fileNoSuchFile {}
    }

    private func fileURL(_ scope: SolarForecastSiteScope) -> URL {
        let key = "\(scope.accountScopeID)|\(scope.siteID)"
        let hash = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("\(hash).json")
    }

    private static func rounded(_ location: SolarHomeLocation) -> SolarHomeLocation {
        location.rounded
    }
}
