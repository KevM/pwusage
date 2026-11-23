import Foundation
@testable import PWUsageCore
import Testing

@Suite("Savings coverage")
struct SavingsCoverageTests {
    private func period(_ id: Int, from: String = "2020-01-01", to end: String? = nil) -> TariffPeriodDTO {
        SavingsTestFixtures.makeFlatPeriod(
            id: id, name: "Plan \(id)", buyRate: 0.2, sellRate: 0.05, effectiveFrom: from, effectiveTo: end
        )
    }

    private func report(
        days: [String], actual: [TariffPeriodDTO]? = nil, reference: [TariffPeriodDTO]? = nil,
        incomplete: Set<String> = [], now: String = "2026-06-10"
    ) throws -> SavingsReport {
        let flows = try days.map { day in
            try SavingsTestFixtures.makeDay(
                day, solar: [0], load: [incomplete.contains(day) ? nil : 100], grid: [100]
            )
        }
        let timeline = SavingsTestFixtures.makeTimeline(
            actual: actual ?? [period(1)], reference: reference ?? [period(2)]
        )
        let parts = now.split(separator: "-").compactMap { Int($0) }
        return SavingsCalculator.compute(
            scenarios: SavingsScenarioFlows.build(days: flows, battery: nil),
            actual: try #require(RatePeriodResolver(timeline: timeline)),
            reference: try #require(RatePeriodResolver(referenceOf: timeline)),
            billingDay: 1,
            now: try SavingsTestFixtures.makeUTCDate(year: parts[0], month: parts[1], day: parts[2], hour: 12)
        )
    }

    private func juneDays(_ end: Int) -> [String] {
        (1 ... end).map { String(format: "2026-06-%02d", $0) }
    }

    @Test func completeCoverageHasNoGaps() throws {
        #expect(try report(days: juneDays(10)).cycle.coverageGaps.isEmpty)
    }

