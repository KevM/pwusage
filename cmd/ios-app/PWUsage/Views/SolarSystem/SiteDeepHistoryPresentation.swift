import Foundation

/// The words and the action of the Solar System screen's "older history" row and the tab accessory.
struct SiteDeepHistoryPresentation: Equatable {
    enum Action: Equatable { case load, continueLoading, stop, reconnectTesla }

    let title: String
    let statusLine: String
    let action: Action?
    /// The accessory's second line while loading.
    let accessoryDetail: String

    init(status: SiteDeepHistoryModel.Status) {
        let back = Self.backText(status)
        let loaded = status.daysLoaded > 0 ? SiteHistoryPresentation.days(status.daysLoaded) + " loaded" : ""
        title = "Older History"
        accessoryDetail = [back, loaded].filter { !$0.isEmpty }.joined(separator: " · ")
        switch status.phase {
        case .idle where status.loadedBack == nil:
            statusLine = "Load every earlier day Tesla still has for this site. It can take a few minutes."
            action = .load
        case .idle:
            statusLine = "Loaded back to \(status.loadedBack.map(Self.format) ?? "")."
            action = .continueLoading
        case .running:
            statusLine = ["Loading older history.", accessoryDetail].filter { !$0.isEmpty }.joined(separator: " ")
            action = .stop
        case .waiting:
            statusLine = "Waiting for Tesla, then loading continues. " + accessoryDetail
            action = .stop
        case .paused(.reconnectTesla):
            statusLine = "Reconnect Tesla to keep loading older history."
            action = .reconnectTesla
        case .paused(.signIn):
            statusLine = "Sign in again to keep loading older history."
            action = nil
        case .finished:
            statusLine = status.loadedBack.map { "All available history is loaded, back to \(Self.format($0))." }
                ?? "There is no older history to load."
            action = nil
        case .unavailable:
            statusLine = "Older history isn’t available for this site yet."
            action = nil
        }
    }

    private static func backText(_ status: SiteDeepHistoryModel.Status) -> String {
        status.loadedBack.map { "Back to \(format($0))" } ?? ""
    }

    /// "Mar 3, 2023" for a "yyyy-MM-dd" day.
    static func format(_ day: String) -> String {
        let parser = DateFormatter()
        parser.calendar = Calendar(identifier: .gregorian)
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = .gmt
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: day) else { return day }
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: .gmt))
    }
}
