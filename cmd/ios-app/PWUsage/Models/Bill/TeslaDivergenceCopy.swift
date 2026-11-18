import Foundation

/// What to tell the user when the plan chosen in PWUsage differs from the plan last saved from
/// Tesla. It names when that Tesla plan was saved, so an old snapshot never reads as live.
struct TeslaDivergenceCopy: Equatable, Sendable {
    let title: String
    let detail: String

    private static let effect = "Your Powerwall uses the plan in Tesla; PWUsage uses yours for bills and savings."

    init(sync: TeslaSyncDTO) {
        let saved = Self.parse(sync.latestUpdatedAt)
        let planName = sync.latestTariffName.flatMap { $0.isEmpty ? nil : "\"\($0)\"" }
        title = "PWUsage’s rate plan differs from Tesla’s"
        if let saved {
            let day = saved.formatted(.dateTime.month(.abbreviated).day().year().locale(Locale(identifier: "en_US")))
            detail = "PWUsage last saved \(planName ?? "its plan") from Tesla on \(day). \(Self.effect)"
        } else {
            detail = "\(planName ?? "Tesla’s plan") is the plan PWUsage last saved from Tesla. \(Self.effect)"
        }
    }

    /// Syncing often changes nothing on screen, so say what it found.
    static func syncNotice(previousTeslaPlan: Int?, refreshed: SiteTariffsTimelineResponse) -> String {
        let hasActiveCustomPlan = refreshed.teslaSync.differsFromActiveManual
        if refreshed.teslaSync.latestTariffId != previousTeslaPlan {
            return hasActiveCustomPlan
                ? "Saved Tesla's updated plan to your history. The plan you chose stays active."
                : "Tesla's updated plan was saved to your history."
        }
        return hasActiveCustomPlan
            ? "Checked Tesla: its plan hasn't changed. The plan you chose stays active."
            : "Checked Tesla: your rate plan is up to date."
    }

    private static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        return (try? Date(value, strategy: .iso8601))
            ?? (try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
    }
}
