import Foundation

/// An offline solar forecast for the demo home: two arrays, a week of winter
/// days shaped in the home's local time. Nothing is fetched, stored or
/// connected, so Settings and Smart Shift show a forecast without a key or a
/// location.
actor DemoForecastStore: SolarForecastManaging {
    private static let credentialID = "demo-credential"
    private static let resourceIDs = ["demo-east", "demo-west"]
    private let now: @Sendable () -> Date

    /// Follows the clock, so a long demo session never ages out of the
    /// six-hour freshness the recommendation requires.
    init(now: @escaping @Sendable () -> Date = Date.init) {
        self.now = now
    }

    /// The planning history's winter curve, half-hourly for a week from the half
    /// hour before now.
    private func intervals() -> [SolarForecastInterval] {
        let step: TimeInterval = 30 * 60
        let start = Date(timeIntervalSince1970: floor(now().timeIntervalSince1970 / step) * step - step)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = DemoFixtures.timeZone
        return (0 ..< 7 * 48).map { index in
            let periodStart = start.addingTimeInterval(TimeInterval(index) * step)
            return SolarForecastInterval(
                periodStart: periodStart, periodEnd: periodStart.addingTimeInterval(step),
                powerKw: DemoFixtures.solarKw(hour: calendar.component(.hour, from: periodStart))
            )
        }
    }

    func activateAccountScope(_ accountScopeID: String?) async {}

    func credential(accountScopeID: String, siteID: String) async -> SolarForecastCredential? {
        SolarForecastCredential(accountScopeID: accountScopeID, siteID: siteID,
                                credentialID: Self.credentialID, resourceIDs: Self.resourceIDs)
    }

    func connect(
        apiKey: String, accountScopeID: String, siteID: String, resourceIDs: [String]?
    ) async throws -> String {
        Self.credentialID
    }

    func discoverSites(accountScopeID: String, siteID: String, manual: Bool) async throws -> [SolcastSite] {
        [SolcastSite(resourceID: "demo-east", name: "East array", tags: []),
         SolcastSite(resourceID: "demo-west", name: "West array", tags: [])]
    }

    func selectArrays(_ resourceIDs: [String], accountScopeID: String, siteID: String) async throws {}

    func refresh(accountScopeID: String, siteID: String, manual: Bool) async -> SolarForecastRefreshResult {
        .refreshed
    }

    func cachedBatch(accountScopeID: String, siteID: String) async -> SolarForecastBatch? {
        SolarForecastBatch(credentialID: Self.credentialID, resourceIDs: Self.resourceIDs,
                           intervals: intervals(), fetchedAt: now().addingTimeInterval(-25 * 60))
    }

    func isRecommendationUsable(accountScopeID: String, siteID: String) async -> Bool { true }

    func budget(for accountScopeID: String, siteID: String) async -> SolarForecastBudget {
        SolarForecastBudget(utcDay: now(), totalAttempts: 2, automaticAttempts: 1, deferredUntil: nil)
    }

    func disconnect(accountScopeID: String, siteID: String) async throws {}
    func signOut() async throws {}
}
