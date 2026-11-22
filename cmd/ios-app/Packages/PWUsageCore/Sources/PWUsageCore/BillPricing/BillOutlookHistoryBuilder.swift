import Foundation

public enum BillOutlookHistoryBuilder {
    private static let slotSeconds: TimeInterval = 300

    private struct BucketKey: Hashable {
        let tariffName: String
        let periodName: String
        let buyRate: Double
        let sellRate: Double
    }

    private struct PeriodKey: Hashable {
        let tariffName: String
        let periodName: String
    }

    public struct Input {
        public let days: [EnergyFlowDay]
        public let cycleStart: Date
        public let cycleEnd: Date
        public let now: Date
        public let resolver: RatePeriodResolver
        public let timeZone: TimeZone

        public init(
            days: [EnergyFlowDay],
            cycleStart: Date,
            cycleEnd: Date,
            now: Date,
            resolver: RatePeriodResolver,
            timeZone: TimeZone
        ) {
            self.days = days
            self.cycleStart = cycleStart
            self.cycleEnd = cycleEnd
            self.now = now
            self.resolver = resolver
            self.timeZone = timeZone
        }
    }

    public static func build(_ input: Input) -> BillOutlookHistory? {
        guard let lastTimestamp = lastObservedSlotStart(
            in: input.days,
            cycleStart: input.cycleStart,
            cycleEnd: input.cycleEnd
        ) else {
            return nil
        }
        let cutoff = min(lastTimestamp.addingTimeInterval(slotSeconds), input.cycleEnd)
        let points = buildPoints(input: input, cutoff: cutoff)
        let tariffTimeline = buildTariffTimeline(
            resolver: input.resolver,
            from: cutoff,
            to: input.cycleEnd,
            requiredEnd: min(input.now, input.cycleEnd)
        )

        return BillOutlookHistory(
            points: points,
            observedThrough: cutoff,
            complete: points.last?.complete ?? false,
            tariffTimeline: tariffTimeline
        )
    }

    private static func buildPoints(input: Input, cutoff: Date) -> [BillOutlookPoint] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = input.timeZone

        var cumulativeBuckets: [BillOutlookBucket] = []
        var bucketIndexByKey: [BucketKey: Int] = [:]
        var runningComplete = true
        var points: [BillOutlookPoint] = [
            BillOutlookPoint(date: input.cycleStart, buckets: [], complete: true, estimatedCost: 0, periods: [])
        ]

