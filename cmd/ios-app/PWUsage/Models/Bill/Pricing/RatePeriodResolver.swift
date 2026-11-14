import Foundation

struct ResolvedRatePeriod: Equatable, Sendable {
    let planName: String
    let periodName: String
    let buyRate: Double
    let sellRate: Double

    static let unknown = ResolvedRatePeriod(
        planName: "Unknown",
        periodName: "Unknown",
        buyRate: 0,
        sellRate: 0
    )
}

struct RatePeriodResolver: Sendable {
    private let periods: [TariffPeriodDTO]
    private let holidayDates: Set<String>
    private let calendar: Calendar

    init?(timeline: SiteTariffsTimelineResponse) {
        guard let timeZone = TimeZone(identifier: timeline.timezone) else { return nil }
        self.periods = timeline.periods
        self.holidayDates = Set(timeline.holidayDates ?? [])
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        self.calendar = calendar
    }

    func period(at instant: Date) -> ResolvedRatePeriod {
        guard let match = match(at: instant) else { return .unknown }
        let planName = match.period.name.isEmpty ? "Unknown" : match.period.name
        return ResolvedRatePeriod(
            planName: planName,
            periodName: match.window.touName.rawValue,
            buyRate: match.window.buyRate,
            sellRate: match.window.sellRate
        )
    }

    func match(at instant: Date) -> ActiveTariffPeriodMatch? {
        let comps = calendar.dateComponents([.year, .month, .day, .weekday, .hour, .minute], from: instant)
        guard let year = comps.year, let month = comps.month, let day = comps.day,
              let weekday = comps.weekday, let hour = comps.hour, let minute = comps.minute else {
            return nil
        }
        let today = String(format: "%04d-%02d-%02d", year, month, day)
        guard let period = period(on: today) else { return nil }
        guard let season = period.seasons.first(where: {
            Self.seasonMatches(month: month, day: day, season: $0)
        }) else {
            return nil
        }
        let isWeekend = weekday == 1 || weekday == 7 || holidayDates.contains(today)
        let windows = isWeekend ? season.weekendPeriods : season.weekdayPeriods
        let minuteOfDay = hour * 60 + minute
        guard let window = windows.first(where: { Self.windowMatches(minuteOfDay: minuteOfDay, window: $0) }) else {
            return nil
        }
        return ActiveTariffPeriodMatch(period: period, season: season, window: window)
    }

    /// The plan the server prices `day` with: the one covering it, else (in a gap) the nearest
    /// earlier plan by end date, else (before every plan) the earliest. Mirrors `resolveTariffForDate`.
    private func period(on day: String) -> TariffPeriodDTO? {
        if let exact = periods.first(where: {
            $0.effectiveFrom <= day && ($0.effectiveTo == nil || day <= ($0.effectiveTo ?? ""))
        }) {
            return exact
        }
        if let earlier = periods.filter({ ($0.effectiveTo ?? "") != "" && ($0.effectiveTo ?? "") < day })
            .max(by: { ($0.effectiveTo ?? "") < ($1.effectiveTo ?? "") }) {
            return earlier
        }
        return periods.min(by: { $0.effectiveFrom < $1.effectiveFrom })
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
