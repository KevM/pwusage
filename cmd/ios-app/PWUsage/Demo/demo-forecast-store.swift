import Foundation

/// An offline solar forecast for the demo home: two arrays, a week of winter
/// days shaped in the home's local time. Nothing is fetched, stored or
/// connected, so Settings and Smart Shift show a forecast without a key or a
/// location.
actor DemoForecastStore: SolarForecastProviding {
    private static let descriptorValue = SolarForecastProviderDescriptor(
        id: .openMeteo,
        displayName: "Open-Meteo",
        attribution: "Automatic forecast from Open-Meteo.",
        requirement: .detectedLayout,
        providesCautiousPower: true,
        refreshThreshold: 1800,
        maximumUsableAge: 86400 * 7,
        modelVersion: "demo-v1",
        attributionURL: URL(string: "https://open-meteo.com")
    )

    nonisolated var descriptor: SolarForecastProviderDescriptor {
        Self.descriptorValue
    }

    /// Daily weather multipliers across the 7-day forecast horizon (Day 0 through Day 6).
    /// Models realistic weather progression: clear winter sun today, bright tomorrow, a low-solar
    /// cloudy system moving through on days 2-3, clearing on day 4, high sun on day 5, and steady on day 6.
    private static let dailyWeatherFactors: [Double] = [1.0, 1.25, 0.40, 0.20, 0.75, 1.30, 1.05]
    private let now: @Sendable () -> Date

    /// Follows the clock, so a long demo session never ages out of the
    /// six-hour freshness the recommendation requires.
    init(now: @escaping @Sendable () -> Date = Date.init) {
        self.now = now
    }

    /// The planning history's winter curve, half-hourly for a week from the half
    /// hour before now, shaped by day-to-day weather variation so the forecast is curvy.
    func intervals() -> [SolarForecastInterval] {
        let step: TimeInterval = 30 * 60
        let start = Date(timeIntervalSince1970: floor(now().timeIntervalSince1970 / step) * step - step)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = DemoFixtures.timeZone
        let startDay = calendar.startOfDay(for: start)
        return (0 ..< 7 * 48).map { index in
            let periodStart = start.addingTimeInterval(TimeInterval(index) * step)
            let periodDay = calendar.startOfDay(for: periodStart)
            let dayOffset = max(0, min(Self.dailyWeatherFactors.count - 1,
                                       calendar.dateComponents([.day], from: startDay, to: periodDay).day ?? 0))
            let weatherFactor = Self.dailyWeatherFactors[dayOffset]
            let baseKw = DemoFixtures.solarKw(hour: calendar.component(.hour, from: periodStart))
            return SolarForecastInterval(
                periodStart: periodStart, periodEnd: periodStart.addingTimeInterval(step),
                powerKw: (baseKw * weatherFactor * 10).rounded() / 10,
                cautiousPowerKw: (baseKw * weatherFactor * 0.7 * 10).rounded() / 10
            )
        }
    }

    func configuration(for request: SolarForecastRequest) async -> SolarForecastConfiguration {
        SolarForecastConfiguration(readiness: .ready, fingerprint: "demo-fingerprint", cacheRevision: "demo-revision")
    }

    func refresh(_ request: SolarForecastRequest) async -> SolarForecastProviderResult {
        let batch = rawBatch()
        return SolarForecastProviderResult(batch: batch, outcome: .refreshed)
    }

    func cachedForecast(for request: SolarForecastRequest) async -> SolarForecastRawBatch? {
        rawBatch()
    }

    private func rawBatch() -> SolarForecastRawBatch {
        SolarForecastRawBatch(
            providerID: .openMeteo,
            fingerprint: "demo-fingerprint",
            cacheRevision: "demo-revision",
            intervals: intervals(),
            fetchedAt: now().addingTimeInterval(-25 * 60),
            acClipKw: nil
        )
    }

    func activateAccountScope(_ accountScopeID: String?) async {}
    func clearAccountData() async throws {}
}
