import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Site deep history")
struct SiteDeepHistoryTests {
    let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-1")
    private let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    /// 2026-11-02 12:00 in Chicago (CST).
    private let now = Date(timeIntervalSince1970: 1_793_642_400)

    private var onboardingStore: SiteHistoryOnboardingStore { SiteHistoryOnboardingStore(directory: directory) }
    private var deepStore: SiteDeepHistoryStore { SiteDeepHistoryStore(directory: directory) }

    private func make(_ environment: FakeOnboardingEnvironment, clock: Date? = nil) -> SiteDeepHistory {
        let fixed = clock ?? now
        return SiteDeepHistory(
            environment: environment, store: deepStore, onboarding: onboardingStore, now: { fixed })
    }

    /// Onboarding that stopped a year back.
    private func seedOnboarding(oldestChecked: String) async throws {
        var progress = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
        progress.oldestChecked = oldestChecked
        try await onboardingStore.save(progress, scope: scope)
    }

    @Test func walksPastAYearToTheHistoryStartAndStoresEverySlice() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.historyStart = "2025-06-01"
        try await seedOnboarding(oldestChecked: "2025-11-02")
        let outcome = await make(environment).run(scope: scope)
        #expect(outcome == .finished(.reachedHistoryStart))
        #expect(environment.requests.first?.from == "2025-09-03")
        #expect(environment.requests.first?.days == 60)
        #expect(environment.requests.last?.from == "2025-06-01")
        #expect(environment.requests.count == 3)
        let days = environment.stored.flatMap(\.self).sorted()
        #expect(days.first == "2025-06-01")
        #expect(days.last == "2025-11-01")
        #expect(days.count == 154)
        let progress = try #require(try await deepStore.progress(scope: scope))
        #expect(progress.phase == .finished(.reachedHistoryStart))
        #expect(progress.oldestChecked == "2025-06-01")
        #expect(progress.daysLoaded == 154)
        // Detection's own progress is untouched.
        #expect(try await onboardingStore.progress(scope: scope)?.oldestChecked == "2025-11-02")
    }

    @Test func startsFromTodayWithoutOnboardingProgress() async {
        let environment = FakeOnboardingEnvironment()
        _ = await make(environment).run(scope: scope, maxSlices: 1)
        #expect(environment.requests.map(\.from) == ["2026-09-03"])
    }

    @Test func resumesFromTheSavedCursor() async {
        let first = FakeOnboardingEnvironment()
        _ = await make(first).run(scope: scope, maxSlices: 2)
        let second = FakeOnboardingEnvironment()
        _ = await make(second).run(scope: scope, maxSlices: 1)
        #expect(second.requests.map(\.from) == ["2026-05-06"])
    }

    @Test func aPartialSliceShrinksToThreeDaysThenRampsUpOnConsecutiveCompletes() async {
        let environment = FakeOnboardingEnvironment()
        environment.answers = [
            .fill(.partial),
            .fill(.complete),
            .fill(.complete),
            .fill(.complete),
            .fill(.complete),
            .fill(.complete)
        ]
        _ = await make(environment).run(scope: scope, maxSlices: 6)
        #expect(environment.requests.map(\.days) == [60, 3, 3, 6, 6, 12])
        #expect(environment.requests.map(\.from) == [
            "2026-09-03", "2026-10-30", "2026-10-27", "2026-10-21", "2026-10-15", "2026-10-03"
        ])
    }

    @Test func thirdPartialAfterShrinkingBacksOffAndBusyWaits() async {
        let environment = FakeOnboardingEnvironment()
        environment.answers = [.fill(.partial), .fill(.partial), .fill(.partial), .fill(.partial)]
        #expect(await make(environment).run(scope: scope)
            == .waiting(until: now.addingTimeInterval(60), reason: .retrying))
        #expect(environment.requests.map(\.days) == [60, 3, 3, 3])
        let busy = FakeOnboardingEnvironment()
        busy.answers = [.fill(.busy)]
        let other = SolarForecastSiteScope(accountScopeID: "b", siteID: "s")
        #expect(await make(busy).run(scope: other) == .waiting(until: now.addingTimeInterval(30), reason: .busy))
    }

    @Test func teslaThrottleWaitsAndIsHonoredBeforeAsking() async {
        let retryAt = now.addingTimeInterval(600)
        let environment = FakeOnboardingEnvironment()
        environment.answers = [.failure(MobileSolarHistoryFillError.rateLimited(retryAt: retryAt, isFallback: false))]
        #expect(await make(environment).run(scope: scope) == .waiting(until: retryAt, reason: .teslaLimited))
        let early = FakeOnboardingEnvironment()
        #expect(await make(early, clock: now.addingTimeInterval(60)).run(scope: scope)
            == .waiting(until: retryAt, reason: .teslaLimited))
        #expect(early.requests.isEmpty)
        let later = FakeOnboardingEnvironment()
        _ = await make(later, clock: retryAt.addingTimeInterval(1)).run(scope: scope, maxSlices: 1)
        #expect(later.requests.map(\.from) == ["2026-09-03"])
    }

    @Test func yieldsAtMaxSlices() async {
        let environment = FakeOnboardingEnvironment()
        #expect(await make(environment).run(scope: scope, maxSlices: 2) == .yielded)
        #expect(environment.requests.count == 2)
    }

    @Test func aDisabledAnswerFinishesAsUnavailable() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.answers = [.disabled]
        #expect(await make(environment).run(scope: scope) == .finished(.historyUnavailable))
        #expect(try await deepStore.progress(scope: scope)?.phase == .finished(.historyUnavailable))
    }

    @Test func noTimeZoneIsUnavailable() async {
        let environment = FakeOnboardingEnvironment()
        environment.timeZone = nil
        #expect(await make(environment).run(scope: scope) == .unavailable)
        #expect(environment.requests.isEmpty)
    }

    @Test func reconnectPausesUntilResumed() async throws {
        try await expectPause(MobileSolarHistoryFillError.teslaReconnectRequired, .reconnectTesla)
    }

    @Test func signInPausesUntilResumed() async throws {
        try await expectPause(PWUsageAPIError.signInRequired, .signIn)
    }

    private func expectPause(_ error: any Error, _ reason: SiteHistoryOnboarding.PauseReason) async throws {
        let environment = FakeOnboardingEnvironment()
        environment.answers = [.failure(error)]
        #expect(await make(environment).run(scope: scope) == .paused(reason))
        let again = FakeOnboardingEnvironment()
        #expect(await make(again).run(scope: scope) == .paused(reason))
        #expect(again.requests.isEmpty)
        try await deepStore.resume(scope: scope)
        _ = await make(again).run(scope: scope, maxSlices: 1)
        #expect(again.requests.map(\.from) == ["2026-09-03"])
    }

    @Test func cancellationSavesNothing() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.fillDelay = .seconds(30)
        let deep = make(environment)
        var run: Task<SiteHistoryOnboarding.Outcome, Never>?
        environment.onFill = { run?.cancel() }
        run = Task { await deep.run(scope: scope) }
        #expect(await run?.value == .stopped)
        #expect(try await deepStore.progress(scope: scope) == nil)
        #expect(environment.stored.isEmpty)
    }

    @Test func progressSavedBeforeStopWasRecordedStillLoads() async throws {
        let json = """
        {"account-a|site-1":{"oldestChecked":"2026-10-24","phase":{"active":{}},"daysLoaded":9,"failures":0}}
        """
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(json.utf8).write(to: directory.appendingPathComponent("deep-history.json"))
        let progress = try #require(try await deepStore.progress(scope: scope))
        #expect(progress.oldestChecked == "2026-10-24")
        #expect(!progress.userStopped)
        let environment = FakeOnboardingEnvironment()
        _ = await make(environment).run(scope: scope, maxSlices: 1)
        #expect(environment.requests.map(\.from) == ["2026-08-25"])
    }
}
