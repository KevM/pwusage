import Foundation

/// The sites whose found layout nobody has seen yet, in one small file beside the layout records so
/// record enumeration sees only records. Excluded from backup. An unreadable file means nothing is
/// owed: only a celebration is lost.
struct SolarLayoutOwedReveals {
    private let fileManager: FileManager
    private let fileURL: URL
    private var cache: Set<SolarForecastSiteScope>?

    init(fileManager: FileManager, recordDirectory: URL) {
        self.fileManager = fileManager
        fileURL = recordDirectory.deletingLastPathComponent()
            .appendingPathComponent("\(recordDirectory.lastPathComponent)-reveals.json")
    }

    mutating func contains(_ scope: SolarForecastSiteScope) -> Bool {
        load().contains(scope)
    }

    mutating func insert(_ scope: SolarForecastSiteScope) throws {
        var owed = load()
        guard owed.insert(scope).inserted else { return }
        try save(owed)
    }

    mutating func remove(_ scope: SolarForecastSiteScope) throws {
        var owed = load()
        guard owed.remove(scope) != nil else { return }
        try save(owed)
    }

    mutating func removeAll() throws {
        cache = []
        do {
            try fileManager.removeItem(at: fileURL)
        } catch let error as CocoaError where error.code == .fileNoSuchFile {}
    }

    private mutating func load() -> Set<SolarForecastSiteScope> {
        if let cache { return cache }
        let loaded = (try? Data(contentsOf: fileURL))
            .flatMap { try? JSONDecoder().decode(Set<SolarForecastSiteScope>.self, from: $0) } ?? []
        cache = loaded
        return loaded
    }

    private mutating func save(_ owed: Set<SolarForecastSiteScope>) throws {
        cache = owed
        try fileManager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(owed).write(
            to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = fileURL
        try url.setResourceValues(values)
    }
}
