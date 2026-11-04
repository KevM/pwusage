import Foundation
@testable import PWUsage
import Testing

extension LoadTimingForecastEstimatorTests {
    @Test("cautiousSafetyRulesOutADipACloudyWeekWouldSink")
    func cautiousSafetyRulesOutADipACloudyWeekWouldSink() throws {
        let tariffs = [tariff(0, 14_400, key: "OFF", buy: 0.10, sell: 0.03),
                       tariff(14_400, 57_600, key: "ON", buy: 0.31, sell: 0.04),
                       tariff(57_600, 100_800, key: "OFF", buy: 0.10, sell: 0.03),
                       tariff(100_800, 144_000, key: "ON", buy: 0.31, sell: 0.04)]
        // Median solar of 4 kW against a 3.5 kW home banks 12 kWh across both On-Peaks;
        // a cloudy week (each interval 20% toward pv_estimate10 = 0) leaves it 7.2 short.
        let onPeak = { (hour: Double) in (4 ..< 16).contains(hour) || (28 ..< 40).contains(hour) }
        let forecast = halfHourForecast(hours: 40, typical: { onPeak($0) ? 4 : 0 }, cautious: { _ in 0 })
        // 8 kWh in an hour: even a run straddling into On-Peak leaves it 11.2 short.
        let result = safetyEvaluate(forecast: forecast, tariffs: tariffs, balances: ["ON": 0, "OFF": -20],
                                    profile: load(8, hours: 1),
                                    home: 3.5)

        let comparison = try #require(result.comparison)
        #expect(comparison.safety == .nowSafe)
        #expect(comparison.recommendedStart == start)
        #expect(abs(comparison.recommendedCost - 0.80) < 1e-9)
        let ruledOut = try #require(comparison.ruledOut)
        #expect(ruledOut.start == start.addingTimeInterval(14_400))
        #expect(ruledOut.periodKey == "ON")
        #expect(abs(ruledOut.cost - 0.32) < 1e-9)
    }

    @Test("nowIsCheckedToo")
    func nowIsCheckedToo() throws {
        let tariffs = [tariff(0, 43_200, key: "ON_PEAK", buy: 0.31, sell: 0.04),
                       tariff(43_200, 144_000, key: "OFF_PEAK", buy: 0.10, sell: 0.03)]
        // 2 kW of solar against a 1.2 kW home banks 1 + 0.8 × 12 = 10.6 by the end of On-Peak,
        // enough for a 10 kWh half-hour run; a cloudy week banks 1 + 0.4 × 12 = 5.8, so
        // starting now leaves it 4.2 short.
        let forecast = halfHourForecast(hours: 40, typical: { $0 < 12 ? 2 : 0 }, cautious: { _ in 0 })
        let result = safetyEvaluate(forecast: forecast, tariffs: tariffs, balances: ["ON_PEAK": 1, "OFF_PEAK": -20],
                                    profile: load(10, hours: 0.5), home: 1.2)

        let comparison = try #require(result.comparison)
        #expect(comparison.safety == .nowUnsafe(periodKey: "ON_PEAK"))
        #expect(abs(comparison.costNow - 0.40) < 1e-9)
        #expect(comparison.recommendedCost > comparison.costNow)
        #expect(comparison.recommendedStart >= start.addingTimeInterval(43_200))
        #expect(comparison.savings == 0)
    }

    @Test("noSafeStartPicksSmallestShortfall")
    func noSafeStartPicksSmallestShortfall() throws {
        // Half-hour runs never straddle the 20 h switch. 10 kW of solar for 9 h against a
        // 3.8 kW home banks 14 kWh in each period. A cloudy week keeps A's first hour, so
        // it nets 74 − 76 = −2 and B 72 − 76 = −4: an 8 kWh run leaves A 10 short, B 12.
        let tariffs = [tariff(0, 72_000, key: "A", buy: 0.31, sell: 0.06),
                       tariff(72_000, 144_000, key: "B", buy: 0.31, sell: 0.04)]
        let forecast = halfHourForecast(hours: 40,
                                        typical: { $0 < 9 || (20 ..< 29).contains($0) ? 10 : 0 },
                                        cautious: { $0 < 1 ? 10 : 0 })
        let result = safetyEvaluate(forecast: forecast, tariffs: tariffs, balances: ["A": 0, "B": 0],
                                    profile: load(8, hours: 0.5),
                                    home: 3.8)

        let comparison = try #require(result.comparison)
        #expect(comparison.safety == .noSafeStart(periodKey: "A"))
        #expect(comparison.recommendedStart == start)
        #expect(comparison.ruledOut?.start == start.addingTimeInterval(72_000))
        #expect(comparison.ruledOut?.periodKey == "B")
    }

