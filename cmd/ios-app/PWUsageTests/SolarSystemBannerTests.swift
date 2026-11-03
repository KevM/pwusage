import Foundation
@testable import PWUsage
import Testing

@Suite("Solar System banner")
struct SolarSystemBannerTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-1")
    private let now = Date(timeIntervalSince1970: 1_793_642_400)
    private let home = SolarHomeLocation(latitude: 43.4, longitude: -87.9, source: .device)

    private func status(
        location: SolarHomeLocation?, days: Int, throttle: Date? = nil,
        phase: SiteHistoryOnboardingProgress.Phase = .active
    ) -> SiteHistoryStatus {
        var progress = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
        progress.phase = phase
        let stored = (1 ... days).compactMap { SiteLocalDays.adding(-$0, to: "2026-11-02", timeZone: .gmt) }
        var types: [String: SolarDayType] = [:]
        for (index, day) in stored.enumerated() where index >= 3 {
            types[day] = index % 2 == 0 ? .clear : .cloudy
        }
        return SiteHistoryStatus(
            scope: scope, progress: progress, throttledUntil: throttle, homeLocation: location,
            storedDays: stored, ledger: SiteHistoryDayLedger(days: types))
    }

    private func banner(_ status: SiteHistoryStatus) -> (SolarSystemBannerModel, SiteHistoryPresentation) {
        let presentation = SiteHistoryPresentation(status: status, now: now)
        return (SolarSystemBannerModel(presentation: presentation, status: status), presentation)
    }

    @Test func loadingCarriesTheStoredDaysWithTheirColors() {
        let (model, presentation) = banner(status(location: home, days: 30))
        #expect(presentation.showsBanner)
        #expect(model.mode == .loading)
        #expect(model.countText == "30 days")
        #expect(model.days.count == 30)
        #expect(model.days.last?.day == "2026-11-01")
        // The three newest days are downloaded but not yet sorted.
        #expect(model.days.suffix(3).allSatisfy { $0.type == nil })
        #expect(!model.isPaused)
    }

    @Test func aTeslaLimitPausesTheDots() {
        let (model, presentation) = banner(status(location: home, days: 9, throttle: now.addingTimeInterval(600)))
        #expect(presentation.showsBanner)
        #expect(model.isPaused)
    }

    @Test func withoutALocationItAsksForOne() {
        let (model, presentation) = banner(status(location: nil, days: 9))
        #expect(presentation.showsBanner)
        #expect(model.mode == .needsLocation)
        #expect(model.accessibilityLabel == "Add your location to find your solar system")
    }

    @Test func hiddenWhenFinishedOrPausedForReconnect() {
        #expect(!banner(status(location: home, days: 9, phase: .paused(.reconnectTesla))).1.showsBanner)
        #expect(!banner(status(location: home, days: 9, phase: .finished(.reachedOneYear))).1.showsBanner)
        #expect(!SiteHistoryPresentation(status: nil, now: now).showsBanner)
    }

    // MARK: - Motion

    private func days(_ types: [String: SolarDayType?]) -> [SiteHistoryStatus.Day] {
        types.keys.sorted().map { SiteHistoryStatus.Day(day: $0, type: types[$0] ?? nil) }
    }

    @Test func newDaysGlideInThreesAndTheFirstLookReplaysNothing() {
        var clocks = SolarSystemBannerClocks()
        clocks.observe(days: days(["2026-10-01": .clear]), now: now)
        #expect(!clocks.isAnimating(at: now))
        #expect(clocks.landed(days(["2026-10-01": .clear]), at: now) == 1)

        let four = days(["2026-10-01": .clear, "2026-10-02": nil, "2026-10-03": nil, "2026-10-04": nil,
                         "2026-10-05": nil])
        clocks.observe(days: four, now: now)
        #expect(clocks.glide("2026-10-05", at: now) == 0)
        #expect(clocks.glide("2026-10-04", at: now) == nil)
        #expect(clocks.glide("2026-10-04", at: now.addingTimeInterval(SolarSystemBannerClocks.stagger)) == 0)
        // The fourth new day waits for the next group of three.
        #expect(clocks.glide("2026-10-02", at: now.addingTimeInterval(0.5)) == nil)
        #expect(clocks.glide("2026-10-02", at: now.addingTimeInterval(SolarSystemBannerClocks.groupSpacing)) == 0)
        #expect(!clocks.isAnimating(at: now.addingTimeInterval(3)))
    }

    @Test func motionEndsWhenTheLastGlideOrArcFinishes() throws {
        var clocks = SolarSystemBannerClocks()
        clocks.observe(days: days(["2026-10-01": nil]), now: now)
        #expect(clocks.motionEnd == nil)

        clocks.observe(days: days(["2026-10-01": .clear, "2026-10-02": nil]), now: now)
        // The new day glides now; the clear one arcs at once (it never had to glide).
        let end = try #require(clocks.motionEnd)
        #expect(end == now.addingTimeInterval(SolarSystemBannerClocks.glideDuration))
        #expect(clocks.isAnimating(at: end.addingTimeInterval(-0.01)))
        #expect(!clocks.isAnimating(at: end))
    }

    @Test func clearDaysArcIntoTheCompassAtThePass() {
        var clocks = SolarSystemBannerClocks()
        clocks.observe(days: days(["2026-10-01": nil]), now: now)
        let sorted = days(["2026-10-01": .clear])
        clocks.observe(days: sorted, now: now)
        #expect(clocks.arc("2026-10-01", at: now) == 0)
        #expect(clocks.landed(sorted, at: now) == 0)
        #expect(clocks.landed(sorted, at: now.addingTimeInterval(SolarSystemBannerClocks.arcDuration)) == 1)
    }
}
