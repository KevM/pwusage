import CryptoKit
import Foundation
import PWUsageCore

struct SavedRatePlanTimeline: Codable, Equatable, Sendable {
    let timeline: SiteTariffsTimelineResponse
    let etag: String?
    let savedAt: Date
}

/// Saved rate plan timeline per account and site, stored in Application Support.
actor RatePlanTimelineStore {
    static let shared = RatePlanTimelineStore()

    private let directory: URL
    private let fileManager: FileManager
    private var cache: [SolarForecastSiteScope: SavedRatePlanTimeline] = [:]

    init(fileManager: FileManager = .default, directory: URL? = nil) {
        self.fileManager = fileManager
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        self.directory = directory ?? support.appendingPathComponent("RatePlanTimeline", isDirectory: true)
    }

    func saved(scope: SolarForecastSiteScope) throws -> SavedRatePlanTimeline? {
        if let entry = cache[scope] { return entry }
        let url = fileURL(scope)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let entry = try JSONDecoder().decode(SavedRatePlanTimeline.self, from: Data(contentsOf: url))
        cache[scope] = entry
        return entry
    }

    func save(
        _ timeline: SiteTariffsTimelineResponse,
        etag: String?,
        scope: SolarForecastSiteScope,
        savedAt: Date = .now
    ) throws {
        try ensureProtectedDirectory()
        let entry = SavedRatePlanTimeline(timeline: timeline, etag: etag, savedAt: savedAt)
        let url = fileURL(scope)
        try JSONEncoder().encode(entry).write(
            to: url,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
        cache[scope] = entry
        try applyProtectionAndBackupExclusion(to: url)
    }

    func remove(scope: SolarForecastSiteScope) throws {
        cache.removeValue(forKey: scope)
        do {
            try fileManager.removeItem(at: fileURL(scope))
        } catch let error as CocoaError where error.code == .fileNoSuchFile {}
    }

    func removeAll() throws {
        cache.removeAll()
        guard fileManager.fileExists(atPath: directory.path) else { return }
        try fileManager.removeItem(at: directory)
    }

    private func fileURL(_ scope: SolarForecastSiteScope) -> URL {
        let key = "\(scope.accountScopeID)|\(scope.siteID)"
        let hash = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("\(hash).json")
    }

    private func ensureProtectedDirectory() throws {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var protectedDirectory = directory
        try protectedDirectory.setResourceValues(values)
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: directory.path
        )
    }

    private func applyProtectionAndBackupExclusion(to url: URL) throws {
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var protectedFile = url
        try protectedFile.setResourceValues(values)
    }
}
