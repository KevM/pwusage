import Foundation

/// One site's deep-history walk. Separate from the onboarding progress, so loading older history
/// never touches what detection decided. `oldestChecked` is the cursor: every day in
/// `[oldestChecked, start)` came back `complete`.
struct SiteDeepHistoryProgress: Codable, Equatable, Sendable {
    enum Phase: Codable, Equatable, Sendable {
        case active
        case paused(SiteHistoryOnboarding.PauseReason)
        case finished(SiteHistoryOnboarding.FinishReason)
    }

    var oldestChecked: String
    /// The server's first possible day of data, once a fill has answered.
    var historyStart: String?
    var phase: Phase = .active
    /// Days returned by this walk's complete slices.
    var daysLoaded = 0
    var failures = 0
    var nextAttemptAt: Date?
    var waitReason: SiteHistoryOnboarding.WaitReason?
    /// The user pressed Stop: no run, foreground or background, until they continue.
    var userStopped = false

    /// Progress saved before a field existed still loads, with that field at its default.
    init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        oldestChecked = try values.decode(String.self, forKey: .oldestChecked)
        historyStart = try values.decodeIfPresent(String.self, forKey: .historyStart)
        phase = try values.decodeIfPresent(Phase.self, forKey: .phase) ?? .active
        daysLoaded = try values.decodeIfPresent(Int.self, forKey: .daysLoaded) ?? 0
        failures = try values.decodeIfPresent(Int.self, forKey: .failures) ?? 0
        nextAttemptAt = try values.decodeIfPresent(Date.self, forKey: .nextAttemptAt)
        waitReason = try values.decodeIfPresent(SiteHistoryOnboarding.WaitReason.self, forKey: .waitReason)
        userStopped = try values.decodeIfPresent(Bool.self, forKey: .userStopped) ?? false
    }

    init(oldestChecked: String, historyStart: String? = nil) {
        self.oldestChecked = oldestChecked
        self.historyStart = historyStart
    }
}

/// Deep-history progress per account and site, in one small file.
actor SiteDeepHistoryStore {
    static let shared = SiteDeepHistoryStore()

    private let fileURL: URL
    private let fileManager: FileManager
    private var cache: [String: SiteDeepHistoryProgress]?

    init(fileManager: FileManager = .default, directory customDirectory: URL? = nil) {
        self.fileManager = fileManager
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        let directory = customDirectory ?? support.appendingPathComponent("SiteDeepHistory", isDirectory: true)
        fileURL = directory.appendingPathComponent("deep-history.json")
    }

    func progress(scope: SolarForecastSiteScope) throws -> SiteDeepHistoryProgress? {
        try load()[Self.key(scope)]
    }

    /// Keeps the stored stop flag: a run's own copy must not undo a Stop pressed meanwhile.
    /// `userStopped` sets it instead (Stop and Continue).
    func save(
        _ progress: SiteDeepHistoryProgress, scope: SolarForecastSiteScope, userStopped: Bool? = nil
    ) throws {
        try update { state in
            var saved = progress
            saved.userStopped = userStopped ?? state[Self.key(scope)]?.userStopped ?? false
            state[Self.key(scope)] = saved
        }
    }

    /// Records that the user stopped a started walk. Nothing to stop without saved progress.
    func markStopped(scope: SolarForecastSiteScope) throws {
        try update { state in state[Self.key(scope)]?.userStopped = true }
    }

    /// Make a paused walk active again, keeping its cursor (after a reconnect, say).
    func resume(scope: SolarForecastSiteScope) throws {
        try update { state in
            guard var progress = state[Self.key(scope)], progress.phase != .active,
                  case .paused = progress.phase else { return }
            progress.phase = .active
            progress.failures = 0
            progress.nextAttemptAt = nil
            state[Self.key(scope)] = progress
        }
    }

    /// Make the account's walks paused for `reason` active again, keeping their cursors, whichever
    /// site is selected. Other pauses and finished walks are left alone.
    func resumePaused(accountScopeID: String, reason: SiteHistoryOnboarding.PauseReason) throws {
        let prefix = "\(accountScopeID)|"
        try update { state in
            for (key, var progress) in state where key.hasPrefix(prefix) && progress.phase == .paused(reason) {
                progress.phase = .active
                progress.failures = 0
                progress.nextAttemptAt = nil
                state[key] = progress
            }
        }
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

    private func load() throws -> [String: SiteDeepHistoryProgress] {
        if let cache { return cache }
        guard fileManager.fileExists(atPath: fileURL.path) else { return [:] }
        let state = try JSONDecoder().decode([String: SiteDeepHistoryProgress].self, from: Data(contentsOf: fileURL))
        cache = state
        return state
    }

    private func update(_ change: (inout [String: SiteDeepHistoryProgress]) -> Void) throws {
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
