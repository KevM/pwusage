import Foundation
@testable import PWUsage
import Testing

@MainActor
private final class LifecycleProbe {
    var now: Date
    var sleeps: [TimeInterval] = []
    var scheduled: [Date?] = []
    var historyEnabled = true

    init(now: Date) { self.now = now }
}

@MainActor
@Suite("Site history onboarding lifecycle")
struct SiteHistoryOnboardingLifecycleTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-1")
    private let other = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-2")
    private let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    /// 2026-11-02 12:00 in Chicago (CST).
    private let start = Date(timeIntervalSince1970: 1_793_642_400)

    private var store: SiteHistoryOnboardingStore { SiteHistoryOnboardingStore(directory: directory) }
    private var ledgers: SiteHistoryDayLedgerStore { SiteHistoryDayLedgerStore(directory: directory) }

    /// `sleep` defaults to moving the probe's clock forward, as if the wait had passed.
    private func make(
        _ environment: FakeOnboardingEnvironment, probe: LifecycleProbe,
        sleep: SiteHistoryOnboardingLifecycle.Sleep? = nil
    ) -> SiteHistoryOnboardingLifecycle {
        let store = store
        let clock = { probe.now }
        return SiteHistoryOnboardingLifecycle(
            onboarding: SiteHistoryOnboarding(environment: environment, store: store, now: clock),
            store: store,
            ledgers: ledgers,
            isHistoryEnabled: { _ in probe.historyEnabled },
            scheduleBackground: { probe.scheduled.append($0) },
            sleep: sleep ?? { delay in
                probe.sleeps.append(delay)
                probe.now = probe.now.addingTimeInterval(delay)
            },
            now: clock
        )
    }

    private static let sleepUntilCancelled: SiteHistoryOnboardingLifecycle.Sleep = { _ in
        try await Task.sleep(for: .seconds(3600))
    }

    @Test func theForegroundWaitsOutABackoffAndCarriesOn() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.producing = false
        environment.answers = [.fill(.busy)]
        let probe = LifecycleProbe(now: start)
        let lifecycle = make(environment, probe: probe)
        lifecycle.activate(scope: scope)
        await lifecycle.foregroundTask?.value
        #expect(probe.sleeps == [30])
        #expect(environment.requests.first?.from == environment.requests.dropFirst().first?.from)
        #expect(try await store.progress(scope: scope)?.phase == .finished(.noSolarProduction))
    }

    @Test func switchingSitesCancelsTheOtherSitesRunWithoutTouchingIt() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.producing = false
        environment.answers = [.fill(.busy)]
        let probe = LifecycleProbe(now: start)
        let lifecycle = make(environment, probe: probe, sleep: Self.sleepUntilCancelled)
        lifecycle.activate(scope: scope)
        try await eventually { environment.requests.count == 1 }
        let first = lifecycle.foregroundTask
        environment.defaultAnswer = .fill(.busy)
        lifecycle.activate(scope: other)
        await first?.value
        try await eventually { environment.sites.count == 2 }
        #expect(environment.sites == ["site-1", "site-2"])
        let waiting = try #require(try await store.progress(scope: scope))
        #expect(waiting.oldestChecked == waiting.checkedUntil)
        #expect(waiting.waitReason == .busy)
        #expect(lifecycle.lastScope == other)
        lifecycle.stop()
    }

    @Test func leavingTheForegroundAsksForTheSavedBackoff() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.producing = false
        environment.answers = [.fill(.busy)]
        let probe = LifecycleProbe(now: start)
        let lifecycle = make(environment, probe: probe, sleep: Self.sleepUntilCancelled)
        lifecycle.activate(scope: scope)
        try await eventually { environment.requests.count == 1 }
        await lifecycle.deactivate()
        #expect(probe.scheduled == [start.addingTimeInterval(30)])
        #expect(lifecycle.foregroundTask == nil)
    }

    @Test func anAccountThrottleDefersTheNextOpportunity() async throws {
        let probe = LifecycleProbe(now: start)
        let lifecycle = make(FakeOnboardingEnvironment(), probe: probe)
        try await store.setThrottle(start.addingTimeInterval(3600), accountScopeID: scope.accountScopeID)
        #expect(await lifecycle.nextOpportunity(scope: other) == start.addingTimeInterval(3600))
        #expect(await lifecycle.nextOpportunity(
            scope: SolarForecastSiteScope(accountScopeID: "account-b", siteID: "site-1")) == start)
    }

    @Test func aPausedOrFinishedSiteAsksForNoBackgroundTime() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.answers = [.failure(MobileSolarHistoryFillError.teslaReconnectRequired)]
        let probe = LifecycleProbe(now: start)
        let lifecycle = make(environment, probe: probe)
        lifecycle.activate(scope: scope)
        await lifecycle.foregroundTask?.value
        await lifecycle.deactivate()
        #expect(probe.scheduled == [nil])
    }

    @Test func aSiteWithoutTheHistoryBetaIsNeverAsked() async {
        let environment = FakeOnboardingEnvironment()
        let probe = LifecycleProbe(now: start)
        probe.historyEnabled = false
        let lifecycle = make(environment, probe: probe)
        lifecycle.activate(scope: scope)
        await lifecycle.foregroundTask?.value
        #expect(await lifecycle.runInBackground(scope: scope) == nil)
        #expect(environment.requests.isEmpty)
    }

    @Test func aSiteThatFinishedWithoutHistoryReopensOnceItIsEnabled() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.answers = [.disabled]
        let probe = LifecycleProbe(now: start)
        let lifecycle = make(environment, probe: probe)
        lifecycle.activate(scope: scope)
        await lifecycle.foregroundTask?.value
        #expect(try await store.progress(scope: scope)?.phase == .finished(.historyUnavailable))
        _ = await lifecycle.runInBackground(scope: scope, maxSlices: 1)
        #expect(environment.requests.count == 2)
        #expect(try await store.progress(scope: scope)?.phase == .active)
    }

    @Test func aSiteThatStoppedForALocationReopensOnceItHasOne() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.location = false
        let lifecycle = make(environment, probe: LifecycleProbe(now: start))
        lifecycle.activate(scope: scope)
        await lifecycle.foregroundTask?.value
        #expect(try await store.progress(scope: scope)?.phase == .finished(.locationNeeded))
        let requests = environment.requests.count

        lifecycle.activate(scope: scope)
        await lifecycle.foregroundTask?.value
        #expect(environment.requests.count == requests)

        environment.location = true
        environment.producing = false
        lifecycle.activate(scope: scope)
        await lifecycle.foregroundTask?.value
        #expect(environment.requests.count > requests)
        lifecycle.stop()
    }

    @Test func correctingTheLocationReopensDetectionAndKeepsTheCursor() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.defaultAnswer = .disabled
        var progress = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
        progress.oldestChecked = "2026-09-20"
        progress.phase = .finished(.detectorNeedsOtherAction)
        progress.lastAssessedCheckedDays = 42
        progress.detectedTargets = [.clear15]
        progress.sortedCheckedDays = 42
        progress.lastOutlook = .needsOtherAction
        try await store.save(progress, scope: scope)
        try await store.save(progress, scope: other)
        let lifecycle = make(environment, probe: LifecycleProbe(now: start))
        await lifecycle.resumeAfterLocationChange(scope: scope)
        let resumed = try #require(try await store.progress(scope: scope))
        #expect(resumed.phase == .active)
        #expect(resumed.oldestChecked == progress.oldestChecked)
        #expect(resumed.lastAssessedCheckedDays == 0)
        #expect(resumed.detectedTargets == nil)
        #expect(resumed.sortedCheckedDays == nil)
        #expect(resumed.lastOutlook == nil)
        #expect(try await store.progress(scope: other) == progress)
        lifecycle.activate(scope: scope)
        await lifecycle.foregroundTask?.value
        #expect(environment.requests.first?.from == "2026-09-17")
    }

    @Test(arguments: [SiteHistoryOnboardingProgress.Phase.paused(.reconnectTesla),
                      .finished(.reachedHistoryStart), .finished(.layoutFound), .active])
    func changingLocationPreservesOtherPhases(_ phase: SiteHistoryOnboardingProgress.Phase) async throws {
        var progress = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
        progress.phase = phase
        try await store.save(progress, scope: scope)
        let lifecycle = make(FakeOnboardingEnvironment(), probe: LifecycleProbe(now: start))
        await lifecycle.resumeAfterLocationChange(scope: scope)
        #expect(try await store.progress(scope: scope) == progress)
    }

    @Test func resumingAPauseOnlyWakesThatReasonInThatAccount() async throws {
        let saved = store
        let elsewhere = SolarForecastSiteScope(accountScopeID: "account-b", siteID: "site-1")
        for (target, reason) in [(scope, .reconnectTesla), (other, .signIn), (elsewhere, .reconnectTesla)]
            as [(SolarForecastSiteScope, SiteHistoryOnboarding.PauseReason)] {
            var progress = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
            progress.phase = .paused(reason)
            try await saved.save(progress, scope: target)
        }
        let lifecycle = make(FakeOnboardingEnvironment(), probe: LifecycleProbe(now: start))
        await lifecycle.resumePaused(accountScopeID: scope.accountScopeID, reason: .reconnectTesla)
        #expect(try await store.progress(scope: scope)?.phase == .active)
        #expect(try await store.progress(scope: other)?.phase == .paused(.signIn))
        #expect(try await store.progress(scope: elsewhere)?.phase == .paused(.reconnectTesla))
    }

    @Test func stoppingCancelsAndWithdrawsTheBackgroundRequest() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.producing = false
        environment.answers = [.fill(.busy)]
        let probe = LifecycleProbe(now: start)
        let lifecycle = make(environment, probe: probe, sleep: Self.sleepUntilCancelled)
        lifecycle.activate(scope: scope)
        try await eventually { environment.requests.count == 1 }
        let running = lifecycle.foregroundTask
        lifecycle.stop()
        await running?.value
        #expect(probe.scheduled == [nil])
        #expect(lifecycle.lastScope == nil)
        await lifecycle.deactivate()
        #expect(probe.scheduled == [nil])
    }

    @Test func aBackgroundOpportunityIsBoundedAndAsksForMore() async {
        let environment = FakeOnboardingEnvironment()
        let probe = LifecycleProbe(now: start)
        let lifecycle = make(environment, probe: probe)
        #expect(await lifecycle.runInBackground(scope: scope, maxSlices: 2) == start)
        #expect(environment.requests.count == 2)
    }

    @Test func foregroundContinuesAfterJoiningABoundedBackgroundRun() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.producing = false
        var release: CheckedContinuation<Void, Never>?
        environment.onFillWait = { await withCheckedContinuation { release = $0 } }
        let lifecycle = make(environment, probe: LifecycleProbe(now: start))
        let background = Task { await lifecycle.runInBackground(scope: scope, maxSlices: 1) }
        try await eventually { release != nil }
        lifecycle.activate(scope: scope)
        // Keep the background fill parked while the foreground joins it.
        try await staysTrue(for: .milliseconds(100)) { environment.requests.count == 1 }
        environment.onFillWait = nil
        release?.resume()
        _ = await background.value
        await lifecycle.foregroundTask?.value
        #expect(environment.requests.count == 30)
        #expect(try await store.progress(scope: scope)?.phase == .finished(.noSolarProduction))
        lifecycle.stop()
    }

    @Test func aBackgroundLaunchRunsAndReschedulesOnce() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.answers = [.fill(.complete), .fill(.busy)]
        let probe = LifecycleProbe(now: start)
        let lifecycle = make(environment, probe: probe)
        let task = FakeBackgroundTask()
        BackgroundSiteHistoryOnboarding.handleLaunch(
            task: task, lifecycle: lifecycle, dueScope: { scope }, reschedule: { probe.scheduled.append($0) })
        try await eventually { task.completedCount == 1 }
        #expect(task.lastSuccess == true)
        #expect(probe.scheduled == [start.addingTimeInterval(30)])
    }

    @Test func expirationCancelsTheSliceAndCompletesOnce() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.fillDelay = .seconds(3600)
        let probe = LifecycleProbe(now: start)
        let lifecycle = make(environment, probe: probe)
        let task = FakeBackgroundTask()
        let work = BackgroundSiteHistoryOnboarding.handleLaunch(
            task: task, lifecycle: lifecycle, dueScope: { scope }, reschedule: { probe.scheduled.append($0) })
        try await eventually { environment.requests.count == 1 }
        task.expirationHandler?()
        await work.value
        try await eventually { task.completedCount == 1 }
        #expect(task.lastSuccess == false)
        #expect(probe.scheduled == [start])
        #expect(try await store.progress(scope: scope) == nil)
        try await staysTrue(for: .milliseconds(50)) { task.completedCount == 1 }
    }

    @Test func aBackgroundLaunchWithoutASessionAsksForNothing() async throws {
        let probe = LifecycleProbe(now: start)
        let lifecycle = make(FakeOnboardingEnvironment(), probe: probe)
        let task = FakeBackgroundTask()
        BackgroundSiteHistoryOnboarding.handleLaunch(
            task: task, lifecycle: lifecycle, dueScope: { nil }, reschedule: { probe.scheduled.append($0) })
        try await eventually { task.completedCount == 1 }
        #expect(task.lastSuccess == false)
        #expect(probe.scheduled == [nil])
    }

    @Test func theStatusCountsStoredDaysAndOnlyThisSitesLedger() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.defaultAnswer = .failure(URLError(.timedOut))
        environment.stored = [["2026-10-30", "2026-10-31"]]
        try await ledgers.save(SiteHistoryDayLedger(days: ["2026-10-30": .clear, "2026-10-31": .cloudy]), scope: scope)
        try await ledgers.save(SiteHistoryDayLedger(days: ["2026-10-30": .clear, "2026-10-31": .clear]), scope: other)
        // The cursor claims five months were checked.
        var progress = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
        progress.oldestChecked = "2026-06-01"
        try await store.save(progress, scope: scope)
        let lifecycle = make(environment, probe: LifecycleProbe(now: start), sleep: Self.sleepUntilCancelled)
        lifecycle.activate(scope: scope)
        try await eventually { lifecycle.status?.progress?.waitReason == .retrying }
        #expect(lifecycle.status?.downloadedDays == 2)
        #expect(lifecycle.status?.producingDays == 2)
        #expect(lifecycle.status?.clearDays == 1)
        #expect(lifecycle.status?.days.map(\.type) == [.clear, .cloudy])
        lifecycle.stop()
    }

    @Test func theStatusFollowsTheActiveScopeAndClearsOnStop() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.defaultAnswer = .fill(.busy)
        environment.storedResult = DetectedSolarLayout(
            status: .detected, confidence: "medium", reasons: [],
            planes: [.init(azimuth: 180, tilt: 20, dcKwp: 5, effectiveKw: 4, azimuthRange90: [170, 190],
                           tiltRange90: [18, 22])],
            acClipKw: nil, historyDays: 60, clearDays: 20, firstDay: nil, lastDay: nil)
        let lifecycle = make(environment, probe: LifecycleProbe(now: start), sleep: Self.sleepUntilCancelled)
        lifecycle.activate(scope: scope)
        try await eventually { lifecycle.status?.progress?.waitReason == .busy }
        #expect(lifecycle.status?.scope == scope)
        #expect(lifecycle.status?.hasUsableLayout == true)
        #expect(lifecycle.status?.wedge == .fitted(azimuthRange90: [170, 190]))
        lifecycle.activate(scope: other)
        try await eventually { lifecycle.status?.scope == other && lifecycle.status?.progress != nil }
        lifecycle.stop()
        #expect(lifecycle.status == nil)
        try await staysTrue(for: .milliseconds(50)) { lifecycle.status == nil }
    }

    @Test func forgettingASiteStopsItsRunAndDropsOnlyItsProgress() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.defaultAnswer = .fill(.busy)
        let lifecycle = make(environment, probe: LifecycleProbe(now: start), sleep: Self.sleepUntilCancelled)
        try await store.save(SiteHistoryOnboardingProgress(checkedUntil: "2026-11-01"), scope: other)
        try await ledgers.save(SiteHistoryDayLedger(days: ["2026-11-01": .clear]), scope: scope)
        try await ledgers.save(SiteHistoryDayLedger(days: ["2026-11-01": .clear]), scope: other)
        lifecycle.activate(scope: scope)
        try await eventually { lifecycle.status?.progress != nil }
        let running = lifecycle.foregroundTask
        await lifecycle.forget(scope: scope)
        #expect(try await ledgers.ledger(scope: scope) == nil)
        #expect(try await ledgers.ledger(scope: other) != nil)
        await running?.value
        #expect(lifecycle.foregroundTask == nil)
        #expect(try await store.progress(scope: scope) == nil)
        #expect(try await store.progress(scope: other) != nil)
        #expect(lifecycle.status?.progress == nil)
        lifecycle.activate(scope: scope)
        try await eventually { environment.requests.count == 2 }
        #expect(environment.requests.last?.from == "2026-10-30")
        lifecycle.stop()
    }

    @Test func stoppingCancelsABackgroundRunAndItAsksForNoMoreTime() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.fillDelay = .seconds(3600)
        let probe = LifecycleProbe(now: start)
        let lifecycle = make(environment, probe: probe)
        let background = Task { await lifecycle.runInBackground(scope: scope) }
        try await eventually { environment.requests.count == 1 }
        lifecycle.stop()
        #expect(await background.value == nil)
        #expect(environment.stored.isEmpty)
        #expect(try await store.progress(scope: scope) == nil)
        #expect(probe.scheduled == [nil])
    }

    @Test func theBackgroundRequestNeedsTheNetworkButNotPower() {
        let request = BackgroundSiteHistoryOnboarding.request(earliest: start)
        #expect(request.identifier == BackgroundSiteHistoryOnboarding.identifier)
        #expect(request.requiresNetworkConnectivity)
        #expect(!request.requiresExternalPower)
        #expect(request.earliestBeginDate == start)
    }
}
