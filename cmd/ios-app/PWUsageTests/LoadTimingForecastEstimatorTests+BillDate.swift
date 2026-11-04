import Foundation
@testable import PWUsage
import Testing

extension LoadTimingForecastEstimatorTests {
    @Test("historyProjectsBanksToTheBillDate")
    func historyProjectsBanksToTheBillDate() throws {
        // `start` is 08:00 UTC; ten days of tariff from midnight cover the cycle.
        let cycleEnd = start.addingTimeInterval(10 * 86_400)
        let context = historyContext { Self.isDaylight($0) ? 2 : -0.5 }
        let result = evaluate(.history(context: context), now: start, tariffs: dailyTariffs(days: 11),
                              balances: ["ON_PEAK": 2, "OFF_PEAK": -10], cycleEnd: cycleEnd)

        let comparison = try #require(result.comparison)
        #expect(comparison.projectionEnd == cycleEnd)
        #expect(!comparison.projectionEndsAtRateChange)
        // Search and chart still end at midnight tomorrow.
        #expect(comparison.horizonEnd == start.addingTimeInterval(40 * 3600))
        let onPeak = try #require(comparison.lanes.first { $0.periodKey == "ON_PEAK" })
        let offPeak = try #require(comparison.lanes.first { $0.periodKey == "OFF_PEAK" })
        // Ten days hold 120 On-Peak hours and 120 Off-Peak hours.
        #expect(abs(onPeak.projectedKwh - (2 + 2 * 120)) < 1e-9)
        #expect(abs(offPeak.projectedKwh - (-10 - 0.5 * 120)) < 1e-9)
    }

    @Test("forecastWindowThenHistory")
    func forecastWindowThenHistory() throws {
        // Two days of 3 kW solar against 1 kW home, then history's 0.5 kW, to a cycle end five days out.
        let cycleEnd = start.addingTimeInterval(5 * 86_400)
        let intervals = (0 ..< 96).map { forecast(3, from: TimeInterval($0) * 1800, to: TimeInterval($0 + 1) * 1800) }
        let context = historyContext(home: 1, grid: { _ in 0.5 })
        let result = evaluate(.forecast(intervals: intervals, context: context), now: start,
                              tariffs: [tariff(0, 5 * 86_400)], balances: ["p": 2], cycleEnd: cycleEnd)

        let comparison = try #require(result.comparison)
        #expect(comparison.projectionEnd == cycleEnd)
        let lane = try #require(comparison.lanes.first { $0.periodKey == "p" })
        #expect(abs(lane.projectedKwh - (2 + 2 * 48 + 0.5 * 72)) < 1e-9)
    }

    @Test("A forecast without grid history still ends at the forecast and midnight tomorrow")
    func forecastWithoutHistoryKeepsTodaysHorizon() throws {
        let intervals = (0 ..< 240).map { forecast(3, from: TimeInterval($0) * 1800, to: TimeInterval($0 + 1) * 1800) }
        let result = evaluate(.forecast(intervals: intervals, context: context(home: 1)), now: start,
                              tariffs: [tariff(0, 5 * 86_400)], balances: ["p": 2],
                              cycleEnd: start.addingTimeInterval(5 * 86_400))

        let comparison = try #require(result.comparison)
        #expect(comparison.projectionEnd == start.addingTimeInterval(40 * 3600))
        #expect(comparison.horizonEnd == comparison.projectionEnd)
        let lane = try #require(comparison.lanes.first { $0.periodKey == "p" })
        #expect(abs(lane.projectedKwh - (2 + 2 * 40)) < 1e-9)
    }

