import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Site history onboarding")
struct SiteHistoryOnboardingTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-1")
    private let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    /// 2026-11-02 12:00 in Chicago (CST).
    private let now = Date(timeIntervalSince1970: 1_793_642_400)

    private var ledgers: SiteHistoryDayLedgerStore { SiteHistoryDayLedgerStore(directory: directory) }

    private func make(
        _ environment: FakeOnboardingEnvironment, store: SiteHistoryOnboardingStore? = nil, clock: Date? = nil
    ) -> SiteHistoryOnboarding {
        let fixed = clock ?? now
        return SiteHistoryOnboarding(
            environment: environment, store: store ?? SiteHistoryOnboardingStore(directory: directory),
            ledgers: ledgers, now: { fixed })
    }

    private static func layout(
        _ status: DetectedSolarLayout.Status, _ confidence: String?, reasons: [String] = []
    ) -> DetectedSolarLayout {
        DetectedSolarLayout(
            status: status, confidence: confidence, reasons: reasons,
            planes: [.init(azimuth: 180, tilt: 20, dcKwp: 5, effectiveKw: 4, azimuthRange90: [175, 185],
                           tiltRange90: [18, 22])],
            acClipKw: nil, historyDays: 60, clearDays: 30, firstDay: nil, lastDay: nil)
    }

    @Test func walksBackNewestFirstInThreeDaySlicesFromYesterday() async throws {
        let environment = FakeOnboardingEnvironment()
        _ = await make(environment).run(scope: scope, maxSlices: 3)
        #expect(environment.requests.map(\.from) == ["2026-10-30", "2026-10-27", "2026-10-24"])
        #expect(environment.requests.allSatisfy { $0.days == 3 })
        #expect(environment.stored.first == ["2026-10-30", "2026-10-31", "2026-11-01"])
        let progress = try #require(try await SiteHistoryOnboardingStore(directory: directory).progress(scope: scope))
        #expect(progress.checkedUntil == "2026-11-02")
        #expect(progress.oldestChecked == "2026-10-24")
        #expect(progress.checkedDays(timeZone: try #require(environment.timeZone)) == 9)
    }

    @Test func countsOnlyCheckedDaysThatHoldReadings() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.solarWh = [nil, 0]
        environment.firstDataDay = "2026-10-28"
        environment.answers = [.fill(.complete), .fill(.partial), .fill(.complete)]
        _ = await make(environment).run(scope: scope, maxSlices: 3)
        let progress = try #require(try await SiteHistoryOnboardingStore(directory: directory).progress(scope: scope))
        #expect(progress.checkedDays(timeZone: .gmt) == 6)
        #expect(progress.daysWithData == 5)
    }

    @Test func retriesTheSameSliceUntilItIsComplete() async {
        let environment = FakeOnboardingEnvironment()
        environment.answers = [.fill(.partial), .fill(.partial), .fill(.complete)]
        _ = await make(environment).run(scope: scope, maxSlices: 4)
        #expect(environment.requests.map(\.from) == ["2026-10-30", "2026-10-30", "2026-10-30", "2026-10-27"])
    }

    @Test func resumesFromThePersistedCursorAfterRelaunch() async {
        let first = FakeOnboardingEnvironment()
        _ = await make(first).run(scope: scope, maxSlices: 2)
        let second = FakeOnboardingEnvironment()
        _ = await make(second).run(scope: scope, maxSlices: 1)
        #expect(second.requests.map(\.from) == ["2026-10-24"])
    }

    @Test func aLostResponseLeavesTheCursorAndBacksOff() async {
        let environment = FakeOnboardingEnvironment()
        environment.answers = [.failure(URLError(.networkConnectionLost))]
        let outcome = await make(environment).run(scope: scope)
        #expect(outcome == .waiting(until: now.addingTimeInterval(60), reason: .retrying))
        let later = FakeOnboardingEnvironment()
        _ = await make(later, clock: now.addingTimeInterval(61)).run(scope: scope, maxSlices: 1)
        #expect(later.requests.map(\.from) == ["2026-10-30"])
    }

    @Test func aBusyLockWaitsBeforeAskingAgain() async {
        let environment = FakeOnboardingEnvironment()
        environment.answers = [.fill(.busy)]
        let outcome = await make(environment).run(scope: scope)
        #expect(outcome == .waiting(until: now.addingTimeInterval(30), reason: .busy))
        #expect(environment.requests.count == 1)
    }

    @Test func aTeslaThrottleIsHonouredForTheWholeAccountAcrossRelaunch() async {
        let retryAt = now.addingTimeInterval(3600)
        let environment = FakeOnboardingEnvironment()
        let throttle = MobileSolarHistoryFillError.rateLimited(retryAt: retryAt, isFallback: false)
        environment.answers = [.fill(.complete), .failure(throttle)]
        let outcome = await make(environment).run(scope: scope)
        #expect(outcome == .waiting(until: retryAt, reason: .teslaLimited))
        #expect(environment.requests.map(\.from) == ["2026-10-30", "2026-10-27"])

        let otherSite = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-2")
        let relaunched = FakeOnboardingEnvironment()
        let early = await make(relaunched, clock: now.addingTimeInterval(1800)).run(scope: otherSite)
        #expect(early == .waiting(until: retryAt, reason: .teslaLimited))
        #expect(relaunched.requests.isEmpty)

        let otherAccount = SolarForecastSiteScope(accountScopeID: "account-b", siteID: "site-1")
        _ = await make(relaunched, clock: now.addingTimeInterval(1800)).run(scope: otherAccount, maxSlices: 1)
        #expect(relaunched.requests.count == 1)

        let after = FakeOnboardingEnvironment()
        _ = await make(after, clock: retryAt).run(scope: scope, maxSlices: 1)
        // The throttled slice is asked for again; the cursor did not move.
        #expect(after.requests.map(\.from) == ["2026-10-27"])
    }

    @Test func aTokenBackoffWaitsLikeAThrottle() async {
        let retryAt = now.addingTimeInterval(120)
        let environment = FakeOnboardingEnvironment()
        environment.answers = [.failure(MobileSolarHistoryFillError.teslaUnavailable(retryAt: retryAt))]
        #expect(await make(environment).run(scope: scope) == .waiting(until: retryAt, reason: .teslaLimited))
    }

    @Test func authenticationProblemsPauseWithAnAction() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.answers = [.failure(MobileSolarHistoryFillError.teslaReconnectRequired)]
        #expect(await make(environment).run(scope: scope) == .paused(.reconnectTesla))
        #expect(await make(environment).run(scope: scope) == .paused(.reconnectTesla))
        #expect(environment.requests.count == 1)

        let signedOut = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-9")
        environment.answers = [.failure(PWUsageAPIError.signInRequired)]
        #expect(await make(environment).run(scope: signedOut) == .paused(.signIn))

        try await SiteHistoryOnboardingStore(directory: directory).resume(scope: scope)
        _ = await make(environment).run(scope: scope, maxSlices: 1)
        #expect(environment.requests.last?.from == "2026-10-30")
    }

    @Test func aDisabledSiteFinishes() async {
        let environment = FakeOnboardingEnvironment()
        environment.answers = [.disabled]
        #expect(await make(environment).run(scope: scope) == .finished(.historyUnavailable))
    }

    @Test func noTimeZoneMeansNoHistoryYet() async {
        let environment = FakeOnboardingEnvironment()
        environment.timeZone = nil
        #expect(await make(environment).run(scope: scope) == .unavailable)
        #expect(environment.requests.isEmpty)
    }

    @Test func stopsAtTheHistoryStartWithAPartialFinalSlice() async {
        let environment = FakeOnboardingEnvironment()
        environment.historyStart = "2026-10-26"
        let outcome = await make(environment).run(scope: scope)
        #expect(environment.requests.map(\.from) == ["2026-10-30", "2026-10-27", "2026-10-26"])
        #expect(environment.requests.last?.days == 1)
        #expect(outcome == .finished(.reachedHistoryStart))
    }

    @Test func stopsAtOneYear() async {
        let environment = FakeOnboardingEnvironment()
        environment.producingDayLimit = 10
        let outcome = await make(environment).run(scope: scope)
        #expect(outcome == .finished(.reachedOneYear))
        #expect(environment.requests.last?.from == "2025-11-02")
        let total = environment.requests.map(\.days).reduce(0, +)
        #expect(total == 365)
    }

    @Test func anExistingHighConfidenceLayoutStopsAfterRecentHistory() async {
        let environment = FakeOnboardingEnvironment()
        environment.confidence = .high
        let outcome = await make(environment).run(scope: scope)
        #expect(outcome == .finished(.layoutAlreadyUsable))
        #expect(environment.requests.map(\.days).reduce(0, +) == 15)
        #expect(environment.detectionCount == 0)
    }

    @Test func anExistingMediumLayoutKeepsGoingTowardHighConfidence() async {
        let environment = FakeOnboardingEnvironment()
        environment.confidence = .medium
        environment.clearEvery = 2
        environment.detections = [Self.layout(.detected, "high")]
        let outcome = await make(environment).run(scope: scope)
        #expect(outcome == .finished(.layoutFound))
        #expect(environment.requests.map(\.days).reduce(0, +) == 42)
    }

    @Test func withoutALocationImportsTheInitialCheckpointOnlyWithoutAPass() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.location = false
        let outcome = await make(environment).run(scope: scope)
        #expect(outcome == .finished(.locationNeeded))
        #expect(environment.requests.map(\.days).reduce(0, +) == 90)
        #expect(environment.passes.isEmpty)
        #expect(environment.detectionCount == 0)
        #expect(try await ledgers.ledger(scope: scope) == nil)
    }

    @Test func passesEverySecondSliceAndDetectsOnTargetsAndTheFallback() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.clearEvery = 2
        environment.answers = Array(repeating: .fill(.complete), count: 30) + [.disabled]
        environment.detections = Array(repeating: Self.layout(.lowConfidence, "low", reasons: ["few-clear-days"]),
                                       count: 3)
        _ = await make(environment).run(scope: scope)
        // A pass every six days; 30 complete slices.
        #expect(environment.passes.count == 15)
        #expect(environment.passes.first?.days.count == 6)
        // 42 (producing gate, 15 clear already reached), 72 (30-day fallback), 84 (40 clear).
        #expect(environment.detectionCount == 3)

        let ledger = try #require(try await ledgers.ledger(scope: scope))
        #expect(ledger.dayTypes.count == 90)
        #expect(ledger.checkpoint?.producingDays == 90)
        #expect(ledger.checkpoint?.clearDays == 45)
        #expect(ledger.checkpoint?.azimuthRange90 == [175, 185])
    }

    @Test func aUsableLayoutKeepsLoadingUntilHighConfidence() async {
        let environment = FakeOnboardingEnvironment()
        environment.clearEvery = 2
        environment.detections = [Self.layout(.detected, "medium"), Self.layout(.detected, "high")]
        let outcome = await make(environment).run(scope: scope)
        #expect(outcome == .finished(.layoutFound))
        #expect(environment.detectionCount == 2)
        #expect(environment.requests.map(\.days).reduce(0, +) == 72)
    }

    @Test func producing180DaysIsATarget() async {
        let environment = FakeOnboardingEnvironment()
        environment.clearEvery = 10
        environment.answers = Array(repeating: .fill(.complete), count: 60) + [.disabled]
        environment.detections = Array(repeating: Self.layout(.detected, "medium"), count: 10)
        _ = await make(environment).run(scope: scope)
        // 42, 72, 102, 132 (fallback), 144 (15 clear), 174 (fallback), 180 (180 producing).
        #expect(environment.detectionCount == 7)
    }

    @Test func doesNotDetectBeforeTheProducingDayGatePasses() async {
        let environment = FakeOnboardingEnvironment()
        environment.clearEvery = 2
        environment.producingDayLimit = 30
        environment.answers = Array(repeating: .fill(.complete), count: 30) + [.disabled]
        _ = await make(environment).run(scope: scope)
        #expect(environment.passes.count == 15)
        #expect(environment.detectionCount == 0)
    }

    @Test func aDetectorProblemOtherThanHistoryStopsTheSearch() async {
        let environment = FakeOnboardingEnvironment()
        environment.clearEvery = 2
        environment.detections = [Self.layout(.lowConfidence, "low", reasons: ["location-mismatch"])]
        #expect(await make(environment).run(scope: scope) == .finished(.detectorNeedsOtherAction))
    }

    @Test func aSiteWithoutProductionStopsAtTheInitialCheckpoint() async {
        let environment = FakeOnboardingEnvironment()
        environment.producing = false
        #expect(await make(environment).run(scope: scope) == .finished(.noSolarProduction))
        #expect(environment.requests.map(\.days).reduce(0, +) == 90)
        #expect(environment.detectionCount == 0)
    }

    @Test func assessesOnceMoreWhenTheHistoryStartEndsTheSearch() async {
        let environment = FakeOnboardingEnvironment()
        environment.historyStart = "2026-09-10"
        environment.clearEvery = 2
        environment.detections = [Self.layout(.lowConfidence, "low", reasons: ["few-clear-days"]),
                                  Self.layout(.detected, "medium")]
        let outcome = await make(environment).run(scope: scope)
        #expect(outcome == .finished(.layoutFound))
        #expect(environment.detectionCount == 2)
    }

    @Test func cancellationLeavesTheCursorAtTheLastConfirmedSlice() async throws {
        let environment = FakeOnboardingEnvironment()
        let onboarding = make(environment)
        var task: Task<SiteHistoryOnboarding.Outcome, Never>?
        environment.onFill = { if environment.requests.count == 2 { task?.cancel() } }
        task = Task { await onboarding.run(scope: scope) }
        #expect(await task?.value == .stopped)
        let progress = try #require(try await SiteHistoryOnboardingStore(directory: directory).progress(scope: scope))
        #expect(progress.oldestChecked == "2026-10-30")
    }

    @Test func aCallerArrivingWhileACancelledRunUnwindsStartsAFreshOne() async {
        let environment = FakeOnboardingEnvironment()
        environment.fillDelay = .seconds(3600)
        let onboarding = make(environment)
        let first = Task { await onboarding.run(scope: scope) }
        try? await eventually { environment.requests.count == 1 }
        environment.fillDelay = nil
        first.cancel()
        // Called before the cancelled run has unwound, as a quick return to the foreground is.
        let second = await onboarding.run(scope: scope, maxSlices: 1)
        #expect(await first.value == .stopped)
        #expect(second == .yielded)
        #expect(environment.requests.map(\.from) == ["2026-10-30", "2026-10-30"])
    }

    @Test func overlappingRunsForOneSiteShareOneJob() async {
        let environment = FakeOnboardingEnvironment()
        let onboarding = make(environment)
        async let first = onboarding.run(scope: scope, maxSlices: 2)
        async let second = onboarding.run(scope: scope, maxSlices: 2)
        _ = await (first, second)
        #expect(environment.requests.count == 2)
    }

    @Test func removingAnAccountForgetsItsSitesAndThrottle() async throws {
        let store = SiteHistoryOnboardingStore(directory: directory)
        let environment = FakeOnboardingEnvironment()
        let throttle = MobileSolarHistoryFillError.rateLimited(retryAt: now.addingTimeInterval(600), isFallback: true)
        environment.answers = [.failure(throttle)]
        _ = await make(environment, store: store).run(scope: scope)
        try await store.removeAccount("account-a")
        #expect(try await store.progress(scope: scope) == nil)
        #expect(try await store.throttle(accountScopeID: "account-a") == nil)
    }
}

