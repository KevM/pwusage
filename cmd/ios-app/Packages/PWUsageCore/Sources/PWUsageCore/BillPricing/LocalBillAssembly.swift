import Foundation

/// Bill pricing and forecasts assembled from already loaded energy flows for one cycle.
public struct LocalBillAssembly {
    public struct PeriodTotal {
        public let tariffName: String
        public let periodName: String
        public let netGridKwh: Double
        public let cost: Double
    }

    public let estimatedCost: Double?
    public let periods: [PeriodTotal]
    public let energyDataThrough: Date?
    public let loadTiming: LoadTiming?
    public let outlook: BillOutlookHistory?

    private static let slotSeconds: TimeInterval = 300
    private static let timelineLookbackSeconds: TimeInterval = 60 * 60
    private static let loadTimingHorizonSeconds: TimeInterval = 7 * 24 * 60 * 60

    private struct BillSummary {
        let estimatedCost: Double?
        let periods: [PeriodTotal]
    }

    private struct LoadTimingInput {
        let buckets: [BillUsageBucket]
        let costs: [Double]
        let resolver: RatePeriodResolver
        let cycleEnd: Date
        let energyDataThrough: Date?
        let now: Date
        let timeZone: TimeZone
    }

    public static func compute(
        days flowDays: [EnergyFlowDay],
        cycle: (start: Date, end: Date),
        resolver: RatePeriodResolver,
        now: Date,
        timeZone: TimeZone
    ) -> Self {
        let buckets = BillUsageAggregator.buckets(days: flowDays, from: cycle.start, to: cycle.end, resolver: resolver)
        let costs = BillPricing.costs(buckets)
        let summary = Self.summarizeBill(buckets: buckets, costs: costs)
        let energyDataThrough = Self.lastNonNilSlotInstant(in: flowDays, cycleStart: cycle.start, cycleEnd: cycle.end)
        let loadTiming = Self.buildLoadTiming(LoadTimingInput(
            buckets: buckets,
            costs: costs,
            resolver: resolver,
            cycleEnd: cycle.end,
            energyDataThrough: energyDataThrough,
            now: now,
            timeZone: timeZone
        ))
        let outlook = BillOutlookHistoryBuilder.build(.init(
            days: flowDays,
            cycleStart: cycle.start,
            cycleEnd: cycle.end,
            now: now,
            resolver: resolver,
            timeZone: timeZone
        ))

        return Self(
            estimatedCost: summary.estimatedCost,
            periods: summary.periods,
            energyDataThrough: energyDataThrough,
            loadTiming: loadTiming,
            outlook: outlook
        )
    }

    private static func summarizeBill(buckets: [BillUsageBucket], costs: [Double]) -> BillSummary {
        guard !buckets.isEmpty else {
            return BillSummary(estimatedCost: nil, periods: [])
        }
        struct PeriodGroupKey: Hashable {
            let tariffName: String
            let periodName: String
        }
        var periods: [PeriodTotal] = []
        var indexByKey: [PeriodGroupKey: Int] = [:]
        var totalCost = 0.0

        for (bucket, cost) in zip(buckets, costs) {
            let tariffName = bucket.planName.isEmpty ? "Unknown" : bucket.planName
            let periodName = bucket.periodName.isEmpty ? "Unknown" : bucket.periodName
            let key = PeriodGroupKey(tariffName: tariffName, periodName: periodName)
            let kwh = bucket.gridWh / 1000.0
            totalCost += cost

            if let existingIndex = indexByKey[key] {
                let existing = periods[existingIndex]
                periods[existingIndex] = PeriodTotal(
                    tariffName: tariffName,
                    periodName: periodName,
                    netGridKwh: existing.netGridKwh + kwh,
                    cost: existing.cost + cost
                )
            } else {
                indexByKey[key] = periods.count
                periods.append(PeriodTotal(
                    tariffName: tariffName,
                    periodName: periodName,
                    netGridKwh: kwh,
                    cost: cost
                ))
            }
        }
        return BillSummary(estimatedCost: totalCost, periods: periods)
    }

    private static func buildLoadTiming(_ input: LoadTimingInput) -> LoadTiming? {
        guard let computed = LoadTimingCalculator.compute(
            buckets: input.buckets,
            costs: input.costs,
            resolver: input.resolver,
            now: input.now,
            timeZone: input.timeZone
        ) else {
            return nil
        }

        let clampedEnergyThrough = input.energyDataThrough.map { min($0, input.now) } ?? input.now
        let timelineStart = max(clampedEnergyThrough, input.now.addingTimeInterval(-timelineLookbackSeconds))
        let sevenDaysOut = input.now.addingTimeInterval(loadTimingHorizonSeconds)
        let segments = LoadTimingTimelineBuilder.segments(
            resolver: input.resolver,
            from: timelineStart,
            to: max(sevenDaysOut, input.cycleEnd),
            requiredEnd: sevenDaysOut
        )
        return LoadTiming(
            hasTariff: computed.hasTariff,
            hasCycleData: computed.hasCycleData,
            activeIsCheapest: computed.activeIsCheapest,
            periods: computed.periods,
            pricingPeriods: computed.pricingPeriods,
            tariffTimeline: segments,
            nextCheaper: computed.nextCheaper,
            nextCheaperPhrase: computed.nextCheaperPhrase,
            nextStartPhraseByKey: computed.nextStartPhraseByKey
        )
    }

    public static func lastNonNilSlotInstant(
        in days: [EnergyFlowDay],
        cycleStart: Date,
        cycleEnd: Date
    ) -> Date? {
        var latest: Date?
        for day in days {
            for (slotIndex, maybeGrid) in day.gridWh.enumerated() where maybeGrid != nil {
                let instant = day.dayStart.addingTimeInterval(TimeInterval(slotIndex) * slotSeconds)
                guard instant >= cycleStart, instant < cycleEnd else { continue }
                if let current = latest {
                    if instant > current { latest = instant }
                } else {
                    latest = instant
                }
            }
        }
        return latest
    }
}
