import Foundation
@testable import PWUsage
import Testing

@Suite("Rate Growth")
struct RateGrowthTests {
    @Test("Two plans four years apart give the compound yearly rise")
    func twoPlansFourYearsApartGiveCompoundRate() throws {
        let resolver = try Self.resolver([
            SavingsTestFixtures.makeFlatPeriod(
                id: 1, name: "Old", buyRate: 0.20, sellRate: 0.05,
                effectiveFrom: "2020-01-01", effectiveTo: "2023-12-31"
            ),
            SavingsTestFixtures.makeFlatPeriod(
                id: 2, name: "New", buyRate: 0.2431, sellRate: 0.05, effectiveFrom: "2024-01-01"
            )
        ])
        let growth = RateGrowth.measure(
            actual: resolver,
            firstDay: try SavingsTestFixtures.makeUTCDate(year: 2020, month: 1, day: 1, hour: 0),
            now: try SavingsTestFixtures.makeUTCDate(year: 2025, month: 1, day: 1, hour: 12)
        )
        #expect(growth.isMeasured)
        #expect(growth.measuredSince == "2020-01-01")
        #expect(abs(growth.annualRate - 0.0499) < 0.0005)
    }

    @Test("Less than two years between the windows uses the typical pace")
    func underTwoYearsUsesTypical() throws {
        let resolver = try Self.resolver([
            SavingsTestFixtures.makeFlatPeriod(id: 1, name: "Old", buyRate: 0.20, sellRate: 0.05)
        ])
        let growth = RateGrowth.measure(
            actual: resolver,
            firstDay: try SavingsTestFixtures.makeUTCDate(year: 2020, month: 1, day: 1, hour: 0),
            now: try SavingsTestFixtures.makeUTCDate(year: 2021, month: 6, day: 1, hour: 12)
        )
        #expect(growth == .typical)
    }

    @Test("Falling rates clamp to zero but stay measured")
    func fallingRatesClampToZero() throws {
        let resolver = try Self.resolver([
            SavingsTestFixtures.makeFlatPeriod(
                id: 1, name: "Old", buyRate: 0.30, sellRate: 0.05,
                effectiveFrom: "2020-01-01", effectiveTo: "2023-12-31"
            ),
            SavingsTestFixtures.makeFlatPeriod(
                id: 2, name: "New", buyRate: 0.20, sellRate: 0.05, effectiveFrom: "2024-01-01"
            )
        ])
        let growth = RateGrowth.measure(
            actual: resolver,
            firstDay: try SavingsTestFixtures.makeUTCDate(year: 2020, month: 1, day: 1, hour: 0),
            now: try SavingsTestFixtures.makeUTCDate(year: 2025, month: 1, day: 1, hour: 12)
        )
        #expect(growth.isMeasured)
        #expect(growth.annualRate == 0)
    }

    @Test("Hours with no known rate plan are skipped, not counted as zero")
    func unknownHoursAreSkipped() throws {
        let resolver = try Self.resolver([
            SavingsTestFixtures.makeFlatPeriod(
                id: 1, name: "Old", buyRate: 0.20, sellRate: 0.05,
                effectiveFrom: "2020-01-01", effectiveTo: "2020-06-30"
            ),
            SavingsTestFixtures.makeFlatPeriod(
                id: 2, name: "New", buyRate: 0.2431, sellRate: 0.05, effectiveFrom: "2024-01-01"
            )
        ])
        let growth = RateGrowth.measure(
            actual: resolver,
            firstDay: try SavingsTestFixtures.makeUTCDate(year: 2020, month: 1, day: 1, hour: 0),
            now: try SavingsTestFixtures.makeUTCDate(year: 2025, month: 1, day: 1, hour: 12)
        )
        #expect(growth.isMeasured)
        #expect(abs(growth.annualRate - 0.0499) < 0.0005)
    }

    @Test("Time-of-use windows weigh each hour, not each window")
    func timeOfUseMeanWeighsHours() throws {
        let touPlan = TariffPeriodDTO(
            periodId: 1,
            tariffId: 10,
            name: "Old",
            version: 1,
            source: .manual,
            effectiveFrom: "2020-01-01",
            effectiveTo: "2023-12-31",
            isCurrentToday: true,
            updatedBy: nil,
            seasons: [TariffSeasonInput(
                name: "All Year",
                fromMonth: 1,
                toMonth: 12,
                weekdayPeriods: Self.touWindows,
                weekendPeriods: Self.touWindows
            )]
        )
        let resolver = try Self.resolver([
            touPlan,
            SavingsTestFixtures.makeFlatPeriod(
                id: 2, name: "New", buyRate: 0.2431, sellRate: 0.05, effectiveFrom: "2024-01-01"
            )
        ])
        let growth = RateGrowth.measure(
            actual: resolver,
            firstDay: try SavingsTestFixtures.makeUTCDate(year: 2020, month: 1, day: 1, hour: 0),
            now: try SavingsTestFixtures.makeUTCDate(year: 2025, month: 1, day: 1, hour: 12)
        )
        // Hourly mean (5 h at 0.40, 19 h at 0.20) is 0.24167, so the rise to 0.2431 is about 0.146% a year.
        #expect(growth.isMeasured)
        #expect(abs(growth.annualRate - 0.00146) < 0.0001)
    }

    private static let touWindows: [TimePeriodWindowInput] = [
        TimePeriodWindowInput(
            touName: .offPeak, fromHour: 0, fromMinute: 0, toHour: 17, toMinute: 0, buyRate: 0.20, sellRate: 0.05
        ),
        TimePeriodWindowInput(
            touName: .onPeak, fromHour: 17, fromMinute: 0, toHour: 22, toMinute: 0, buyRate: 0.40, sellRate: 0.05
        ),
        TimePeriodWindowInput(
            touName: .offPeak, fromHour: 22, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.20, sellRate: 0.05
        )
    ]

    private static func resolver(_ periods: [TariffPeriodDTO]) throws -> RatePeriodResolver {
        let timeline = SavingsTestFixtures.makeTimeline(actual: periods, reference: [])
        return try #require(RatePeriodResolver(timeline: timeline))
    }
}
