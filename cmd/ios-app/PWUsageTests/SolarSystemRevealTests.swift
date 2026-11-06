import Foundation
@testable import PWUsage
import Testing

/// When a reveal is owed, and what the status, presentation and banner make of it.
@MainActor
@Suite("Solar System reveal")
struct SolarSystemRevealTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "site")
    private let other = SolarForecastSiteScope(accountScopeID: "account", siteID: "other")
    private let home = SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .device)
    private let now = Date(timeIntervalSince1970: 1_793_642_400)
    private let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)

    private func result(
        _ status: DetectedSolarLayout.Status = .detected, confidence: String = "medium"
    ) -> DetectedSolarLayout {
        let plane = DetectedSolarLayout.Plane(azimuth: 202, tilt: 22, dcKwp: 8.8, effectiveKw: 8.8,
                                              azimuthRange90: [195, 210], tiltRange90: [20, 24])
        return DetectedSolarLayout(status: status, confidence: status == .detected ? confidence : nil,
                                   reasons: [], planes: status == .detected ? [plane] : [], acClipKw: nil,
                                   historyDays: 90, clearDays: 20, firstDay: nil, lastDay: nil)
    }

    private func store() async throws -> SolarLayoutRecordStore {
        let store = SolarLayoutRecordStore(directory: folder)
        try await store.setLocation(home, scope: scope)
        return store
    }

    private func save(_ result: DetectedSolarLayout, to store: SolarLayoutRecordStore) async throws {
        try await store.saveResult(result, scope: scope, for: home, at: now)
    }

    // MARK: - The store

    @Test func theFirstUsableLayoutFoundOnThisPhoneOwesAReveal() async throws {
        let store = try await store()
        #expect(try await !store.isRevealOwed(scope: scope))
        try await save(result(), to: store)
        #expect(try await store.isRevealOwed(scope: scope))
        #expect(try await !store.isRevealOwed(scope: other))
    }

    @Test func aResultWithoutAUsableLayoutOwesNothing() async throws {
        let store = try await store()
        try await save(result(.notEnoughHistory), to: store)
        try await save(result(.detected, confidence: "low"), to: store)
        #expect(try await !store.isRevealOwed(scope: scope))
    }

    @Test func improvingALayoutOwesNoSecondReveal() async throws {
        let store = try await store()
        try await save(result(), to: store)
        try await store.acknowledgeReveal(scope: scope)
        try await save(result(confidence: "high"), to: store)
        #expect(try await !store.isRevealOwed(scope: scope))
    }

    @Test func aLayoutFromICloudNeverCelebrates() async throws {
        let store = SolarLayoutRecordStore(directory: folder)
        let restored = SolarLayoutRecord(
            location: home, locationSetAt: now, result: result(confidence: "high"), detectedAt: now,
            attemptedAt: now, detectorVersion: SolarLayoutDetector.version, resultLocation: home)
        try await store.applyRemoteRecord(restored, scope: scope)
        #expect(try await !store.isRevealOwed(scope: scope))
        // And it stays the found layout when this phone improves on it.
        try await save(result(confidence: "high"), to: store)
        #expect(try await !store.isRevealOwed(scope: scope))
    }

    @Test func aMediumLayoutFromICloudImprovedHereOwesNothing() async throws {
        let store = SolarLayoutRecordStore(directory: folder)
        let restored = SolarLayoutRecord(
            location: home, locationSetAt: now, result: result(), detectedAt: now,
            attemptedAt: now, detectorVersion: SolarLayoutDetector.version, resultLocation: home)
        try await store.applyRemoteRecord(restored, scope: scope)
        try await save(result(confidence: "high"), to: store)
        #expect(try await !store.isRevealOwed(scope: scope))
    }

    @Test func aNewDetectorVersionDoesNotCelebrateAnOldLayoutAgain() async throws {
        let store = SolarLayoutRecordStore(directory: folder)
        let older = SolarLayoutRecord(
            location: home, locationSetAt: now, result: result(), detectedAt: now,
            attemptedAt: now, detectorVersion: SolarLayoutDetector.version - 1, resultLocation: home)
        try await store.applyRemoteRecord(older, scope: scope)
        try await save(result(), to: store)
        #expect(try await !store.isRevealOwed(scope: scope))
    }

    @Test func anOwedRevealSurvivesARelaunchUntilAcknowledged() async throws {
        let store = try await store()
        try await save(result(), to: store)
        let relaunched = SolarLayoutRecordStore(directory: folder)
        #expect(try await relaunched.isRevealOwed(scope: scope))
        try await relaunched.acknowledgeReveal(scope: scope)
        #expect(try await !SolarLayoutRecordStore(directory: folder).isRevealOwed(scope: scope))
    }

    @Test func signingOutForgetsAnOwedReveal() async throws {
        let store = try await store()
        try await save(result(), to: store)
        try await store.removeAll()
        #expect(try await !store.isRevealOwed(scope: scope))
        #expect(try await !SolarLayoutRecordStore(directory: folder).isRevealOwed(scope: scope))
    }

    @Test func changingTheHomeLocationDropsTheOwedRevealAndAReFindCelebratesAgain() async throws {
        let store = try await store()
        try await save(result(), to: store)
        let moved = SolarHomeLocation(latitude: 44.0, longitude: -88.0, source: .device)
        try await store.setLocation(moved, scope: scope)
        #expect(try await !store.isRevealOwed(scope: scope))
        try await store.saveResult(result(), scope: scope, for: moved, at: now)
        #expect(try await store.isRevealOwed(scope: scope))
    }

    @Test func aLaterResultWithoutALayoutDropsTheOwedReveal() async throws {
        let store = try await store()
        try await save(result(), to: store)
        try await save(result(.notEnoughHistory), to: store)
        #expect(try await !store.isRevealOwed(scope: scope))
    }

    // MARK: - Status and presentation

    private func status(
        result: DetectedSolarLayout?, owed: Bool, phase: SiteHistoryOnboardingProgress.Phase = .active
    ) -> SiteHistoryStatus {
        var progress = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
        progress.phase = phase
        return SiteHistoryStatus(
            scope: scope, progress: progress, throttledUntil: nil, result: result, homeLocation: home,
            storedDays: ["2026-11-01"], isRevealOwed: owed)
    }

    @Test func anOwedRevealKeepsTheBannerUpInEveryFoundPhase() {
        for confidence in ["medium", "high"] {
            let found = status(result: result(confidence: confidence), owed: true)
            #expect(SiteHistoryPresentation(status: found, now: now).showsBanner)
        }
        let finished = status(result: result(), owed: true, phase: .finished(.reachedOneYear))
        #expect(SiteHistoryPresentation(status: finished, now: now).showsBanner)
        let paused = status(result: result(), owed: true, phase: .paused(.reconnectTesla))
        #expect(SiteHistoryPresentation(status: paused, now: now).showsBanner)
    }

    @Test func acknowledgingHidesTheBanner() {
        let seen = status(result: result(), owed: false)
        #expect(!SiteHistoryPresentation(status: seen, now: now).showsBanner)
    }

    @Test func nothingIsOwedWithoutALayoutToShow() {
        let hidden = status(result: nil, owed: true, phase: .finished(.reachedOneYear))
        #expect(!hidden.isRevealOwed)
        #expect(!SiteHistoryPresentation(status: hidden, now: now).showsBanner)
    }

    @Test func theBannerSaysWhatWasFound() {
        let found = status(result: result(), owed: true)
        let presentation = SiteHistoryPresentation(status: found, now: now)
        let model = SolarSystemBannerModel(presentation: presentation, status: found)
        #expect(model.mode == .found)
        #expect(model.title == "Found your solar system")
        #expect(model.inlineTitle == "Solar system found")
        #expect(model.detailText == "8.8 kW · facing south-southwest")
        #expect(model.wedgeCenter == 202)
        #expect(model.accessibilityLabel.hasPrefix("Found your solar system. Solar system: 8.8 kilowatts"))
    }

    @Test func aStillLoadingSiteWithoutAnOwedRevealKeepsTheLoadingBanner() {
        let loading = status(result: nil, owed: false)
        let presentation = SiteHistoryPresentation(status: loading, now: now)
        #expect(SolarSystemBannerModel(presentation: presentation, status: loading).mode == .loading)
    }

    // MARK: - The lifecycle

    private func lifecycle(_ environment: FakeOnboardingEnvironment) -> SiteHistoryOnboardingLifecycle {
        let store = SiteHistoryOnboardingStore(directory: folder)
        return SiteHistoryOnboardingLifecycle(
            onboarding: SiteHistoryOnboarding(environment: environment, store: store),
            store: store, ledgers: SiteHistoryDayLedgerStore(directory: folder),
            isHistoryEnabled: { _ in true }, scheduleBackground: { _ in })
    }

    @Test func theStatusCarriesAnOwedRevealAndAcknowledgingClearsIt() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.storedResult = result()
        environment.isRevealOwed = true
        let lifecycle = lifecycle(environment)
        lifecycle.activate(scope: scope)
        await lifecycle.foregroundTask?.value
        await lifecycle.refreshStatus()
        #expect(lifecycle.status?.isRevealOwed == true)

        await lifecycle.acknowledgeReveal(scope: scope)
        #expect(environment.isRevealOwed == false)
        #expect(lifecycle.status?.isRevealOwed == false)
        lifecycle.stop()
    }

    @Test func forgettingASiteForgetsItsOwedReveal() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.storedResult = result()
        environment.isRevealOwed = true
        let lifecycle = lifecycle(environment)
        await lifecycle.forget(scope: scope)
        #expect(environment.isRevealOwed == false)
        lifecycle.stop()
    }

    #if DEBUG
        // MARK: - Debug: Ignore Existing Layout

        @Test func ignoringHidesOnlyLayoutsFromBeforeItWasTurnedOn() throws {
            let defaults = try #require(UserDefaults(suiteName: "SolarSystemReveal.\(UUID().uuidString)"))
            #expect(!SiteHistoryDebugSettings.hidesResult(detectedAt: now, scope: scope, defaults: defaults))
            SiteHistoryDebugSettings.setIgnoresLayout(true, scope: scope, at: now, defaults: defaults)
            #expect(SiteHistoryDebugSettings.ignoresLayout(scope, defaults: defaults))
            #expect(SiteHistoryDebugSettings.hidesResult(
                detectedAt: now.addingTimeInterval(-1), scope: scope, defaults: defaults))
            #expect(!SiteHistoryDebugSettings.hidesResult(
                detectedAt: now.addingTimeInterval(1), scope: scope, defaults: defaults))
            #expect(!SiteHistoryDebugSettings.hidesResult(
                detectedAt: now.addingTimeInterval(-1), scope: other, defaults: defaults))
            SiteHistoryDebugSettings.setIgnoresLayout(false, scope: scope, at: now, defaults: defaults)
            #expect(!SiteHistoryDebugSettings.hidesResult(
                detectedAt: now.addingTimeInterval(-1), scope: scope, defaults: defaults))
        }

        @Test func aDebugReplayOwesARevealForTheStoredLayoutOnly() async throws {
            let store = try await store()
            try await store.markRevealOwed(scope: scope)
            #expect(try await !store.isRevealOwed(scope: scope))
            try await save(result(), to: store)
            try await store.acknowledgeReveal(scope: scope)
            try await store.markRevealOwed(scope: scope)
            #expect(try await store.isRevealOwed(scope: scope))
        }
    #endif
}
