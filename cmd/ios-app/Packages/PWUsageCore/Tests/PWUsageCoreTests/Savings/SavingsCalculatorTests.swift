import Foundation
@testable import PWUsageCore
import Testing

@Suite("Savings Calculator")
struct SavingsCalculatorTests {
    @Test("Cycle recorded cost matches the server bill fixture")
    func cycleRecordedCostMatchesServerBill() throws {
        let fixture = try BillPricingFixture.load("single-plan-cycle")
        let expectedCost = try #require(fixture.expected.currentBill.estimatedCost)
        let flowDays = fixture.days.map { $0.asEnergyFlowDay() }
        let refTimeline = SavingsTestFixtures.withReference(timeline: fixture.timeline, buyRate: 0.14, sellRate: 0.04)
        let actualResolver = try #require(RatePeriodResolver(timeline: fixture.timeline))
        let refResolver = try #require(RatePeriodResolver(referenceOf: refTimeline))

        let scenarios = SavingsScenarioFlows.build(days: flowDays, battery: nil)
        let report = SavingsCalculator.compute(
            scenarios: scenarios,
            actual: actualResolver,
            reference: refResolver,
            billingDay: fixture.billingDay,
            now: fixture.now
        )

        #expect(abs(report.cycle.costs.recorded - expectedCost) < 1e-6)
    }

    @Test("Solar and Powerwall/rate-plan breakdown sums to total savings")
    func breakdownSumsToTotal() throws {
        let day = try SavingsTestFixtures.makeDay(
            "2026-06-10",
            solar: [1_000, 0],
            load: [500, 1_000],
            grid: [-500, 500],
            battery: [0, -500]
        )
        let timeline = SavingsTestFixtures.makeTimeline(actualBuy: 0.30, actualSell: 0.05, refBuy: 0.15, refSell: 0.03)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let battery = SiteBatteryDTO(nameplateEnergyWh: 13_500, nameplatePowerW: 5_000, backupReservePercent: 20)
        let scenarios = SavingsScenarioFlows.build(days: [day], battery: battery)
        let now = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 6, day: 15, hour: 12)

        let report = SavingsCalculator.compute(
            scenarios: scenarios,
            actual: actual,
            reference: reference,
            billingDay: 1,
            now: now
        )

