#if canImport(FoundationEssentials)
    import FoundationEssentials
#else
    import Foundation
#endif

public struct ResolvedRatePeriod: Equatable, Sendable {
    public let planName: String
    public let periodName: String
    public let buyRate: Double
    public let sellRate: Double

    public init(planName: String, periodName: String, buyRate: Double, sellRate: Double) {
        self.planName = planName
        self.periodName = periodName
        self.buyRate = buyRate
        self.sellRate = sellRate
    }

    public static let unknown = ResolvedRatePeriod(
        planName: "Unknown",
        periodName: "Unknown",
        buyRate: 0,
        sellRate: 0
    )
}

/// A slot resolved from the plan that matched it: the bucket identity, and whether that plan is an estimate.
public struct MatchedRatePeriod: Equatable, Sendable {
    public let resolved: ResolvedRatePeriod
    public let isEstimated: Bool

    public init(resolved: ResolvedRatePeriod, isEstimated: Bool) {
        self.resolved = resolved
        self.isEstimated = isEstimated
    }

    public static let unknown = MatchedRatePeriod(resolved: .unknown, isEstimated: false)
}

public struct RatePeriodResolver: Sendable {
    public struct ScheduleMatch: Equatable, Sendable {
        public let period: TariffPeriodDTO
        public let season: TariffSeasonInput
        public let window: TimePeriodWindowInput
        public let seasonIndex: Int
        public let isWeekend: Bool
        public let windowIndex: Int

        public var windowIdentity: WindowIdentity {
            WindowIdentity(
                periodId: period.periodId,
                seasonIndex: seasonIndex,
                isWeekend: isWeekend,
                windowIndex: windowIndex
            )
        }
    }

    public struct WindowIdentity: Hashable, Sendable {
        public let periodId: Int
        public let seasonIndex: Int
        public let isWeekend: Bool
        public let windowIndex: Int
    }

    private let periods: [TariffPeriodDTO]
    private let holidayDates: Set<String>
    private let calendar: Calendar

    public var earliestEffectiveFrom: String? { periods.map(\.effectiveFrom).min() }

    public var siteTimeZone: TimeZone {
        calendar.timeZone
    }

    public init?(timeline: SiteTariffsTimelineResponse) {
        self.init(
            periods: timeline.periods,
            timezone: timeline.timezone,
            holidayDates: timeline.holidayDates
        )
    }

    public init?(referenceOf timeline: SiteTariffsTimelineResponse) {
        guard !timeline.referencePeriods.isEmpty else { return nil }
        self.init(
            periods: timeline.referencePeriods,
            timezone: timeline.timezone,
            holidayDates: timeline.holidayDates
        )
    }

    private init?(periods: [TariffPeriodDTO], timezone: String, holidayDates: [String]?) {
        guard let timeZone = TimeZone(identifier: timezone) else { return nil }
        self.periods = periods
        self.holidayDates = Set(holidayDates ?? [])
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        self.calendar = calendar
    }

    public func period(at instant: Date, strict: Bool = false) -> ResolvedRatePeriod {
        matchedPeriod(at: instant, strict: strict).resolved
    }

    /// Resolves `instant` like `period(at:strict:)` and also reports whether the matched plan is an estimate,
    /// from the same schedule match, so callers need no second lookup.
    public func matchedPeriod(at instant: Date, strict: Bool = false) -> MatchedRatePeriod {
        guard let match = scheduleMatch(at: instant, strict: strict) else { return .unknown }
        let planName = match.period.name.isEmpty ? "Unknown" : match.period.name
        return MatchedRatePeriod(
            resolved: ResolvedRatePeriod(
                planName: planName,
                periodName: match.window.touName.rawValue,
                buyRate: match.window.buyRate,
                sellRate: match.window.sellRate
            ),
            isEstimated: match.period.source == .estimated
        )
    }

    public func match(at instant: Date) -> ActiveTariffPeriodMatch? {
        guard let found = scheduleMatch(at: instant) else { return nil }
        return ActiveTariffPeriodMatch(period: found.period, season: found.season, window: found.window)
    }

