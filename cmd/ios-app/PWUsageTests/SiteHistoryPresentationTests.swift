import Foundation
@testable import PWUsage
import Testing

@Suite("Site history presentation")
struct SiteHistoryPresentationTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-1")
    /// 2026-11-02 12:00 in Chicago (CST).
    private let now = Date(timeIntervalSince1970: 1_793_642_400)
    private let chicago = TimeZone(identifier: "America/Chicago") ?? .gmt
    private let home = SolarHomeLocation(latitude: 43.4, longitude: -87.9, source: .device)

    private func progress(
        _ phase: SiteHistoryOnboardingProgress.Phase = .active, oldest: String = "2026-07-25"
    ) -> SiteHistoryOnboardingProgress {
        var progress = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
        progress.oldestChecked = oldest
        progress.phase = phase
        return progress
    }

    private static func days(_ count: Int) -> [String] {
        (1 ... max(count, 1)).compactMap { SiteLocalDays.adding(-$0, to: "2026-11-02", timeZone: .gmt) }
            .prefix(count).map(\.self)
    }

    /// `clear` of the stored days are clear and the rest cloudy.
    private static func ledger(_ days: [String], clear: Int) -> SiteHistoryDayLedger {
        var types: [String: SolarDayType] = [:]
        for (index, day) in days.enumerated() { types[day] = index < clear ? .clear : .cloudy }
        return SiteHistoryDayLedger(days: types)
    }

    private static func result(_ confidence: String) -> DetectedSolarLayout {
        DetectedSolarLayout(
            status: confidence == "low" ? .lowConfidence : .detected, confidence: confidence, reasons: [],
            planes: [
                .init(azimuth: 202, tilt: 22, dcKwp: 6.2, effectiveKw: 5.3, azimuthRange90: [190, 214],
                      tiltRange90: [20, 24]),
                .init(azimuth: 110, tilt: 18, dcKwp: 2.6, effectiveKw: 2.2, azimuthRange90: [90, 130],
                      tiltRange90: [15, 21])],
            acClipKw: nil, historyDays: 120, clearDays: 30, firstDay: nil, lastDay: nil)
    }

    private func present(
        _ progress: SiteHistoryOnboardingProgress?, throttle: Date? = nil, result: DetectedSolarLayout? = nil,
        location: SolarHomeLocation? = nil, stored: Int = 96, clear: Int = 21, passed: Bool = true
    ) -> SiteHistoryPresentation {
        let days = Self.days(stored)
        return SiteHistoryPresentation(
            status: SiteHistoryStatus(
                scope: scope, progress: progress, throttledUntil: throttle, result: result,
                homeLocation: location ?? home, storedDays: days,
                ledger: passed ? Self.ledger(days, clear: clear) : nil),
            now: now, timeZone: chicago)
    }

    @Test func loadingCountsTheStoredDaysNotTheOnboardingPosition() {
        // The cursor says 100 days were checked; the phone holds 96.
        let loading = present(progress())
        #expect(loading.phase == .loading)
        #expect(loading.downloadedDays == 96)
        #expect(loading.clearDays == 21)
        #expect(loading.producingDays == 96)
        #expect(loading.statusLine == "96 days downloaded, 21 clear")
        #expect(loading.rowValue == "Loading")
        #expect(loading.showsBanner)
        #expect(loading.action == nil)
        #expect(loading.accessibilitySummary == "Finding your solar system. 96 days downloaded, 21 clear.")
        #expect(!loading.statusLine.contains("checked"))
    }

    @Test func daysNotYetSortedAreDownloadedOnly() {
        let early = present(progress(), stored: 6, passed: false)
        #expect(early.statusLine == "6 days downloaded")
        #expect(early.clearDays == 0)
    }

    @Test func aTeslaLimitWaitsWithATime() {
        let waiting = present(progress(), throttle: now.addingTimeInterval(1800))
        #expect(waiting.phase == .waiting)
        #expect(waiting.statusLine.hasPrefix("Tesla is limiting requests. Continues after"))
        #expect(waiting.showsBanner)
        #expect(present(progress(), throttle: now.addingTimeInterval(-1)).phase == .loading)
    }

    @Test func withoutALocationItAsksForOne() {
        let missing = SiteHistoryPresentation(
            status: SiteHistoryStatus(scope: scope, progress: progress(.finished(.locationNeeded)),
                                      throttledUntil: nil, storedDays: Self.days(90)),
            now: now)
        #expect(missing.phase == .needsLocation)
        #expect(missing.action == .addLocation)
        #expect(missing.statusLine == "Add your location to find your solar system")
        #expect(missing.showsBanner)
    }

    @Test func aReconnectPauseAsksForTheActionAndHidesTheBanner() {
        let paused = present(progress(.paused(.reconnectTesla)))
        #expect(paused.phase == .needsReconnect)
        #expect(paused.action == .reconnectTesla)
        #expect(!paused.showsBanner)
        #expect(present(progress(.paused(.signIn))).action == nil)
    }

    @Test func aUsableLayoutStillLoadingIsImproving() {
        let improving = present(progress(), result: Self.result("medium"))
        #expect(improving.phase == .foundImproving)
        #expect(improving.statusLine == "Usable, still improving")
        #expect(!improving.showsBanner)
        #expect(improving.accessibilitySummary
            == "Finding your solar system. 96 days downloaded, 21 clear. Usable, still improving.")
    }

    @Test func highConfidenceOrAFinishedSearchIsFinal() {
        let high = present(progress(), result: Self.result("high"))
        #expect(high.phase == .foundFinal)
        #expect(high.statusLine == "Found with high confidence")
        let finished = present(progress(.finished(.reachedOneYear)), result: Self.result("medium"))
        #expect(finished.phase == .foundFinal)
        #expect(finished.accessibilitySummary == "Solar system: 8.8 kilowatts, two panel groups, "
            + "main group facing south-southwest, tilted 22 degrees, medium confidence.")
    }

    @Test func anEstimatedLocationOffersTheExactOneOnceFound() {
        let estimated = SolarHomeLocation(latitude: 43.4, longitude: -87.9, source: .estimated)
        #expect(present(progress(), result: Self.result("high"), location: estimated).action == .useExactLocation)
        #expect(present(progress(), location: estimated).action == nil)
    }

    @Test func finishesWithoutALayoutAreUnavailable() {
        let none = present(progress(.finished(.noSolarProduction)), clear: 0)
        #expect(none.phase == .unavailable)
        #expect(none.statusLine == "No solar production found")
        #expect(!none.showsBanner)
        #expect(present(progress(.finished(.historyUnavailable))).rowValue == "Unavailable")
        #expect(present(progress(.finished(.reachedHistoryStart))).statusLine
            == "Not enough clear days to find a layout yet")
    }

    @Test func nothingYet() {
        let none = SiteHistoryPresentation(status: nil, now: now)
        #expect(none.phase == .loading)
        #expect(!none.showsBanner)
        #expect(none.countsText.isEmpty)
    }

    @Test func compassNames() {
        #expect(SolarSystemCompass.abbreviation(202) == "SSW")
        #expect(SolarSystemCompass.name(202) == "south-southwest")
        #expect(SolarSystemCompass.abbreviation(355) == "N")
        #expect(SolarSystemCompass.abbreviation(-90) == "W")
    }
}
