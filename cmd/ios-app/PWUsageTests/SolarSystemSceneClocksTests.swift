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
        clocks.observe(days: days(["2026-11-01": .clear, "2026-10-31": .cloudy]), hasLayout: true, now: now)
        #expect(!clocks.isAnimating(at: now))
        #expect(clocks.growth("2026-11-01", at: now) == 1)
        #expect(clocks.flight("2026-11-01", at: now) == (1, 1))
        #expect(clocks.found(at: now) == 1)
    }

    @Test func newDaysGrowInAndNewlyClearDaysFly() {
        var clocks = SolarSystemSceneClocks()
        clocks.observe(days: days(["2026-11-01": nil]), hasLayout: false, now: now)
        clocks.observe(days: days(["2026-11-01": .clear, "2026-10-31": nil]), hasLayout: false, now: now)
        #expect(clocks.growth("2026-10-31", at: now) == 0)
        #expect(clocks.growth("2026-10-31", at: now.addingTimeInterval(1)) == 1)
        #expect(clocks.growth("2026-11-01", at: now) == 1)
        let early = clocks.flight("2026-11-01", at: now.addingTimeInterval(0.2))
        #expect(early.travel == 0)
        let landed = clocks.flight("2026-11-01", at: now.addingTimeInterval(2))
        #expect(landed.travel == 1)
        #expect(landed.ray == 1)
        #expect(clocks.isAnimating(at: now.addingTimeInterval(0.5)))
        #expect(!clocks.isAnimating(at: now.addingTimeInterval(5)))
    }

    @Test func aLayoutArrivingStartsTheFoundSequenceOnce() {
        var clocks = SolarSystemSceneClocks()
        clocks.observe(days: [], hasLayout: false, now: now)
        clocks.observe(days: [], hasLayout: true, now: now)
        #expect(clocks.found(at: now) == 0)
        #expect(clocks.found(at: now.addingTimeInterval(SolarSystemSceneClocks.foundDuration + 0.01)) == 1)
        clocks.observe(days: [], hasLayout: true, now: now.addingTimeInterval(1))
        #expect(clocks.found(at: now.addingTimeInterval(1)) < 1)
    }
}
