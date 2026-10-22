import Foundation
import Testing
@testable import PWUsage

struct BillOutlookTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func bucket(_ kwh: Double, buy: Double = 0.3) -> BillOutlookBucket {
        .init(tariffName: "Utility", periodName: "Peak", netGridKwh: kwh, buyRate: buy, sellRate: 0.04)
    }
    func history(complete: Bool = true) -> BillOutlookHistory {
        .init(points: [.init(date: now, buckets: [bucket(10)], complete: complete,
                            estimatedCost: 3, periods: [.init(tariffName: "Utility", periodName: "Peak", netGridKwh: 10)])],
              observedThrough: now, complete: complete,
              tariffTimeline: [.init(start: now, end: now.addingTimeInterval(86400), periodKey: "peak", name: "Peak",
                                     buyRate: 0.3, sellRate: 0.04, tariffName: "Utility", periodName: "Peak")])
    }
    func context(grid: Double = 1) -> LoadTimingForecastEstimator.PlanningContext {
        .init(timeZone: "UTC", slots: stride(from: 0, to: 1440, by: 30).map {
            .init(localMinute: $0, homeKw: 1, batteryNetChargeKw: 0, gridNetExportKw: grid)
        }, asOf: now)
    }
    @Test func solarBlockIncludesIntervalsBeforeNowWithoutGridHistory() {
        let pattern = LoadTimingForecastEstimator.PlanningContext(timeZone: "UTC", slots: context().slots.map {
            .init(localMinute: $0.localMinute, homeKw: 1, batteryNetChargeKw: 0)
        }, asOf: now)
        let solar = [
            SolarForecastInterval(periodStart: now, periodEnd: now.addingTimeInterval(600), powerKw: 3),
            SolarForecastInterval(periodStart: now.addingTimeInterval(600), periodEnd: now.addingTimeInterval(3600), powerKw: 3)]
        let result = BillOutlook.evaluate(history: history(), context: pattern, forecast: solar,
                                         now: now.addingTimeInterval(900), cycleEnd: now.addingTimeInterval(3600))
        #expect(result.points.last?.date == now.addingTimeInterval(3600))
        #expect(result.usesSolar)
        #expect(!result.usesHistory)
    }
    @Test func projectionReportsTheDataItActuallyUsed() {
        let futureSolar = [SolarForecastInterval(periodStart: now.addingTimeInterval(3600),
            periodEnd: now.addingTimeInterval(7200), powerKw: 5)]
        let result = BillOutlook.evaluate(history: history(), context: context(), forecast: futureSolar, now: now,
                                         cycleEnd: now.addingTimeInterval(7200))
        #expect(!result.points.isEmpty)
        #expect(!result.usesSolar)
        #expect(result.usesHistory)
    }
    @Test func solarWithoutGridHistoryKeepsThirtyMinuteObservationLimit() {
        let pattern = LoadTimingForecastEstimator.PlanningContext(timeZone: "UTC", slots: context().slots.map {
            .init(localMinute: $0.localMinute, homeKw: 1, batteryNetChargeKw: 0)
        }, asOf: now)
        let solar = [SolarForecastInterval(periodStart: now, periodEnd: now.addingTimeInterval(86400), powerKw: 3)]
        let later = now.addingTimeInterval(45 * 60)
        #expect(BillOutlook.project(history: history(), context: pattern, forecast: solar, now: later,
                                   cycleEnd: now.addingTimeInterval(86400)).isEmpty)
        #expect(!BillOutlook.project(history: history(), context: context(), forecast: solar, now: later,
                                    cycleEnd: now.addingTimeInterval(86400)).isEmpty)
    }
    @Test func matchesCanonicalServerPricingFixtures() throws {
        struct Fixture: Decodable { let name: String; let buckets: [BillOutlookBucket]; let expectedCost: Double }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../next-app/src/lib/test-support/bill-outlook-fixtures.json")
        let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: url))
        for fixture in fixtures {
            #expect(abs(BillOutlook.cost(fixture.buckets) - fixture.expectedCost) < 0.0000001, "\(fixture.name)")
        }
    }
    @Test func projectsHistoryWithoutAJobAndStartsAfterMeasuredInterval() throws {
        let result = BillOutlook.project(history: history(), context: context(), forecast: [], now: now,
                                         cycleEnd: now.addingTimeInterval(86400))
        let end = try #require(result.last)
        #expect(end.date == now.addingTimeInterval(86400))
        #expect(abs(end.periods[0].netGridKwh - (-14)) < 0.000001)
        #expect(abs(end.estimatedCost - (-0.56)) < 0.000001)
    }
    @Test func missingHistoryAndStaleContextDoNotInventProjection() {
        #expect(BillOutlook.project(history: history(complete: false), context: context(), forecast: [], now: now,
                                    cycleEnd: now.addingTimeInterval(86400)).isEmpty)
        #expect(BillOutlook.project(history: history(), context: context(), forecast: [], now: now.addingTimeInterval(90000),
                                    cycleEnd: now.addingTimeInterval(172800)).isEmpty)
    }
    @Test func anInProgressSampleAloneIsNotAProjection() {
        let empty = LoadTimingForecastEstimator.PlanningContext(timeZone: "UTC", slots: [], asOf: now)
        let result = BillOutlook.evaluate(history: history(), context: empty, forecast: [],
                                         now: now.addingTimeInterval(-240), cycleEnd: now.addingTimeInterval(86400))
        #expect(result.points.isEmpty)
    }
    @Test func solarUsesTypicalHomeFlowThenFallsBackToGridHistory() throws {
        let forecast = [SolarForecastInterval(periodStart: now, periodEnd: now.addingTimeInterval(3600), powerKw: 5)]
        let result = BillOutlook.project(history: history(), context: context(), forecast: forecast, now: now,
                                         cycleEnd: now.addingTimeInterval(7200))
        let end = try #require(result.last)
        #expect(abs(end.periods[0].netGridKwh - 5) < 0.000001)
    }
    @Test func rateChangesKeepHistoricalPricingAndReachCycleEnd() throws {
        var history = history()
        history.tariffTimeline = [
            .init(start: now, end: now.addingTimeInterval(3600), periodKey: "peak", name: "Peak", buyRate: 0.3,
                  sellRate: 0.04, tariffName: "Utility", periodName: "Peak"),
            .init(start: now.addingTimeInterval(3600), end: now.addingTimeInterval(7200), periodKey: "peak", name: "Peak",
                  buyRate: 0.6, sellRate: 0.04, tariffName: "Utility", periodName: "Peak")]
        let end = try #require(BillOutlook.project(history: history, context: context(grid: -1), forecast: [], now: now,
                                                  cycleEnd: now.addingTimeInterval(7200)).last)
        #expect(end.date == now.addingTimeInterval(7200))
        #expect(abs(end.estimatedCost - 3.9) < 0.000001)
    }
}
