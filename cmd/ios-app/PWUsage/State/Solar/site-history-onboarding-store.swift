import Foundation

/// One site's onboarding progress. The single cursor is `oldestChecked`: every day in
/// `[oldestChecked, checkedUntil)` was returned `complete` by a fill. There is no per-day ledger.
struct SiteHistoryOnboardingProgress: Codable, Equatable, Sendable {
    enum Phase: Codable, Equatable, Sendable {
        case active
        case paused(SiteHistoryOnboarding.PauseReason)
        case finished(SiteHistoryOnboarding.FinishReason)
    }

    /// Exclusive end of the checked range: the site-local day the job began.
    let checkedUntil: String
    var oldestChecked: String
    /// The server's first possible day of data, once a fill has answered.
    var historyStart: String?
    var phase: Phase = .active
    /// Checked days at the last readiness assessment; 0 before the first.
    var lastAssessedCheckedDays = 0
    var producingDays: Int?
    var lastOutlook: SolarLayoutHistoryOutlook?
    /// Checked days whose record held any solar reading (an empty, pre-provisioning day has none).
    var daysWithData = 0
    /// Consecutive slice attempts that did not complete.
    var failures = 0
    var nextAttemptAt: Date?
    var waitReason: SiteHistoryOnboarding.WaitReason?

    init(checkedUntil: String) {
        self.checkedUntil = checkedUntil
        oldestChecked = checkedUntil
    }

    func checkedDays(timeZone: TimeZone) -> Int {
        max(SiteLocalDays.days(from: oldestChecked, to: checkedUntil, timeZone: timeZone) ?? 0, 0)
    }
}

/// Onboarding progress per account and site, and the Tesla retry deadline per account, in one
/// small file. A throttle belongs to the account's Tesla grant, so it holds back every site of it.
actor SiteHistoryOnboardingStore {
    static let shared = SiteHistoryOnboardingStore()

    private struct Persisted: Codable {
        var sites: [String: SiteHistoryOnboardingProgress] = [:]
        var throttles: [String: Date] = [:]
    }

    private let fileURL: URL
    private let fileManager: FileManager
    private var cache: Persisted?

    init(fileManager: FileManager = .default, directory customDirectory: URL? = nil) {
        self.fileManager = fileManager
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        let directory = customDirectory ?? support.appendingPathComponent("SiteHistoryOnboarding", isDirectory: true)
        fileURL = directory.appendingPathComponent("progress.json")
    }

    func progress(scope: SolarForecastSiteScope) throws -> SiteHistoryOnboardingProgress? {
        try load().sites[Self.key(scope)]
    }

    func save(_ progress: SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope) throws {
        try update { $0.sites[Self.key(scope)] = progress }
    }

    /// Make a paused or finished site active again, keeping its cursor (after a reconnect, say).
    func resume(scope: SolarForecastSiteScope) throws {
        try update { state in
            guard var progress = state.sites[Self.key(scope)] else { return }
            progress.phase = .active
            progress.failures = 0
            progress.nextAttemptAt = nil
            state.sites[Self.key(scope)] = progress
        }
    }

    /// Make the account's sites paused for `reason` active again, keeping their cursors. Other
    /// pauses and finished sites are left alone.
    func resumePaused(accountScopeID: String, reason: SiteHistoryOnboarding.PauseReason) throws {
        let prefix = "\(accountScopeID)|"
        try update { state in
            for (key, var progress) in state.sites where key.hasPrefix(prefix) && progress.phase == .paused(reason) {
                progress.phase = .active
                progress.failures = 0
                progress.nextAttemptAt = nil
                state.sites[key] = progress
            }
        }
    }

    func throttle(accountScopeID: String) throws -> Date? {
        try load().throttles[accountScopeID]
    }

    /// Keeps the later deadline when one is already stored.
    func setThrottle(_ retryAt: Date, accountScopeID: String) throws {
        try update { state in
            state.throttles[accountScopeID] = max(state.throttles[accountScopeID] ?? retryAt, retryAt)
        }
    }

    func remove(scope: SolarForecastSiteScope) throws {
        try update { $0.sites.removeValue(forKey: Self.key(scope)) }
    }

    func removeAccount(_ accountScopeID: String) throws {
        let prefix = "\(accountScopeID)|"
        try update { state in
            state.sites = state.sites.filter { !$0.key.hasPrefix(prefix) }
            state.throttles.removeValue(forKey: accountScopeID)
        }
    }

    func removeAll() throws {
        cache = Persisted()
        if fileManager.fileExists(atPath: fileURL.path) { try fileManager.removeItem(at: fileURL) }
    }

    private static func key(_ scope: SolarForecastSiteScope) -> String {
        "\(scope.accountScopeID)|\(scope.siteID)"
    }

    private func load() throws -> Persisted {
        if let cache { return cache }
        guard fileManager.fileExists(atPath: fileURL.path) else { return Persisted() }
        let state = try JSONDecoder().decode(Persisted.self, from: Data(contentsOf: fileURL))
        cache = state
        return state
    }

    private func update(_ change: (inout Persisted) -> Void) throws {
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