@Suite("Site-local days")
struct SiteLocalDaysTests {
    private let chicago = TimeZone(identifier: "America/Chicago") ?? .gmt

    @Test func stepsWholeCalendarDaysAcrossDaylightSaving() {
        #expect(SiteLocalDays.adding(1, to: "2026-10-31", timeZone: chicago) == "2026-11-01")
        #expect(SiteLocalDays.adding(1, to: "2026-11-01", timeZone: chicago) == "2026-11-02")
        #expect(SiteLocalDays.adding(-1, to: "2026-03-09", timeZone: chicago) == "2026-03-08")
        #expect(SiteLocalDays.days(from: "2026-03-07", to: "2026-03-10", timeZone: chicago) == 3)
        #expect(SiteLocalDays.adding(-365, to: "2026-11-02", timeZone: chicago) == "2025-11-02")
    }

    @Test func takesTodayInTheSiteTimeZone() {
        // 2026-11-02 03:00Z is still 11-01 in Chicago.
        #expect(SiteLocalDays.today(now: Date(timeIntervalSince1970: 1_793_588_400), timeZone: chicago) == "2026-11-01")
    }

    @Test func rejectsMalformedDays() {
        #expect(SiteLocalDays.adding(1, to: "2026-02-30", timeZone: chicago) == nil)
        #expect(SiteLocalDays.adding(1, to: "yesterday", timeZone: chicago) == nil)
    }
}
