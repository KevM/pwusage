import Foundation
import PWUsageCore

/// Copy and formatting for a rate plan's fixed comparison plan rows. Voice follows
/// `docs/voice-and-terms.md`: "fixed comparison plan" for the comparison, "rate plan" for the real plan.
enum FixedComparisonPresentation {
    static let heading = "Fixed comparison plan"
    static let footer = "Savings compare each plan with this fixed plan. "
        + "Changing it never changes the plan for your energy."
    static let noComparison = "No fixed comparison yet"
    static let estimatedBadge = "Estimated"
    static let changeTitle = "Change"
    static let enterRatesTitle = "Enter rates myself"
    static let pickerTitle = "Fixed Comparison Plan"
    static let pickerFooter = "Estimated from public utility rates in the OpenEI Utility Rate Database."
    static let loadingPlans = "Loading plans…"
    static let useRatesTitle = "Use"

    /// The plan's name, or `No fixed comparison yet` for a gap.
    static func title(_ row: FixedComparisonRow) -> String {
        row.reference?.name ?? noComparison
    }

    /// `$0.16 / kWh` from the reference's first flat rate; nil for a gap.
    static func rate(_ row: FixedComparisonRow, currency: String) -> String? {
        guard let rate = row.reference?.seasons.first?.weekdayPeriods.first?.buyRate else { return nil }
        return rateText(rate, currency: currency)
    }

    static func rateText(_ rate: Double, currency: String) -> String {
        "\(RateFormatting.formatRate(rate, currency: currency)) / kWh"
    }

    /// Only a stored, server-estimated reference is "Estimated"; a staged or owner-chosen one never is.
    static func isEstimated(_ row: FixedComparisonRow) -> Bool {
        row.reference?.source == .estimated
    }

    /// `$0.16 / kWh · Estimated`; nil for a gap.
    static func detail(_ row: FixedComparisonRow, currency: String) -> String? {
        guard let rate = rate(row, currency: currency) else { return nil }
        return isEstimated(row) ? "\(rate) · \(estimatedBadge)" : rate
    }

    /// `Jan 2024 – Dec 2024`, the row's clipped dates.
    static func range(_ row: FixedComparisonRow) -> String {
        RatePlanTimelineFormatting.displayRange(from: row.from, to: row.to)
    }
}

/// One fixed plan a picker offers, from the utility's public plans or the guide's year list.
struct FixedComparisonOption: Equatable, Identifiable, Sendable {
    let label: String
    let name: String
    /// Nil when the server sent no rate details for the plan.
    let buyRate: Double?
    let isDefault: Bool

    var id: String { label }

    init(label: String, name: String, buyRate: Double?, isDefault: Bool) {
        self.label = label
        self.name = name
        self.buyRate = buyRate
        self.isDefault = isDefault
    }

    init(plan: UtilityPlanDTO) {
        self.init(
            label: plan.label, name: plan.name,
            buyRate: plan.seasons?.first?.weekdayPeriods.first?.buyRate, isDefault: plan.isDefault ?? false
        )
    }

    var choice: FixedComparisonChoice {
        .publicPlan(label: label, name: name, buyRate: buyRate ?? 0)
    }

    func rateText(currency: String) -> String? {
        buyRate.map { FixedComparisonPresentation.rateText($0, currency: currency) }
    }
}
