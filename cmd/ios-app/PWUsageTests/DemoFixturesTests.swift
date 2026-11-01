import Foundation
@testable import PWUsage
import Testing

/// The demo is what App Review sees, so these pin the story it has to tell at any
/// real hour: On-peak is on now, Off-peak is cheaper soon, and the bill has a
/// forecast with about ten days left.
@MainActor
@Suite("Demo fixtures")
struct DemoFixturesTests {
    private static var chicago: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = DemoFixtures.timeZone
        return calendar
    }

    @Test("Every fixture decodes")
    func decodesAll() throws {
        let asOf = Date.now
        _ = try DemoFixtures.live(asOf: asOf)
        _ = try DemoFixtures.bill(asOf: asOf)
        _ = try DemoFixtures.planningContext(asOf: asOf).validating(siteID: DemoFixtures.site.id, now: asOf)
        _ = try DemoFixtures.tariffs(asOf: asOf).validating(siteID: DemoFixtures.site.id)
    }

    @Test("The bill cycle ends ten days from today")
    func cycleHasTenDaysLeft() throws {
        let asOf = Date.now
        let bill = try DemoFixtures.bill(asOf: asOf)
        let today = Self.chicago.startOfDay(for: asOf)
        let days = Self.chicago.dateComponents([.day], from: today, to: bill.currentBill.cycleEnd).day
        #expect(days == 10)
        #expect(bill.currentBill.cycleStart < asOf)
    }

    /// A Sunday night, when the real tariff is all Off-peak, and a weekday afternoon.
    @Test("On-peak is on now, whatever the real day and hour",
          arguments: ["2026-11-01T23:30:00-06:00", "2026-11-03T14:00:00-06:00"])
    func peakIsActiveAtAnyHour(_ when: String) throws {
        let asOf = try #require(ISO8601DateFormatter().date(from: when))
        let loadTiming = try #require(try DemoFixtures.bill(asOf: asOf).loadTiming)
        let current = try #require(loadTiming.tariffTimeline.first { $0.start <= asOf && asOf < $0.end })
        #expect(current.name == "On-peak")
        #expect(current.buyRate == 0.31)
        #expect(loadTiming.nextCheaper?.marginalCost == 0.10)
        #expect(try DemoFixtures.live(asOf: asOf).activeLoadTiming?.periodName == "On-peak")
    }

    @Test("Waiting for Off-peak is cheaper than now")
    func waitingIsCheaper() throws {
        let loadTiming = try #require(try DemoFixtures.bill(asOf: .now).loadTiming)
        let activePeriod = loadTiming.periods.first { $0.isActive }
        let active = try #require(activePeriod)
        let activeCost = try #require(active.marginalCost)
        let next = try #require(loadTiming.nextCheaper)
        #expect(active.name == "On-peak")
        #expect(activeCost == 0.31)
        #expect(activeCost > next.marginalCost)
        #expect(next.name == "Off-peak")
    }

    /// The outlook's `complete` means "no missing days", and the projection
    /// refuses an incomplete history, so it must be true for a forecast to show.
    @Test("The bill outlook forecasts to the cycle end")
    func outlookForecastsToCycleEnd() throws {
        let asOf = Date.now
        let bill = try DemoFixtures.bill(asOf: asOf)
        let outlook = try #require(bill.outlook)
        #expect(outlook.observedThrough <= asOf)
        #expect(outlook.complete)
        #expect(outlook.points.last?.date == outlook.observedThrough)
        let context = try #require(DemoFixtures.planningContext(asOf: asOf).estimatorContext)
        let projection = BillOutlook.evaluate(history: outlook, context: context, forecast: [],
                                              now: asOf, cycleEnd: bill.currentBill.cycleEnd)
        #expect(projection.points.last?.date == bill.currentBill.cycleEnd)
        let soFar = try #require(bill.currentBill.estimatedCost)
        #expect((90 ... 140).contains(soFar))
        #expect(abs((outlook.points.last?.estimatedCost ?? 0) - soFar) < 0.01)
    }

    @Test("Rate plans show the demo's two periods")
    func tariffsMatchTimeline() throws {
        let tariffs = DemoFixtures.tariffs(asOf: .now)
        let periods = tariffs.tariffs.flatMap(\.seasons).flatMap(\.periods)
        #expect(periods.map(\.name) == ["On-peak", "Off-peak"])
        #expect(periods.map(\.buyRate) == [0.31, 0.10])
        #expect(periods.map(\.sellRate) == [0.04, 0.03])
    }

    @Test("No real home's identifiers ship in the demo")
    func isAnonymized() throws {
        let asOf = Date.now
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let texts = try [
            String(bytes: encoder.encode(DemoFixtures.live(asOf: asOf)), encoding: .utf8) ?? "",
            String(bytes: encoder.encode(DemoFixtures.bill(asOf: asOf)), encoding: .utf8) ?? "",
            String(bytes: encoder.encode(DemoFixtures.tariffs(asOf: asOf)), encoding: .utf8) ?? "",
            // The planning context is decode-only.
            String(describing: DemoFixtures.planningContext(asOf: asOf)),
            String(describing: DemoFixtures.site)]
        for text in texts {
            for banned in ["Harrison", "2252268092126997", "We energies", "latitude", "longitude"] {
                #expect(!text.localizedCaseInsensitiveContains(banned), "found \(banned)")
            }
        }
    }
}
