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

enum SavingsGapCause: Equatable, Sendable {
    case noFixedRatePlan, noRatePlan, noData
}

struct SavingsDayRange: Equatable, Sendable {
    let first: String
    let last: String
}

struct SavingsCoverageGap: Equatable, Sendable {
    let cause: SavingsGapCause
    let days: Int
    let ranges: [SavingsDayRange]
    let fixedRatePlanStart: String?
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
    var coverageGaps: [SavingsCoverageGap] = []
    /// Counted days with at least one slot priced on an estimated actual or reference plan.
    var estimatedDays: Int = 0

    func gap(_ cause: SavingsGapCause) -> SavingsCoverageGap? {
        coverageGaps.first { $0.cause == cause }
    }
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

    private enum DayStatus {
        case counted
        case uncounted(missingRatePlan: Bool, missingFixedRatePlan: Bool)
    }

    private struct CycleResult {
        let start: Date
        let end: Date
        let costs: ScenarioCosts
        let daysWithData: Int
        let estimatedDays: Int
        let dayStatuses: [String: DayStatus]
    }

    private struct CycleBuckets {
        let recorded = BucketMap()
        let batteryFixed = BucketMap()
        let solarAlone = BucketMap()
        let noSolar = BucketMap()
    }

    private struct DayTally {
        var hasRecordedSlot = false
        var missingRatePlan = false
        var missingFixedRatePlan = false
        var usesEstimate = false
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
            daysWithData: 0,
            estimatedDays: 0,
            dayStatuses: [:]
        )

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let firstStoredDay = scenarios.recorded.first?.dayStart

        return SavingsReport(
            cycle: makeFigures(
                from: [currentResult], firstStoredDay: firstStoredDay, now: now,
                calendar: calendar, reference: reference
            ),
            year: makeFigures(
                from: Array(cycleResults.suffix(12)),
                firstStoredDay: firstStoredDay,
                now: now,
                calendar: calendar,
                reference: reference
            ),
            lifetime: makeFigures(
                from: cycleResults, firstStoredDay: firstStoredDay, now: now,
                calendar: calendar, reference: reference
            ),
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
        let buckets = CycleBuckets()
        var daysWithData = 0
        var estimatedDays = 0
        var dayStatuses: [String: DayStatus] = [:]

        for dayIndex in startIndex ..< context.scenarios.recorded.count {
            let day = context.scenarios.recorded[dayIndex]
            if day.dayStart >= cycle.end { break }
            guard day.dayStart >= cycle.start else { continue }
            let tally = priceDay(dayIndex, cycle: cycle, context: context, buckets: buckets)
            if tally.hasRecordedSlot, day.dayStart <= context.now {
                daysWithData += 1
                if tally.usesEstimate { estimatedDays += 1 }
                dayStatuses[day.day] = .counted
            } else {
                dayStatuses[day.day] = .uncounted(
                    missingRatePlan: tally.missingRatePlan, missingFixedRatePlan: tally.missingFixedRatePlan
                )
            }
        }

        return CycleResult(
            start: cycle.start,
            end: cycle.end,
            costs: costs(buckets),
            daysWithData: daysWithData,
            estimatedDays: estimatedDays,
            dayStatuses: dayStatuses
        )
    }

    /// Prices the slots of one stored day that fall inside `cycle` into `buckets`.
    private static func priceDay(
        _ dayIndex: Int,
        cycle: (start: Date, end: Date),
        context: CyclePricingContext,
        buckets: CycleBuckets
    ) -> DayTally {
        let day = context.scenarios.recorded[dayIndex]
        let dayBatteryFixed = context.scenarios.batteryFixed[dayIndex]
        let daySolarAlone = context.scenarios.solarAlone[dayIndex]
        let dayNoSolar = context.scenarios.noSolar[dayIndex]
        var tally = DayTally()

        for (slotIndex, maybeGrid) in day.gridWh.enumerated() {
            guard let grid1 = maybeGrid else { continue }
            let instant = day.dayStart.addingTimeInterval(TimeInterval(slotIndex) * 300)
            guard instant >= cycle.start, instant < cycle.end else { continue }

            guard let grid2 = dayBatteryFixed.gridWh[slotIndex],
                  let grid3 = daySolarAlone.gridWh[slotIndex],
                  let grid4 = dayNoSolar.gridWh[slotIndex] else { continue }
            let actual = context.actual.matchedPeriod(at: instant, strict: true)
            let reference = context.reference.matchedPeriod(at: instant, strict: true)
            let actualPeriod = actual.resolved
            let refPeriod = reference.resolved
            tally.missingRatePlan = tally.missingRatePlan || actualPeriod == .unknown
            tally.missingFixedRatePlan = tally.missingFixedRatePlan || refPeriod == .unknown
            guard actualPeriod != .unknown, refPeriod != .unknown else { continue }

            tally.hasRecordedSlot = true
            tally.usesEstimate = tally.usesEstimate || actual.isEstimated || reference.isEstimated

            buckets.recorded.add(resolved: actualPeriod, gridWh: Double(grid1))
            buckets.batteryFixed.add(resolved: refPeriod, gridWh: Double(grid2))
            buckets.solarAlone.add(resolved: refPeriod, gridWh: Double(grid3))
            buckets.noSolar.add(resolved: refPeriod, gridWh: Double(grid4))
        }
        return tally
    }

