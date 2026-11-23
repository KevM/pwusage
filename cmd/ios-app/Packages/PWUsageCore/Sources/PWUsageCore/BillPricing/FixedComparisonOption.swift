import Foundation

/// One fixed plan a picker offers, from the utility's public plans or the guide's year list.
public struct FixedComparisonOption: Equatable, Identifiable, Sendable {
    public let label: String
    public let name: String
    /// Nil when the server sent no rate details for the plan.
    public let buyRate: Double?
    public let isDefault: Bool

    public var id: String { label }

    public init(label: String, name: String, buyRate: Double?, isDefault: Bool) {
        self.label = label
        self.name = name
        self.buyRate = buyRate
        self.isDefault = isDefault
    }

    public init(plan: UtilityPlanDTO) {
        self.init(
            label: plan.label, name: plan.name,
            buyRate: plan.seasons?.first?.weekdayPeriods.first?.buyRate, isDefault: plan.isDefault ?? false
        )
    }

    public var choice: FixedComparisonChoice {
        .publicPlan(label: label, name: name, buyRate: buyRate ?? 0)
    }
}
