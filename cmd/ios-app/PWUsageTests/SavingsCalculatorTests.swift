import Foundation
@testable import PWUsage
import Testing

@Suite("Savings Calculator")
struct SavingsCalculatorTests {
    @Test("Cycle recorded cost equals LocalBillBuilder estimatedCost")
    func cycleRecordedCostEqualsLocalBill() async throws {
        let fixture = try BillPricingFixture.load("single-plan-cycle")
        let scope = SolarForecastSiteScope(accountScopeID: "test-account", siteID: "site-1")
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("savings-calc-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = SolarHistoryStore(directory: folder)
        let timeZone = try #require(TimeZone(identifier: fixture.timeline.timezone))
        try await Self.seedStore(store, fixture: fixture, timeZone: timeZone, scope: scope)

        let site = MobileBillResponse.Site(id: "site-1", name: "Home", timezone: fixture.timeline.timezone)
        let billResult = try await LocalBillBuilder(store: store).build(
            site: site,
            billingDay: fixture.billingDay,
            timeline: fixture.timeline,
            scope: scope,
            now: fixture.now
        )
        guard case .ready(let bill) = billResult else {
            Issue.record("Expected ready bill")
            return
        }
        let expectedCost = try #require(bill.currentBill.estimatedCost)

        let cycle = BillingCycle.current(billingDay: fixture.billingDay, now: fixture.now, timeZone: timeZone)
        let flowDays = try #require(try await store.flowDays(scope: scope, from: cycle.start, to: cycle.end))
        let refTimeline = Self.withReference(timeline: fixture.timeline, buyRate: 0.14, sellRate: 0.04)
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

    private static func seedStore(
        _ store: SolarHistoryStore,
        fixture: BillPricingFixture,
        timeZone: TimeZone,
        scope: SolarForecastSiteScope
    ) async throws {
        let historyDays = fixture.days.map { day in
            MobileSolarHistoryDay(
                day: day.day,
                dayStart: day.dayStart,
                status: .complete,
                fetchedAt: day.dayStart,
                solarWh: day.solarWh.map { $0.map(Double.init) },
                loadWh: day.loadWh.map { $0.map(Double.init) },
                gridWh: day.gridWh.map { $0.map(Double.init) },
                batteryWh: Array(repeating: Double?(0), count: day.gridWh.count),
                batterySoc: Array(repeating: Double?.none, count: day.gridWh.count)
            )
        }
        try await store.merge(
            MobileSolarHistoryFill(
                timeZone: timeZone,
                status: .complete,
                historyStart: historyDays.first?.day ?? "2026-01-01",
                days: historyDays
            ),
            scope: scope
        )
    }

    @Test("Solar and Powerwall/rate-plan breakdown sums to total savings")
    func breakdownSumsToTotal() throws {
        let day = try Self.makeDay(
            "2026-06-10",
            solar: [1_000, 0],
            load: [500, 1_000],
            grid: [-500, 500],
            battery: [0, -500]
        )
        let timeline = Self.makeTimeline(actualBuy: 0.30, actualSell: 0.05, refBuy: 0.15, refSell: 0.03)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let battery = SiteBatteryDTO(nameplateEnergyWh: 13_500, nameplatePowerW: 5_000, backupReservePercent: 20)
        let scenarios = SavingsScenarioFlows.build(days: [day], battery: battery)
        let now = try Self.makeUTCDate(year: 2026, month: 6, day: 15, hour: 12)

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
        let mayDay = try Self.makeDay(
            "2026-05-10",
            solar: [10_000],
            load: [0],
            grid: [-10_000]
        )
        // Cycle 2 (June): net import 10 kWh -> cost +2.00 (at buyRate 0.20)
        let juneDay = try Self.makeDay(
            "2026-06-10",
            solar: [0],
            load: [10_000],
            grid: [10_000]
        )
        let timeline = Self.makeTimeline(actualBuy: 0.20, actualSell: 0.03, refBuy: 0.20, refSell: 0.03)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let scenarios = SavingsScenarioFlows.build(days: [mayDay, juneDay], battery: nil)
        let now = try Self.makeUTCDate(year: 2026, month: 6, day: 15, hour: 12)

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
            days.append(try Self.makeDay(
                String(format: "%04d-%02d-10", year, month),
                solar: [0],
                load: [10_000],
                grid: [10_000]
            ))
        }
        let timeline = Self.makeTimeline(actualBuy: 0.10, actualSell: 0.03, refBuy: 0.10, refSell: 0.03)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let scenarios = SavingsScenarioFlows.build(days: days, battery: nil)
        let now = try Self.makeUTCDate(year: 2026, month: 6, day: 15, hour: 12)

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
        let day = try Self.makeDay(
            "2026-06-10",
            solar: [20_000],
            load: [5_000],
            grid: [-15_000]
        )
        let timeline = Self.makeTimeline(actualBuy: 0.15, actualSell: 0.10, refBuy: 0.15, refSell: 0.10)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let scenarios = SavingsScenarioFlows.build(days: [day], battery: nil)
        let now = try Self.makeUTCDate(year: 2026, month: 6, day: 15, hour: 12)

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
        let day1 = try Self.makeDay("2026-06-02", solar: [0], load: [100], grid: [100])
        let day2 = try Self.makeDay("2026-06-05", solar: [0], load: [100], grid: [nil])
        let day3 = try Self.makeDay("2026-06-08", solar: [0], load: [100], grid: [200])
        let timeline = Self.makeTimeline(actualBuy: 0.15, actualSell: 0.05, refBuy: 0.15, refSell: 0.05)
        let actual = try #require(RatePeriodResolver(timeline: timeline))
        let reference = try #require(RatePeriodResolver(referenceOf: timeline))
        let scenarios = SavingsScenarioFlows.build(days: [day1, day2, day3], battery: nil)
        let now = try Self.makeUTCDate(year: 2026, month: 6, day: 10, hour: 12)

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

    @Test("Three synthetic years compute under 2 seconds")
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
        let timeline = Self.makeTimeline(actualBuy: 0.30, actualSell: 0.05, refBuy: 0.14, refSell: 0.04)
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
        #expect(elapsed < .seconds(2))
    }

    private static func makeDay(
        _ dayString: String,
        solar: [Float?],
        load: [Float?],
        grid: [Float?],
        battery: [Float?]? = nil
    ) throws -> EnergyFlowDay {
        let parts = dayString.split(separator: "-").compactMap { Int($0) }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = try #require(TimeZone(identifier: "UTC"))
        let start = try #require(cal.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])))
        return EnergyFlowDay(
            day: dayString,
            dayStart: start,
            solarWh: solar,
            loadWh: load,
            gridWh: grid,
            batteryWh: battery ?? Array(repeating: Float?(0), count: grid.count),
            batterySoc: Array(repeating: nil, count: grid.count)
        )
    }

    private static func makeUTCDate(year: Int, month: Int, day: Int, hour: Int) throws -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = try #require(TimeZone(identifier: "UTC"))
        return try #require(cal.date(from: DateComponents(year: year, month: month, day: day, hour: hour)))
    }

