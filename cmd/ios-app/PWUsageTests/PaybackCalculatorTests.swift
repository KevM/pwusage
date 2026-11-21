import Foundation
@testable import PWUsage
import Testing

@Suite("Payback Calculator")
struct PaybackCalculatorTests {
    private static let utc = TimeZone(secondsFromGMT: 0) ?? .gmt
    private static let flatGrowth = RateGrowth(annualRate: 0, isMeasured: true, measuredSince: "2024-01-01")
    private static let flatChange = SolarHealthReport.ChangeOverTime(
        years: [], months: [], agingPercentPerYear: 0, expectedAgingPercentPerYear: nil,
        agingConfidence: .confident, hasEnoughHistoryForTrend: true
    )

    // MARK: Net cost and credits

    @Test("Net cost takes the credit after incentives")
    func netCostTakesCreditAfterIncentives() {
        let cost = SystemCostDTO(installDate: nil, price: 24_000, taxCreditPercent: 30, incentives: 1_000)
        #expect(abs(PaybackCalculator.netCost(cost) - 16_100) < 0.001)
    }

    @Test("A switched-off credit means no credit")
    func creditOffMeansNoCredit() {
        let cost = SystemCostDTO(installDate: nil, price: 24_000, taxCreditPercent: nil, incentives: 1_000)
        #expect(abs(PaybackCalculator.netCost(cost) - 23_000) < 0.001)
    }

    @Test("Default credit follows the install year")
    func defaultCreditByInstallYear() {
        #expect(PaybackCalculator.defaultTaxCreditPercent(installYear: 2019) == 30)
        #expect(PaybackCalculator.defaultTaxCreditPercent(installYear: 2021) == 26)
        #expect(PaybackCalculator.defaultTaxCreditPercent(installYear: 2023) == 30)
        #expect(PaybackCalculator.defaultTaxCreditPercent(installYear: 2026) == nil)
    }

    // MARK: Solar decline

    @Test("A confident Panel Health measurement sets the solar decline")
    func solarDeclineUsesConfidentMeasurement() {
        let change = SolarHealthReport.ChangeOverTime(
            years: [], months: [], agingPercentPerYear: -0.6, expectedAgingPercentPerYear: nil,
            agingConfidence: .confident, hasEnoughHistoryForTrend: true
        )
        let decline = PaybackCalculator.solarDecline(change)
        #expect(abs(decline.rate - 0.006) < 1e-9)
        #expect(decline.measured)
    }

    @Test("Without confidence the solar decline falls back to the typical rate")
    func solarDeclineFallsBackWithoutConfidence() {
        let change = SolarHealthReport.ChangeOverTime(
            years: [], months: [], agingPercentPerYear: -0.6, expectedAgingPercentPerYear: nil,
            agingConfidence: nil, hasEnoughHistoryForTrend: true
        )
        let decline = PaybackCalculator.solarDecline(change)
        #expect(decline.rate == PaybackCalculator.defaultSolarDecline)
        #expect(!decline.measured)
    }

    @Test("Improving solar output clamps the decline to zero")
    func improvingOutputClampsToZero() {
        let change = SolarHealthReport.ChangeOverTime(
            years: [], months: [], agingPercentPerYear: 0.8, expectedAgingPercentPerYear: nil,
            agingConfidence: .initial, hasEnoughHistoryForTrend: true
        )
        let decline = PaybackCalculator.solarDecline(change)
        #expect(decline.rate == 0)
        #expect(decline.measured)
    }

    // MARK: Break-even

    @Test("Flat savings reach break-even after the expected number of cycles")
    func flatSavingsBreakEvenMonth() throws {
        let cycles = try makeMonthlyCycles { _ in Self.savings(100) }
        let result = try #require(try compute(cycles: cycles, solar: Self.cost(price: 3_000), solarSince: "2026-06-10"))

        let solar = try #require(result.components.first)
        #expect(result.components.count == 1)
        #expect(result.combined == nil)
        #expect(solar.component == .solar)
        #expect(solar.since == "2026-06-10")
        #expect(solar.paidToDate == 600)
        let expected = try utcMonth(2028, 11)
        #expect(solar.breakEven == .projected(month: expected))
    }

    @Test("A break-even already in the past reports the crossing cycle")
    func paidOffReportsCrossingCycle() throws {
        let cycles = try makeMonthlyCycles { _ in Self.savings(100) }
        let result = try #require(try compute(cycles: cycles, solar: Self.cost(price: 500), solarSince: "2025-12-15"))

        let solar = try #require(result.components.first)
        #expect(solar.paidToDate == 1_200)
        let expected = try utcMonth(2026, 4)
        #expect(solar.breakEven == .paidOff(month: expected))
    }