    @Test("shortfallOfThreeIsAllowed")
    func shortfallOfThreeIsAllowed() throws {
        // One 48 kW half hour banks 24 kWh; a cloudy week banks 24 × (1 − w). The balance
        // is set so a 6 kWh run leaves the cautious bank exactly 3 short (and 0.01 more).
        let tariffs = [tariff(0, 144_000, key: "P", buy: 0.31, sell: 0.04)]
        let forecast = halfHourForecast(hours: 40, typical: { $0 < 0.5 ? 48 : 0 }, cautious: { _ in 0 })
        let atThree = 3 - 24 * (1 - LoadTimingForecastEstimator.forecastCautiousWeight)
        func safety(balance: Double) throws -> LoadTimingForecastEstimator.Safety {
            let result = safetyEvaluate(forecast: forecast, tariffs: tariffs, balances: ["P": balance],
                                        profile: load(6, hours: 0.5))
            return try #require(result.comparison).safety
        }
        #expect(try safety(balance: atThree) == .nowSafe)                        // −3.00
        #expect(try safety(balance: atThree - 0.01) == .noSafeStart(periodKey: "P"))  // −3.01
    }

    @Test("boughtPeriodsAreNotChecked")
    func boughtPeriodsAreNotChecked() throws {
        let tariffs = [tariff(0, 144_000, key: "OFF", buy: 0.10, sell: 0.03)]
        let forecast = halfHourForecast(hours: 40, typical: { _ in 0 }, cautious: { _ in 0 })
        let result = safetyEvaluate(forecast: forecast, tariffs: tariffs, balances: ["OFF": -20],
                                    profile: load(6, hours: 1))

        let comparison = try #require(result.comparison)
        #expect(comparison.safety == .nowSafe)
        #expect(comparison.ruledOut == nil)
    }

    @Test("missingCautiousSolarUsesMedian")
    func missingCautiousSolarUsesMedian() throws {
        let tariffs = [tariff(0, 144_000, key: "P", buy: 0.31, sell: 0.04)]
        let forecast = halfHourForecast(hours: 40, typical: { $0 < 10 ? 2 : 0 }, cautious: nil)
        let result = safetyEvaluate(forecast: forecast, tariffs: tariffs, balances: ["P": 0],
                                    profile: load(6, hours: 1))

        let comparison = try #require(result.comparison)
        #expect(comparison.safety == .nowSafe)
        #expect(comparison.ruledOut == nil)
    }

    @Test("safetyWindowEndsAtBillDateWhenSooner")
    func safetyWindowEndsAtBillDateWhenSooner() throws {
        let tariffs = dailyTariffs(days: 12)
        let context = historyContext { Self.isDaylight($0) ? 2 : -0.5 }
        func safetyEnd(cycleDays: Double) throws -> Date {
            let result = evaluate(.history(context: context), now: start, tariffs: tariffs,
                                  balances: ["ON_PEAK": 2, "OFF_PEAK": -10],
                                  cycleEnd: start.addingTimeInterval(cycleDays * 86_400))
            return try #require(result.comparison).safetyEnd
        }
        #expect(try safetyEnd(cycleDays: 3) == start.addingTimeInterval(3 * 86_400))
        #expect(try safetyEnd(cycleDays: 10) == start.addingTimeInterval(7 * 86_400))
    }

    @Test("History after the safety window cannot make a start pass")
    func historyBeyondTheSafetyWindowCannotRescueAStart() throws {
        // Typical history banks plenty in On-Peak over 20 days; the dull day imports
        // so heavily that even a 1-in-4 week (3 − 13/√7 ≈ −1.9 kW) loses On-Peak, so a
        // 6 kWh dip leaves it short at the seven-day mark.
        let context = historyContext(grid: { Self.isDaylight($0) ? 3 : 0 }, cautious: { Self.isDaylight($0) ? -10 : 0 })
        let result = evaluate(.history(context: context), profile: load(6, hours: 1), now: start,
                              tariffs: dailyTariffs(days: 22),
                              balances: ["ON_PEAK": 0, "OFF_PEAK": -10],
                              cycleEnd: start.addingTimeInterval(20 * 86_400))

        let comparison = try #require(result.comparison)
        // `start` is 08:00, inside On-Peak: starting now dips into it.
        #expect(comparison.safety == .nowUnsafe(periodKey: "ON_PEAK"))
        #expect(comparison.ruledOut?.periodKey == "ON_PEAK")
    }
}
