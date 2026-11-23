import Foundation
import PWUsageCore

extension RatePlanHistoryFlow {
    /// The spans review lists, newest first, with their index in `spans` for Change. A span left with
    /// no days (it starts after it ends) is left out, as `periods()` leaves it out of the save.
    var reviewSpans: [(index: Int, span: Span)] {
        spans.enumerated()
            .filter { _, span in span.endDate.map { span.from <= $0 } ?? true }
            .map { (index: $0.offset, span: $0.element) }
    }

    /// Review's Change: steps back until the span at `index` (newest first) is gone, which lands on the
    /// answer that created it. An index past the spans changes nothing.
    mutating func reopenSpan(at index: Int) {
        while spans.count > index {
            let before = self
            back()
            if self == before { return }
        }
    }

    /// The fixed comparison this guide sends for the plan at `index`, or nil to leave what is stored:
    /// the owner's change; else, for a plan that is itself a fixed plan, that plan; else, only when no
    /// reference period covers any of the plan's days, the start year's default fixed plan (else its
    /// first). A partly covered plan stages nothing, and its gaps show as gap rows.
    func stagedFixed(forSpanAt index: Int) -> FixedComparisonChoice? {
        guard spans.indices.contains(index) else { return nil }
        let span = spans[index]
        if let chosen = span.fixed { return chosen }
        if span.plan.kind == .fixed, let label = span.plan.fixedLabel {
            return .publicPlan(label: label, name: span.plan.name, buyRate: span.plan.lowRate)
        }
        let rows = FixedComparisonPairing.rows(for: (span.from, span.endDate), references: referencePeriods)
        guard !rows.contains(where: { $0.reference != nil }) else { return nil }
        return fallbackFixedPlan(startingIn: span.from)
    }

    /// Oldest first. One row per stored reference revision over the plan; a staged comparison is one
    /// row covering the whole plan, its `reference` a display-only period (`source == .manual`).
    func comparisonRows(forSpanAt index: Int) -> [FixedComparisonRow] {
        guard spans.indices.contains(index) else { return [] }
        let span = spans[index]
        if let staged = stagedFixed(forSpanAt: index) {
            return [FixedComparisonRow(
                from: span.from, to: span.endDate, reference: staged.stagedReference(from: span.from, to: span.endDate)
            )]
        }
        return FixedComparisonPairing.rows(for: (span.from, span.endDate), references: referencePeriods)
    }

    private func fallbackFixedPlan(startingIn day: String) -> FixedComparisonChoice? {
        let year = Int(day.prefix(4))
        // Only the year covering the start. A year the server lists with no plans stages nothing; a year
        // it does not list is the current (trusted) year, whose plans are `history.current`.
        let listed = history.years.first { $0.year == year }?.plans ?? (
            history.years.contains { $0.year == year } ? [] : history.current
        )
        let fixedPlans = listed.filter { $0.kind == .fixed && $0.fixedLabel != nil }
        guard let plan = fixedPlans.first(where: \.isDefault) ?? fixedPlans.first, let label = plan.fixedLabel else {
            return nil
        }
        return .publicPlan(label: label, name: plan.name, buyRate: plan.lowRate)
    }
}