    @Test("overdrawnBankRecoversByBillDate")
    func overdrawnBankRecoversByBillDate() throws {
        // Sunday 10:00 UTC. Weekdays have On-Peak 08:00–20:00; weekends are all Off-Peak.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let dayZero = start.addingTimeInterval(-8 * 3600)
        let weekday = { (day: Int) -> Bool in
            !calendar.isDateInWeekend(dayZero.addingTimeInterval(Double(day) * 86_400))
        }
        let sunday = try #require((0 ..< 7).first {
            calendar.component(.weekday, from: dayZero.addingTimeInterval(Double($0) * 86_400)) == 1
        })
        let now = dayZero.addingTimeInterval(Double(sunday) * 86_400 + 10 * 3600)
        let cycleEnd = now.addingTimeInterval(23 * 86_400)
        let car = LoadProfile(id: "car", name: "Charge the car", kind: .appliance, energyKwh: 52.7,
                              durationHours: 52.7 / 9, carSettings: nil)
        // Daylight exports 3 kW; nights import 2 kW.
        let context = historyContext { Self.isDaylight($0) ? 3 : -2 }
        let result = evaluate(.history(context: context), profile: car, now: now,
                              tariffs: dailyTariffs(days: sunday + 25, onPeakDay: weekday),
                              balances: ["ON_PEAK": 5, "OFF_PEAK": -64], cycleEnd: cycleEnd)

        let comparison = try #require(result.comparison)
        let monday = dayZero.addingTimeInterval(Double(sunday + 1) * 86_400)
        #expect(comparison.recommendedStart >= monday.addingTimeInterval(8 * 3600))
        #expect(comparison.recommendedEnd <= monday.addingTimeInterval(20 * 3600))
        #expect(abs(comparison.recommendedCost - 52.7 * 0.04) < 1e-6)
        let onPeak = try #require(comparison.lanes.first { $0.periodKey == "ON_PEAK" })
        #expect(abs(onPeak.projectedAfterRecommendedKwh - (onPeak.projectedKwh - 52.7)) < 1e-6)
        #expect(onPeak.projectedAfterRecommendedKwh > 0)
    }

    @Test("runsMayFinishAfterTheSearchWindow")
    func runsMayFinishAfterTheSearchWindow() throws {
        // Midnight tomorrow is start + 40 h. Cheap "q" begins at 20:00 tomorrow (start + 36 h).
        let profile = LoadProfile(id: "pump", name: "Pump", kind: .appliance, energyKwh: 6, durationHours: 6,
                                  carSettings: nil)
        let tariffs = [tariff(0, 129_600, key: "p", buy: 0.30, sell: 0.05),
                       tariff(129_600, 432_000, key: "q", buy: 0.05, sell: 0.01)]
        let result = evaluate(.flat(timeZone: "UTC"), profile: profile, now: start, tariffs: tariffs,
                              balances: ["p": -10, "q": -10], cycleEnd: start.addingTimeInterval(432_000))

        let comparison = try #require(result.comparison)
        let twentyTomorrow = start.addingTimeInterval(129_600)
        #expect(comparison.horizonEnd == start.addingTimeInterval(144_000))
        #expect(comparison.evaluatedStarts.contains(twentyTomorrow))
        #expect(comparison.recommendedStart == twentyTomorrow)
        #expect(comparison.recommendedEnd > comparison.horizonEnd)
        #expect(comparison.evaluatedStarts.allSatisfy { $0 < comparison.horizonEnd })
    }

    @Test("A run must still finish by the bill date")
    func runsMustFinishByTheBillDate() throws {
        let profile = LoadProfile(id: "pump", name: "Pump", kind: .appliance, energyKwh: 6, durationHours: 6,
                                  carSettings: nil)
        let tariffs = [tariff(0, 129_600, key: "p", buy: 0.30, sell: 0.05),
                       tariff(129_600, 432_000, key: "q", buy: 0.05, sell: 0.01)]
        let cycleEnd = start.addingTimeInterval(140_000)
        let result = evaluate(.flat(timeZone: "UTC"), profile: profile, now: start, tariffs: tariffs,
                              balances: ["p": -10, "q": -10], cycleEnd: cycleEnd)

        let comparison = try #require(result.comparison)
        #expect(comparison.recommendedEnd <= cycleEnd)
        #expect(comparison.evaluatedStarts.allSatisfy { $0.addingTimeInterval(6 * 3600) <= cycleEnd })
    }

    @Test("rateChangeEndsProjection")
    func rateChangeEndsProjection() throws {
        let tariffs = [tariff(0, 5 * 86_400, key: "p", buy: 0.30, sell: 0.05),
                       tariff(5 * 86_400, 10 * 86_400, key: "p", buy: 0.40, sell: 0.05)]
        let result = evaluate(.history(context: historyContext { _ in 0.5 }), now: start, tariffs: tariffs,
                              balances: ["p": 2], cycleEnd: start.addingTimeInterval(10 * 86_400))

        let comparison = try #require(result.comparison)
        #expect(comparison.projectionEnd == start.addingTimeInterval(5 * 86_400))
        #expect(comparison.projectionEndsAtRateChange)
        let lane = try #require(comparison.lanes.first { $0.periodKey == "p" })
        #expect(abs(lane.projectedKwh - (2 + 0.5 * 120)) < 1e-9)
    }

    @Test("historyFillFollowsFallBack")
    func historyFillFollowsFallBack() throws {
        // Noon CDT on 2026-10-31 to midnight CST on 2026-11-02: 12 + 25 hours.
        let now = try #require(ISO8601DateFormatter().date(from: "2026-10-31T17:00:00Z"))
        let cycleEnd = try #require(ISO8601DateFormatter().date(from: "2026-11-02T06:00:00Z"))
        let tariffs = [LoadTimingTariffSegment(start: now, end: cycleEnd, periodKey: "p", name: "p", buyRate: 0.3,
                                               sellRate: 0.05)]
        let context = historyContext(timeZone: "America/Chicago", grid: { _ in 1 })
        let result = evaluate(.history(context: context), now: now, tariffs: tariffs, balances: ["p": 2],
                              cycleEnd: cycleEnd)

        let comparison = try #require(result.comparison)
        #expect(comparison.projectionEnd == cycleEnd)
        let lane = try #require(comparison.lanes.first { $0.periodKey == "p" })
        #expect(abs(lane.projectedKwh - (2 + 37)) < 1e-9)
    }
}
