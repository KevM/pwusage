import Foundation

struct ScenarioCosts: Equatable, Sendable {
    let recorded: Double
    let batteryFixed: Double
    let solarAlone: Double
    let noSolar: Double

    static let zero = ScenarioCosts(recorded: 0, batteryFixed: 0, solarAlone: 0, noSolar: 0)

    static func + (lhs: ScenarioCosts, rhs: ScenarioCosts) -> ScenarioCosts {
        ScenarioCosts(
            recorded: lhs.recorded + rhs.recorded,
            batteryFixed: lhs.batteryFixed + rhs.batteryFixed,
            solarAlone: lhs.solarAlone + rhs.solarAlone,
            noSolar: lhs.noSolar + rhs.noSolar
        )
    }
}

struct SavingsFigures: Equatable, Sendable {
    let costs: ScenarioCosts
    var total: Double { costs.noSolar - costs.recorded }
    var solar: Double { costs.noSolar - costs.solarAlone }
    var powerwallAndRatePlan: Double { costs.solarAlone - costs.recorded }
    var fixedRateSystem: Double { costs.noSolar - costs.batteryFixed }
    var fixedRateSolarAlone: Double { costs.noSolar - costs.solarAlone }
    let daysWithData: Int
    let daysInPeriod: Int
}

struct SavingsReport: Equatable, Sendable {
    let cycle: SavingsFigures
    let year: SavingsFigures
    let lifetime: SavingsFigures
    let cycleStart: Date
}

enum SavingsCalculator {
    private struct BucketKey: Hashable {
        let planName: String
        let periodName: String
        let buyRate: Double
        let sellRate: Double
    }

    private struct CycleResult {
        let start: Date
        let end: Date
        let costs: ScenarioCosts
        let daysWithData: Int
    }

    private struct CyclePricingContext {
        let scenarios: SavingsScenarioDays
        let actual: RatePeriodResolver
        let reference: RatePeriodResolver
        let now: Date
    }

    private final class BucketMap {
        private var buckets: [BillUsageBucket] = []
        private var indexByKey: [BucketKey: Int] = [:]

        func add(resolved: ResolvedRatePeriod, gridWh: Double) {
            let key = BucketKey(
                planName: resolved.planName,
                periodName: resolved.periodName,
                buyRate: resolved.buyRate,
                sellRate: resolved.sellRate
            )
            if let index = indexByKey[key] {
                buckets[index].gridWh += gridWh
            } else {
                indexByKey[key] = buckets.count
                buckets.append(BillUsageBucket(
                    planName: resolved.planName,
                    periodName: resolved.periodName,
                    buyRate: resolved.buyRate,
                    sellRate: resolved.sellRate,
                    gridWh: gridWh,
                    loadWh: 0,
                    solarWh: 0
                ))
            }
        }

        func totalCost() -> Double {
            guard !buckets.isEmpty else { return 0 }
            return BillPricing.costs(buckets).reduce(0, +)
        }
    }

    static func compute(
        scenarios: SavingsScenarioDays,
        actual: RatePeriodResolver,
        reference: RatePeriodResolver,
        billingDay: Int,
        now: Date
    ) -> SavingsReport {
        let timeZone = actual.siteTimeZone
        let currentCycle = BillingCycle.current(billingDay: billingDay, now: now, timeZone: timeZone)
        let firstDayStart = scenarios.recorded.first?.dayStart ?? currentCycle.start
        let allCycles = BillingCycle.cycles(
            billingDay: billingDay,
            from: firstDayStart,
            through: now,
            timeZone: timeZone
        )

        let context = CyclePricingContext(scenarios: scenarios, actual: actual, reference: reference, now: now)
        let cycleResults = priceAllCycles(allCycles, context: context)
        let currentResult = cycleResults.last ?? CycleResult(
            start: currentCycle.start,
            end: currentCycle.end,
            costs: .zero,
            daysWithData: 0
        )

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let firstStoredDay = scenarios.recorded.first?.dayStart

        return SavingsReport(
            cycle: makeFigures(from: [currentResult], firstStoredDay: firstStoredDay, now: now, calendar: calendar),
            year: makeFigures(
                from: Array(cycleResults.suffix(12)),
                firstStoredDay: firstStoredDay,
                now: now,
                calendar: calendar
            ),
            lifetime: makeFigures(from: cycleResults, firstStoredDay: firstStoredDay, now: now, calendar: calendar),
            cycleStart: currentCycle.start
        )
    }

