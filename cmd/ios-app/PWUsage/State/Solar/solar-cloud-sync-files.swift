import CloudKit
import Foundation

/// The synchronization metadata files. Account layout records live in the record store.
struct SolarCloudSyncFiles {
    private static let zoneSavedKey = "pwusage.solarLayoutZoneSaved"

    let fileManager: FileManager
    let userDefaults: UserDefaults
    let stateURL: URL
    let systemFieldsURL: URL
    let pendingScopesURL: URL

    var hasSavedZone: Bool {
        get { userDefaults.bool(forKey: Self.zoneSavedKey) }
        nonmutating set { userDefaults.set(newValue, forKey: Self.zoneSavedKey) }
    }

    func loadState() -> CKSyncEngine.State.Serialization? {
        decode(CKSyncEngine.State.Serialization.self, from: stateURL)
    }

    func saveState(_ serialization: CKSyncEngine.State.Serialization) throws {
        try write(serialization, to: stateURL)
    }

    func loadSystemFields() -> [String: Data] {
        decode([String: Data].self, from: systemFieldsURL) ?? [:]
    }

    func saveSystemFields(_ fields: [String: Data]) throws {
        try write(fields, to: systemFieldsURL)
    }

    func loadPendingScopes() -> Set<SolarForecastSiteScope> {
        Set(decode([SolarForecastSiteScope].self, from: pendingScopesURL) ?? [])
    }

    func savePendingScopes(_ scopes: Set<SolarForecastSiteScope>) throws {
        try write(Array(scopes), to: pendingScopesURL)
    }

    /// Every file is removed even if an earlier removal fails; the first error is reported.
    func removeAll() throws {
        userDefaults.removeObject(forKey: Self.zoneSavedKey)
        var firstError: (any Error)?
        for url in [stateURL, systemFieldsURL, pendingScopesURL] {
            do {
                try fileManager.removeItem(at: url)
            } catch let error as CocoaError where error.code == .fileNoSuchFile {
                continue
            } catch {
                firstError = firstError ?? error
            }
        }
        if let firstError { throw firstError }
    }

    private func decode<Value: Decodable>(_ type: Value.Type, from url: URL) -> Value? {
        guard fileManager.fileExists(atPath: url.path), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private func write(_ value: some Encodable, to url: URL) throws {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(value).write(
            to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
    }
}
