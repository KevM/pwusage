import CryptoKit
import Foundation

public struct SavedRatePlanTimeline: Codable, Equatable, Sendable {
    public let timeline: SiteTariffsTimelineResponse
    public let etag: String?
    let savedAt: Date
}

/// Saved rate plan timeline per account and site, stored in Application Support.
public actor RatePlanTimelineStore {
    public static let shared = RatePlanTimelineStore()

    private let directory: URL
    private let fileManager: FileManager
    private var cache: [SolarForecastSiteScope: SavedRatePlanTimeline] = [:]

    public init(fileManager: FileManager = .default, directory: URL? = nil) {
        self.fileManager = fileManager
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        self.directory = directory ?? support.appendingPathComponent("RatePlanTimeline", isDirectory: true)
    }

    public func saved(scope: SolarForecastSiteScope) throws -> SavedRatePlanTimeline? {
        if let entry = cache[scope] { return entry }
        let url = fileURL(scope)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let entry = try JSONDecoder().decode(SavedRatePlanTimeline.self, from: Data(contentsOf: url))
        cache[scope] = entry
        return entry
    }

    public func save(
        _ timeline: SiteTariffsTimelineResponse,
        etag: String?,
        scope: SolarForecastSiteScope,
        savedAt: Date = .now
    ) throws {
        try ensureProtectedDirectory()
        let entry = SavedRatePlanTimeline(timeline: timeline, etag: etag, savedAt: savedAt)
        let url = fileURL(scope)
        #if os(iOS)
            let writeOptions: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        #else
            let writeOptions: Data.WritingOptions = [.atomic]
        #endif
        try JSONEncoder().encode(entry).write(to: url, options: writeOptions)
        cache[scope] = entry
        try applyProtectionAndBackupExclusion(to: url)
    }

    func remove(scope: SolarForecastSiteScope) throws {
        cache.removeValue(forKey: scope)
        do {
            try fileManager.removeItem(at: fileURL(scope))
        } catch let error as CocoaError where error.code == .fileNoSuchFile {}
    }

    public func removeAll() throws {
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
        #if os(iOS)
            try fileManager.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: directory.path
            )
        #endif
    }

    private func applyProtectionAndBackupExclusion(to url: URL) throws {
        #if os(iOS)
            try fileManager.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: url.path
            )
        #endif
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var protectedFile = url
        try protectedFile.setResourceValues(values)
    }
}
