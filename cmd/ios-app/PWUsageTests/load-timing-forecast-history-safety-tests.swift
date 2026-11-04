import Foundation
@testable import PWUsage
import Testing

extension LoadTimingForecastEstimatorTests {
    @Test("An overdraw already priced at the buy rate does not fail the safety rule")
    func overdrawAlreadyPricedIsNotPenalised() throws {
        // Off-Peak has 2 kWh banked; a 30 kWh charge buys the other 28 at 10¢ whatever the weather.
        let tariffs = [tariff(0, 43_200, key: "OFF", buy: 0.10, sell: 0.03),
                       tariff(43_200, 144_000, key: "ON", buy: 0.31, sell: 0.04)]
        let result = evaluate(.flat(timeZone: "UTC"),
                              profile: LoadProfile(id: "car", name: "Car", kind: .appliance, energyKwh: 30,
                                                   durationHours: 3, carSettings: nil),
                              now: start, tariffs: tariffs, balances: ["OFF": 2, "ON": -20],
                              cycleEnd: start.addingTimeInterval(144_000))

        let comparison = try #require(result.comparison)
        #expect(comparison.safety == .nowSafe)
        #expect(comparison.recommendedStart == start)
        #expect(abs(comparison.costNow - (2 * 0.03 + 28 * 0.10)) < 1e-9)
    }

    @Test("A forecast that misses the start of the projection is not used with history")
    func forecastMustCoverTheProjectionStart() {
        // The batch starts half an hour after now; history must not silently stand in under the forecast label.
        let intervals = (1 ..< 96).map { forecast(3, from: TimeInterval($0) * 1800, to: TimeInterval($0 + 1) * 1800) }
        let result = evaluate(.forecast(intervals: intervals, context: historyContext(home: 1, grid: { _ in 0.5 })),
                              now: start,
                              tariffs: [tariff(0, 5 * 86_400)], balances: ["p": 2],
                              cycleEnd: start.addingTimeInterval(5 * 86_400))

        #expect(result.comparison == nil)
        #expect(result.unavailableReason == .incompleteCoverage)
    }

