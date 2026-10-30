import Foundation
@testable import PWUsage

enum SolarProviderFixture {
    static let chicago = TimeZone(identifier: "America/Chicago") ?? .gmt
    static let scopeA = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")
    static let scopeB = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-b")
    static let location = SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .device)
    static let detectedAt = Date(timeIntervalSince1970: 1_790_000_000)

    static func layout(
        planes: [SolarLayoutPlane] = [SolarLayoutPlane(azimuth: 90, tilt: 18, dcKwp: 5.6)],
        detectedAt: Date? = detectedAt
    ) -> SolarLayout {
        SolarLayout(planes: planes, acClipKw: nil, confidence: .high, detectedAt: detectedAt)
    }

    static func date(_ text: String, in zone: TimeZone = chicago) -> Date {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter.date(from: text) ?? .distantPast
    }

    static func request(
        scope: SolarForecastSiteScope = scopeA,
        now: Date,
        manual: Bool = false,
        layout: SolarLayout? = layout(),
        location: SolarHomeLocation? = location
    ) -> SolarForecastRequest {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = chicago
        let end = calendar.date(byAdding: .day, value: 2, to: calendar.startOfDay(for: now)) ?? now
        return SolarForecastRequest(
            scope: scope, siteTimeZone: chicago, window: DateInterval(start: now, end: end),
            manual: manual, layout: layout, location: location
        )
    }

    /// Hourly intervals of `powerKw` from `start` for `hours` hours.
    static func intervals(
        from start: Date,
        hours: Int,
        powerKw: Double,
        step: TimeInterval = 3600
    ) -> [SolarForecastInterval] {
        let count = Int(Double(hours) * 3600 / step)
        return (0 ..< count).map { index in
            let periodStart = start.addingTimeInterval(TimeInterval(index) * step)
            return SolarForecastInterval(
                periodStart: periodStart,
                periodEnd: periodStart.addingTimeInterval(step),
                powerKw: powerKw
            )
        }
    }

    /// A Forecast.Solar body for today and tomorrow at the site, relative to `now`.
    static func forecastSolarBody(now: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = chicago
        formatter.dateFormat = "yyyy-MM-dd"
        let today = formatter.string(from: now)
        let tomorrow = formatter.string(from: now.addingTimeInterval(86400))
        return ForecastSolarFixture.json(days: [.normal(today), .normal(tomorrow)])
    }
}

final class MutableSolarClock: SolarForecastClock, @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    init(_ now: Date) { current = now }
    func now() -> Date { lock.withLock { current } }
    func advance(by seconds: TimeInterval) { lock.withLock { current.addTimeInterval(seconds) } }
}

actor InMemorySolarFile<Value: Codable & Sendable>: SolarForecastFileStoring {
    private(set) var value: Value?
    private(set) var saves = 0
    private var failSaves = false

    init(_ value: Value? = nil) { self.value = value }

    func load() async throws -> Value? { value }

    func save(_ newValue: Value) async throws {
        if failSaves { throw CocoaError(.fileWriteNoPermission) }
        saves += 1
        value = newValue
    }

    func setFailingSaves(_ failing: Bool) { failSaves = failing }
}

/// A third provider that exists only here, registered through composition alone: half-hour
/// intervals, a three-day horizon and its own attribution and freshness.
actor SyntheticForecastProvider: SolarForecastProviding {
    static let id = SolarForecastProviderID(rawValue: "synthetic-weather")
    nonisolated let descriptor = SolarForecastProviderDescriptor(
        id: SyntheticForecastProvider.id, displayName: "Synthetic Weather",
        attribution: "Forecast by Synthetic Weather.",
        requirement: .detectedLayout, providesCautiousPower: true,
        refreshThreshold: 3600, maximumUsableAge: 7200, modelVersion: "synthetic-1"
    )
    private let clock: any SolarForecastClock
    private var cache: [SolarForecastSiteScope: SolarForecastRawBatch] = [:]
    private(set) var refreshes = 0

    init(clock: any SolarForecastClock) { self.clock = clock }

    func configuration(for request: SolarForecastRequest) async -> SolarForecastConfiguration {
        guard request.location != nil, request.layout != nil else {
            return SolarForecastConfiguration(readiness: .notConfigured, fingerprint: "", cacheRevision: "")
        }
        return SolarForecastConfiguration(readiness: .ready, fingerprint: "synthetic", cacheRevision: "synthetic")
    }

    func refresh(_ request: SolarForecastRequest) async -> SolarForecastProviderResult {
        refreshes += 1
        let start = request.window.start
        let intervals = SolarProviderFixture.intervals(from: start, hours: 72, powerKw: 2, step: 1800).map {
            SolarForecastInterval(
                periodStart: $0.periodStart,
                periodEnd: $0.periodEnd,
                powerKw: 2,
                cautiousPowerKw: 1.5
            )
        }
        let batch = SolarForecastRawBatch(
            providerID: Self.id, fingerprint: "synthetic", cacheRevision: "synthetic", intervals: intervals,
            fetchedAt: clock.now(), acClipKw: nil
        )
        cache[request.scope] = batch
        return SolarForecastProviderResult(batch: batch, outcome: .refreshed)
    }

    func cachedForecast(for request: SolarForecastRequest) async -> SolarForecastRawBatch? { cache[request.scope] }
    func activateAccountScope(_ accountScopeID: String?) async {}
    func clearAccountData() async throws { cache.removeAll() }
}

/// The Solcast store as the adapter sees it.
actor FakeSolcastStore: SolarForecastManaging {
    var credentialValue: SolarForecastCredential?
    var refreshResult: SolarForecastRefreshResult = .refreshed
    var batch: SolarForecastBatch?
    var usable = true
    private(set) var refreshCount = 0
    private(set) var activatedScopes: [String?] = []

    func configure(
        credential: SolarForecastCredential?,
        batch: SolarForecastBatch?,
        result: SolarForecastRefreshResult = .refreshed
    ) {
        credentialValue = credential
        self.batch = batch
        refreshResult = result
    }

    func setUsable(_ value: Bool) { usable = value }

    func activateAccountScope(_ accountScopeID: String?) async { activatedScopes.append(accountScopeID) }
    func credential(accountScopeID: String, siteID: String) async -> SolarForecastCredential? { credentialValue }
    func connect(
        apiKey: String,
        accountScopeID: String,
        siteID: String,
        resourceIDs: [String]?
    ) async throws -> String { "" }
    func discoverSites(accountScopeID: String, siteID: String, manual: Bool) async throws -> [SolcastSite] { [] }
    func selectArrays(_ resourceIDs: [String], accountScopeID: String, siteID: String) async throws {}
    func refresh(accountScopeID: String, siteID: String, manual: Bool) async -> SolarForecastRefreshResult {
        refreshCount += 1
        return refreshResult
    }

    func cachedBatch(accountScopeID: String, siteID: String) async -> SolarForecastBatch? { batch }
    func isRecommendationUsable(accountScopeID: String, siteID: String) async -> Bool { usable && batch != nil }
    func budget(for accountScopeID: String, siteID: String) async -> SolarForecastBudget {
        SolarForecastBudget(utcDay: .distantPast, totalAttempts: 0, automaticAttempts: 0, deferredUntil: nil)
    }

    func disconnect(accountScopeID: String, siteID: String) async throws {}
    func signOut() async throws {}
}
