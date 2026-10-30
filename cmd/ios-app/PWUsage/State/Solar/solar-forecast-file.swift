import Foundation

/// One JSON value on disk. Injected so tests run without the file system.
protocol SolarForecastFileStoring<Value>: Sendable {
    associatedtype Value: Codable & Sendable
    func load() async throws -> Value?
    func save(_ value: Value) async throws
}

/// A protected, backup-excluded JSON file in `Application Support/SolarForecast`, written the
/// same way as the Solcast store's state.
actor ProtectedSolarForecastFile<Value: Codable & Sendable>: SolarForecastFileStoring {
    let fileURL: URL

    init(name: String, fileManager: FileManager = .default) {
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        fileURL = support.appendingPathComponent("SolarForecast", isDirectory: true)
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
        try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: directory.path)
        try JSONEncoder().encode(value).write(to: fileURL, options: [.atomic, .completeFileProtection])
        var file = fileURL
        try file.setResourceValues(excluded)
    }
}