    @Test("Rate growth shortens solar payback")
    func rateGrowthShortensPayback() throws {
        let cycles = try makeMonthlyCycles { _ in Self.savings(100) }
        let flat = try #require(try compute(cycles: cycles, solar: Self.cost(price: 3_000), solarSince: "2026-06-10"))
        let growing = try #require(try compute(
            cycles: cycles,
            solar: Self.cost(price: 3_000),
            solarSince: "2026-06-10",
            growth: RateGrowth(annualRate: 0.05, isMeasured: true, measuredSince: "2024-01-01")
        ))

        let flatMonth = try projectedMonth(flat.components.first?.breakEven)
        let growingMonth = try projectedMonth(growing.components.first?.breakEven)
        #expect(growingMonth < flatMonth)
    }

    @Test("Battery fade lengthens Powerwall payback past the solar payback")
    func batteryFadeLengthensPowerwallPayback() throws {
        let cycles = try makeMonthlyCycles { _ in Self.solarAndBatterySavings(100) }
        let solarOnly = try #require(try compute(
            cycles: cycles, solar: Self.cost(price: 5_000), solarSince: "2025-12-15"
        ))
        let powerwallOnly = try #require(try compute(
            cycles: cycles, powerwall: Self.cost(price: 5_000, installDate: "2025-12-15"), solarSince: "2025-12-15"
        ))

        let solarMonth = try projectedMonth(solarOnly.components.first?.breakEven)
        let powerwallMonth = try projectedMonth(powerwallOnly.components.first?.breakEven)
        #expect(powerwallMonth > solarMonth)
    }

    @Test("Negative savings never break even")
    func negativeSavingsNeverBreakEven() throws {
        let cycles = try makeMonthlyCycles { _ in Self.savings(-50) }
        let result = try #require(try compute(cycles: cycles, solar: Self.cost(price: 3_000), solarSince: "2026-06-10"))
        #expect(result.components.first?.breakEven == .notWithinHorizon)
    }

    @Test("A zero net cost has no break-even")
    func zeroNetCostHasNoBreakEven() throws {
        let cycles = try makeMonthlyCycles { _ in Self.savings(100) }
        let cost = SystemCostDTO(installDate: nil, price: 1_000, taxCreditPercent: nil, incentives: 1_000)
        let result = try #require(try compute(cycles: cycles, solar: cost, solarSince: "2026-06-10"))
        #expect(result.components.first?.breakEven == .noCost)
    }

    @Test("Fewer than 300 counted days needs a full year, with paid-to-date still set")
    func fewerThan300DaysNeedsFullYear() throws {
        let cycles = try makeMonthlyCycles { _ in Self.savings(100) }
        let result = try #require(try compute(
            cycles: cycles, solar: Self.cost(price: 3_000), solarSince: "2026-06-10", yearDays: 200
        ))
        let solar = try #require(result.components.first)
        #expect(solar.breakEven == .needsFullYear(countedDays: 200))
        #expect(solar.paidToDate == 600)
    }

    @Test("An empty base cycle uses the mean daily savings of its window")
    func emptyBaseCycleUsesMeanDailySavings() throws {
        let cycles = try makeMonthlyCycles(
            { $0 == 11 ? .zero : Self.savings(100) },
            daysWithData: { $0 == 11 ? 0 : 30 }
        )
        let result = try #require(try compute(
            cycles: cycles, solar: Self.cost(price: 3_000), solarSince: "2026-06-10"
        ))
        let solar = try #require(result.components.first)
        #expect(solar.paidToDate == 500)
        let expected = try utcMonth(2028, 12)
        #expect(solar.breakEven == .projected(month: expected))
    }

    // MARK: Combined

    @Test("A solar-only site has no combined payback")
    func solarOnlyCombinedIsNil() throws {
        let cycles = try makeMonthlyCycles { _ in Self.savings(100) }
        let result = try #require(try compute(cycles: cycles, solar: Self.cost(price: 3_000), solarSince: "2026-06-10"))
        #expect(result.combined == nil)
        #expect(result.components.map(\.component) == [.solar])
    }

    @Test("Combined payback sums both components' costs and paid-to-date")
    func combinedSumsBothComponents() throws {
        let cycles = try makeMonthlyCycles { _ in Self.solarAndBatterySavings(100) }
        let result = try #require(try compute(
            cycles: cycles,
            solar: Self.cost(price: 3_000),
            powerwall: Self.cost(price: 3_000, installDate: "2025-12-15"),
            solarSince: "2026-06-10"
        ))
        let combined = try #require(result.combined)
        #expect(combined.netCost == 6_000)
        #expect(combined.paidToDate == 1_200 + 600)
        #expect(combined.since == "2025-12-15")
    }

    @Test("Combined projection sums both streams per cycle, each fading on its own terms")
    func combinedProjectionMatchesHandModel() throws {
        let cycles = try makeMonthlyCycles { _ in Self.splitSavings(solar: 100, battery: 50) }
        let result = try #require(try compute(
            cycles: cycles,
            solar: Self.cost(price: 3_000),
            powerwall: Self.cost(price: 3_000, installDate: "2026-06-10"),
            solarSince: "2026-06-10"
        ))
        // Hand model: solar stays at 100 a cycle; Powerwall starts at 50 and fades 3% a year from its age at now.
        // Paid to date is 600 solar plus 300 Powerwall; net is 3,000 each.
        let start = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 6, day: 10, hour: 0)
        let now = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 11, day: 16, hour: 12)
        let age = now.timeIntervalSince(start) / 86_400 / 365.25
        func capacity(_ years: Double) -> Double { max(0.3, 1 - 0.03 * years) }
        var cumulative = 900.0
        var cycle = 0
        while cumulative < 6_000 {
            let years = Double(cycle + 1) / 12
            cumulative += 100 + 50 * capacity(age + years) / capacity(age)
            cycle += 1
        }
        let combined = try #require(result.combined)
        let expected = try utcMonth(2026, 11)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = Self.utc
        let month = try #require(calendar.date(byAdding: .month, value: cycle, to: expected))
        #expect(combined.netCost == 6_000)
        #expect(combined.paidToDate == 900)
        #expect(combined.breakEven == .projected(month: month))
    }

    @Test("Combined payback counts a late-starting Powerwall from its own install cycle")
    func combinedPaidOffCountsEachFromItsStart() throws {
        // Fourteen cycles of history; the last twelve are the recent window. Powerwall starts in cycle 4.
        let cycles = try makeMonthlyCycles(count: 14) { _ in Self.splitSavings(solar: 100, battery: 50) }
        let result = try #require(try compute(
            cycles: cycles,
            solar: Self.cost(price: 1_000),
            powerwall: Self.cost(price: 500, installDate: "2026-02-10"),
            solarSince: "2025-10-10"
        ))
        // Solar: 14 x 100 = 1,400. Powerwall: cycles 4 to 13, 10 x 50 = 500. Combined crossing 1,500 is in
        // cycle 11 (1,600 cumulative), which ends 1 Oct 2026 and so closes in September.
        let combined = try #require(result.combined)
        let expected = try utcMonth(2026, 9)
        #expect(combined.paidToDate == 1_900)
        #expect(combined.breakEven == .paidOff(month: expected))
    }

    @Test("A shorter history projects on calendar months from the current cycle")
    func shortHistoryProjectsOnCalendarMonths() throws {
        let cycles = try makeMonthlyCycles(count: 11) { _ in Self.savings(100) }
        let result = try #require(try compute(cycles: cycles, solar: Self.cost(price: 3_000), solarSince: "2026-07-10"))
        let solar = try #require(result.components.first)
        #expect(solar.paidToDate == 500)
        let expected = try utcMonth(2028, 12)
        #expect(solar.breakEven == .projected(month: expected))
    }

    @Test("A shorter history keeps each month's savings on its own calendar month")
    func shortHistoryKeepsSeasonsOnCalendarMonths() throws {
        // Eleven cycles closing January to November 2026; only June's cycle (ending 1 Jul) saves.
        let cycles = try makeMonthlyCycles(count: 11) { $0 == 5 ? Self.savings(1_000) : .zero }
        let result = try #require(try compute(cycles: cycles, solar: Self.cost(price: 2_000), solarSince: "2025-12-10"))
        let solar = try #require(result.components.first)
        #expect(solar.paidToDate == 1_000)
        // December, missing from the history, takes the mean month (about 91); the rest of the 1,000 comes in June.
        let expected = try utcMonth(2027, 6)
        #expect(solar.breakEven == .projected(month: expected))
    }

    @Test("A start after the last counted day projects from the window's history")
    func startAfterLastCountedDayProjectsFromHistory() throws {
        let cycles = try makeMonthlyCycles(
            { $0 == 11 ? .zero : Self.savings(100) },
            daysWithData: { $0 == 11 ? 0 : 30 }
        )
        let result = try #require(try compute(
            cycles: cycles, solar: Self.cost(price: 3_000, installDate: "2026-11-10"), solarSince: "2024-01-01"
        ))
        let solar = try #require(result.components.first)
        #expect(solar.paidToDate == 0)
        // 100 a cycle from December 2026: the thirtieth cycle closes in May 2029.
        let expected = try utcMonth(2029, 5)
        #expect(solar.breakEven == .projected(month: expected))
    }

    // MARK: Helpers

    private static func savings(_ solar: Double) -> ScenarioCosts {
        ScenarioCosts(recorded: 0, batteryFixed: 0, solarAlone: 0, noSolar: solar)
    }

    /// Solar savings of `value` and Powerwall savings of `value` in one cycle.
    private static func solarAndBatterySavings(_ value: Double) -> ScenarioCosts {
        ScenarioCosts(recorded: 0, batteryFixed: 0, solarAlone: value, noSolar: 2 * value)
    }

    /// Solar savings and Powerwall savings of different sizes in one cycle.
    private static func splitSavings(solar: Double, battery: Double) -> ScenarioCosts {
        ScenarioCosts(recorded: 0, batteryFixed: 0, solarAlone: battery, noSolar: solar + battery)
    }

    private static func cost(price: Double, installDate: String? = nil) -> SystemCostDTO {
        SystemCostDTO(installDate: installDate, price: price, taxCreditPercent: nil, incentives: 0)
    }

    private func utcMonth(_ year: Int, _ month: Int) throws -> Date {
        try SavingsTestFixtures.makeUTCDate(year: year, month: month, day: 1, hour: 0)
    }

    private func projectedMonth(_ breakEven: BreakEven?) throws -> Date {
        guard case let .projected(month)? = breakEven else {
            throw PaybackTestError.notProjected
        }
        return month
    }

    private enum PaybackTestError: Error {
        case notProjected
    }

    /// Monthly cycles ending 1 Dec 2026, oldest first; the last is the current cycle.
    private func makeMonthlyCycles(
        count: Int = 12,
        _ costs: (Int) -> ScenarioCosts,
        daysWithData: (Int) -> Int = { _ in 30 }
    ) throws -> [CycleSavings] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = Self.utc
        let lastEnd = try SavingsTestFixtures.makeUTCDate(year: 2026, month: 12, day: 1, hour: 0)
        return try (0 ..< count).map { index in
            let end = try #require(calendar.date(byAdding: .month, value: index - (count - 1), to: lastEnd))
            let start = try #require(calendar.date(byAdding: .month, value: -1, to: end))
            return CycleSavings(
                start: start, end: end, costs: costs(index), daysWithData: daysWithData(index), daysInCycle: 30
            )
        }
    }

    @Test("Records unrecordedBeforeDay when solar install predates the first stored day")
    func recordsUnrecordedBeforeDayWhenInstallPredatesHistory() throws {
        let cycles = try makeMonthlyCycles { _ in Self.savings(100) }
        let firstStored = try SavingsTestFixtures.makeUTCDate(year: 2025, month: 12, day: 1, hour: 0)
        let earlier = try #require(try compute(
            cycles: cycles,
            solar: Self.cost(price: 3_000),
            solarSince: "2023-06-15",
            firstStoredDay: firstStored
        ))
        #expect(earlier.unrecordedBeforeDay == "2025-12-01")

        let covered = try #require(try compute(
            cycles: cycles,
            solar: Self.cost(price: 3_000),
            solarSince: "2026-01-01",
            firstStoredDay: firstStored
        ))
        #expect(covered.unrecordedBeforeDay == nil)
    }

    private func compute(
        cycles: [CycleSavings],
        solar: SystemCostDTO? = nil,
        powerwall: SystemCostDTO? = nil,
        solarSince: String,
        yearDays: Int = 365,
        growth: RateGrowth = Self.flatGrowth,
        firstStoredDay: Date? = nil
    ) throws -> PaybackResult? {
        let figures = SavingsFigures(costs: .zero, daysWithData: yearDays, daysInPeriod: 365)
        let report = SavingsReport(
            cycle: figures,
            year: figures,
            lifetime: figures,
            cycleStart: try SavingsTestFixtures.makeUTCDate(year: 2026, month: 11, day: 1, hour: 0),
            solarSinceInstall: figures,
            powerwallSinceInstall: nil,
            cycles: cycles,
            recentCycles: Array(cycles.suffix(12)),
            batteryStartDay: nil,
            rateGrowth: growth,
            firstStoredDay: firstStoredDay
        )
        let costs = SystemCostsDTO(siteInstalled: solarSince, solar: solar, powerwall: powerwall)
        return PaybackCalculator.compute(
            report: report,
            costs: costs,
            change: Self.flatChange,
            timeZone: Self.utc,
            now: try SavingsTestFixtures.makeUTCDate(year: 2026, month: 11, day: 16, hour: 12)
        )
    }
}
