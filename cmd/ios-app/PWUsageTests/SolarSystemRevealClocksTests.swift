import Foundation
@testable import PWUsage
import Testing

/// The replay of a found system for someone who wasn't watching when it was found.
@Suite("Solar System reveal clocks")
struct SolarSystemRevealClocksTests {
    private let now = Date(timeIntervalSince1970: 1_793_642_400)
    private let clear = "2026-11-01"
    private let cloudy = "2026-10-31"
    private let oldest = "2026-10-01"

    private var days: [SiteHistoryStatus.Day] {
        [.init(day: oldest, type: .clear), .init(day: cloudy, type: .cloudy), .init(day: clear, type: .clear)]
    }

    private func revealing(days: [SiteHistoryStatus.Day]? = nil) -> SolarSystemSceneClocks {
        var clocks = SolarSystemSceneClocks()
        clocks.observe(days: days ?? self.days, columns: 5, hasLayout: true, revealOwed: true, now: now)
        return clocks
    }

    private func seenAt(_ clocks: SolarSystemSceneClocks) -> Date? {
        if case .playing(let seenAt) = clocks.reveal { return seenAt }
        return nil
    }

    @Test func aFirstLookWithoutAnOwedRevealStillShowsTheFinishedHouse() {
        var clocks = SolarSystemSceneClocks()
        clocks.observe(days: days, columns: 5, hasLayout: true, revealOwed: false, now: now)
        #expect(clocks.reveal == .none)
        #expect(!clocks.isAnimating(at: now))
        #expect(clocks.build(at: now) == 1)
    }

    @Test func anOwedRevealStartsFromAnEmptyStrip() {
        let clocks = revealing()
        #expect(clocks.isReplaying)
        #expect(clocks.isAnimating(at: now))
        #expect(clocks.growth(oldest, at: now) == 0)
        #expect(clocks.build(at: now) == 0)
        #expect(clocks.widenedColumns(at: now) == 1)
    }

    @Test func theStripGrowsOutwardFromTheNewestWeek() {
        let clocks = revealing()
        let early = now.addingTimeInterval(SolarSystemSceneClocks.growDuration + 0.01)
        #expect(clocks.growth(clear, at: early) == 1)
        #expect(clocks.growth(oldest, at: early) < 1)
        let grown = now.addingTimeInterval(
            SolarSystemSceneClocks.revealGrow + SolarSystemSceneClocks.growDuration)
        #expect(clocks.growth(oldest, at: grown) == 1)
        #expect(clocks.widenedColumns(at: grown) == nil)
    }

    @Test func daysTakeTheirColorsInOneSweepAfterTheStripHasGrown() {
        let clocks = revealing()
        #expect(!clocks.isSorted(clear, at: now))
        #expect(!clocks.isSorted(oldest, at: now.addingTimeInterval(SolarSystemSceneClocks.revealGrow)))
        let swept = now.addingTimeInterval(SolarSystemSceneClocks.revealGrow + SolarSystemSceneClocks.revealSweep)
        #expect(clocks.isSorted(clear, at: swept))
        #expect(clocks.isSorted(oldest, at: swept))
    }

    @Test func onlyClearDaysFlyAndOnlyAfterTheSweep() {
        let clocks = revealing()
        let swept = SolarSystemSceneClocks.revealGrow + SolarSystemSceneClocks.revealSweep
        #expect(clocks.flight(clear, at: now.addingTimeInterval(swept - 0.01)) == 0)
        #expect(clocks.hasLanded(cloudy, at: now))
        let landed = now.addingTimeInterval(swept + SolarSystemSceneClocks.revealFlights + 0.01)
        #expect(clocks.hasLanded(clear, at: landed))
        #expect(clocks.hasLanded(oldest, at: landed))
    }

    @Test func flightsTakeTheSameTimeHoweverManyClearDaysThereAre() throws {
        let many = try (0 ..< 300).map { offset in
            let day = try #require(SiteLocalDays.adding(-offset, to: clear, timeZone: .gmt))
            return SiteHistoryStatus.Day(day: day, type: .clear)
        }
        let clocks = revealing(days: many)
        let landed = now.addingTimeInterval(SolarSystemSceneClocks.revealGrow
            + SolarSystemSceneClocks.revealSweep + SolarSystemSceneClocks.revealFlights + 0.01)
        #expect(many.allSatisfy { clocks.hasLanded($0.day, at: landed) })
    }

