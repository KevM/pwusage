import Foundation

/// The fixed comparison plan an owner chose (or the guide staged) for one rate plan's dates.
public enum FixedComparisonChoice: Equatable, Sendable, Encodable {
    /// A utility fixed plan, saved by its URDB label; `name` and `buyRate` are for display only.
    case publicPlan(label: String, name: String, buyRate: Double)
    case manual(name: String, buyRate: Double, sellRate: Double)

    public var name: String {
        switch self {
        case let .publicPlan(_, name, _), let .manual(name, _, _): name
        }
    }

    public var buyRate: Double {
        switch self {
        case let .publicPlan(_, _, buyRate), let .manual(_, buyRate, _): buyRate
        }
    }

    /// The URDB label of a utility plan choice; nil for manual rates.
    public var label: String? {
        if case let .publicPlan(label, _, _) = self { label } else { nil }
    }

    private enum CodingKeys: String, CodingKey {
        case label, name, buyRate, sellRate
    }

    public func encode(to encoder: Encoder) throws {
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
}
