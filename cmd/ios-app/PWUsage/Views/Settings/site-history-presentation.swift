import Foundation

/// What Settings and the tab accessory say about a site's history loading. The checked count
/// never has a denominator: the search can extend, so "of N" would move.
struct SiteHistoryPresentation: Equatable {
    enum Action: Equatable { case reconnectTesla, setLocation, openSolarForecast }

    static let accessoryTitle = "Loading history for Solar Forecasting"

    /// The short value on the Settings row.
    let rowValue: String
    let headline: String
    let detail: String
    let action: Action?
    let checkedDays: Int
    let daysWithData: Int
    /// The checked days, oldest first, or nil before any are checked.
    let checkedRange: String?
    /// Days with solar production at the last check, or nil before one.
    let producingDays: Int?
    let showsAccessory: Bool

    var checkedDaysText: String { Self.days(checkedDays) + " checked" }

    init(status: SiteHistoryStatus?, now: Date, timeZone: TimeZone = .current) {
        let progress = status?.progress
        checkedDays = progress?.checkedDays(timeZone: .gmt) ?? 0
        daysWithData = progress?.daysWithData ?? 0
        producingDays = progress?.producingDays
        checkedRange = progress.flatMap(Self.range)
        showsAccessory = status?.isLoadingForForecasting ?? false
        let text = Self.text(status: status, now: now, timeZone: timeZone)
        rowValue = text.row
        headline = text.headline
        detail = text.detail
        action = text.action
    }

    private struct Wording {
        let row: String
        let headline: String
        let detail: String
        var action: Action?

        init(_ row: String, _ headline: String, _ detail: String, _ action: Action? = nil) {
            self.row = row
            self.headline = headline
            self.detail = detail
            self.action = action
        }
    }

    private static func text(status: SiteHistoryStatus?, now: Date, timeZone: TimeZone) -> Wording {
        guard let status, let progress = status.progress else {
            return Wording("Not Started", "Not started",
                           "History for Solar Forecasting loads while pwusage is open, newest days first.", nil)
        }
        switch progress.phase {
        case .active: return active(status, progress: progress, now: now, timeZone: timeZone)
        case .paused(.reconnectTesla):
            return Wording("Paused", "Paused", "Reconnect Tesla to keep loading history.", .reconnectTesla)
        case .paused(.signIn):
            return Wording("Paused", "Paused", "Sign in again to keep loading history.", nil)
        case .finished(let reason): return finished(reason, progress: progress)
        }
    }

    private static func active(
        _ status: SiteHistoryStatus, progress: SiteHistoryOnboardingProgress, now: Date, timeZone: TimeZone
    ) -> Wording {
        let headline = status.hasUsableLayout ? "Loading recent history" : "Loading history"
        if let until = status.throttledUntil, until > now {
            return Wording("Waiting", headline,
                           "Tesla is limiting requests. Loading continues after \(time(until, now: now, timeZone)).")
        }
        if let until = progress.nextAttemptAt, until > now {
            return Wording("Waiting", headline, "Loading continues after \(time(until, now: now, timeZone)).", nil)
        }
        let detail = status.hasUsableLayout
            ? "Your solar layout is already set up. pwusage is loading your recent days."
            : "pwusage looks back up to a year and stops once Solar Forecasting has what it needs."
        return Wording("Loading", headline, detail, nil)
    }

    private static func finished(_ reason: SiteHistoryOnboarding.FinishReason, progress: SiteHistoryOnboardingProgress)
        -> Wording {
        switch reason {
        case .layoutFound:
            return Wording("Done", "Solar layout found", "Solar Forecasting has the history it needs.", nil)
        case .layoutAlreadyUsable:
            return Wording("Done", "Recent history loaded", "Your solar layout was already set up.", nil)
        case .locationNeeded:
            return Wording("Needs Location", "Home location needed",
                           "Set your home location so pwusage can find your solar layout.", .setLocation)
        case .noSolarProduction:
            return Wording("Done", "No solar production found",
                           "The checked days show no solar production. Solar Forecasting needs a solar system.")
        case .detectorNeedsOtherAction:
            return Wording("Done", "More history won’t help",
                           "pwusage could not find a solar layout from this history. "
                               + "Solar Forecast shows what it found.",
                           .openSolarForecast)
        case .historyUnavailable:
            return Wording("Unavailable", "History unavailable", "Site history is not available for this site yet.")
        case .reachedHistoryStart, .reachedOneYear:
            let limit = reason == .reachedOneYear
                ? "pwusage checked a year of history."
                : "pwusage checked all the history this site has."
            let next = progress.lastOutlook == .needsOtherAction
                ? " Solar Forecast shows what it found."
                : " Your solar layout is checked again as new days arrive."
            return Wording("Done", "History checked", limit + next,
                           progress.lastOutlook == .needsOtherAction ? .openSolarForecast : nil)
        }
    }

    static func days(_ count: Int) -> String {
        count == 1 ? "1 day" : "\(count.formatted()) days"
    }

    /// `oldestChecked` through the day before `checkedUntil`, as calendar days.
    private static func range(_ progress: SiteHistoryOnboardingProgress) -> String? {
        guard progress.oldestChecked < progress.checkedUntil,
              let last = SiteLocalDays.adding(-1, to: progress.checkedUntil, timeZone: .gmt),
              let first = date(progress.oldestChecked), let final = date(last) else { return nil }
        var style = Date.FormatStyle(date: .abbreviated, time: .omitted)
        style.timeZone = .gmt
        return first == final ? first.formatted(style) : "\(first.formatted(style)) to \(final.formatted(style))"
    }

    private static func date(_ day: String) -> Date? {
        var strategy = Date.ISO8601FormatStyle().year().month().day()
        strategy.timeZone = .gmt
        return try? Date(day, strategy: strategy)
    }

    /// A time today, or a date and time further out.
    private static func time(_ date: Date, now: Date, _ timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var style = calendar.isDate(date, inSameDayAs: now)
            ? Date.FormatStyle(date: .omitted, time: .shortened)
            : Date.FormatStyle(date: .abbreviated, time: .shortened)
        style.timeZone = timeZone
        return date.formatted(style)
    }
}
