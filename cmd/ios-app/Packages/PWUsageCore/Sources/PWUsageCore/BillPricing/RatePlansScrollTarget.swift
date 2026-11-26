import Foundation

/// Which rate plan the editor scrolls to when a savings entry point opens it.
public enum RatePlansScrollTarget: Equatable, Sendable {
    /// The plan in effect today (the savings button).
    case today
    /// The oldest plan with uncovered days in the savings caveat's date ranges.
    case firstUncovered(within: [SavingsDayRange])

    /// The plan's `periodId` to scroll to; nil when no plan matches, which leaves the editor at the top.
    public func periodID(in timeline: SiteTariffsTimelineResponse) -> Int? {
        switch self {
        case .today:
            return timeline.periods.first(where: \.isCurrentToday)?.periodId
        case let .firstUncovered(ranges):
            return timeline.periods.sorted { $0.effectiveFrom < $1.effectiveFrom }.first { period in
                let rows = FixedComparisonPairing.rows(
                    for: (period.effectiveFrom, period.effectiveTo), references: timeline.referencePeriods
                )
                return rows.contains { row in
                    row.reference == nil && ranges.contains { range in
                        row.from <= range.last && (row.to.map { $0 >= range.first } ?? true)
                    }
                }
            }?.periodId
        }
    }
}
