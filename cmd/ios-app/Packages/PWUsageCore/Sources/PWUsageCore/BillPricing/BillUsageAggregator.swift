import Foundation

public struct BillUsageBucket: Equatable, Sendable {
    public let planName: String
    public let periodName: String
    public let buyRate: Double
    public let sellRate: Double
    public var gridWh: Double
    public var loadWh: Double
    public var solarWh: Double

    public init(
        planName: String,
        periodName: String,
        buyRate: Double,
        sellRate: Double,
        gridWh: Double,
        loadWh: Double,
        solarWh: Double
    ) {
        self.planName = planName
        self.periodName = periodName
        self.buyRate = buyRate
        self.sellRate = sellRate
        self.gridWh = gridWh
        self.loadWh = loadWh
        self.solarWh = solarWh
    }
}

public enum BillUsageAggregator {
    private struct BucketKey: Hashable {
        let planName: String
        let periodName: String
        let buyRate: Double
        let sellRate: Double
    }

    public static func buckets(
        days: [EnergyFlowDay],
        from startDate: Date,
        to endDate: Date,
        resolver: RatePeriodResolver
    ) -> [BillUsageBucket] {
        var result: [BillUsageBucket] = []
        var indexByKey: [BucketKey: Int] = [:]

        for day in days {
            for (slotIndex, maybeGrid) in day.gridWh.enumerated() {
                guard let grid = maybeGrid else { continue }
                let instant = day.dayStart.addingTimeInterval(TimeInterval(slotIndex) * 300)
                guard instant >= startDate, instant < endDate else { continue }

                let resolved = resolver.period(at: instant)
                let key = BucketKey(
                    planName: resolved.planName,
                    periodName: resolved.periodName,
                    buyRate: resolved.buyRate,
                    sellRate: resolved.sellRate
                )
                let solar = slotIndex < day.solarWh.count ? Double(day.solarWh[slotIndex] ?? 0) : 0
                let load = slotIndex < day.loadWh.count ? Double(day.loadWh[slotIndex] ?? 0) : 0

                if let existingIndex = indexByKey[key] {
                    result[existingIndex].gridWh += Double(grid)
                    result[existingIndex].loadWh += load
                    result[existingIndex].solarWh += solar
                } else {
                    indexByKey[key] = result.count
                    result.append(BillUsageBucket(
                        planName: resolved.planName,
                        periodName: resolved.periodName,
                        buyRate: resolved.buyRate,
                        sellRate: resolved.sellRate,
                        gridWh: Double(grid),
                        loadWh: load,
                        solarWh: solar
                    ))
                }
            }
        }
        return result
    }
}
