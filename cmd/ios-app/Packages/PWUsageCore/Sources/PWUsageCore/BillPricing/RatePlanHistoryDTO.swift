import Foundation

public enum RatePlanKind: String, Codable, Sendable {
    case fixed
    case timeOfUse = "time_of_use"
}

public struct RatePlanPeakWindowDTO: Decodable, Sendable, Equatable, Identifiable {
    public let label: String
    public let fromHour: Int
    public let toHour: Int

    public var id: String { label }

    public init(label: String, fromHour: Int, toHour: Int) {
        self.label = label
        self.fromHour = fromHour
        self.toHour = toHour
    }
}

public struct RatePlanHistoryPlanDTO: Decodable, Sendable, Equatable, Identifiable {
    public let name: String
    public let startDate: String
    public let kind: RatePlanKind
    public let isDefault: Bool
    public let closest: Bool
    public let lowRate: Double
    public let highRate: Double
    public let peakWindows: [RatePlanPeakWindowDTO]
    /// Label of the window closest to the Tesla plan (Time of Use only).
    public let closestWindow: String?
    /// Fixed plans: the URDB label to save.
    public let fixedLabel: String?

    /// Unique within a list: two rows can share a name when one Peak-hours option is priced apart.
    public var id: String { fixedLabel ?? peakWindows.first?.label ?? name }

    public init(
        name: String,
        startDate: String,
        kind: RatePlanKind,
        isDefault: Bool = false,
        closest: Bool = false,
        lowRate: Double,
        highRate: Double,
        peakWindows: [RatePlanPeakWindowDTO] = [],
        closestWindow: String? = nil,
        fixedLabel: String? = nil
    ) {
        self.name = name
        self.startDate = startDate
        self.kind = kind
        self.isDefault = isDefault
        self.closest = closest
        self.lowRate = lowRate
        self.highRate = highRate
        self.peakWindows = peakWindows
        self.closestWindow = closestWindow
        self.fixedLabel = fixedLabel
    }
}

public struct RatePlanHistoryYearDTO: Decodable, Sendable, Equatable, Identifiable {
    public let year: Int
    public let askDate: String
    public let plans: [RatePlanHistoryPlanDTO]

    public var id: Int { year }

    public init(year: Int, askDate: String, plans: [RatePlanHistoryPlanDTO]) {
        self.year = year
        self.askDate = askDate
        self.plans = plans
    }
}

public struct RatePlanHistoryDTO: Decodable, Sendable, Equatable {
    public let utilityName: String
    public let historyStart: String
    public let fillThrough: String?
    public let teslaShape: RatePlanKind?
    /// Plans in effect on `fillThrough` (today when nil): the newest plan the guide fills.
    public let current: [RatePlanHistoryPlanDTO]
    /// Newest first.
    public let years: [RatePlanHistoryYearDTO]

    public init(
        utilityName: String,
        historyStart: String,
        fillThrough: String? = nil,
        teslaShape: RatePlanKind? = nil,
        current: [RatePlanHistoryPlanDTO],
        years: [RatePlanHistoryYearDTO]
    ) {
        self.utilityName = utilityName
        self.historyStart = historyStart
        self.fillThrough = fillThrough
        self.teslaShape = teslaShape
        self.current = current
        self.years = years
    }
}

/// One confirmed past plan period; `to` is JSON `null` for the open (latest) period.
public struct RatePlanHistoryPeriod: Encodable, Sendable, Equatable {
    public let label: String
    public let from: String
    public let endDate: String?
    /// The fixed comparison plan chosen for this period; omitted from the JSON when nil (leave as stored).
    public let fixed: FixedComparisonChoice?

    public init(label: String, from: String, to endDate: String?, fixed: FixedComparisonChoice? = nil) {
        self.label = label
        self.from = from
        self.endDate = endDate
        self.fixed = fixed
    }

    private enum CodingKeys: String, CodingKey {
        case label, from, fixed
        case endDate = "to"
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(label, forKey: .label)
        try container.encode(from, forKey: .from)
        try container.encode(endDate, forKey: .endDate)
        try container.encodeIfPresent(fixed, forKey: .fixed)
    }
}
