import Foundation

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
}
