import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

@Suite("Savings Components")
struct SavingsComponentTests {
    @Test("Solar since install starts at the install cycle and counts that cycle in full")
    func solarSinceInstallStartsAtInstallCycle() throws {
        // Each day has 10 kWh of load and no grid use, so noSolar costs $1.00 a day at $0.10/kWh.
        let days = try ["2026-04-10", "2026-05-10", "2026-06-10"].map { day in
            try SavingsTestFixtures.makeDay(day, solar: [10_000], load: [10_000], grid: [0])
        }
        let timeline = SavingsTestFixtures.makeTimeline(actualBuy: 0.10, actualSell: 0.03, refBuy: 0.10, refSell: 0.03)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let scenarios = SavingsScenarioFlows.build(days: days, battery: nil)
        let now = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 6, day: 15, hour: 12)
        let installDay = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 5, day: 15, hour: 0)

        let report = SavingsCalculator.compute(
            scenarios: scenarios,
            actual: actual,
            reference: reference,
            billingDay: 1,
            now: now,
            starts: ComponentStarts(solar: installDay, powerwall: nil)
        )

        // May and June count in full (May 10 is before the install day); April is excluded.
        #expect(report.lifetime.daysWithData == 3)
        #expect(report.solarSinceInstall.daysWithData == 2)
        #expect(abs(report.solarSinceInstall.costs.noSolar - 2.0) < 1e-9)
        #expect(report.powerwallSinceInstall == nil)
    }

    @Test("Powerwall since install pays back scenario three minus scenario one from its cycle")
    func powerwallSinceInstallUsesScenarioThreeMinusOne() throws {
        // Load 10 kWh, solar 5 kWh, so grid import 5 kWh.
        // Recorded (actual $0.10): $0.50. Solar alone (reference $0.20): $1.00.
        let day = try SavingsTestFixtures.makeDay("2026-06-10", solar: [5_000], load: [10_000], grid: [5_000])
        let timeline = SavingsTestFixtures.makeTimeline(actualBuy: 0.10, actualSell: 0.03, refBuy: 0.20, refSell: 0.03)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let scenarios = SavingsScenarioFlows.build(days: [day], battery: nil)
        let now = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 6, day: 15, hour: 12)
        let powerwallDay = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 6, day: 5, hour: 0)

        let report = SavingsCalculator.compute(
            scenarios: scenarios,
            actual: actual,
            reference: reference,
            billingDay: 1,
            now: now,
            starts: ComponentStarts(solar: nil, powerwall: powerwallDay)
        )

        let powerwall = try #require(report.powerwallSinceInstall)
        #expect(abs(powerwall.powerwallAndRatePlan - 0.50) < 1e-9)
        #expect(abs(powerwall.costs.solarAlone - 1.00) < 1e-9)
        #expect(abs(report.lifetime.powerwallAndRatePlan - powerwall.powerwallAndRatePlan) < 1e-9)
    }

    @Test("A component starting after the last stored day has zero figures")
    func componentStartAfterLastDayGivesZeroFigures() throws {
        let day = try SavingsTestFixtures.makeDay("2026-06-10", solar: [0], load: [10_000], grid: [10_000])
        let timeline = SavingsTestFixtures.makeTimeline(actualBuy: 0.10, actualSell: 0.03, refBuy: 0.10, refSell: 0.03)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let scenarios = SavingsScenarioFlows.build(days: [day], battery: nil)
        let now = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 6, day: 15, hour: 12)
        let future = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 7, day: 1, hour: 0)

        let report = SavingsCalculator.compute(
            scenarios: scenarios,
            actual: actual,
            reference: reference,
            billingDay: 1,
            now: now,
            starts: ComponentStarts(solar: future, powerwall: future)
        )

        #expect(report.solarSinceInstall.costs == .zero)
        #expect(report.solarSinceInstall.daysWithData == 0)
        #expect(report.powerwallSinceInstall?.costs == .zero)
        #expect(report.lifetime.daysWithData == 1)
    }

    @Test("Recent cycles are the last twelve billing cycles, oldest first")
    func recentCyclesAreLastTwelveOldestFirst() throws {
        var days: [EnergyFlowDay] = []
        // 14 months: 2025-05 through 2026-06, each day imports 10 kWh at $0.10/kWh.
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

        #expect(report.recentCycles.count == 12)
        #expect(report.recentCycles.last?.start == report.cycleStart)
        let oldestStart = try SavingsTestFixtures.makeUTCDate(year: 2025, month: 7, day: 1, hour: 0)
        #expect(report.recentCycles.first?.start == oldestStart)
        #expect(report.recentCycles.allSatisfy { $0.daysInCycle >= 28 && $0.daysInCycle <= 31 })
        let recentTotal = report.recentCycles.reduce(0) { $0 + $1.costs.recorded }
        #expect(abs(recentTotal - report.year.costs.recorded) < 1e-9)
    }

    @Test("Powerwall start override feeds the scenario battery start day")
    func powerwallStartDayIsReportedOnReport() throws {
        let day = try SavingsTestFixtures.makeDay("2026-06-10", solar: [0], load: [100], grid: [100])
        let timeline = SavingsTestFixtures.makeTimeline(actualBuy: 0.10, actualSell: 0.03, refBuy: 0.10, refSell: 0.03)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let battery = SiteBatteryDTO(nameplateEnergyWh: 13_500, nameplatePowerW: 5_000, backupReservePercent: 20)
        let scenarios = SavingsScenarioFlows.build(days: [day], battery: battery, batteryStartOverride: "2026-06-10")
        let now = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 6, day: 15, hour: 12)

        let report = SavingsCalculator.compute(
            scenarios: scenarios,
            actual: actual,
            reference: reference,
            billingDay: 1,
            now: now
        )

        #expect(report.batteryStartDay == "2026-06-10")
    }
}
