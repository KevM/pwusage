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

    @Test func loadingShowsTheNewestDaysAsDotsWithTheirColors() {
        let (model, presentation) = banner(status(location: home, days: 30))
        #expect(presentation.showsBanner)
        #expect(model.mode == .loading)
        #expect(model.countText == "30 days")
        #expect(model.dots.count == SolarSystemBannerModel.dotCount)
        #expect(model.dots.last?.day == "2026-11-01")
        // The three newest days are downloaded but not yet sorted.
        #expect(model.dots.suffix(3).allSatisfy { $0.type == nil })
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
}
