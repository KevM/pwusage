import Foundation

/// How fast the site's actual rate plans have risen per year, for projecting savings forward.
public struct RateGrowth: Equatable, Sendable {
    /// Compound yearly rise, from 0 to 10%.
    public let annualRate: Double
    public let isMeasured: Bool
    /// YYYY-MM-DD of the first covered day, when measured.
    public let measuredSince: String?

    /// The pace used when the timeline cannot measure a rise.
    public static let typical = RateGrowth(annualRate: 0.03, isMeasured: false, measuredSince: nil)

    public init(annualRate: Double, isMeasured: Bool, measuredSince: String?) {
        self.annualRate = annualRate
        self.isMeasured = isMeasured
        self.measuredSince = measuredSince
    }

    private static let minimumYears = 2.0
    private static let maximumAnnualRate = 0.10
    private static let windowDays = 365
    private static let sampleMinute = 30

    /// Compares the mean hourly buy rate of the last 365 days with the 365 days starting at the first
    /// strictly covered day on or after `firstDay`. Hours the actual timeline does not cover are skipped.
    /// Returns `.typical` when the windows are less than two years apart or either window has no known hours.
    static func measure(actual: RatePeriodResolver, firstDay: Date, now: Date) -> RateGrowth {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = actual.siteTimeZone
        let nowDay = calendar.startOfDay(for: now)
        guard let lastStart = calendar.date(byAdding: .day, value: 1 - windowDays, to: nowDay),
              let firstStart = firstCoveredDay(
                  actual: actual,
                  from: calendar.startOfDay(for: firstDay),
                  before: lastStart,
                  calendar: calendar
              ),
              let days = calendar.dateComponents([.day], from: firstStart, to: lastStart).day else {
            return .typical
        }
        let years = Double(days) / 365.25
        guard years >= minimumYears,
              let first = meanBuyRate(actual: actual, windowStart: firstStart, calendar: calendar),
              let last = meanBuyRate(actual: actual, windowStart: lastStart, calendar: calendar),
              first > 0 else {
            return .typical
        }
        let compound = pow(last / first, 1 / years) - 1
        return RateGrowth(
            annualRate: min(max(compound, 0), maximumAnnualRate),
            isMeasured: true,
            measuredSince: RatePlanCalendarDays.formatYMD(firstStart, in: actual.siteTimeZone)
        )
    }

    private static func firstCoveredDay(
        actual: RatePeriodResolver,
        from startDay: Date,
        before endDay: Date,
        calendar: Calendar
    ) -> Date? {
        var day = startDay
        if let earliest = actual.earliestEffectiveFrom,
           let parsed = RatePlanCalendarDays.parseYMD(earliest, in: calendar.timeZone) {
            day = max(day, calendar.startOfDay(for: parsed))
        }
        while day < endDay {
            if dayHasCoverage(actual: actual, day: day, calendar: calendar) {
                return day
            }
            guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { break }
            day = calendar.startOfDay(for: next)
        }
        return nil
    }

    private static func dayHasCoverage(actual: RatePeriodResolver, day: Date, calendar: Calendar) -> Bool {
        for hour in 0 ..< 24 {
            guard let instant = calendar.date(
                bySettingHour: hour, minute: sampleMinute, second: 0, of: day
            ) else { continue }
            if actual.matchedPeriod(at: instant, strict: true) != .unknown {
                return true
            }
        }
        return false
    }

    /// Mean buy rate over one sample per hour (at hh:30 site-local) across `windowDays` days, strict.
    /// Nil when no hour in the window is covered.
    private static func meanBuyRate(
        actual: RatePeriodResolver,
        windowStart: Date,
        calendar: Calendar
    ) -> Double? {
        var total = 0.0
        var count = 0
        for dayOffset in 0 ..< windowDays {
            guard let day = calendar.date(byAdding: .day, value: dayOffset, to: windowStart) else { continue }
            for hour in 0 ..< 24 {
                guard let instant = calendar.date(
                    bySettingHour: hour, minute: sampleMinute, second: 0, of: day
                ) else { continue }
                let matched = actual.matchedPeriod(at: instant, strict: true)
                guard matched != .unknown else { continue }
                total += matched.resolved.buyRate
                count += 1
            }
        }
        return count > 0 ? total / Double(count) : nil
    }
}
