import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Site deep history in the background")
struct SiteDeepHistoryBackgroundTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-1")
    private let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    private let start = Date(timeIntervalSince1970: 1_793_642_400)

    private let onboardingStore: SiteHistoryOnboardingStore
    private let deepStore: SiteDeepHistoryStore

    init() {
        onboardingStore = SiteHistoryOnboardingStore(directory: directory)
        deepStore = SiteDeepHistoryStore(directory: directory)
    }

    /// Onboarding is finished; the deep walk is saved only when `deep` is given.
    private func make(
        _ environment: FakeOnboardingEnvironment, deep: SiteDeepHistoryProgress? = nil
    ) async throws -> SiteHistoryOnboardingLifecycle {
        var finished = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
        finished.oldestChecked = "2026-10-30"
        finished.phase = .finished(.layoutFound)
        try await onboardingStore.save(finished, scope: scope)
        if let deep { try await deepStore.save(deep, scope: scope, userStopped: deep.userStopped) }
        let clock = { start }
        let engine = SiteDeepHistory(
            environment: environment, store: deepStore, onboarding: onboardingStore, now: clock)
        return SiteHistoryOnboardingLifecycle(
            onboarding: SiteHistoryOnboarding(environment: environment, store: onboardingStore, now: clock),
            store: onboardingStore, ledgers: SiteHistoryDayLedgerStore(directory: directory),
            deepHistory: SiteDeepHistoryModel(deepHistory: engine, store: deepStore, now: clock),
            isHistoryEnabled: { _ in true }, scheduleBackground: { _ in }, now: clock)
    }

    private func started(_ oldest: String = "2026-10-30") -> SiteDeepHistoryProgress {
        SiteDeepHistoryProgress(oldestChecked: oldest)
    }

    @Test func aBackgroundRunWalksOlderHistoryAfterOnboardingWhenTheUserStartedIt() async throws {
        let environment = FakeOnboardingEnvironment()
        let lifecycle = try await make(environment, deep: started())
        _ = await lifecycle.runInBackground(scope: scope, maxSlices: 2)
        #expect(environment.requests.map(\.from) == ["2026-10-27", "2026-10-24"])
        #expect(try await deepStore.progress(scope: scope)?.oldestChecked == "2026-10-24")
    }

    @Test func aSiteThatNeverStartedNeverRunsTheWalkInTheBackground() async throws {
        let environment = FakeOnboardingEnvironment()
        let lifecycle = try await make(environment)
        #expect(await lifecycle.runInBackground(scope: scope, maxSlices: 5) == nil)
        #expect(environment.requests.isEmpty)
        #expect(try await deepStore.progress(scope: scope) == nil)
    }

    @Test func theTeslaThrottleIsHonoredAndReturnedAsTheNextOpportunity() async throws {
        let retryAt = start.addingTimeInterval(600)
        try await onboardingStore.setThrottle(retryAt, accountScopeID: scope.accountScopeID)
        let environment = FakeOnboardingEnvironment()
        let lifecycle = try await make(environment, deep: started())
        #expect(await lifecycle.runInBackground(scope: scope) == retryAt)
        #expect(environment.requests.isEmpty)
    }

    @Test func aRunStaysWithinTheSliceLimit() async throws {
        let environment = FakeOnboardingEnvironment()
        let lifecycle = try await make(environment, deep: started())
        _ = await lifecycle.runInBackground(scope: scope, maxSlices: 1)
        #expect(environment.requests.count == 1)
    }

    @Test func theUsersStopEndsBackgroundRunsUntilTheyContinue() async throws {
        let environment = FakeOnboardingEnvironment()
        let lifecycle = try await make(environment, deep: started())
        let model = try #require(lifecycle.deepHistory)
        await model.select(scope: scope)
        await model.stop()
        #expect(await lifecycle.runInBackground(scope: scope, maxSlices: 3) == nil)
        #expect(environment.requests.isEmpty)
        #expect(await lifecycle.nextOpportunity(scope: scope) == nil)
        model.start()
        await model.runTask?.value
        #expect(!environment.requests.isEmpty)
    }

    @Test func nextOpportunityFollowsTheWalksState() async throws {
        let environment = FakeOnboardingEnvironment()
        let never = try await make(environment)
        #expect(await never.nextOpportunity(scope: scope) == nil)
        var backoff = started()
        backoff.nextAttemptAt = start.addingTimeInterval(300)
        let waiting = try await make(environment, deep: backoff)
        #expect(await waiting.nextOpportunity(scope: scope) == start.addingTimeInterval(300))
        try await onboardingStore.setThrottle(start.addingTimeInterval(900), accountScopeID: scope.accountScopeID)
        #expect(await waiting.nextOpportunity(scope: scope) == start.addingTimeInterval(900))
        var paused = started()
        paused.phase = .paused(.reconnectTesla)
        let pausedLifecycle = try await make(environment, deep: paused)
        #expect(await pausedLifecycle.nextOpportunity(scope: scope) == nil)
        var finished = started()
        finished.phase = .finished(.reachedHistoryStart)
        let finishedLifecycle = try await make(environment, deep: finished)
        #expect(await finishedLifecycle.nextOpportunity(scope: scope) == nil)
    }

    @Test func activationResumesAWalkTheUserDidNotStop() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.historyStart = "2026-10-20"
        let lifecycle = try await make(environment, deep: started())
        lifecycle.activate(scope: scope)
        try await eventually { lifecycle.deepHistory?.status.phase == .finished }
        #expect(environment.requests.first?.from == "2026-10-27")
    }

    @Test func activationLeavesAStoppedWalkAlone() async throws {
        var stopped = started()
        stopped.userStopped = true
        let environment = FakeOnboardingEnvironment()
        let lifecycle = try await make(environment, deep: stopped)
        lifecycle.activate(scope: scope)
        try await staysTrue(for: .milliseconds(200)) { environment.requests.isEmpty }
    }

    @Test func leavingTheForegroundStopsTheRunButNotTheWalk() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.fillDelay = .seconds(60)
        let lifecycle = try await make(environment, deep: started())
        lifecycle.activate(scope: scope)
        try await eventually { !environment.requests.isEmpty }
        await lifecycle.deactivate()
        #expect(lifecycle.deepHistory?.status.isLoading == false)
        #expect(await lifecycle.nextOpportunity(scope: scope) != nil)
    }
}