    @Test func theWholeRevealRunsAboutElevenSeconds() throws {
        let clocks = revealing()
        var end = now.addingTimeInterval(10)
        #expect(clocks.isAnimating(at: end))
        end = now.addingTimeInterval(12)
        #expect(!clocks.isAnimating(at: end))
        #expect(clocks.houseTime(at: end) > SolarSystemSceneClocks.houseDuration)
        let seen = try #require(seenAt(clocks))
        #expect(abs(clocks.houseTime(at: seen)) < 1e-6)
    }

    @Test func aDayWithNoFlightStillGetsItsRevealWithNoClearDays() throws {
        let clocks = revealing(days: [.init(day: cloudy, type: .cloudy)])
        #expect(try #require(seenAt(clocks)) > now)
        #expect(clocks.build(at: now) == 0)
    }

    @Test func laterStatusChangesDoNotRestartAReveal() throws {
        var clocks = revealing()
        let started = try #require(seenAt(clocks))
        clocks.observe(days: days, columns: 5, hasLayout: true, revealOwed: true, now: now.addingTimeInterval(4))
        #expect(seenAt(clocks) == started)
        // Acknowledged part way through: it plays on.
        clocks.observe(days: days, columns: 5, hasLayout: true, revealOwed: false, now: now.addingTimeInterval(9))
        #expect(clocks.isAnimating(at: now.addingTimeInterval(9)))
    }

    @Test func skippingSettlesOnTheFinishedHouseAtOnce() {
        var clocks = revealing()
        clocks.skipReveal()
        #expect(clocks.reveal == .skipped)
        #expect(!clocks.isAnimating(at: now))
        #expect(clocks.build(at: now) == 1)
        #expect(clocks.growth(oldest, at: now) == 1)
        #expect(clocks.isSorted(oldest, at: now))
        #expect(clocks.hasLanded(clear, at: now))
        #expect(clocks.widenedColumns(at: now) == nil)
        // Still owed for a moment after the skip: no restart.
        clocks.observe(days: days, columns: 5, hasLayout: true, revealOwed: true, now: now)
        #expect(clocks.reveal == .skipped)
    }

    @Test func watchingTheFindLivePlaysItOnceAndCountsAsTheReveal() throws {
        var clocks = SolarSystemSceneClocks()
        clocks.observe(days: days, columns: 5, hasLayout: false, revealOwed: false, now: now)
        clocks.observe(days: days, columns: 5, hasLayout: true, revealOwed: true, now: now)
        #expect(!clocks.isReplaying)
        #expect(clocks.isSorted(clear, at: now))
        let seen = try #require(seenAt(clocks))
        #expect(abs(clocks.houseTime(at: seen)) < 1e-6)
    }

    @Test func anOwedRevealForAnAlreadyStandingHousePlaysInPlace() {
        var clocks = SolarSystemSceneClocks()
        clocks.observe(days: days, columns: 5, hasLayout: true, revealOwed: false, now: now)
        clocks.observe(days: days, columns: 5, hasLayout: true, revealOwed: true, now: now)
        #expect(clocks.isReplaying)
    }

    // MARK: - The scene during a reveal

    private func frame(_ clocks: SolarSystemSceneClocks, at time: Date) -> SceneFrame {
        var input = SolarSystemSceneInput(status: nil, layout: nil, isWaiting: false)
        input.days = days
        input.fittedRange = [195, 210]
        input.groups = [SolarSystemHouse.Group(azimuth: 202, tilt: 22, kilowatts: 8.8)]
        return SceneFrame(input: input, clocks: clocks, camera: .found, now: time)
    }

    @Test func theSceneWaitsOverheadWithTheStripUntilTheBuild() {
        let frame = frame(revealing(), at: now.addingTimeInterval(3))
        #expect(frame.stripPresence == 1)
        #expect(frame.sceneHeight == SolarSystemVisual.sceneHeight)
        #expect(frame.build == 0)
        #expect(frame.wedgeCenter == 202)
    }

    @Test func theWedgeNarrowsAsDaysLandInsteadOfStartingAtTheFit() {
        let clocks = revealing()
        let fitted = SolarSystemWedge.width(clearDays: 2, fittedRange: [195, 210])
        let swept = SolarSystemSceneClocks.revealGrow + SolarSystemSceneClocks.revealSweep
        let early = frame(clocks, at: now.addingTimeInterval(swept))
        #expect(early.wedgeWidth > fitted)
        let oneLanded = frame(clocks, at: now.addingTimeInterval(swept + SolarSystemSceneClocks.flightDuration + 0.01))
        let allLanded = frame(clocks, at: now.addingTimeInterval(swept + SolarSystemSceneClocks.revealFlights + 0.01))
        #expect(allLanded.landedClear == 2)
        #expect(oneLanded.wedgeWidth >= allLanded.wedgeWidth)
    }
}
