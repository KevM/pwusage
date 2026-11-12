import CryptoKit
import Foundation

extension SolarForecastSiteScope {
    /// A file-name-safe digest of the scope, for per-site storage.
    var storageHash: String {
        SHA256.hash(data: Data("\(accountScopeID)|\(siteID)".utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// Completed years of the health pass, one small JSON file per site and year. Derived data: it is
/// never synced, and losing it only costs a recompute. Horizons hold -infinity, so floats are
/// written as strings where they are not finite.
struct SolarHealthCache: Sendable {
    let directory: URL

    init(directory: URL? = nil, fileManager: FileManager = .default) {
        self.directory = directory ?? (fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory).appendingPathComponent("SolarHealth", isDirectory: true)
    }

    /// The cached year, nil when none exists or it cannot be read.
    func year(_ year: Int, scope: SolarForecastSiteScope) -> SolarHealthYear? {
        guard let data = try? Data(contentsOf: file(year, scope: scope)) else { return nil }
        let decoder = JSONDecoder()
        decoder.nonConformingFloatDecodingStrategy = Self.floatStrategyDecoding
        return try? decoder.decode(SolarHealthYear.self, from: data)
    }

    func store(_ year: SolarHealthYear, scope: SolarForecastSiteScope) throws {
        let folder = siteDirectory(scope)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.nonConformingFloatEncodingStrategy = Self.floatStrategyEncoding
        try encoder.encode(year).write(
            to: file(year.year, scope: scope), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func remove(scope: SolarForecastSiteScope) throws {
        let folder = siteDirectory(scope)
        if FileManager.default.fileExists(atPath: folder.path) { try FileManager.default.removeItem(at: folder) }
    }

    private func siteDirectory(_ scope: SolarForecastSiteScope) -> URL {
        directory.appendingPathComponent(scope.storageHash, isDirectory: true)
    }

    private func file(_ year: Int, scope: SolarForecastSiteScope) -> URL {
        siteDirectory(scope).appendingPathComponent("\(year).json")
    }

    private static let floatStrategyEncoding = JSONEncoder.NonConformingFloatEncodingStrategy.convertToString(
        positiveInfinity: "inf", negativeInfinity: "-inf", nan: "nan")
    private static let floatStrategyDecoding = JSONDecoder.NonConformingFloatDecodingStrategy.convertFromString(
        positiveInfinity: "inf", negativeInfinity: "-inf", nan: "nan")
}
