import Foundation
@testable import PWUsageCore

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
}
