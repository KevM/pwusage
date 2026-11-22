import Foundation

public struct BillOutlookBucket: Codable, Equatable, Sendable {
    public let tariffName: String
    public let periodName: String
    public var netGridKwh: Double
    public let buyRate: Double
    public let sellRate: Double
    public var key: String { tariffName + "\u{1f}" + periodName }

    public init(
        tariffName: String,
        periodName: String,
        netGridKwh: Double,
        buyRate: Double,
        sellRate: Double
    ) {
        self.tariffName = tariffName
        self.periodName = periodName
        self.netGridKwh = netGridKwh
        self.buyRate = buyRate
        self.sellRate = sellRate
    }
}

public struct BillOutlookPeriod: Codable, Equatable, Sendable {
    public let tariffName: String
    public let periodName: String
    public var netGridKwh: Double
    public var key: String { tariffName + "\u{1f}" + periodName }

    public init(tariffName: String, periodName: String, netGridKwh: Double) {
        self.tariffName = tariffName
        self.periodName = periodName
        self.netGridKwh = netGridKwh
    }
}

public struct BillOutlookPoint: Codable, Equatable, Sendable {
    public let date: Date
    public let buckets: [BillOutlookBucket]
    public let complete: Bool
    public let estimatedCost: Double
    public let periods: [BillOutlookPeriod]

    public init(
        date: Date,
        buckets: [BillOutlookBucket],
        complete: Bool,
        estimatedCost: Double,
        periods: [BillOutlookPeriod]
    ) {
        self.date = date
        self.buckets = buckets
        self.complete = complete
        self.estimatedCost = estimatedCost
        self.periods = periods
    }
}

public struct BillOutlookTariff: Codable, Equatable, Sendable {
    public let start: Date
    public let end: Date
    public let periodKey: String
    public let name: String
    public let buyRate: Double
    public let sellRate: Double
    public let tariffName: String
    public let periodName: String
    public var segment: LoadTimingTariffSegment {
        .init(start: start, end: end, periodKey: periodKey, name: name, buyRate: buyRate, sellRate: sellRate)
    }

    public init(
        start: Date,
        end: Date,
        periodKey: String,
        name: String,
        buyRate: Double,
        sellRate: Double,
        tariffName: String,
        periodName: String
    ) {
        self.start = start
        self.end = end
        self.periodKey = periodKey
        self.name = name
        self.buyRate = buyRate
        self.sellRate = sellRate
        self.tariffName = tariffName
        self.periodName = periodName
    }
}

public struct BillOutlookHistory: Codable, Equatable, Sendable {
    public let points: [BillOutlookPoint]
    public let observedThrough: Date
    public let complete: Bool
    public var tariffTimeline: [BillOutlookTariff]

    public init(
        points: [BillOutlookPoint],
        observedThrough: Date,
        complete: Bool,
        tariffTimeline: [BillOutlookTariff]
    ) {
        self.points = points
        self.observedThrough = observedThrough
        self.complete = complete
        self.tariffTimeline = tariffTimeline
    }
}
