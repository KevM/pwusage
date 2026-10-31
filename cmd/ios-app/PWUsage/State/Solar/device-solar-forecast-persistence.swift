import CryptoKit
import Foundation

extension SolarForecastStore: SolarForecastManaging {}

actor DeviceSolarForecastPersistence: SolarForecastPersistence {
    let fileURL: URL
    var cached: SolarForecastPersistedState?

    init(fileManager: FileManager = .default) {
        fileURL = Self.stateFileURL(fileManager: fileManager)
    }

    nonisolated static func hasPersistedState(fileManager: FileManager = .default) throws -> Bool {
        do {
            _ = try fileManager.attributesOfItem(atPath: stateFileURL(fileManager: fileManager).path)
            return true
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
            return false
        }
        // Other errors, including a locked sandbox, must not trigger credential deletion.
    }

    private nonisolated static func stateFileURL(fileManager: FileManager) -> URL {
        let directory = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("SolarForecast", isDirectory: true)
        return directory.appendingPathComponent("state.json", isDirectory: false)
    }

    func loadState() throws -> SolarForecastPersistedState {
        if let cached { return cached }
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return SolarForecastPersistedState() }
        let data = try Data(contentsOf: fileURL)
        let state = try JSONDecoder().decode(SolarForecastPersistedState.self, from: data)
        cached = state
        return state
    }

    func saveState(_ state: SolarForecastPersistedState) throws {
        let manager = FileManager.default
        try manager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        var directoryValues = URLResourceValues()
        directoryValues.isExcludedFromBackup = true
        var directory = fileURL.deletingLastPathComponent()
        try directory.setResourceValues(directoryValues)
        try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: directory.path)
        let data = try JSONEncoder().encode(state)
        try data.write(to: fileURL, options: .atomic)
        try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: fileURL.path)
        var fileValues = URLResourceValues()
        fileValues.isExcludedFromBackup = true
        var protectedFile = fileURL
        try protectedFile.setResourceValues(fileValues)
        cached = state
    }
}

@MainActor
struct SolarForecastStoreSessionCleanup: SolarForecastSessionCleanup {
    /// Held as the protocol so an injected store is actually used. Bypassing this
    /// would clear the real shared store during tests.
    let store: any SolarForecastManaging
    /// Clears automatic-provider caches and raw history. Provider request ledgers survive.
    var service: SolarForecastService?
    var historyStore: SolarHistoryStore = .shared
    var layoutRecordStore: SolarLayoutRecordStore = .shared
    var cloudSync: SolarLayoutCloudSync = .shared

    /// All cleanup steps run even if an earlier step fails.
    func signOut() async throws {
        var firstError: (any Error)?
        do { try await store.signOut() } catch { firstError = error }
        do { try await service?.clearAccountData() } catch { firstError = firstError ?? error }
        do { try await historyStore.removeAll() } catch { firstError = firstError ?? error }
        do { try await layoutRecordStore.removeAll() } catch { firstError = firstError ?? error }
        await cloudSync.stop()
        if let firstError { throw firstError }
    }
}
