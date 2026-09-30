import Foundation
import Testing
@testable import PWUsage

@MainActor
@Suite("Dashboard Coordinator Tests", .serialized)
struct DashboardCoordinatorTests {
    @Test("Initial foreground load and exact sixty minute request counts")
    func initialForegroundLoadAndExactSixtyMinuteRequestCounts() async throws {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)

        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1"])
        #expect(api.billSiteIDs == ["site-1"])

        for _ in 1..<60 {
            clock.advance(minutes: 1)
            await coordinator.refreshDue()
        }

        #expect(api.liveSiteIDs.count == 12, "Live is fetched at t=0,5,...,55 in [0,60m).")
        #expect(api.billSiteIDs.count == 2, "Bill is fetched at t=0,30 in [0,60m).")
    }

    @Test("Background suspends polling and foreground return makes one due request")
    func backgroundSuspendsPollingAndForegroundReturnMakesOneDueRequest() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: .seconds(3_600))
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(coordinator.pollingTimerIsActive)
        coordinator.scenePhaseChanged(isActive: false)
        #expect(!coordinator.pollingTimerIsActive)

        clock.advance(minutes: 60)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 1)

        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(coordinator.pollingTimerIsActive)
        #expect(api.liveSiteIDs.count == 2, "Returning after missed intervals performs one refresh, not catch-up calls.")
        #expect(api.billSiteIDs.count == 2)
    }

    @Test("Duplicate scene and timer events do not fetch before endpoint is due")
    func duplicateSceneAndTimerEventsDoNotFetchBeforeEndpointIsDue() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        await coordinator.refreshDue()

        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 1)
    }

    @Test("In-flight refreshes are deduplicated")
    func inFlightRefreshesAreDeduplicated() async {
        let api = DashboardAPISpy()
        api.holdLive = true
        api.holdBill = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let first = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()
        let second = Task { await coordinator.refreshDue() }
        await Task.yield()
        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 0)

        api.resumeRequests()
        await first.value
        await second.value
        #expect(api.billSiteIDs.count == 1)
    }

    @Test("Bill waits for live request so it can see refreshed energy history")
    func billWaitsForLiveRequestSoItCanSeeRefreshedEnergyHistory() async {
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: Date.init, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let first = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()

        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 0)

        api.resumeRequests()
        await first.value
        #expect(api.billSiteIDs.count == 1)
    }

    @Test("Site switch resets cadence and ignores old site response")
    func siteSwitchResetsCadenceAndIgnoresOldSiteResponse() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        api.holdLive = true
        api.holdBill = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        let first = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()

        coordinator.selectSite("site-2")
        await Task.yield()
        api.resumeRequests()
        await first.value
        await coordinator.refreshDue()

        #expect(api.liveSiteIDs == ["site-1", "site-2"])
        #expect(api.billSiteIDs == ["site-2"])
        #expect(coordinator.live.response?.site.id == "site-2")
        #expect(coordinator.bill.response?.site.id == "site-2")
    }

    @Test("Unauthorized stops polling and signals sign-in")
    func unauthorizedStopsPollingAndSignalsSignIn() async {
        let api = DashboardAPISpy()
        api.liveError = PWUsageAPIError.signInRequired
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()

        #expect(coordinator.requiresSignIn)
        #expect(!coordinator.isForeground)
        #expect(coordinator.live.lastAttempt == Date(timeIntervalSince1970: 0))
        #expect(coordinator.live.lastSuccess == nil)
        let liveRequestsAfterUnauthorized = api.liveSiteIDs.count
        let billRequestsAfterUnauthorized = api.billSiteIDs.count

        await coordinator.refreshDue()
        #expect(api.liveSiteIDs.count == liveRequestsAfterUnauthorized)
        #expect(api.billSiteIDs.count == billRequestsAfterUnauthorized)

        api.liveError = nil
        coordinator.authenticationRestored()
        await coordinator.refreshDue()
        #expect(!coordinator.requiresSignIn)
        #expect(api.liveSiteIDs.count == liveRequestsAfterUnauthorized + 1)
    }

    @Test("Server failure keeps stale response and separates attempt from success")
    func serverFailureKeepsStaleResponseAndSeparatesAttemptFromSuccess() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        let priorLive = coordinator.live.response
        let priorSuccess = coordinator.live.lastSuccess
        #expect(priorLive != nil)
        #expect(priorSuccess != nil)

        api.liveError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        clock.advance(minutes: 5)
        await coordinator.refreshDue()

        #expect(coordinator.live.response == priorLive)
        #expect(coordinator.live.lastSuccess == priorSuccess)
        #expect(coordinator.live.lastAttempt == clock.now)
        #expect(coordinator.live.isUnavailable)
        #expect(coordinator.live.unavailableStatusCode == 503)
        #expect(api.liveSiteIDs.count == 2)

        api.liveError = URLError(.notConnectedToInternet)
        clock.advance(minutes: 5)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs.count == 3)
        #expect(coordinator.live.response == priorLive)
        #expect(coordinator.live.lastSuccess == priorSuccess)
        #expect(coordinator.live.isUnavailable)
        #expect(coordinator.live.unavailableStatusCode == nil)

        await coordinator.refreshDue()
        #expect(api.liveSiteIDs.count == 3, "A failed attempt still anchors cadence to prevent rapid retries.")
    }

    @Test("Regression pin: a released coordinator is deallocated, so its deinit backstop runs")
    func releasedCoordinatorIsDeallocated() async throws {
        let api = DashboardAPISpy()
        var coordinator: DashboardCoordinator? = DashboardCoordinator(
            siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) },
            timerInterval: .seconds(3_600)
        )
        coordinator?.scenePhaseChanged(isActive: true)
        #expect(coordinator?.pollingTimerIsActive == true)
        // What this proves: the polling timer does not retain the coordinator, so
        // `deinit` is reachable and the `timerTask` cancel in it can run. What it
        // does not prove: that anything new happened here. The `[weak self]` timer
        // loop already deallocated before `deinit` existed, so this test passed on
        // the base revision unchanged. It is kept only because it now guards the
        // invariant `deinit` depends on — a strongly-capturing timer task added
        // later would silently make the whole `deinit` unreachable.
        weak var released = coordinator
        coordinator = nil
        for _ in 0..<200 where released != nil {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(released == nil, "The polling timer must not keep the coordinator alive.")
    }

    @Test("Tearing down the coordinator discards a live response that is still in flight")
    func teardownDiscardsInFlightLiveResponse() async throws {
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: .milliseconds(20))
        coordinator.scenePhaseChanged(isActive: true)
        let tick = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()
        coordinator.authenticationInvalidated()
        coordinator.scenePhaseChanged(isActive: false)
        api.resumeRequests()
        await tick.value
        #expect(coordinator.live.response == nil)
        #expect(coordinator.live.lastSuccess == nil)
    }

    @Test("Screen appearances put a five minute floor under the bill request")
    func screenAppearancesFloorTheBillRequest() async throws {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let forecast = DashboardForecastStoreSpy(siteID: "site-1")
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, planningAPI: api, forecastStore: forecast,
            accountScopeID: "local-account", now: { clock.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()
        await coordinator.loadTimingDetailAppeared()
        #expect(api.billSiteIDs == ["site-1"], "A second appearance inside five minutes must not re-request the bill.")

        await coordinator.refreshAll(trigger: .userGesture)
        await coordinator.refreshAll(trigger: .userGesture)
        #expect(api.billSiteIDs == ["site-1", "site-1", "site-1"], "An explicit pull always requests.")

        clock.advance(minutes: 10)
        await coordinator.loadTimingDetailAppeared()
        #expect(api.billSiteIDs == ["site-1", "site-1", "site-1", "site-1"],
                "Past the floor an appearance requests again.")
    }

    @Test("Reopening the detail inside the bill floor keeps the enhancement")
    func reopeningInsideTheBillFloorKeepsTheEnhancement() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let forecast = DashboardForecastStoreSpy(siteID: "site-1")
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, planningAPI: api, forecastStore: forecast,
            accountScopeID: "local-account", now: { clock.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.solarForecastState == .enhanced)
        clock.advance(minutes: 1)
        await coordinator.loadTimingDetailAppeared()

        #expect(api.billSiteIDs == ["site-1"], "The floor suppresses the second request.")
        #expect(coordinator.solarForecastState == .enhanced,
                "A bill fetched inside the floor is fresh, so the enhancement must not be dropped.")
    }

    @Test("Manual refresh with a missing planning context re-fetches the context")
    func manualRefreshRefetchesAMissingPlanningContext() async throws {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let forecast = DashboardForecastStoreSpy(siteID: "site-1")
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, planningAPI: api, forecastStore: forecast,
            accountScopeID: "local-account", now: { clock.now }, timerInterval: nil
        )
        coordinator.scenePhaseChanged(isActive: true)

        api.contextError = PWUsageAPIError.requestRejected(statusCode: 404, message: nil)
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.solarForecastState == .failedWithBasic)
        #expect(coordinator.loadPlanningContext == nil)
        #expect(coordinator.solarForecastUnavailableReason == .serverOutdated)
        #expect(api.contextSiteIDs == ["site-1"])

        api.contextError = nil
        await coordinator.loadTimingDetailRefreshed()

        #expect(api.contextSiteIDs == ["site-1", "site-1"],
                "A pull must re-fetch the household profile instead of failing forever.")
        #expect(coordinator.loadPlanningContext != nil)
        #expect(coordinator.solarForecastState == .enhanced)
    }

    @Test("Regression pin: a non-manual forecast refresh does not re-fetch a missing planning context")
    func automaticRefreshDoesNotRefetchAMissingPlanningContext() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let forecast = DashboardForecastStoreSpy(siteID: "site-1")
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, planningAPI: api, forecastStore: forecast,
            accountScopeID: "local-account", now: { clock.now }, timerInterval: nil
        )
        api.contextError = URLError(.notConnectedToInternet)
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.loadPlanningContext == nil)
        #expect(api.contextSiteIDs == ["site-1"])

        api.contextError = nil
        await coordinator.refreshSolarForecast(manual: false)

        // What this proves: re-fetching the household profile is gated on
        // `manual`, so the automatic path cannot hammer it and cannot turn a
        // diagnosed `serverOutdated`/`contextInvalid` into a generic retry.
        // What it does not prove: anything new. The base revision reached the
        // same outcome through a trailing `loadPlanningContext != nil` guard, and
        // this test passed on it unchanged. Kept as the negative control for
        // `manualRefreshRefetchesAMissingPlanningContext`, which cannot show that
        // the `manual` gate is real without a case that stays shut.
        #expect(api.contextSiteIDs == ["site-1"],
                "Only a manual refresh may re-fetch the household profile.")
        #expect(coordinator.solarForecastState == .failedWithBasic)
    }

    @Test("A user-gesture refreshAll bypasses interval checks and fetches both live and bill")
    func userGestureRefreshAllBypassesIntervalChecksAndFetchesBoth() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1"])
        #expect(api.billSiteIDs == ["site-1"])

        // Advance by only 1 minute (neither live 5m nor bill 30m is due)
        clock.advance(minutes: 1)
        await coordinator.refreshAll(trigger: .userGesture)

        #expect(api.liveSiteIDs == ["site-1", "site-1"])
        #expect(api.billSiteIDs == ["site-1", "site-1"])
    }

    @Test("A user-gesture refreshBill bypasses interval checks and fetches only bill")
    func userGestureRefreshBillBypassesIntervalChecksAndFetchesOnlyBill() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1"])
        #expect(api.billSiteIDs == ["site-1"])

        // Advance by only 1 minute
        clock.advance(minutes: 1)
        await coordinator.refreshBill(trigger: .userGesture)

        #expect(api.liveSiteIDs == ["site-1"])
        #expect(api.billSiteIDs == ["site-1", "site-1"])
    }

    @Test("refreshBill does not wait for in-flight live task")
    func refreshBillDoesNotWaitForInFlightLiveTask() async {
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: Date.init, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let liveCall = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()

        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 0)

        // refreshBill should execute immediately without waiting for live task to finish
        await coordinator.refreshBill(trigger: .userGesture)
        #expect(api.billSiteIDs.count == 1)

        api.resumeRequests()
        await liveCall.value
    }

    @Test("Concurrent refreshAll and refreshBill coalesce in-flight requests")
    func concurrentRefreshesCoalesceInFlightRequests() async {
        let api = DashboardAPISpy()
        api.holdLive = true
        api.holdBill = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let first = Task { await coordinator.refreshAll(trigger: .userGesture) }
        await api.waitUntilLiveRequestStarts()
        let second = Task { await coordinator.refreshAll(trigger: .userGesture) }

        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 0)

        api.resumeRequests()
        await first.value
        await second.value

        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 1)

        api.holdBill = true
        let bill1 = Task { await coordinator.refreshBill(trigger: .userGesture) }
        await api.waitUntilBillRequestStarts(targetCount: 2)
        let bill2 = Task { await coordinator.refreshBill(trigger: .userGesture) }

        api.resumeRequests()
        await bill1.value
        await bill2.value

        #expect(api.billSiteIDs.count == 2)
    }

    @Test("refreshAll and refreshBill early return when requiresSignIn is true")
    func refreshesEarlyReturnWhenRequiresSignIn() async {
        let api = DashboardAPISpy()
        api.liveError = PWUsageAPIError.signInRequired
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(coordinator.requiresSignIn)

        let liveCount = api.liveSiteIDs.count
        let billCount = api.billSiteIDs.count

        await coordinator.refreshAll(trigger: .userGesture)
        await coordinator.refreshBill(trigger: .userGesture)

        #expect(api.liveSiteIDs.count == liveCount)
        #expect(api.billSiteIDs.count == billCount)
    }
}

