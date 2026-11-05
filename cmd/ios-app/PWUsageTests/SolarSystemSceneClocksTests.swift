import Foundation
@testable import PWUsage
import Testing

@Suite("Solar System scene clocks")
struct SolarSystemSceneClocksTests {
    private let now = Date(timeIntervalSince1970: 1_793_642_400)

    private func days(_ types: [String: SolarDayType?]) -> [SiteHistoryStatus.Day] {
        types.keys.sorted().map { SiteHistoryStatus.Day(day: $0, type: types[$0] ?? nil) }
    }

    @Test func theFirstLookShowsTheCurrentStateWithoutReplaying() {
        var clocks = SolarSystemSceneClocks()
        clocks.observe(days: days(["2026-11-01": .clear, "2026-10-31": .cloudy]), columns: 2, hasLayout: true,
                       now: now)
        #expect(!clocks.isAnimating(at: now))
        #expect(clocks.growth("2026-11-01", at: now) == 1)
        #expect(clocks.flight("2026-11-01", at: now) == 1)
        #expect(clocks.build(at: now) == 1)
        #expect(clocks.houseTime(at: now) > 100)
        #expect(clocks.widenedColumns(at: now) == nil)
    }

    @Test func newDaysGrowInAndNewlyClearDaysFlyForOnePointOneSeconds() {
        var clocks = SolarSystemSceneClocks()
        clocks.observe(days: days(["2026-11-01": nil]), columns: 1, hasLayout: false, now: now)
        clocks.observe(days: days(["2026-11-01": .clear, "2026-10-31": nil]), columns: 1, hasLayout: false,
                       now: now)
        #expect(clocks.growth("2026-10-31", at: now) == 0)
        #expect(clocks.growth("2026-10-31", at: now.addingTimeInterval(1)) == 1)
        #expect(clocks.growth("2026-11-01", at: now) == 1)
        #expect(clocks.flight("2026-11-01", at: now) == 0)
        #expect(!clocks.hasLanded("2026-11-01", at: now.addingTimeInterval(1)))
        #expect(clocks.hasLanded("2026-11-01", at: now.addingTimeInterval(1.5)))
        #expect(clocks.isAnimating(at: now.addingTimeInterval(0.5)))
        #expect(!clocks.isAnimating(at: now.addingTimeInterval(5)))
    }

    @Test func theStripWidensSmoothlyWhenAWeekArrives() throws {
        var clocks = SolarSystemSceneClocks()
        clocks.observe(days: [], columns: 3, hasLayout: false, now: now)
        clocks.observe(days: [], columns: 4, hasLayout: false, now: now)
        let middle = try #require(clocks.widenedColumns(at: now.addingTimeInterval(0.25)))
        #expect(middle > 3 && middle < 4)
        #expect(clocks.widenedColumns(at: now.addingTimeInterval(1)) == nil)
    }

    @Test func theBuildWaitsForTheLastFlightThenRunsOnce() {
        var clocks = SolarSystemSceneClocks()
        clocks.observe(days: days(["2026-11-01": nil]), columns: 1, hasLayout: false, now: now)
        clocks.observe(days: days(["2026-11-01": .clear]), columns: 1, hasLayout: true, now: now)
        let landed = clocks.flights.values.map { $0.addingTimeInterval(SolarSystemSceneClocks.flightDuration) }
            .max() ?? now
        let start = landed.addingTimeInterval(SolarSystemSceneClocks.buildDelay)
        #expect(clocks.build(at: start) == 0)
        #expect(clocks.build(at: start.addingTimeInterval(SolarSystemSceneClocks.buildDuration + 0.01)) == 1)
        #expect(abs(clocks.houseTime(at: start) + SolarSystemSceneClocks.houseStart) < 1e-6)
        clocks.observe(days: days(["2026-11-01": .clear]), columns: 1, hasLayout: true, now: start)
        #expect(clocks.build(at: start) == 0)
    }

    @Test func easingIsCubicInAndOut() {
        #expect(SolarSystemSceneClocks.ease(0) == 0)
        #expect(SolarSystemSceneClocks.ease(0.5) == 0.5)
        #expect(SolarSystemSceneClocks.ease(1) == 1)
        #expect(abs(SolarSystemSceneClocks.ease(0.25) - 0.0625) < 1e-12)
    }

    // MARK: - The day strip

    private func stripPresence(_ clocks: SolarSystemSceneClocks, isFound: Bool, at time: Date) -> Double {
        var input = SolarSystemSceneInput(status: nil, layout: nil, isWaiting: false)
        if isFound { input.groups = [SolarSystemHouse.Group(azimuth: 180, tilt: 20, kilowatts: 8)] }
        return SceneFrame(input: input, clocks: clocks, camera: .found, now: time).stripPresence
    }

    @Test func theStripShowsWhileLoadingAndIsGoneWhenOpeningOnAFoundSystem() {
        #expect(stripPresence(SolarSystemSceneClocks(), isFound: false, at: now) == 1)
        var opened = SolarSystemSceneClocks()
        opened.observe(days: days(["2026-11-01": .clear]), columns: 1, hasLayout: true, now: now)
        #expect(stripPresence(opened, isFound: true, at: now) == 0)
    }

    @Test func theStripLeavesDuringTheFindAfterTheLastFlightLands() {
        var clocks = SolarSystemSceneClocks()
        clocks.observe(days: days(["2026-11-01": nil]), columns: 1, hasLayout: false, now: now)
        clocks.observe(days: days(["2026-11-01": .clear]), columns: 1, hasLayout: true, now: now)
        // The dots fly from the strip, so it stays until the tilt is underway.
        #expect(stripPresence(clocks, isFound: true, at: now.addingTimeInterval(1)) == 1)
        let tilted = now.addingTimeInterval(SolarSystemSceneClocks.flightDuration + 0.3
            + SolarSystemSceneClocks.buildDelay + SolarSystemSceneClocks.buildDuration + 1)
        #expect(stripPresence(clocks, isFound: true, at: tilted) == 0)
    }
}