    private static func makeTimeline(
        actualBuy: Double,
        actualSell: Double,
        refBuy: Double,
        refSell: Double
    ) -> SiteTariffsTimelineResponse {
        let actualPeriod = makeFlatPeriod(id: 1, name: "Actual", buyRate: actualBuy, sellRate: actualSell)
        let refPeriod = makeFlatPeriod(id: 2, name: "Reference", buyRate: refBuy, sellRate: refSell)
        return SiteTariffsTimelineResponse(
            version: 2,
            siteId: "site-1",
            timezone: "UTC",
            currency: "USD",
            periods: [actualPeriod],
            referencePeriods: [refPeriod],
            battery: nil,
            reattribution: nil,
            holidayDates: [],
            teslaSync: TeslaSyncDTO(
                latestTariffId: nil,
                latestTariffName: nil,
                latestUpdatedAt: nil,
                activeManualUpdatedAt: nil,
                differsFromActiveManual: false
            )
        )
    }

    private static func withReference(
        timeline: SiteTariffsTimelineResponse,
        buyRate: Double,
        sellRate: Double
    ) -> SiteTariffsTimelineResponse {
        let refPeriod = makeFlatPeriod(id: 99, name: "Reference", buyRate: buyRate, sellRate: sellRate)
        return SiteTariffsTimelineResponse(
            version: timeline.version,
            siteId: timeline.siteId,
            timezone: timeline.timezone,
            currency: timeline.currency,
            periods: timeline.periods,
            referencePeriods: [refPeriod],
            battery: timeline.battery,
            reattribution: timeline.reattribution,
            holidayDates: timeline.holidayDates,
            teslaSync: timeline.teslaSync
        )
    }

    private static func makeFlatPeriod(
        id: Int,
        name: String,
        buyRate: Double,
        sellRate: Double
    ) -> TariffPeriodDTO {
        let window = TimePeriodWindowInput(
            touName: .offPeak,
            fromHour: 0,
            fromMinute: 0,
            toHour: 24,
            toMinute: 0,
            buyRate: buyRate,
            sellRate: sellRate
        )
        let season = TariffSeasonInput(
            name: "All Year",
            fromMonth: 1,
            toMonth: 12,
            weekdayPeriods: [window],
            weekendPeriods: [window]
        )
        return TariffPeriodDTO(
            periodId: id,
            tariffId: id * 10,
            name: name,
            version: 1,
            source: .manual,
            effectiveFrom: "2020-01-01",
            effectiveTo: nil,
            isCurrentToday: true,
            updatedBy: nil,
            seasons: [season]
        )
    }
}
