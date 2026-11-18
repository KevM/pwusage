import Foundation

/// Whether the energy history on this phone reaches back far enough to call its savings
/// "Lifetime". Savings and payback count only stored days, and the phone keeps a year until the
/// older-history walk loads the rest, so until that walk finishes the figure is named for what it
/// covers and payback waits rather than counting the missing years as no savings.
enum SavingsHistoryCoverage: Equatable, Sendable {
    /// Every day the site has is on the phone, or there is no walk to run (demo).
    case complete
    /// Older history is loading.
    case loading(since: Date)
    /// The walk is not running; `action` is how the owner can continue it, nil when nothing more can load.
    case partial(since: Date, action: SiteDeepHistoryPresentation.Action?)

    init(firstStoredDay: Date?, olderHistory: SiteDeepHistoryModel.Status?) {
        guard let firstStoredDay, let olderHistory else {
            self = .complete
            return
        }
        switch olderHistory.phase {
        case .finished:
            self = .complete
        case .running, .waiting:
            self = .loading(since: firstStoredDay)
        case .idle:
            self = .partial(since: firstStoredDay, action: olderHistory.loadedBack == nil ? .load : .continueLoading)
        case .paused(.reconnectTesla):
            self = .partial(since: firstStoredDay, action: .reconnectTesla)
        case .paused(.signIn), .unavailable:
            self = .partial(since: firstStoredDay, action: nil)
        }
    }

    /// "Lifetime", or "Since Nov 18, 2025" while older days are missing.
    func lifetimeTitle(timeZone: TimeZone) -> String {
        guard let since else { return "Lifetime" }
        return "Since \(since.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: timeZone)))"
    }

    var note: String? {
        switch self {
        case .complete:
            nil
        case .loading:
            "Older history is loading, so this covers only the days loaded so far."
        case .partial(_, action: .reconnectTesla):
            "This covers only the history on this phone. Reconnect Tesla to load the rest."
        case .partial(_, action: .load), .partial(_, action: .continueLoading):
            "This covers only the history on this phone. Load older history to see your lifetime."
        case .partial:
            "Earlier history isn’t available, so this covers only the days on this phone."
        }
    }

    var action: SiteDeepHistoryPresentation.Action? {
        if case .partial(_, let action) = self { return action }
        return nil
    }

    var actionTitle: String? {
        switch action {
        case .load: "Load Older History"
        case .continueLoading: "Continue Loading"
        case .reconnectTesla: "Reconnect Tesla"
        case .stop, nil: nil
        }
    }

    /// Payback adds up stored cycles against the whole system cost, so a missing year reads as no
    /// savings and pushes the paid-off date out. Wait while days from before the phone's history
    /// can still load; once nothing more can, show what there is.
    func holdsPayback(costs: SystemCostsDTO?, timeZone: TimeZone) -> Bool {
        guard let since, self == .loading(since: since) || action != nil else { return false }
        let installs = [costs?.solar?.installDate ?? costs?.siteInstalled, costs?.powerwall?.installDate]
            .compactMap { $0.flatMap { RatePlanTimelineFormatting.parseYMD($0, in: timeZone) } }
        guard let earliest = installs.min() else { return true }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.startOfDay(for: earliest) < since
    }

    var paybackNote: String? {
        switch self {
        case .complete: nil
        case .loading:
            "Payback appears once older history finishes loading, so it counts every year since install."
        case .partial(_, action: .reconnectTesla):
            "Payback needs your history back to install. Reconnect Tesla to load it."
        case .partial:
            "Payback needs your history back to install. Load older history to see it."
        }
    }

    private var since: Date? {
        switch self {
        case .complete: nil
        case .loading(let since), .partial(let since, _): since
        }
    }
}