@MainActor
private final class TestClock {
    private(set) var now = Date(timeIntervalSince1970: 1_800_000_000)

    func advance(minutes: Int) {
        now = now.addingTimeInterval(TimeInterval(minutes * 60))
    }
}

@MainActor
private final class DashboardAPISpy: MobileDashboardDataAPI, MobileLoadPlanningDataAPI {
    private(set) var liveSiteIDs: [String] = []
    private(set) var billSiteIDs: [String] = []
    private(set) var contextSiteIDs: [String] = []
    var liveError: Error?
    var billError: Error?
    var contextError: Error?
    var contextAsOf = Date(timeIntervalSince1970: 1_800_000_000)
    var holdLive = false
    var holdBill = false
    private var liveContinuations: [(String, CheckedContinuation<MobileLiveResponse, Error>)] = []
    private var billContinuations: [(String, CheckedContinuation<MobileBillResponse, Error>)] = []
    private var liveStartWaiters: [CheckedContinuation<Void, Never>] = []
    private var billStartWaiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func fetchLive(siteID: String) async throws -> MobileLiveResponse {
        liveSiteIDs.append(siteID)
        let waiters = liveStartWaiters
        liveStartWaiters.removeAll()
        waiters.forEach { $0.resume() }
        if holdLive {
            return try await withCheckedThrowingContinuation { liveContinuations.append((siteID, $0)) }
        }
        if let liveError { throw liveError }
        return Self.liveResponse(siteID: siteID)
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        billSiteIDs.append(siteID)
        let currentCount = billSiteIDs.count
        billStartWaiters.removeAll { targetCount, continuation in
            if currentCount >= targetCount {
                continuation.resume()
                return true
            }
            return false
        }
        if holdBill {
            return try await withCheckedThrowingContinuation { billContinuations.append((siteID, $0)) }
        }
        if let billError { throw billError }
        return Self.billResponse(siteID: siteID)
    }

    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        contextSiteIDs.append(siteID)
        if let contextError { throw contextError }
        return Self.planningContextResponse(siteID: siteID, asOf: contextAsOf)
    }

    func waitUntilLiveRequestStarts() async {
        if !liveSiteIDs.isEmpty { return }
        await withCheckedContinuation { liveStartWaiters.append($0) }
    }

    func waitUntilBillRequestStarts(targetCount: Int = 1) async {
        if billSiteIDs.count >= targetCount { return }
        await withCheckedContinuation { billStartWaiters.append((targetCount, $0)) }
    }

    func resumeRequests() {
        holdLive = false
        holdBill = false
        let livePending = liveContinuations
        liveContinuations.removeAll()
        livePending.forEach { siteID, continuation in continuation.resume(returning: Self.liveResponse(siteID: siteID)) }
        let billPending = billContinuations
        billContinuations.removeAll()
        billPending.forEach { siteID, continuation in continuation.resume(returning: Self.billResponse(siteID: siteID)) }
    }

    private static func liveResponse(siteID: String) -> MobileLiveResponse {
        // A charge reading older than two hours decodes as unknown, so date it now rather than
        // reusing the deliberately stale `liveStatusAt` above.
        let chargeAt = ISO8601DateFormatter().string(from: Date())
        let json = #"{"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"UTC","localDate":"2026-09-23"},"live":{"solarPower":1,"loadPower":2,"batteryPower":3,"gridPower":4},"stateOfCharge":50,"activeTariff":"Peak","today":{"homeKwh":1,"solarKwh":2,"gridNetKwh":3,"batteryNetKwh":4},"todayComplete":true,"currentBill":null,"sources":{"liveStatusAt":"2026-09-23T12:00:00Z","energyDataThrough":null,"stateOfChargeAt":"\#(chargeAt)"}}"#
        return try! MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data(json.utf8))
    }

    private static func billResponse(siteID: String) -> MobileBillResponse {
        let json = #"{"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"UTC"},"currentBill":{"estimatedCost":42,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"sources":{"calculatedAt":"2026-09-23T12:00:00Z","energyDataThrough":null}}"#
        return try! MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(json.utf8))
    }

    private static func planningContextResponse(
        siteID: String,
        asOf: Date
    ) -> MobileLoadPlanningContextResponse {
        MobileLoadPlanningContextResponse(
            version: 1,
            site: .init(id: siteID, timezone: "UTC"),
            units: .init(power: "kW", localMinute: "minute-of-day"),
            asOf: asOf,
            availability: .available,
            unavailableReason: nil,
            usableDayCount: 14,
            historyStart: asOf.addingTimeInterval(-14 * 24 * 60 * 60),
            historyEnd: asOf.addingTimeInterval(-60),
            slots: (0..<48).map { index in
                MobileLoadPlanningContextResponse.Slot(
                    localMinute: index * 30, homeKw: 1, batteryNetChargeKw: 0, sampleCount: 14, coverage: 1
                )
            }
        )
    }
}