    public func scheduleMatch(at instant: Date, strict: Bool = false) -> ScheduleMatch? {
        let comps = calendar.dateComponents([.year, .month, .day, .weekday, .hour, .minute], from: instant)
        guard let year = comps.year, let month = comps.month, let day = comps.day,
              let weekday = comps.weekday, let hour = comps.hour, let minute = comps.minute else {
            return nil
        }
        let today = Self.isoDayString(year: year, month: month, day: day)
        guard let period = period(on: today, strict: strict) else { return nil }
        guard let seasonIndex = period.seasons.firstIndex(where: {
            Self.seasonMatches(month: month, day: day, season: $0)
        }) else {
            return nil
        }
        let season = period.seasons[seasonIndex]
        let isWeekend = weekday == 1 || weekday == 7 || holidayDates.contains(today)
        let windows = isWeekend ? season.weekendPeriods : season.weekdayPeriods
        let minuteOfDay = hour * 60 + minute
        guard let windowIndex = windows.firstIndex(where: {
            Self.windowMatches(minuteOfDay: minuteOfDay, window: $0)
        }) else {
            return nil
        }
        return ScheduleMatch(
            period: period,
            season: season,
            window: windows[windowIndex],
            seasonIndex: seasonIndex,
            isWeekend: isWeekend,
            windowIndex: windowIndex
        )
    }

    func boundaryMinutes() -> [Int] {
        var minutes: Set<Int> = [0]
        for period in periods {
            for season in period.seasons {
                for window in season.weekdayPeriods + season.weekendPeriods {
                    minutes.insert((window.fromHour * 60 + window.fromMinute) % 1440)
                    minutes.insert((window.toHour * 60 + window.toMinute) % 1440)
                }
            }
        }
        return minutes.sorted()
    }

    /// The plan the server prices `day` with: the one covering it, else (in a gap) the nearest
    /// earlier plan by end date, else (before every plan) the earliest. Mirrors `resolveTariffForDate`.
    /// When `strict` is `true`, only a plan whose effective range covers `day` matches.
    private func period(on day: String, strict: Bool) -> TariffPeriodDTO? {
        if let exact = periods.first(where: {
            $0.effectiveFrom <= day && ($0.effectiveTo == nil || day <= ($0.effectiveTo ?? ""))
        }) {
            return exact
        }
        guard !strict else { return nil }
        if let earlier = periods.filter({ ($0.effectiveTo ?? "") != "" && ($0.effectiveTo ?? "") < day })
            .max(by: { ($0.effectiveTo ?? "") < ($1.effectiveTo ?? "") }) {
            return earlier
        }
        return periods.min(by: { $0.effectiveFrom < $1.effectiveFrom })
    }

    private static func isoDayString(year: Int, month: Int, day: Int) -> String {
        let rawYear = String(year)
        let yearText = rawYear.count < 4 ? String(repeating: "0", count: 4 - rawYear.count) + rawYear : rawYear
        let monthText = month < 10 ? "0\(month)" : "\(month)"
        let dayText = day < 10 ? "0\(day)" : "\(day)"
        return "\(yearText)-\(monthText)-\(dayText)"
    }

    private static func seasonMatches(month: Int, day: Int, season: TariffSeasonInput) -> Bool {
        let start = season.fromMonth * 100 + (season.fromDay ?? 1)
        let end = season.toMonth * 100 + (season.toDay ?? 31)
        let today = month * 100 + day
        return start <= end ? today >= start && today <= end : today >= start || today <= end
    }

    private static func windowMatches(minuteOfDay: Int, window: TimePeriodWindowInput) -> Bool {
        let start = window.fromHour * 60 + window.fromMinute
        let end = window.toHour * 60 + window.toMinute
        if start == 0, end == 1440 || end == 0 { return true }
        if start < end { return minuteOfDay >= start && minuteOfDay < end }
        return minuteOfDay >= start || minuteOfDay < end
    }
}