    private static func costs(_ buckets: CycleBuckets) -> ScenarioCosts {
        ScenarioCosts(
            recorded: buckets.recorded.totalCost(), batteryFixed: buckets.batteryFixed.totalCost(),
            solarAlone: buckets.solarAlone.totalCost(), noSolar: buckets.noSolar.totalCost()
        )
    }

    private static func makeFigures(
        from results: [CycleResult],
        firstStoredDay: Date?,
        now: Date,
        calendar: Calendar,
        reference: RatePeriodResolver
    ) -> SavingsFigures {
        let totalCosts = results.reduce(.zero) { $0 + $1.costs }
        let daysWithData = results.reduce(0) { $0 + $1.daysWithData }
        let estimatedDays = results.reduce(0) { $0 + $1.estimatedDays }
        let periodStart = results.first?.start ?? now
        let effectiveStart = firstStoredDay.map { max(periodStart, $0) } ?? periodStart
        let startDay = calendar.startOfDay(for: effectiveStart)
        let today = calendar.startOfDay(for: now)
        let coverage = coverageGaps(
            results: results, startDay: startDay, today: today, calendar: calendar,
            fixedRatePlanStart: reference.earliestEffectiveFrom
        )
        return SavingsFigures(
            costs: totalCosts,
            daysWithData: daysWithData,
            daysInPeriod: coverage.daysInPeriod,
            coverageGaps: coverage.gaps,
            estimatedDays: estimatedDays
        )
    }

    private static func coverageGaps(
        results: [CycleResult], startDay: Date, today: Date, calendar: Calendar, fixedRatePlanStart: String?
    ) -> (daysInPeriod: Int, gaps: [SavingsCoverageGap]) {
        let statuses = results.reduce(into: [String: DayStatus]()) { merged, result in
            merged.merge(result.dayStatuses) { _, new in new }
        }
        var days: [(String, DayStatus?)] = []
        var date = startDay
        while date <= today {
            let day = RatePlanTimelineFormatting.formatYMD(date, in: calendar.timeZone)
            days.append((day, statuses[day]))
            guard let next = calendar.date(byAdding: .day, value: 1, to: date) else { break }
            date = calendar.startOfDay(for: next)
        }
        let gaps = [SavingsGapCause.noFixedRatePlan, .noRatePlan, .noData].compactMap { cause in
            makeGap(cause, days: days, fixedRatePlanStart: fixedRatePlanStart)
        }
        return (days.count, gaps)
    }

    private static func matches(_ cause: SavingsGapCause, status: DayStatus?) -> Bool {
        switch (cause, status) {
        case (.noFixedRatePlan, .uncounted(_, let missing)): missing
        case (.noRatePlan, .uncounted(let missing, _)): missing
        case (.noData, .none), (.noData, .uncounted(false, false)): true
        default: false
        }
    }

    private static func makeGap(
        _ cause: SavingsGapCause, days: [(String, DayStatus?)], fixedRatePlanStart: String?
    ) -> SavingsCoverageGap? {
        var ranges: [SavingsDayRange] = []
        var first: String?
        var last: String?
        var count = 0
        for (day, status) in days {
            if case .counted = status {
                if let first, let last { ranges.append(.init(first: first, last: last)) }
                first = nil
                last = nil
                continue
            }
            if matches(cause, status: status) {
                count += 1
                if first == nil { first = day }
                last = day
            }
        }
        if let first, let last { ranges.append(.init(first: first, last: last)) }
        guard count > 0 else { return nil }
        let start = cause == .noFixedRatePlan && (ranges.last?.last ?? "") < (fixedRatePlanStart ?? "")
            ? fixedRatePlanStart : nil
        return SavingsCoverageGap(cause: cause, days: count, ranges: ranges, fixedRatePlanStart: start)
    }
}