    @Test("Against a server without grid history, Smart Shift keeps today's recommendation")
    func olderServerKeepsTodaysRecommendation() throws {
        // Harrison's Sunday: Off-Peak owed, On-Peak +5. Monday's median solar lifts On-Peak to +33 by
        // midnight; a cloudy Monday (pv_estimate10) adds nothing. Without history the projection ends at
        // midnight tomorrow, so before the bill-date projection the answer was 4:30 PM tomorrow ($3.38).
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let dayZero = start.addingTimeInterval(-8 * 3600)
        let sunday = try #require((0 ..< 7).first {
            calendar.component(.weekday, from: dayZero.addingTimeInterval(Double($0) * 86_400)) == 1
        })
        let sundayStart = dayZero.addingTimeInterval(Double(sunday) * 86_400)
        let now = sundayStart.addingTimeInterval(13.2 * 3600)
        let mondayStart = sundayStart.addingTimeInterval(86_400)
        let intervals = (0 ..< ((48 - 13) * 2)).map { index -> SolarForecastInterval in
            let periodStart = sundayStart.addingTimeInterval(13 * 3600 + Double(index) * 1800)
            let hour = periodStart.timeIntervalSince(mondayStart) / 3600
            let onPeakDaylight = (8 ..< 20).contains(hour)
            return SolarForecastInterval(periodStart: periodStart, periodEnd: periodStart.addingTimeInterval(1800),
                                         powerKw: onPeakDaylight ? 1 + 28.0 / 12 : 0,
                                         cautiousPowerKw: onPeakDaylight ? 1 : 0)
        }
        let weekday = { (day: Int) in !calendar.isDateInWeekend(dayZero.addingTimeInterval(Double(day) * 86_400)) }
        let car = LoadProfile(id: "car", name: "Charge the car", kind: .appliance, energyKwh: 52.7,
                              durationHours: 52.7 / 9, carSettings: nil)
        let result = evaluate(.forecast(intervals: intervals, context: context(home: 1)), profile: car, now: now,
                              tariffs: dailyTariffs(days: sunday + 25, onPeakDay: weekday),
                              balances: ["ON_PEAK": 5, "OFF_PEAK": -64], cycleEnd: now.addingTimeInterval(23 * 86_400))

        let comparison = try #require(result.comparison)
        #expect(comparison.recommendedStart == mondayStart.addingTimeInterval(16.5 * 3600))
        #expect(abs(comparison.recommendedCost - (31.5 * 0.04 + 21.2 * 0.10)) < 1e-6)
    }

    @Test("Equally cheap starts go to the earliest despite floating-point noise")
    func equallyCheapStartsGoToTheEarliest() throws {
        // Sunday 17:39 UTC; Monday On-Peak 08:00–20:00 banks plenty, Off-Peak is owed.
        // The car (73 kWh, 15→80%) costs 52.7 kWh × 4¢ at any start that fits in On-Peak.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let dayZero = start.addingTimeInterval(-8 * 3600)
        let sunday = try #require((0 ..< 7).first {
            calendar.component(.weekday, from: dayZero.addingTimeInterval(Double($0) * 86_400)) == 1
        })
        let now = dayZero.addingTimeInterval(Double(sunday) * 86_400 + 17 * 3600 + 39 * 60 + 41.869)
        let monday = dayZero.addingTimeInterval(Double(sunday + 1) * 86_400)
        let car = LoadProfile(id: "car", name: "Charge the car", kind: .car, energyKwh: 36, durationHours: 4,
                              carSettings: CarLoadSettings(capacityKwh: 73, initialStateOfCharge: 15,
                                                           targetStateOfCharge: 80,
                                                           chargingLevel: .level2))
        let weekday = { (day: Int) in !calendar.isDateInWeekend(dayZero.addingTimeInterval(Double(day) * 86_400)) }
        let context = historyContext { Self.isDaylight($0) ? 1.7 : -0.8 }
        let result = evaluate(.history(context: context), profile: car, now: now,
                              tariffs: dailyTariffs(days: sunday + 25, onPeakDay: weekday),
                              balances: ["ON_PEAK": 4.615, "OFF_PEAK": -54.653],
                              cycleEnd: now.addingTimeInterval(23 * 86_400))

        let comparison = try #require(result.comparison)
        #expect(comparison.recommendedStart == monday.addingTimeInterval(8 * 3600))

        // With a dull day that imports in On-Peak, every On-Peak start fails; the
        // ruled-out start must still be the earliest of the equally cheap ones.
        let dull = historyContext(grid: { Self.isDaylight($0) ? 1.7 : -0.8 },
                                  cautious: { Self.isDaylight($0) ? -8 : -0.8 })
        let rejected = try #require(evaluate(.history(context: dull), profile: car, now: now,
                                             tariffs: dailyTariffs(days: sunday + 25, onPeakDay: weekday),
                                             balances: ["ON_PEAK": 4.615, "OFF_PEAK": -54.653],
                                             cycleEnd: now.addingTimeInterval(23 * 86_400)).comparison)
        #expect(rejected.ruledOut?.start == monday.addingTimeInterval(8 * 3600))
    }

    @Test("The cloudy week pulls each typical day toward the dull day by 1/√7, not seven dull days")
    func cautiousHistoryIsAOneInFourWeek() throws {
        // On-Peak exports 2 kW on a typical day and imports 1 kW on the dull day. Seven dull
        // days would leave On-Peak about 84 kWh short; a 1-in-4 week still banks
        // 12 h × (2 − 3/√7) ≈ 10.4 kWh a day, so a 30 kWh charge now passes.
        let context = historyContext(grid: { Self.isDaylight($0) ? 2 : 0 }, cautious: { Self.isDaylight($0) ? -1 : 0 })
        let result = evaluate(.history(context: context), profile: load(30, hours: 3), now: start,
                              tariffs: dailyTariffs(days: 22), balances: ["ON_PEAK": 0, "OFF_PEAK": -10],
                              cycleEnd: start.addingTimeInterval(20 * 86_400))

        let comparison = try #require(result.comparison)
        #expect(comparison.safety == .nowSafe)
        #expect(comparison.recommendedStart == start)
        #expect(comparison.ruledOut == nil)
    }

    @Test("A run straddling the safety cutoff counts the draw before it")
    func drawIsProratedAtTheSafetyCutoff() throws {
        // 08:10, so the seven-day cutoff falls inside the 08:00–08:30 history step.
        // History adds 1 kW in both runs; the 2 kW run outlasts the cutoff by 10 minutes,
        // so 336 kWh is drawn before it and the bank ends 164.9 + 168 − 336 = −3.1 there.
        // Dropping the straddling step would count only 335.67 kWh and pass at −2.77.
        let now = start.addingTimeInterval(600)
        let hours = 7 * 24 + 1.0 / 6
        let run = LoadProfile(id: "run", name: "Run", kind: .appliance, energyKwh: 2 * hours, durationHours: hours,
                              carSettings: nil)
        let result = evaluate(.history(context: historyContext(grid: { _ in 1 })), profile: run, now: now,
                              tariffs: [tariff(0, 20 * 86_400, key: "P", buy: 0.31, sell: 0.04)],
                              balances: ["P": 164.9], cycleEnd: start.addingTimeInterval(20 * 86_400))

        let comparison = try #require(result.comparison)
        #expect(comparison.safety != .nowSafe)
    }

    @Test("The cautious forecast moves each interval about 20% toward pv_estimate10")
    func cautiousForecastIsAOneInFourWeek() throws {
        // Typical solar banks 20 kWh a day for a week; pv_estimate10 says nothing at all.
        // Seven days of pv_estimate10 would leave a 60 kWh charge 60 short; a 1-in-4 week
        // banks 140 × (1 − 0.199) ≈ 112, so it passes. A 120 kWh charge still fails.
        let week = halfHourForecast(hours: 7 * 24 + 1, typical: { $0.truncatingRemainder(dividingBy: 24) < 10 ? 2 : 0 },
                                    cautious: { _ in 0 })
        func safety(_ kwh: Double) throws -> LoadTimingForecastEstimator.Safety {
            let result = safetyEvaluate(forecast: week,
                                        tariffs: [tariff(0, 20 * 86_400, key: "P", buy: 0.31, sell: 0.04)],
                                        balances: ["P": 0], profile: load(kwh, hours: 6))
            return try #require(result.comparison).safety
        }
        #expect(abs(LoadTimingForecastEstimator.forecastCautiousWeight - 0.199) < 0.001)
        #expect(try safety(60) == .nowSafe)
        #expect(try safety(120) == .noSafeStart(periodKey: "P"))
    }

    @Test("A sunny week with a gloomy pv_estimate10 tail still suggests Monday's On-Peak")
    func sunnyWeekWithAGloomyTailSuggestsMondayOnPeak() throws {
        // Shaped on the owner's Monday 2026-10-19 (06:04): Off-Peak owed, On-Peak +4.6,
        // a 52.7 kWh charge, 4 kW of median solar 09–17 each day, home 1.2 kW, and
        // pv_estimate10 falling from 80% of the median on Monday to 12% by Sunday.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let dayZero = start.addingTimeInterval(-8 * 3600)
        let monday = try #require((0 ..< 7).first {
            calendar.component(.weekday, from: dayZero.addingTimeInterval(Double($0) * 86_400)) == 2
        })
        let mondayStart = dayZero.addingTimeInterval(Double(monday) * 86_400)
        let now = mondayStart.addingTimeInterval(6 * 3600 + 4 * 60)
        let tail = [0.8, 0.7, 0.8, 0.4, 0.35, 0.25, 0.12, 0.8]
        let intervals = (0 ..< (8 * 48)).map { index -> SolarForecastInterval in
            let periodStart = mondayStart.addingTimeInterval(Double(index) * 1800)
            let hour = Double(index % 48) / 2
            let sun = (9 ..< 17).contains(hour) ? 4.0 : 0
            return SolarForecastInterval(periodStart: periodStart, periodEnd: periodStart.addingTimeInterval(1800),
                                         powerKw: sun, cautiousPowerKw: sun * tail[index / 48])
        }
        let context = historyContext(home: 1.2, grid: { Self.isDaylight($0) ? 1 : -0.8 }, cautious: { _ in -0.8 })
        let weekday = { (day: Int) in !calendar.isDateInWeekend(dayZero.addingTimeInterval(Double(day) * 86_400)) }
        let car = LoadProfile(id: "car", name: "Charge the car", kind: .appliance, energyKwh: 52.7,
                              durationHours: 52.7 / 9, carSettings: nil)
        let plan = Estimator.plan(.init(
            now: now,
            timing: timing(dailyTariffs(days: monday + 25, onPeakDay: weekday),
                           balances: ["ON_PEAK": 4.615, "OFF_PEAK": -66]),
            projection: .forecast(intervals: intervals, context: context),
            balanceSourceTime: now, billingCycleEnd: now.addingTimeInterval(23 * 86_400),
            currencyCode: "USD"))
        let result = Estimator.evaluate(profile: car, plan: plan)

        let comparison = try #require(result.comparison)
        #expect(comparison.recommendedStart == mondayStart.addingTimeInterval(8 * 3600))
        #expect(abs(comparison.recommendedCost - 52.7 * 0.04) < 1e-6)
    }

    @Test("A forecast that starts after the energy data still prices the card, with history filling the gap")
    func historyFillsTheGapBeforeTheForecastStarts() throws {
        // Energy data through 08:20, so the projection starts at 08:25; a forecast fetched
        // at 08:36 starts at 08:30. History's 6 kW fills the 5 minutes between, then the
        // forecast's 3 kW of solar against a 1 kW home runs to the end of the tariff.
        let source = start.addingTimeInterval(20 * 60), now = start.addingTimeInterval(40 * 60)
        let intervals = (1 ..< 4).map { forecast(3, from: TimeInterval($0) * 1800, to: TimeInterval($0 + 1) * 1800) }
        let plan = Estimator.plan(.init(
            now: now,
            timing: timing([tariff(0, 7200)], balances: ["p": 2]),
            projection: .forecast(intervals: intervals,
                                  context: historyContext(home: 1, grid: { _ in 6 })),
            balanceSourceTime: source, billingCycleEnd: start.addingTimeInterval(86_400),
            currencyCode: "USD"))
        let result = Estimator.evaluate(profile: profile(0.5, hours: 0.5), plan: plan)

        let comparison = try #require(result.comparison, "\(String(describing: result.unavailableReason))")
        #expect(comparison.assumptions.contains { $0.hasPrefix("Solar follows your solar forecast") })
        let lane = try #require(comparison.lanes.first { $0.periodKey == "p" })
        #expect(abs(lane.projectedKwh - (2 + 6 * 5.0 / 60 + 2 * 1.5)) < 1e-9)
    }

    @Test("With grid history filling the gap, the forecast card takes energy data up to an hour old")
    func forecastWithGridHistoryAllowsHourOldEnergyData() throws {
        // Energy data through 00:00, read at 00:33: the server's data lagged, and a
        // 30-minute limit swapped the forecast card for history. History's 6 kW
        // fills 00:05–00:30, then the forecast's 3 kW of solar against a 1 kW home.
        let intervals = (1 ..< 4).map { forecast(3, from: TimeInterval($0) * 1800, to: TimeInterval($0 + 1) * 1800) }
        func run(ageMinutes: Double) -> Estimator.Result {
            let plan = Estimator.plan(.init(
                now: start.addingTimeInterval(ageMinutes * 60),
                timing: timing([tariff(0, 7200)], balances: ["p": 2]),
                projection: .forecast(intervals: intervals,
                                      context: historyContext(home: 1, grid: { _ in 6 })),
                balanceSourceTime: start, billingCycleEnd: start.addingTimeInterval(86_400),
                currencyCode: "USD"))
            return Estimator.evaluate(profile: profile(0.5, hours: 0.5), plan: plan)
        }

        let comparison = try #require(run(ageMinutes: 33).comparison,
                                      "\(String(describing: run(ageMinutes: 33).unavailableReason))")
        #expect(comparison.assumptions.contains { $0.hasPrefix("Solar follows your solar forecast") })
        let lane = try #require(comparison.lanes.first { $0.periodKey == "p" })
        #expect(abs(lane.projectedKwh - (2 + 6 * 25.0 / 60 + 2 * 1.5)) < 1e-9)

        #expect(run(ageMinutes: 61).unavailableReason == .staleBalance)
    }
}
