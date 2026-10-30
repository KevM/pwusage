import Foundation

/// One JSON value on disk. Injected so tests run without the file system.
protocol SolarForecastFileStoring<Value>: Sendable {
    associatedtype Value: Codable & Sendable
    func load() async throws -> Value?
    func save(_ value: Value) async throws
}

/// Backup-excluded forecast metadata. Ordinary files require an unlocked device;
/// explicitly background-accessible files use a separate directory available after the
/// first unlock. Credentials and the Solcast store retain their existing protection.
actor ProtectedSolarForecastFile<Value: Codable & Sendable>: SolarForecastFileStoring {
    let fileURL: URL
    private let backgroundAccessible: Bool
    private let legacyFileURL: URL?

    init(name: String, backgroundAccessible: Bool = false, fileManager: FileManager = .default) {
        self.backgroundAccessible = backgroundAccessible
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        legacyFileURL = backgroundAccessible
            ? support.appendingPathComponent("SolarForecast", isDirectory: true).appendingPathComponent(name) : nil
        let directory = backgroundAccessible ? "SolarForecastBackground" : "SolarForecast"
        fileURL = support.appendingPathComponent(directory, isDirectory: true)
            .appendingPathComponent(name, isDirectory: false)
    }

    func load() throws -> Value? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        return try JSONDecoder().decode(Value.self, from: Data(contentsOf: fileURL))
    }

    func save(_ value: Value) throws {
        let manager = FileManager.default
        var directory = fileURL.deletingLastPathComponent()
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        var excluded = URLResourceValues()
        excluded.isExcludedFromBackup = true
        try directory.setResourceValues(excluded)
        let protection: FileProtectionType = backgroundAccessible ? .completeUntilFirstUserAuthentication : .complete
        try manager.setAttributes([.protectionKey: protection], ofItemAtPath: directory.path)
        let options: Data.WritingOptions = backgroundAccessible
            ? [.atomic, .completeFileProtectionUntilFirstUserAuthentication] : [.atomic, .completeFileProtection]
        try JSONEncoder().encode(value).write(to: fileURL, options: options)
        var file = fileURL
        try file.setResourceValues(excluded)
        // The new directory starts cold. Remove the old protected copy only after a
        // successful save, including sign-out's empty-state save, so private history
        // cannot remain orphaned by the storage policy change.
        if let legacyFileURL, manager.fileExists(atPath: legacyFileURL.path) {
            try manager.removeItem(at: legacyFileURL)
        }
    }
}