        var dayStart = input.cycleStart
        while dayStart < cutoff {
            // 36 hours from local midnight always falls on the following local calendar day, including DST.
            let next = calendar.startOfDay(for: dayStart.addingTimeInterval(36 * 3600))
            let through = min(next, cutoff)
            let overlappingDays = input.days.filter {
                $0.dayStart < through && $0.dayStart.addingTimeInterval(26 * 3600) > dayStart
            }
            let dayBuckets = BillUsageAggregator.buckets(
                days: overlappingDays,
                from: dayStart,
                to: through,
                resolver: input.resolver
            )
            runningComplete = runningComplete && isWindowComplete(days: overlappingDays, from: dayStart, to: through)

            merge(dayBuckets, into: &cumulativeBuckets, indexByKey: &bucketIndexByKey)
            points.append(BillOutlookPoint(
                date: through,
                buckets: cumulativeBuckets,
                complete: runningComplete,
                estimatedCost: cost(cumulativeBuckets),
                periods: summarizePeriods(cumulativeBuckets)
            ))
            dayStart = next
        }
        return points
    }

    /// Mirrors priceBillUsage: merge rate buckets first, then proportionally net each plan/period.
    public static func cost(_ buckets: [BillOutlookBucket]) -> Double {
        Dictionary(grouping: merged(buckets), by: \.key).values.reduce(0) { total, group in
            let imports = group.reduce(0) { $0 + max($1.netGridKwh, 0) }
            let exports = group.reduce(0) { $0 + max(-$1.netGridKwh, 0) }
            let net = imports - exports
            return total + group.reduce(0) { sum, bucket in
                if net > 0 && bucket.netGridKwh > 0 {
                    return sum + bucket.netGridKwh * (net / imports) * bucket.buyRate
                }
                if net < 0 && bucket.netGridKwh < 0 {
                    return sum + bucket.netGridKwh * (-net / exports) * abs(bucket.sellRate)
                }
                return sum
            }
        }
    }

    public static func merged(_ buckets: [BillOutlookBucket]) -> [BillOutlookBucket] {
        var result: [BillOutlookBucket] = []
        for bucket in buckets {
            if let index = result.firstIndex(where: {
                $0.key == bucket.key && $0.buyRate == bucket.buyRate && $0.sellRate == bucket.sellRate
            }) {
                result[index].netGridKwh += bucket.netGridKwh
            } else { result.append(bucket) }
        }
        return result
    }

    private static func buildTariffTimeline(
        resolver: RatePeriodResolver,
        from start: Date,
        to end: Date,
        requiredEnd: Date
    ) -> [BillOutlookTariff] {
        LoadTimingTimelineBuilder.segments(
            resolver: resolver,
            from: start,
            to: end,
            requiredEnd: requiredEnd
        ).map { segment in
            let resolved = resolver.period(at: segment.start)
            return BillOutlookTariff(
                start: segment.start,
                end: segment.end,
                periodKey: segment.periodKey,
                name: segment.name,
                buyRate: segment.buyRate,
                sellRate: segment.sellRate,
                tariffName: resolved.planName,
                periodName: resolved.periodName
            )
        }
    }

    private static func lastObservedSlotStart(
        in days: [EnergyFlowDay],
        cycleStart: Date,
        cycleEnd: Date
    ) -> Date? {
        var latest: Date?
        for day in days {
            for (slotIndex, maybeGrid) in day.gridWh.enumerated() where maybeGrid != nil {
                let instant = day.dayStart.addingTimeInterval(TimeInterval(slotIndex) * slotSeconds)
                guard instant >= cycleStart, instant < cycleEnd else { continue }
                if let currentLatest = latest {
                    if instant > currentLatest {
                        latest = instant
                    }
                } else {
                    latest = instant
                }
            }
        }
        return latest
    }

    private static func isWindowComplete(days: [EnergyFlowDay], from startDate: Date, to endDate: Date) -> Bool {
        let expected = Int((endDate.timeIntervalSince(startDate) / slotSeconds).rounded())
        guard expected > 0 else { return false }

        var observedInstants: Set<TimeInterval> = []
        observedInstants.reserveCapacity(expected)
        for day in days {
            for (slotIndex, maybeGrid) in day.gridWh.enumerated() where maybeGrid != nil {
                let instant = day.dayStart.addingTimeInterval(TimeInterval(slotIndex) * slotSeconds)
                if instant >= startDate, instant < endDate {
                    observedInstants.insert(instant.timeIntervalSince1970)
                }
            }
        }
        return observedInstants.count == expected
    }

    private static func merge(
        _ dayBuckets: [BillUsageBucket],
        into cumulative: inout [BillOutlookBucket],
        indexByKey: inout [BucketKey: Int]
    ) {
        for bucket in dayBuckets {
            let tariffName = bucket.planName.isEmpty ? "Unknown" : bucket.planName
            let periodName = bucket.periodName.isEmpty ? "Unknown" : bucket.periodName
            let key = BucketKey(
                tariffName: tariffName,
                periodName: periodName,
                buyRate: bucket.buyRate,
                sellRate: bucket.sellRate
            )
            let kwh = bucket.gridWh / 1000.0
            if let existingIndex = indexByKey[key] {
                cumulative[existingIndex].netGridKwh += kwh
            } else {
                indexByKey[key] = cumulative.count
                cumulative.append(BillOutlookBucket(
                    tariffName: tariffName,
                    periodName: periodName,
                    netGridKwh: kwh,
                    buyRate: bucket.buyRate,
                    sellRate: bucket.sellRate
                ))
            }
        }
    }

    private static func summarizePeriods(_ buckets: [BillOutlookBucket]) -> [BillOutlookPeriod] {
        var periods: [BillOutlookPeriod] = []
        var indexByKey: [PeriodKey: Int] = [:]
        for bucket in buckets {
            let key = PeriodKey(tariffName: bucket.tariffName, periodName: bucket.periodName)
            if let existingIndex = indexByKey[key] {
                periods[existingIndex].netGridKwh += bucket.netGridKwh
            } else {
                indexByKey[key] = periods.count
                periods.append(BillOutlookPeriod(
                    tariffName: bucket.tariffName,
                    periodName: bucket.periodName,
                    netGridKwh: bucket.netGridKwh
                ))
            }
        }
        return periods
    }
}