/// A configured forecast store, so the Load timing appearance path runs far
/// enough to exercise the bill refresh and the planning-context fetch.
private actor DashboardForecastStoreSpy: SolarForecastManaging {
    private let siteID: String

    init(siteID: String) {
        self.siteID = siteID
    }

    func activateAccountScope(_ accountScopeID: String?) {}
    func credential(accountScopeID: String, siteID: String) -> SolarForecastCredential? {
        guard siteID == self.siteID else { return nil }
        return SolarForecastCredential(
            accountScopeID: accountScopeID, siteID: siteID, credentialID: "fixture", resourceIDs: ["east"]
        )
    }
    func connect(apiKey: String, accountScopeID: String, siteID: String, resourceIDs: [String]?) throws -> String {
        throw SolarForecastStore.StoreError.invalidConfiguration
    }
    func discoverSites(accountScopeID: String, siteID: String, manual: Bool) throws -> [SolcastSite] { [] }
    func selectArrays(_ resourceIDs: [String], accountScopeID: String, siteID: String) throws {}
    func refresh(accountScopeID: String, siteID: String, manual: Bool) -> SolarForecastRefreshResult { .refreshed }
    func cachedBatch(accountScopeID: String, siteID: String) -> SolarForecastBatch? {
        SolarForecastBatch(
            credentialID: "fixture",
            resourceIDs: ["east"],
            intervals: [SolarForecastInterval(
                periodStart: Date(timeIntervalSince1970: 1_800_000_000),
                periodEnd: Date(timeIntervalSince1970: 1_800_001_800),
                powerKw: 2
            )],
            fetchedAt: Date(timeIntervalSince1970: 1_800_000_000)
        )
    }
    func isRecommendationUsable(accountScopeID: String, siteID: String) -> Bool { true }
    func budget(for accountScopeID: String, siteID: String) -> SolarForecastBudget {
        SolarForecastBudget(
            utcDay: Date(timeIntervalSince1970: 1_800_000_000), totalAttempts: 1, automaticAttempts: 1, deferredUntil: nil
        )
    }
    func disconnect(accountScopeID: String, siteID: String) throws {}
    func signOut() async throws {}
}
