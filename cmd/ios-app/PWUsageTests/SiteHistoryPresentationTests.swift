import Foundation
@testable import PWUsage
import Testing

@Suite("Site history presentation")
struct SiteHistoryPresentationTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-1")
    /// 2026-11-02 12:00 in Chicago (CST).
    private let now = Date(timeIntervalSince1970: 1_793_642_400)
    private let chicago = TimeZone(identifier: "America/Chicago") ?? .gmt

    private func progress(
        _ phase: SiteHistoryOnboardingProgress.Phase = .active, oldest: String = "2026-09-21"
    ) -> SiteHistoryOnboardingProgress {
        var progress = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
        progress.oldestChecked = oldest
        progress.phase = phase
        progress.daysWithData = 30
        return progress
    }

    private func present(
        _ progress: SiteHistoryOnboardingProgress?, throttle: Date? = nil, usable: Bool = false
    ) -> SiteHistoryPresentation {
        SiteHistoryPresentation(
            status: SiteHistoryStatus(
                scope: scope, progress: progress, throttledUntil: throttle, hasUsableLayout: usable),
            now: now, timeZone: chicago)
    }

    @Test func loadingShowsTheAccessoryWithCheckedAndAvailableDaysApart() {
        let loading = present(progress())
        #expect(loading.rowValue == "Loading")
        #expect(loading.showsAccessory)
        #expect(loading.checkedDays == 42)
        #expect(loading.daysWithData == 30)
        #expect(loading.checkedDaysText == "42 days checked")
        #expect(!loading.checkedDaysText.contains("of"))
        #expect(loading.checkedRange?.contains(" to ") == true)
    }

    @Test func aSiteWithAUsableLayoutLoadsRecentDaysQuietly() {
        let recent = present(progress(), usable: true)
        #expect(!recent.showsAccessory)
        #expect(recent.headline == "Loading recent history")
    }

    @Test func aTeslaLimitWaitsWithATimeAndKeepsTheAccessory() {
        let waiting = present(progress(), throttle: now.addingTimeInterval(1800))
        #expect(waiting.rowValue == "Waiting")
        #expect(waiting.detail.hasPrefix("Tesla is limiting requests."))
        #expect(waiting.action == nil)
        #expect(waiting.showsAccessory)
        #expect(present(progress(), throttle: now.addingTimeInterval(-1)).rowValue == "Loading")
    }

    @Test func aReconnectPauseAsksForTheActionAndHidesTheAccessory() {
        let paused = present(progress(.paused(.reconnectTesla)))
        #expect(paused.rowValue == "Paused")
        #expect(paused.action == .reconnectTesla)
        #expect(!paused.showsAccessory)
        #expect(present(progress(.paused(.signIn))).action == nil)
    }

    @Test func finishesSayWhatIsKnownAndWhatHappensNext() {
        #expect(present(progress(.finished(.layoutFound))).headline == "Solar layout found")
        let location = present(progress(.finished(.locationNeeded)))
        #expect(location.action == .setLocation)
        #expect(!location.showsAccessory)
        let year = present(progress(.finished(.reachedOneYear)))
        #expect(year.detail.contains("a year of history"))
        #expect(year.detail.contains("checked again as new days arrive"))
        var stuck = progress(.finished(.reachedHistoryStart))
        stuck.lastOutlook = .needsOtherAction
        #expect(present(stuck).action == .openSolarForecast)
        #expect(present(progress(.finished(.historyUnavailable))).rowValue == "Unavailable")
    }

    @Test func nothingCheckedYetHasNoRange() {
        let none = SiteHistoryPresentation(status: nil, now: now)
        #expect(none.rowValue == "Not Started")
        #expect(none.checkedRange == nil)
        #expect(!none.showsAccessory)
        #expect(present(progress(oldest: "2026-11-02")).checkedRange == nil)
        #expect(present(progress(oldest: "2026-11-01")).checkedRange?.contains(" to ") == false)
        #expect(present(progress(oldest: "2026-11-01")).checkedDaysText == "1 day checked")
    }
}
