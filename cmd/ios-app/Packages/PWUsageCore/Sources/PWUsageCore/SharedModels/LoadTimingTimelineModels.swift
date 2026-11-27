#if canImport(FoundationEssentials)
    import FoundationEssentials
#else
    import Foundation
#endif

public struct LoadTimingTariffSegment: Codable, Equatable, Sendable {
    public let start: Date
    public let end: Date
    public let periodKey: String
    public let name: String
    public let buyRate: Double
    public let sellRate: Double

    public init(
        start: Date,
        end: Date,
        periodKey: String,
        name: String,
        buyRate: Double,
        sellRate: Double
    ) {
        self.start = start
        self.end = end
        self.periodKey = periodKey
        self.name = name
        self.buyRate = buyRate
        self.sellRate = sellRate
    }
}

public struct NextCheaperPeriod: Codable, Equatable, Sendable {
    public let name: String
    public let marginalCost: Double
    public let phrase: String

    public init(name: String, marginalCost: Double, phrase: String) {
        self.name = name
        self.marginalCost = marginalCost
        self.phrase = phrase
    }

    public static func periodKey(_ name: String) -> String {
        name
    }
}

public struct LoadTimingPeriod: Codable, Equatable, Sendable {
    public let name: String
    public let marginalCost: Double?
    public let basis: String
    public let cycleNetExportKwh: Double
    public let isActive: Bool
    public let nextStartPhrase: String?
    public let buyRate: Double
    public let sellRate: Double

    public init(
        name: String,
        marginalCost: Double?,
        basis: String,
        cycleNetExportKwh: Double,
        isActive: Bool,
        nextStartPhrase: String?,
        buyRate: Double,
        sellRate: Double
    ) {
        self.name = name
        self.marginalCost = marginalCost
        self.basis = basis
        self.cycleNetExportKwh = cycleNetExportKwh
        self.isActive = isActive
        self.nextStartPhrase = nextStartPhrase
        self.buyRate = buyRate
        self.sellRate = sellRate
    }

    public var hasFiniteAmounts: Bool {
        buyRate.isFinite && sellRate.isFinite && (marginalCost?.isFinite ?? true)
    }
}

public struct LoadTiming: Codable, Equatable, Sendable {
    public let hasTariff: Bool
    public let hasCycleData: Bool
    public let activeIsCheapest: Bool
    public let periods: [LoadTimingPeriod]
    public let pricingPeriods: [LoadTimingPeriod]
    public let tariffTimeline: [LoadTimingTariffSegment]
    public let nextCheaper: NextCheaperPeriod?
    public let nextCheaperPhrase: String?
    public let nextStartPhraseByKey: [String: String]

    private enum CodingKeys: String, CodingKey {
        case hasTariff, hasCycleData, activeIsCheapest, periods, pricingPeriods, tariffTimeline
        case nextCheaper, nextCheaperPhrase, nextStartPhraseByKey
    }

    public init(
        hasTariff: Bool,
        hasCycleData: Bool,
        activeIsCheapest: Bool,
        periods: [LoadTimingPeriod],
        pricingPeriods: [LoadTimingPeriod],
        tariffTimeline: [LoadTimingTariffSegment] = [],
        nextCheaper: NextCheaperPeriod?,
        nextCheaperPhrase: String?,
        nextStartPhraseByKey: [String: String]
    ) {
        self.hasTariff = hasTariff
        self.hasCycleData = hasCycleData
        self.activeIsCheapest = activeIsCheapest
        self.periods = periods
        self.pricingPeriods = pricingPeriods
        self.tariffTimeline = tariffTimeline
        self.nextCheaper = nextCheaper
        self.nextCheaperPhrase = nextCheaperPhrase
        self.nextStartPhraseByKey = nextStartPhraseByKey
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hasTariff = try container.decode(Bool.self, forKey: .hasTariff)
        hasCycleData = try container.decode(Bool.self, forKey: .hasCycleData)
        activeIsCheapest = try container.decode(Bool.self, forKey: .activeIsCheapest)
        periods = try container.decode([LoadTimingPeriod].self, forKey: .periods)
        pricingPeriods = try container.decode([LoadTimingPeriod].self, forKey: .pricingPeriods)
        tariffTimeline = try container.decodeIfPresent([LoadTimingTariffSegment].self, forKey: .tariffTimeline) ?? []
        nextCheaper = try container.decodeIfPresent(NextCheaperPeriod.self, forKey: .nextCheaper)
        nextCheaperPhrase = try container.decodeIfPresent(String.self, forKey: .nextCheaperPhrase)
        nextStartPhraseByKey = try container.decodeIfPresent([String: String].self, forKey: .nextStartPhraseByKey)
            ?? [:]
    }

    public var hasFiniteAmounts: Bool {
        periods.allSatisfy(\.hasFiniteAmounts) && pricingPeriods.allSatisfy(\.hasFiniteAmounts)
            && tariffTimeline.allSatisfy { $0.buyRate.isFinite && $0.sellRate.isFinite }
            && (nextCheaper?.marginalCost.isFinite ?? true)
    }
}
