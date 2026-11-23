import Foundation

/// Which rate plan the editor scrolls to when a savings entry point opens it.
public enum RatePlansScrollTarget: Equatable, Sendable {
    /// The plan in effect today (the savings button).
    case today
    /// The oldest plan with a sub-range no fixed comparison plan covers (the savings caveat).
    case firstUncovered

    /// The plan's `periodId` to scroll to; nil when no plan matches, which leaves the editor at the top.
    public func periodID(in timeline: SiteTariffsTimelineResponse) -> Int? {
        switch self {
        case .today:
            return timeline.periods.first(where: \.isCurrentToday)?.periodId
        case .firstUncovered:
            return timeline.periods.sorted { $0.effectiveFrom < $1.effectiveFrom }.first { period in
                FixedComparisonPairing.rows(
                    for: (period.effectiveFrom, period.effectiveTo), references: timeline.referencePeriods
                ).contains { $0.reference == nil }
            }?.periodId
        }
    }
}
