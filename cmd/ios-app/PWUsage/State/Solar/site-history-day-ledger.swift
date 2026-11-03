import Foundation

/// The latest clear-day pass for one site: when it ran, what it counted, and the largest plane's
/// fitted direction range when a full detection ran with it.
struct SiteHistoryCheckpoint: Codable, Equatable, Sendable {
    let ranAt: Date
    let producingDays: Int
    let clearDays: Int
    /// `azimuthRange90` of the fit's largest plane; nil when the pass ran without a fit.
    var azimuthRange90: [Double]?
}

/// One site's day types from the latest clear-day pass, packed one character per site-local day
/// from `firstDay`: `c` clear, `o` cloudy, `n` no production, `-` not stored. The samples stay in
/// the history store; this holds only what the pass decided about them.
struct SiteHistoryDayLedger: Codable, Equatable, Sendable {
    private(set) var firstDay: String?
    private(set) var types: String
    var checkpoint: SiteHistoryCheckpoint?

    init(days: [String: SolarDayType]) {
        let sorted = days.keys.sorted()
        firstDay = sorted.first
        guard let first = sorted.first, let last = sorted.last,
              let span = SiteLocalDays.days(from: first, to: last, timeZone: .gmt) else {
            types = ""
            return
        }
        var characters = [Character](repeating: "-", count: span + 1)
        for (day, type) in days {
            guard let offset = SiteLocalDays.days(from: first, to: day, timeZone: .gmt) else { continue }
            characters[offset] = Self.character(type)
        }
        types = String(characters)
    }

    init(classification: SolarDayClassification) {
        self.init(days: classification.days)
    }

    /// Every stored day with its type, keyed by site-local day.
    var dayTypes: [String: SolarDayType] {
        guard let firstDay else { return [:] }
        var days: [String: SolarDayType] = [:]
        for (offset, character) in types.enumerated() {
            guard let type = Self.type(character),
                  let day = SiteLocalDays.adding(offset, to: firstDay, timeZone: .gmt) else { continue }
            days[day] = type
        }
        return days
    }

    var clearDays: Int { types.count { $0 == "c" } }
    var producingDays: Int { types.count { $0 == "c" || $0 == "o" } }

    private static func character(_ type: SolarDayType) -> Character {
        switch type {
        case .clear: "c"
        case .cloudy: "o"
        case .noProduction: "n"
        }
    }

    private static func type(_ character: Character) -> SolarDayType? {
        switch character {
        case "c": .clear
        case "o": .cloudy
        case "n": .noProduction
        default: nil
        }
    }
}

/// Day ledgers per account and site, in one small file beside the onboarding progress, with the
/// same backup exclusion and file protection.
actor SiteHistoryDayLedgerStore {
    static let shared = SiteHistoryDayLedgerStore()

    private let fileURL: URL
    private let fileManager: FileManager
    private var cache: [String: SiteHistoryDayLedger]?

    init(fileManager: FileManager = .default, directory customDirectory: URL? = nil) {
        self.fileManager = fileManager
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        let directory = customDirectory ?? support.appendingPathComponent("SiteHistoryOnboarding", isDirectory: true)
        fileURL = directory.appendingPathComponent("day-ledger.json")
    }

    func ledger(scope: SolarForecastSiteScope) throws -> SiteHistoryDayLedger? {
        try load()[Self.key(scope)]
    }

    func save(_ ledger: SiteHistoryDayLedger, scope: SolarForecastSiteScope) throws {
        try update { $0[Self.key(scope)] = ledger }
    }

    func remove(scope: SolarForecastSiteScope) throws {
        try update { $0.removeValue(forKey: Self.key(scope)) }
    }

    func removeAll() throws {
        cache = [:]
        if fileManager.fileExists(atPath: fileURL.path) { try fileManager.removeItem(at: fileURL) }
    }

    private static func key(_ scope: SolarForecastSiteScope) -> String {
        "\(scope.accountScopeID)|\(scope.siteID)"
    }

    private func load() throws -> [String: SiteHistoryDayLedger] {
        if let cache { return cache }
        guard fileManager.fileExists(atPath: fileURL.path) else { return [:] }
        let state = try JSONDecoder().decode([String: SiteHistoryDayLedger].self, from: Data(contentsOf: fileURL))
        cache = state
        return state
    }

    private func update(_ change: (inout [String: SiteHistoryDayLedger]) -> Void) throws {
        var state = try load()
        change(&state)
        let directory = fileURL.deletingLastPathComponent()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var excluded = directory
        try excluded.setResourceValues(values)
        try JSONEncoder().encode(state).write(
            to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        cache = state
    }
}
