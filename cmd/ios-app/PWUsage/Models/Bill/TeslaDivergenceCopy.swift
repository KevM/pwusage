import Foundation

/// What to tell the user when their custom plan and the Tesla plan disagree.
struct TeslaDivergenceCopy: Equatable, Sendable {
    let title: String
    let detail: String

    init(sync: TeslaSyncDTO) {
        let ours = Self.parse(sync.activeManualUpdatedAt)
        let theirs = Self.parse(sync.latestUpdatedAt)
        let planName = sync.latestTariffName.flatMap { $0.isEmpty ? nil : "\"\($0)\"" } ?? "Its plan"
        func day(_ date: Date) -> String {
            date.formatted(.dateTime.month(.abbreviated).day().year().locale(Locale(identifier: "en_US")))
        }
        if let ours, let theirs, ours >= theirs {
            title = "Your custom plan is newer than Tesla's"
            detail = "\(planName) in your Tesla account hasn't changed since \(day(theirs))."
        } else if let ours, let theirs {
            title = "Tesla changed its plan after your custom plan"
            detail = "\(planName) was updated in your Tesla account on \(day(theirs)); yours was saved \(day(ours))."
        } else {
            title = "Tesla's plan differs from your custom plan"
            detail = "\(planName) is saved in your Tesla account."
        }
    }

    /// Syncing often changes nothing on screen, so say what it found.
    static func syncNotice(previousTeslaPlan: Int?, refreshed: SiteTariffsTimelineResponse) -> String {
        let hasActiveCustomPlan = refreshed.teslaSync.differsFromActiveManual
        if refreshed.teslaSync.latestTariffId != previousTeslaPlan {
            return hasActiveCustomPlan
                ? "Saved Tesla's updated plan to your history. Your custom plan stays active."
                : "Tesla's updated plan was saved to your history."
        }
        return hasActiveCustomPlan
            ? "Checked Tesla: its plan hasn't changed. Your custom plan stays active."
            : "Checked Tesla: your rate plan is up to date."
    }

    private static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        return (try? Date(value, strategy: .iso8601))
            ?? (try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
    }
}
