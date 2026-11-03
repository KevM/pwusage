import Foundation
@testable import PWUsage
import Testing

@Suite("Solar layout clear-day pass")
struct SolarLayoutClearDaysTests {
    private static let chicago = TimeZone(identifier: "America/Chicago") ?? .gmt

    private static func classify(_ fixture: SolarLayoutFixture) throws -> SolarDayClassification {
        let timeZone = try #require(TimeZone(identifier: fixture.input.timeZone))
        return try SolarLayoutDetector.classifyDays(
            samples: SolarLayoutDetectorTests.samples(fixture), latitude: fixture.input.latitude,
            longitude: fixture.input.longitude, timeZone: timeZone, checkCancellation: {})
    }

    @Test(arguments: SolarLayoutDetectorTests.fixtureNames)
    func sortsEveryProducingDayIntoClearOrCloudy(name: String) throws {
        let fixture = try SolarLayoutFixture.load(name)
        let days = try Self.classify(fixture)
        #expect(days.producingDays == fixture.result.historyDays, "\(name) producing days")
        #expect(days.producingDays == days.clearDays + days.days.values.count(where: { $0 == .cloudy }))
        #expect(days.days.keys.allSatisfy { $0.count == 10 }, "\(name) site-local day keys")
    }

    /// The reference records the clear count only when detection got past the producing-day gate.
    @Test(arguments: ["east-west-clipped-60d", "south-shaded-100d"])
    func clearCountMatchesTheReference(name: String) throws {
        let fixture = try SolarLayoutFixture.load(name)
        let selection = try #require(fixture.stages.selection)
        #expect(try Self.classify(fixture).clearDays == selection.clearDays)
    }

    @Test func noHistoryHasNoDays() throws {
        let days = try SolarLayoutDetector.classifyDays(
            samples: [], latitude: 43.4, longitude: -87.9, timeZone: Self.chicago, checkCancellation: {})
        #expect(days.days.isEmpty)
        #expect(days.clearDays == 0)
    }

    @Test func storedDaysWithoutProductionAreNoProduction() throws {
        func at(_ iso: String, _ solarWh: Double) throws -> (timestamp: Date, solarWh: Double) {
            try (#require(ISO8601DateFormatter().date(from: iso)), solarWh)
        }
        // 11-01 straddles the fall-back change; both of its samples are 11-01 locally.
        let samples = try [
            at("2026-10-31T17:00:00Z", 0), at("2026-11-01T05:30:00Z", 0), at("2026-11-01T06:30:00Z", 0),
            at("2026-11-02T17:00:00Z", 80)]
        let days = try SolarLayoutDetector.classifyDays(
            samples: samples, latitude: 43.4, longitude: -87.9, timeZone: Self.chicago, checkCancellation: {})
        #expect(days.days["2026-10-31"] == .noProduction)
        #expect(days.days["2026-11-01"] == .noProduction)
        #expect(days.days["2026-11-02"] == .cloudy)
        #expect(days.days.count == 3)
        #expect(days.producingDays == 1)
    }

    @Test func honorsCancellation() {
        struct Stop: Error {}
        #expect(throws: Stop.self) {
            try SolarLayoutDetector.classifyDays(
                samples: [(Date(timeIntervalSince1970: 1_780_333_200), 50)], latitude: 43.4, longitude: -87.9,
                timeZone: Self.chicago, checkCancellation: { throw Stop() })
        }
    }
}