        #expect(abs((report.cycle.solar + report.cycle.powerwallAndRatePlan) - report.cycle.total) < 1e-9)
        #expect(abs((report.year.solar + report.year.powerwallAndRatePlan) - report.year.total) < 1e-9)
        #expect(abs((report.lifetime.solar + report.lifetime.powerwallAndRatePlan) - report.lifetime.total) < 1e-9)
    }

    @Test("Netting stays inside each billing cycle")
    func nettingStaysInsideEachCycle() throws {
        // Cycle 1 (May): net export 10 kWh -> credit -0.30 (at sellRate 0.03)
        let mayDay = try SavingsTestFixtures.makeDay(
            "2026-05-10",
            solar: [10_000],
            load: [0],
            grid: [-10_000]
        )
        // Cycle 2 (June): net import 10 kWh -> cost +2.00 (at buyRate 0.20)
        let juneDay = try SavingsTestFixtures.makeDay(
            "2026-06-10",
            solar: [0],
            load: [10_000],
            grid: [10_000]
        )
        let timeline = SavingsTestFixtures.makeTimeline(actualBuy: 0.20, actualSell: 0.03, refBuy: 0.20, refSell: 0.03)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let scenarios = SavingsScenarioFlows.build(days: [mayDay, juneDay], battery: nil)
        let now = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 6, day: 15, hour: 12)

        let report = SavingsCalculator.compute(
            scenarios: scenarios,
            actual: actual,
            reference: reference,
            billingDay: 1,
            now: now
        )

        // If cycles netted together, cost would be 0. Separately: -0.30 + 2.00 = 1.70.
        #expect(abs(report.lifetime.costs.recorded - 1.70) < 1e-9)
        #expect(abs(report.cycle.costs.recorded - 2.00) < 1e-9)
    }

    @Test("Year period includes only the 12 billing cycles ending with the current one")
    func yearIsTwelveCyclesEndingNow() throws {
        var days: [EnergyFlowDay] = []
        // 14 months: 2025-05 through 2026-06. Each day imports 10 kWh at $0.10/kWh = $1.00.
        for offset in 0 ..< 14 {
            let year = 2025 + (4 + offset) / 12
            let month = (4 + offset) % 12 + 1
            days.append(try SavingsTestFixtures.makeDay(
                String(format: "%04d-%02d-10", year, month),
                solar: [0],
                load: [10_000],
                grid: [10_000]
            ))
        }
        let timeline = SavingsTestFixtures.makeTimeline(actualBuy: 0.10, actualSell: 0.03, refBuy: 0.10, refSell: 0.03)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let scenarios = SavingsScenarioFlows.build(days: days, battery: nil)
        let now = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 6, day: 15, hour: 12)

        let report = SavingsCalculator.compute(
            scenarios: scenarios,
            actual: actual,
            reference: reference,
            billingDay: 1,
            now: now
        )

        #expect(abs(report.cycle.costs.recorded - 1.0) < 1e-9)
        #expect(abs(report.year.costs.recorded - 12.0) < 1e-9)
        #expect(abs(report.lifetime.costs.recorded - 14.0) < 1e-9)
    }

    @Test("Savings can exceed no-solar cost when recorded bill is a net credit")
    func savingsCanExceedNoSolarCostWhenBillIsCredit() throws {
        let day = try SavingsTestFixtures.makeDay(
            "2026-06-10",
            solar: [20_000],
            load: [5_000],
            grid: [-15_000]
        )
        let timeline = SavingsTestFixtures.makeTimeline(actualBuy: 0.15, actualSell: 0.10, refBuy: 0.15, refSell: 0.10)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let scenarios = SavingsScenarioFlows.build(days: [day], battery: nil)
        let now = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 6, day: 15, hour: 12)

        let report = SavingsCalculator.compute(
            scenarios: scenarios,
            actual: actual,
            reference: reference,
            billingDay: 1,
            now: now
        )

        // noSolar cost = 5 kWh * 0.15 = 0.75; recorded = -15 kWh * 0.10 = -1.50; total savings = 2.25 > 0.75
        #expect(report.cycle.costs.recorded < 0)
        #expect(report.cycle.total > report.cycle.costs.noSolar)
        #expect(abs(report.cycle.total - 2.25) < 1e-9)
    }

    @Test("Coverage counts site-local days with recorded grid data and total days in period")
    func coverageCountsDaysWithData() throws {
        let day1 = try SavingsTestFixtures.makeDay("2026-06-02", solar: [0], load: [100], grid: [100])
        let day2 = try SavingsTestFixtures.makeDay("2026-06-05", solar: [0], load: [100], grid: [nil])
        let day3 = try SavingsTestFixtures.makeDay("2026-06-08", solar: [0], load: [100], grid: [200])
        let timeline = SavingsTestFixtures.makeTimeline(actualBuy: 0.15, actualSell: 0.05, refBuy: 0.15, refSell: 0.05)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let scenarios = SavingsScenarioFlows.build(days: [day1, day2, day3], battery: nil)
        let now = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 6, day: 10, hour: 12)

        let report = SavingsCalculator.compute(
            scenarios: scenarios,
            actual: actual,
            reference: reference,
            billingDay: 1,
            now: now
        )

        #expect(report.cycle.daysWithData == 2)
        #expect(report.cycle.daysInPeriod == 9)
    }

    @Test("Days before reference plan effectiveFrom are excluded from costs and daysWithData")
    func excludesDaysBeforeReferenceEffectiveFrom() throws {
        let beforePlan = try SavingsTestFixtures.makeDay("2025-06-05", solar: [0], load: [1_000], grid: [1_000])
        let duringPlan = try SavingsTestFixtures.makeDay("2026-06-05", solar: [1_000], load: [1_000], grid: [0])
        let timeline = SavingsTestFixtures.makeTimeline(
            actualBuy: 0.20,
            actualSell: 0.05,
            refBuy: 0.30,
            refSell: 0.05,
            actualEffectiveFrom: "2025-01-01",
            refEffectiveFrom: "2026-01-01"
        )
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let scenarios = SavingsScenarioFlows.build(days: [beforePlan, duringPlan], battery: nil)
        let now = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 6, day: 10, hour: 12)

        let report = SavingsCalculator.compute(
            scenarios: scenarios,
            actual: actual,
            reference: reference,
            billingDay: 1,
            now: now
        )

        // Only 2026-06-05 is covered by both plans: 1 kWh noSolar @ $0.30 vs $0 recorded = $0.30 savings.
        #expect(report.lifetime.daysWithData == 1)
        #expect(report.lifetime.gap(.noFixedRatePlan)?.fixedRatePlanStart == "2026-01-01")
        #expect(abs(report.lifetime.costs.recorded) < 1e-9)
        #expect(abs(report.lifetime.costs.noSolar - 0.30) < 1e-9)
        #expect(abs(report.lifetime.total - 0.30) < 1e-9)
    }

    @Test("Slots with grid data but nil home usage are skipped across all four scenarios")
    func skipsSlotsWithNilHomeUsage() throws {
        let missingLoadDay = try SavingsTestFixtures.makeDay("2026-06-04", solar: [0], load: [nil], grid: [1_000])
        let validDay = try SavingsTestFixtures.makeDay("2026-06-05", solar: [1_000], load: [1_000], grid: [0])
        let timeline = SavingsTestFixtures.makeTimeline(actualBuy: 0.20, actualSell: 0.05, refBuy: 0.30, refSell: 0.05)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let scenarios = SavingsScenarioFlows.build(days: [missingLoadDay, validDay], battery: nil)
        let now = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 6, day: 10, hour: 12)

        let report = SavingsCalculator.compute(
            scenarios: scenarios,
            actual: actual,
            reference: reference,
            billingDay: 1,
            now: now
        )

        #expect(report.lifetime.daysWithData == 1)
        #expect(abs(report.lifetime.costs.recorded) < 1e-9)
        #expect(abs(report.lifetime.costs.noSolar - 0.30) < 1e-9)
        #expect(abs(report.lifetime.total - 0.30) < 1e-9)
    }

    @Test("Three synthetic years compute under 15 seconds")
    func lifetimeThreeYearsBenchmark() throws {
        let oneDaySlots = 288
        let solar = (0 ..< oneDaySlots).map { slot -> Float? in
            (96 ..< 200).contains(slot) ? 300 : 0
        }
        let load = Array(repeating: Float?(150), count: oneDaySlots)
        let grid = (0 ..< oneDaySlots).map { slot -> Float? in
            (solar[slot] ?? 0) > 0 ? -150 : 150
        }
        let battery = [Float?(100)] + Array(repeating: Float?(0), count: oneDaySlots - 1)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = try #require(TimeZone(identifier: "UTC"))
        let start = try #require(cal.date(from: DateComponents(year: 2024, month: 1, day: 1)))

        let days = (0 ..< 1_095).map { offset -> EnergyFlowDay in
            let dayStart = start.addingTimeInterval(Double(offset) * 86_400)
            return EnergyFlowDay(
                day: "day-\(offset)",
                dayStart: dayStart,
                solarWh: solar,
                loadWh: load,
                gridWh: grid,
                batteryWh: battery,
                batterySoc: Array(repeating: nil, count: oneDaySlots)
            )
        }
        let timeline = SavingsTestFixtures.makeTimeline(actualBuy: 0.30, actualSell: 0.05, refBuy: 0.14, refSell: 0.04)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let batteryDTO = SiteBatteryDTO(nameplateEnergyWh: 13_500, nameplatePowerW: 5_000, backupReservePercent: 20)
        let now = start.addingTimeInterval(1_094 * 86_400 + 43_200)

        let clock = ContinuousClock()
        let elapsed = clock.measure {
            let scenarios = SavingsScenarioFlows.build(days: days, battery: batteryDTO)
            let report = SavingsCalculator.compute(
                scenarios: scenarios,
                actual: actual,
                reference: reference,
                billingDay: 1,
                now: now
            )
            #expect(report.lifetime.daysWithData == 1_095)
        }
        print("SavingsCalculator 3-year benchmark: \(elapsed)")
        // A guard against an algorithmic blowup, not a speed target: hosted CI takes 2.3 to 2.9 s
        // optimized and 4.2 to 5.3 s in Debug, so a tighter limit fails on a busy runner.
        #expect(elapsed < .seconds(15))
    }

    @Test("Report measures rate growth from the first stored day")
    func reportMeasuresRateGrowthFromFirstStoredDay() throws {
        let slots = 288
        let day = try SavingsTestFixtures.makeDay(
            "2022-01-01",
            solar: Array(repeating: Float?(0), count: slots),
            load: Array(repeating: Float?(150), count: slots),
            grid: Array(repeating: Float?(150), count: slots)
        )
        let scenarios = SavingsScenarioFlows.build(days: [day], battery: nil)
        let old = SavingsTestFixtures.makeFlatPeriod(
            id: 1, name: "Old", buyRate: 0.20, sellRate: 0.05, effectiveFrom: "2020-01-01", effectiveTo: "2024-12-31"
        )
        let new = SavingsTestFixtures.makeFlatPeriod(
            id: 2, name: "New", buyRate: 0.22, sellRate: 0.05, effectiveFrom: "2025-01-01"
        )
        let reference = SavingsTestFixtures.makeFlatPeriod(id: 9, name: "Reference", buyRate: 0.14, sellRate: 0.04)
        let timeline = SavingsTestFixtures.makeTimeline(actual: [old, new], reference: [reference])
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let referenceResolver = try #require(RatePeriodResolver(referenceOf: timeline))

        let report = SavingsCalculator.compute(
            scenarios: scenarios,
            actual: actual,
            reference: referenceResolver,
            billingDay: 1,
            now: try SavingsTestFixtures.makeUTCDate(year: 2026, month: 3, day: 1, hour: 12)
        )

        #expect(report.rateGrowth.isMeasured)
        #expect(report.rateGrowth.measuredSince == "2022-01-01")
        // 0.22 / 0.20 over about 3.17 years (2022-01-01 to 2025-03-02) is about 3.06% a year.
        #expect(abs(report.rateGrowth.annualRate - 0.0306) < 0.0005)
    }
}
