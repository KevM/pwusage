import Foundation

/// One slice of a rate plan's dates and the fixed comparison (reference) period covering it.
/// Dates are `YYYY-MM-DD`; `to` is the inclusive last day, matching `TariffPeriodDTO.effectiveTo`.
public struct FixedComparisonRow: Equatable, Sendable {
    /// First day of the slice, clipped to the plan.
    public let from: String
    /// Inclusive last day of the slice, clipped to the plan; nil means open-ended.
    public let to: String?
    /// The covering reference period; nil means "No fixed comparison yet".
    public let reference: TariffPeriodDTO?

    public init(from: String, to: String?, reference: TariffPeriodDTO?) {
        self.from = from
        self.to = to
        self.reference = reference
    }
}

/// Pairs a rate plan's date range with the reference periods covering it.
public enum FixedComparisonPairing {
    /// Rows oldest first, one per overlapping reference period clipped to the plan, with a
    /// `reference == nil` row for each sub-range no reference covers. Both ends are inclusive.
    public static func rows(
        for plan: (from: String, to: String?),
        references: [TariffPeriodDTO]
    ) -> [FixedComparisonRow] {
        var rows: [FixedComparisonRow] = []
        var cursor = plan.from

        for reference in references.sorted(by: { $0.effectiveFrom < $1.effectiveFrom }) {
            if let planEnd = plan.to, cursor > planEnd { break }
            if let planEnd = plan.to, reference.effectiveFrom > planEnd { continue }
            if let referenceEnd = reference.effectiveTo, referenceEnd < cursor { continue }

            let start = max(reference.effectiveFrom, cursor)
            if start > cursor, let gapEnd = day(before: start) {
                rows.append(FixedComparisonRow(from: cursor, to: gapEnd, reference: nil))
            }
            let end = clippedEnd(reference.effectiveTo, planEnd: plan.to)
            rows.append(FixedComparisonRow(from: start, to: end, reference: reference))
            guard let end, let next = day(after: end) else { return rows }
            cursor = next
        }

        if plan.to.map({ cursor <= $0 }) ?? true {
            rows.append(FixedComparisonRow(from: cursor, to: plan.to, reference: nil))
        }
        return rows
    }

    private static func clippedEnd(_ referenceEnd: String?, planEnd: String?) -> String? {
        switch (referenceEnd, planEnd) {
        case let (referenceEnd?, planEnd?): min(referenceEnd, planEnd)
        case let (referenceEnd?, nil): referenceEnd
        case let (nil, planEnd): planEnd
        }
    }

    private static func day(before day: String) -> String? { shifted(day, by: -1) }
    private static func day(after day: String) -> String? { shifted(day, by: 1) }

    private static func shifted(_ day: String, by days: Int) -> String? {
        var calendar = Calendar(identifier: .gregorian)
        guard let utc = TimeZone(identifier: "UTC") else { return nil }
        calendar.timeZone = utc
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
              let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])),
              let moved = calendar.date(byAdding: .day, value: days, to: date) else { return nil }
        let result = calendar.dateComponents([.year, .month, .day], from: moved)
        guard let year = result.year, let month = result.month, let dayOfMonth = result.day else { return nil }
        return String(format: "%04ld-%02ld-%02ld", year, month, dayOfMonth)
    }
}
