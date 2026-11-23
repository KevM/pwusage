import Foundation
import PWUsageCore

/// The fixed comparison plan an owner chose (or the guide staged) for one rate plan's dates.
enum FixedComparisonChoice: Equatable, Sendable, Encodable {
    /// A utility fixed plan, saved by its URDB label; `name` and `buyRate` are for display only.
    case publicPlan(label: String, name: String, buyRate: Double)
    case manual(name: String, buyRate: Double, sellRate: Double)

    var name: String {
        switch self {
        case let .publicPlan(_, name, _), let .manual(name, _, _): name
        }
    }

    var buyRate: Double {
        switch self {
        case let .publicPlan(_, _, buyRate), let .manual(_, buyRate, _): buyRate
        }
    }

    /// The URDB label of a utility plan choice; nil for manual rates.
    var label: String? {
        if case let .publicPlan(label, _, _) = self { label } else { nil }
    }

    private enum CodingKeys: String, CodingKey {
        case label, name, buyRate, sellRate
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .publicPlan(label, _, _):
            try container.encode(label, forKey: .label)
        case let .manual(name, buyRate, sellRate):
            try container.encode(name, forKey: .name)
            try container.encode(buyRate, forKey: .buyRate)
            try container.encode(sellRate, forKey: .sellRate)
        }
    }

    /// A display-only reference period for the staged choice over `from...to`, so one row type
    /// renders stored and staged comparisons alike. Never sent: `source` is `.manual`, never
    /// `.estimated`, and `periodId`/`tariffId` are -1. One flat all-day season at `buyRate`.
    func stagedReference(from: String, to: String?) -> TariffPeriodDTO {
        let sell = if case let .manual(_, _, sellRate) = self { sellRate } else { 0.0 }
        let window = TimePeriodWindowInput(
            touName: .offPeak, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0,
            buyRate: buyRate, sellRate: sell
        )
        let season = TariffSeasonInput(
            name: "All Year", fromMonth: 1, toMonth: 12, weekdayPeriods: [window], weekendPeriods: [window]
        )
        return TariffPeriodDTO(
            periodId: -1, tariffId: -1, name: name, version: 0, source: .manual,
            effectiveFrom: from, effectiveTo: to, isCurrentToday: false, updatedBy: nil,
            seasons: [season], urdbLabel: label
        )
    }
}