    @Test func fixedRatePlanStartingLateIsNoFixedRatePlan() throws {
        let cycle = try report(days: juneDays(10), reference: [period(2, from: "2026-06-05")]).cycle
        #expect(cycle.gap(.noFixedRatePlan) == SavingsCoverageGap(
            cause: .noFixedRatePlan, days: 4, ranges: [.init(first: "2026-06-01", last: "2026-06-04")],
            fixedRatePlanStart: "2026-06-05"
        ))
        #expect(cycle.gap(.noRatePlan) == nil)
    }

    @Test func missingRatePlanIsNoRatePlan() throws {
        let gap = try report(days: juneDays(10), actual: [period(1, from: "2026-06-04")]).cycle.gap(.noRatePlan)
        #expect(gap?.days == 3)
        #expect(gap?.ranges == [.init(first: "2026-06-01", last: "2026-06-03")])
        #expect(gap?.fixedRatePlanStart == nil)
    }

    @Test func dayMissingBothPlansAppearsInBothCauses() throws {
        let cycle = try report(days: juneDays(10), actual: [period(1, from: "2026-06-03")],
                               reference: [period(2, from: "2026-06-03")]).cycle
        #expect(cycle.gap(.noFixedRatePlan)?.days == 2)
        #expect(cycle.gap(.noRatePlan)?.days == 2)
    }

    @Test func incompleteSlotsAreNoDataNotPlanGaps() throws {
        let cycle = try report(days: juneDays(10), reference: [period(2, from: "2026-06-05")],
                               incomplete: ["2026-06-02"]).cycle
        #expect(cycle.gap(.noData)?.ranges == [.init(first: "2026-06-02", last: "2026-06-02")])
        #expect(cycle.gap(.noFixedRatePlan)?.days == 3)
    }

    @Test func missingStoredDaysAreNoData() throws {
        let gap = try report(days: ["2026-06-01", "2026-06-04"], now: "2026-06-04").cycle.gap(.noData)
        #expect(gap?.days == 2)
        #expect(gap?.ranges == [.init(first: "2026-06-02", last: "2026-06-03")])
    }

    @Test func runsBridgeNoDataDaysButBreakAtCountedDays() throws {
        let plans = [period(1, from: "2026-06-01", to: "2026-06-02"),
                     period(2, from: "2026-06-07", to: "2026-06-07"), period(3, from: "2026-06-09")]
        let cycle = try report(days: juneDays(10).filter { $0 != "2026-06-04" }, actual: plans).cycle
        #expect(cycle.gap(.noRatePlan)?.ranges == [
            .init(first: "2026-06-03", last: "2026-06-06"), .init(first: "2026-06-08", last: "2026-06-08")
        ])
        #expect(cycle.gap(.noRatePlan)?.days == 4)
        #expect(cycle.gap(.noData)?.days == 1)
    }

    @Test func fixedGapAfterReferenceEndsHasNoStart() throws {
        let gap = try report(days: juneDays(10), reference: [period(2, to: "2026-06-05")]).cycle.gap(.noFixedRatePlan)
        #expect(gap?.fixedRatePlanStart == nil)
        #expect(gap?.ranges == [.init(first: "2026-06-06", last: "2026-06-10")])
    }

    @Test func uncountedDaysPartitionThePeriod() throws {
        let actual = [period(1, to: "2026-06-06"), period(3, from: "2026-06-09")]
        let result = try report(days: juneDays(12).filter { $0 != "2026-06-10" }, actual: actual,
                                reference: [period(2, from: "2026-06-05")], now: "2026-06-12")
        for figures in [result.cycle, result.year, result.lifetime] {
            let missing = figures.coverageGaps.reduce(0) { $0 + $1.days }
            #expect(figures.daysWithData + missing == figures.daysInPeriod)
        }
    }

    @Test func midnightDaylightSavingTransitionCountsBothDays() throws {
        let zone = try #require(TimeZone(identifier: "America/Sao_Paulo"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let start = try #require(calendar.date(from: DateComponents(year: 2018, month: 11, day: 4)))
        let day = EnergyFlowDay(
            day: "2018-11-04", dayStart: start, solarWh: [0], loadWh: [100], gridWh: [100],
            batteryWh: [0], batterySoc: [nil]
        )
        let timeline = SavingsTestFixtures.makeTimeline(
            actual: [period(1, from: "2010-01-01")], reference: [period(2, from: "2010-01-01")],
            timezone: "America/Sao_Paulo"
        )
        let now = try #require(calendar.date(from: DateComponents(year: 2018, month: 11, day: 5, hour: 12)))
        let result = SavingsCalculator.compute(
            scenarios: SavingsScenarioFlows.build(days: [day], battery: nil),
            actual: try #require(RatePeriodResolver(timeline: timeline)),
            reference: try #require(RatePeriodResolver(referenceOf: timeline)), billingDay: 1, now: now
        )
        #expect(result.cycle.daysWithData == 1)
        #expect(result.cycle.daysInPeriod == 2)
        #expect(result.cycle.gap(.noData)?.days == 1)
    }

    @Test func estimatedDaysCountReferenceAndActualEstimates() throws {
        let actual = [
            SavingsTestFixtures.makeFlatPeriod(
                id: 1, name: "Estimate", buyRate: 0.2, sellRate: 0.05,
                effectiveFrom: "2020-01-01", effectiveTo: "2026-06-04", source: .estimated
            ),
            period(3, from: "2026-06-05")
        ]
        let estimatedReference = SavingsTestFixtures.makeFlatPeriod(
            id: 2, name: "Reference", buyRate: 0.2, sellRate: 0.05,
            effectiveFrom: "2026-06-08", source: .estimated
        )
        let reference = [period(4, to: "2026-06-07"), estimatedReference]
        let cycle = try report(days: juneDays(10), actual: actual, reference: reference).cycle
        #expect(cycle.estimatedDays == 7)
        #expect(cycle.daysWithData == 10)
    }

    @Test func estimatedPlansCountAsCoveredDays() throws {
        let estimate = SavingsTestFixtures.makeFlatPeriod(
            id: 3, name: "Estimate", buyRate: 0.2, sellRate: 0.05,
            effectiveFrom: "2026-06-05", source: .estimated
        )
        let cycle = try report(days: juneDays(10), actual: [period(1, to: "2026-06-04"), estimate]).cycle
        #expect(cycle.gap(.noRatePlan) == nil)
        #expect(cycle.daysWithData == 10)
        #expect(cycle.estimatedDays == 6)
    }

    @Test func sameNamedEstimatedThenManualSpansCountByPeriod() throws {
        let actual = [
            SavingsTestFixtures.makeFlatPeriod(
                id: 1, name: "Same", buyRate: 0.2, sellRate: 0.05,
                effectiveFrom: "2020-01-01", effectiveTo: "2026-06-04", source: .estimated
            ),
            SavingsTestFixtures.makeFlatPeriod(
                id: 3, name: "Same", buyRate: 0.2, sellRate: 0.05, effectiveFrom: "2026-06-05"
            )
        ]
        let cycle = try report(days: juneDays(10), actual: actual).cycle
        #expect(cycle.estimatedDays == 4)
        #expect(cycle.daysWithData == 10)
    }

    @Test func sameNamedManualThenEstimatedSpansCountByPeriod() throws {
        let actual = [
            SavingsTestFixtures.makeFlatPeriod(
                id: 1, name: "Same", buyRate: 0.2, sellRate: 0.05,
                effectiveFrom: "2020-01-01", effectiveTo: "2026-06-04"
            ),
            SavingsTestFixtures.makeFlatPeriod(
                id: 3, name: "Same", buyRate: 0.2, sellRate: 0.05, effectiveFrom: "2026-06-05", source: .estimated
            )
        ]
        let cycle = try report(days: juneDays(10), actual: actual).cycle
        #expect(cycle.estimatedDays == 6)
        #expect(cycle.daysWithData == 10)
    }

    @Test func manualPlansCountNoEstimatedDays() throws {
        #expect(try report(days: juneDays(10)).cycle.estimatedDays == 0)
    }

    @Test func yearAndLifetimeGapsSpanCycles() throws {
        let days = ["2026-04-29", "2026-04-30", "2026-05-01", "2026-05-02", "2026-05-31", "2026-06-01"]
        let result = try report(days: days, reference: [period(2, from: "2026-05-02")], now: "2026-06-01")
        #expect(result.lifetime.gap(.noFixedRatePlan)?.ranges == [
            .init(first: "2026-04-29", last: "2026-05-01")
        ])
        #expect(result.cycle.gap(.noFixedRatePlan) == nil)
        #expect(result.lifetime.gap(.noData)?.ranges == [.init(first: "2026-05-03", last: "2026-05-30")])
        #expect(result.year.gap(.noData)?.ranges == result.lifetime.gap(.noData)?.ranges)
    }
}