    private static func priceAllCycles(
        _ cycles: [(start: Date, end: Date)],
        context: CyclePricingContext
    ) -> [CycleResult] {
        var dayCursor = 0
        var results: [CycleResult] = []
        results.reserveCapacity(cycles.count)

        for cycle in cycles {
            while dayCursor < context.scenarios.recorded.count,
                  context.scenarios.recorded[dayCursor].dayStart.addingTimeInterval(25 * 3600) < cycle.start {
                dayCursor += 1
            }
            results.append(priceCycle(cycle: cycle, startIndex: dayCursor, context: context))
        }
        return results
    }

    private static func priceCycle(
        cycle: (start: Date, end: Date),
        startIndex: Int,
        context: CyclePricingContext
    ) -> CycleResult {
        let recordedBuckets = BucketMap()
        let batteryFixedBuckets = BucketMap()
        let solarAloneBuckets = BucketMap()
        let noSolarBuckets = BucketMap()
        var daysWithData = 0

        for dayIndex in startIndex ..< context.scenarios.recorded.count {
            let day = context.scenarios.recorded[dayIndex]
            if day.dayStart >= cycle.end { break }
            let dayBatteryFixed = context.scenarios.batteryFixed[dayIndex]
            let daySolarAlone = context.scenarios.solarAlone[dayIndex]
            let dayNoSolar = context.scenarios.noSolar[dayIndex]

            var hasRecordedSlot = false
            for (slotIndex, maybeGrid) in day.gridWh.enumerated() {
                guard let grid1 = maybeGrid else { continue }
                let instant = day.dayStart.addingTimeInterval(TimeInterval(slotIndex) * 300)
                guard instant >= cycle.start, instant < cycle.end else { continue }

                hasRecordedSlot = true
                let actualPeriod = context.actual.period(at: instant)
                let refPeriod = context.reference.period(at: instant)

                recordedBuckets.add(resolved: actualPeriod, gridWh: Double(grid1))
                if let grid2 = dayBatteryFixed.gridWh[slotIndex] {
                    batteryFixedBuckets.add(resolved: refPeriod, gridWh: Double(grid2))
                }
                if let grid3 = daySolarAlone.gridWh[slotIndex] {
                    solarAloneBuckets.add(resolved: refPeriod, gridWh: Double(grid3))
                }
                if let grid4 = dayNoSolar.gridWh[slotIndex] {
                    noSolarBuckets.add(resolved: refPeriod, gridWh: Double(grid4))
                }
            }
            if hasRecordedSlot, day.dayStart <= context.now {
                daysWithData += 1
            }
        }

        return CycleResult(
            start: cycle.start,
            end: cycle.end,
            costs: ScenarioCosts(
                recorded: recordedBuckets.totalCost(),
                batteryFixed: batteryFixedBuckets.totalCost(),
                solarAlone: solarAloneBuckets.totalCost(),
                noSolar: noSolarBuckets.totalCost()
            ),
            daysWithData: daysWithData
        )
    }

    private static func makeFigures(
        from results: [CycleResult],
        firstStoredDay: Date?,
        now: Date,
        calendar: Calendar
    ) -> SavingsFigures {
        let totalCosts = results.reduce(.zero) { $0 + $1.costs }
        let daysWithData = results.reduce(0) { $0 + $1.daysWithData }
        let periodStart = results.first?.start ?? now
        let effectiveStart = firstStoredDay.map { max(periodStart, $0) } ?? periodStart
        let startDay = calendar.startOfDay(for: effectiveStart)
        let today = calendar.startOfDay(for: now)
        let daysInPeriod = max(
            0,
            (calendar.dateComponents([.day], from: startDay, to: today).day ?? 0) + 1
        )
        return SavingsFigures(
            costs: totalCosts,
            daysWithData: daysWithData,
            daysInPeriod: daysInPeriod
        )
    }
}
