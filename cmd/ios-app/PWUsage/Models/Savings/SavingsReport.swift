import Foundation

/// Where each component's savings clock starts: a site-local midnight, or nil when unknown.
struct ComponentStarts: Equatable, Sendable {
    let solar: Date?
    let powerwall: Date?

    /// Builds starts from owner-entered YYYY-MM-DD days. A nil or unparseable day stays nil.
    static func make(solarDay: String?, powerwallDay: String?, timeZone: TimeZone) -> ComponentStarts {
        ComponentStarts(
            solar: solarDay.flatMap { siteMidnight($0, in: timeZone) },
            powerwall: powerwallDay.flatMap { siteMidnight($0, in: timeZone) }
        )
    }

    private static func siteMidnight(_ ymd: String, in timeZone: TimeZone) -> Date? {
        guard let noon = RatePlanTimelineFormatting.parseYMD(ymd, in: timeZone) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.startOfDay(for: noon)
    }
}

/// One billing cycle's savings, with the days it could count.
struct CycleSavings: Equatable, Sendable {
    let start: Date
    let end: Date
    let costs: ScenarioCosts
    let daysWithData: Int
    let daysInCycle: Int
}

struct SavingsReport: Equatable, Sendable {
    let cycle: SavingsFigures
    let year: SavingsFigures
    let lifetime: SavingsFigures
    let cycleStart: Date
    /// Savings from the solar install cycle onward. Without an install date, from the first stored day.
    let solarSinceInstall: SavingsFigures
    /// Savings from the Powerwall install cycle onward. Nil when there is no Powerwall start.
    let powerwallSinceInstall: SavingsFigures?
    /// Every priced billing cycle since the first stored day, oldest first. Payback reads history from it.
    let cycles: [CycleSavings]
    /// The last 12 billing cycles, oldest first. These are the same cycles `year` sums.
    let recentCycles: [CycleSavings]
    /// The YYYY-MM-DD day the scenarios used as the Powerwall start, after any owner override.
    let batteryStartDay: String?
    /// The yearly rise in the actual rate plans, used to project savings forward.
    let rateGrowth: RateGrowth
    /// The first day stored on the phone; lifetime and payback count from here.
    var firstStoredDay: Date?
}
