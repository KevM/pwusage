import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Dashboard Coordinator Tests", .serialized)
struct DashboardCoordinatorTests {
    @Test("Fast power polls each minute while history and bill stay on thirty minute cadences")
    func fastPowerDoesNotPollHistory() async throws {
        let clock = TestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        for _ in 1 ..< 60 {
            clock.advance(minutes: 1)
            await coordinator.refreshDue()
        }
        #expect(api.powerSiteIDs.count == 60)
        #expect(api.summary.liveSiteIDs.count == 2)
        #expect(api.summary.billSiteIDs.count == 2)
        #expect(coordinator.power.response?.sources.liveStatusAt == clock.now)
        #expect(coordinator.live.response?.sources.liveStatusAt != clock.now)
    }

    @Test("Foregrounding refreshes power even inside its poll cadence without repeating summaries")
    func raiseRefreshesPowerOnly() async throws {
        let clock = TestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        coordinator.scenePhaseChanged(isActive: false)
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { api.powerSiteIDs.count == 2 && coordinator.power.lastSuccess != nil }
        await coordinator.refreshDue()
        #expect(api.summary.liveSiteIDs.count == 1)
        #expect(api.summary.billSiteIDs.count == 1)
    }

    @Test("Raising unsettles Home until its first refresh finishes, so stale cache never flashes a notice")
    func raiseUnsettlesUntilRefreshFinishes() async throws {
        let clock = TestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        #expect(!coordinator.refreshSettled)
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { coordinator.refreshSettled }

        coordinator.scenePhaseChanged(isActive: false)
        api.holdPower = true
        coordinator.scenePhaseChanged(isActive: true)
        #expect(!coordinator.refreshSettled)
        try await eventually { api.pendingPower != nil }
        #expect(!coordinator.refreshSettled)
        api.holdPower = false
        api.resumePower()
        try await eventually { coordinator.refreshSettled }

        // Later polls keep it settled rather than toggling it.
        clock.advance(minutes: 1)
        await coordinator.refreshDue()
        #expect(coordinator.refreshSettled)
    }

    @Test("A failed refresh still settles; a site switch unsettles until the new site refreshes")
    func failureSettlesAndSiteSwitchUnsettles() async throws {
        let clock = TestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        api.powerError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        api.summary.liveError = URLError(.notConnectedToInternet)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { coordinator.refreshSettled }

        api.powerError = nil
        api.summary.liveError = nil
        api.holdPower = true
        coordinator.selectSite("site-2")
        #expect(!coordinator.refreshSettled)
        try await eventually { api.pendingPower != nil }
        api.holdPower = false
        api.resumePower()
        try await eventually { coordinator.refreshSettled }
    }

    @Test("A delayed fast reading cannot return after sign-out or a site change")
    func fastPowerRespectsSessionAndSiteGeneration() async throws {
        for signOut in [true, false] {
            let api = FastDashboardAPISpy(now: Date.init)
            api.holdPower = true
            let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
            let task = Task { await coordinator.refreshAll(trigger: .userGesture) }
            try await eventually { api.pendingPower != nil }
            if signOut { coordinator.authenticationInvalidated() } else { coordinator.selectSite("site-2") }
            api.resumePower()
            await task.value
            #expect(coordinator.power.response == nil)
            #expect(coordinator.live.response == nil)
            #expect(api.summary.liveSiteIDs.isEmpty)
        }
    }

    @Test("Fast power updates preserve summary source times and are persisted on backgrounding")
    func fastPowerPreservesSummaryAndWidgetTimes() async {
        let clock = TestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = DashboardCache(fileURL: directory.appendingPathComponent("cache.json"))
        cache.storeSites([MobileSite(id: "site-1", name: "Home", utility: "Utility")])
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil, cache: cache
        )
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        let summary = coordinator.live.response
        let bill = coordinator.bill.response
        let initialSnapshot = cache.snapshot.live["site-1"]?.response
        clock.advance(minutes: 1)
        await coordinator.refreshDue()
        #expect(coordinator.live.response == summary)
        #expect(coordinator.bill.response == bill)
        #expect(cache.snapshot.live["site-1"]?.response == initialSnapshot)
        coordinator.scenePhaseChanged(isActive: false)
        #expect(cache.snapshot.live["site-1"]?.response.sources.liveStatusAt == clock.now)
        #expect(cache.snapshot.live["site-1"]?.response.sources.energyDataThrough == summary?.sources.energyDataThrough)
    }

    @Test("An older server retains the combined endpoint cadence")
    func fastPowerRouteMissingFallsBack() async {
        let clock = TestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        api.powerError = PWUsageAPIError.requestRejected(statusCode: 404, message: nil)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        await coordinator.refreshAll(trigger: .userGesture)
        clock.advance(minutes: 5)
        await coordinator.refreshAll(trigger: .screenAppearance)
        #expect(api.powerSiteIDs.count == 1)
        #expect(api.summary.liveSiteIDs.count == 2)
    }

    @Test("On an older server a combined-endpoint failure marks live power unavailable")
    func fallbackFailureMarksLivePowerUnavailable() async {
        let clock = TestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        api.powerError = PWUsageAPIError.requestRejected(statusCode: 404, message: nil)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        await coordinator.refreshAll(trigger: .userGesture)
        #expect(!coordinator.livePowerIsUnavailable)

        api.summary.liveError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        clock.advance(minutes: 5)
        await coordinator.refreshAll(trigger: .userGesture)
        #expect(!coordinator.power.isUnavailable)
        #expect(coordinator.livePowerIsUnavailable)
    }

    @Test("With the fast endpoint, live power availability follows that endpoint alone")
    func fastEndpointOwnsLivePowerAvailability() async {
        let clock = TestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        await coordinator.refreshAll(trigger: .userGesture)
        api.summary.liveError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        clock.advance(minutes: 1)
        await coordinator.refreshAll(trigger: .userGesture)
        #expect(coordinator.live.isUnavailable)
        #expect(!coordinator.livePowerIsUnavailable)

        api.powerError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        clock.advance(minutes: 1)
        await coordinator.refreshAll(trigger: .userGesture)
        #expect(coordinator.livePowerIsUnavailable)
    }

    @Test("Disk snapshots preserve timestamps and restore only the selected site")
    func diskSnapshotsRestorePerSite() async throws {
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("dashboard.json")
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let cache = DashboardCache(fileURL: fileURL)
        cache.storeSites([MobileSite(id: "site-1", name: "Home", utility: "Utility"), MobileSite(id: "site-2", name: "Other", utility: "Utility")])
        let api = DashboardAPISpy()
        let savedAt = Date(timeIntervalSince1970: 1_800_000_000)
        let first = DashboardCoordinator(siteID: "site-1", api: api, now: { savedAt }, timerInterval: nil, cache: cache)
        await first.refreshAll(trigger: .userGesture)
        let reloadedCache = DashboardCache(fileURL: fileURL)
        let restored = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil, cache: reloadedCache)
        #expect(restored.live.response == first.live.response)
        #expect(restored.bill.response == first.bill.response)
        #expect(restored.live.lastSuccess == savedAt)
        #expect(restored.bill.lastSuccess == savedAt)
        #expect(restored.live.lastAttempt == nil)
        #expect(restored.live.isRestored)
        #expect(restored.bill.isRestored)

        restored.selectSite("site-2")
        #expect(restored.live.response == nil)
        #expect(restored.bill.response == nil)
        restored.selectSite("site-1")
        #expect(restored.live.response == first.live.response)
        api.liveError = URLError(.notConnectedToInternet)
        api.billError = URLError(.notConnectedToInternet)
        await restored.refreshAll(trigger: .userGesture)
        #expect(restored.live.response == first.live.response)
        #expect(restored.bill.response == first.bill.response)
        #expect(restored.live.isUnavailable)
        #expect(restored.live.isRestored)
        api.liveError = nil
        api.billError = nil
        await restored.refreshAll(trigger: .userGesture)
        #expect(!restored.live.isRestored)
        #expect(!restored.bill.isRestored)

        reloadedCache.storeSites([])
        #expect(DashboardCache(fileURL: fileURL).snapshot.live.isEmpty)
        #expect(DashboardCache(fileURL: fileURL).snapshot.bill.isEmpty)
    }

    @Test("Discarding a session ignores an in-flight response and cannot refill cache")
    func discardedSessionCannotRefillCache() async {
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("dashboard.json")
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let cache = DashboardCache(fileURL: fileURL)
        cache.storeSites([MobileSite(id: "site-1", name: "Home", utility: "Utility")])
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil, cache: cache)
        let refresh = Task { await coordinator.refreshAll(trigger: .userGesture) }
        await api.waitUntilLiveRequestStarts()
        coordinator.authenticationInvalidated()
        coordinator.scenePhaseChanged(isActive: false)
        cache.clear()
        api.resumeRequests()
        await refresh.value
        #expect(coordinator.live.response == nil)
        #expect(cache.snapshot.live.isEmpty)
        #expect(DashboardCache(fileURL: fileURL).snapshot.sites.isEmpty)
        #expect(api.billSiteIDs.isEmpty)
    }

    @Test("Initial foreground load and exact sixty minute request counts")
    func initialForegroundLoadAndExactSixtyMinuteRequestCounts() async throws {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)

        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1"])
        #expect(api.billSiteIDs == ["site-1"])

        for _ in 1 ..< 60 {
            clock.advance(minutes: 1)
            await coordinator.refreshDue()
        }

        #expect(api.liveSiteIDs.count == 12, "Live is fetched at t=0,5,...,55 in [0,60m).")
        #expect(api.billSiteIDs.count == 2, "Bill is fetched at t=0,30 in [0,60m).")
    }

    @Test("A clock moved backwards does not stall the poll")
    func backwardsClockDoesNotStallThePoll() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)

        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1"])

        // The user's clock jumps back an hour.
        clock.advance(minutes: -60)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1", "site-1"])
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

    @Test("A bill fetched while live was still importing history is recalculated once after live")
    func billFetchedDuringLiveWaitIsRecalculatedAfterLive() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        // Both the scene-phase refresh and this one wait on the same live request.
        coordinator.scenePhaseChanged(isActive: true)
        let waiting = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()

        // A screen appearance fetches the bill before live has imported history.
        clock.advance(minutes: 1)
        await coordinator.refreshBill(trigger: .screenAppearance)
        #expect(api.billSiteIDs.count == 1)

        api.resumeRequests()
        await waiting.value
        await coordinator.refreshDue()

        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 2, "Exactly one bill follows live, however many refreshes waited on it.")
    }

    @Test("A bill still in flight when live finishes is recalculated once after it")
    func billInFlightWhenLiveFinishesIsRecalculatedAfterIt() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        api.holdLive = true
        api.holdBill = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        let waiting = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()

        clock.advance(minutes: 1)
        let appearance = Task { await coordinator.refreshBill(trigger: .screenAppearance) }
        await api.waitUntilBillRequestStarts()

        api.resumeRequests()
        await waiting.value
        await appearance.value
        await coordinator.refreshDue()

        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 2)
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
        weak let released = coordinator
        coordinator = nil
        for _ in 0 ..< 200 where released != nil {
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

    @Test("Smart Shift diagnostics gather the forecast store's bookkeeping")
    func diagnosticsGatherTheForecastStoresBookkeeping() async throws {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let forecast = DashboardForecastStoreSpy(siteID: "site-1")
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, planningAPI: api, forecastStore: forecast,
            accountScopeID: "local-account", now: { clock.now }, timerInterval: nil
        )
        #expect(await coordinator.solarForecastDiagnostics()?.lastRefreshResult == nil)

        await coordinator.loadTimingDetailAppeared()
        let diagnostics = try #require(await coordinator.solarForecastDiagnostics())
        #expect(diagnostics.fetchedAt == Date(timeIntervalSince1970: 1_800_000_000))
        #expect(diagnostics.intervalCount == 1)
        #expect(diagnostics.recommendationUsable)
        #expect(diagnostics.budget?.totalAttempts == 1)
        #expect(diagnostics.budget?.totalLimit == SolarForecastStore.totalAttemptsPerUTCDay)
        #expect(diagnostics.lastErrorDescription == "Forecast request failed")
        #expect(diagnostics.lastRefreshResult == "refreshed")
        #expect(diagnostics.connection == "ready")
        #expect(diagnostics.state == "enhanced")
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

    /// The cache self-heals: an entry the device clock has carried past the
    /// context's own 24h bound is refetched and replaced, so a bad entry never
    /// sticks. `revalidationFailureInsideTheLifetimeRefetchesAndReplaces` isolates
    /// the *re-validation* half of the same fall-through, which needs a different
    /// construction; this one covers the far more common lifetime expiry.
    @Test("A cached entry that has aged out is replaced by the next fetch")
    func poisonedCacheEntryIsReplacedOnNextFetch() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let forecast = DashboardForecastStoreSpy(siteID: "site-1")
        api.contextAsOf = clock.now.addingTimeInterval(-60)
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, planningAPI: api, forecastStore: forecast,
            accountScopeID: "local-account", now: { clock.now }, timerInterval: nil
        )
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.loadPlanningContext != nil)
        let fetchesAfterFirstLoad = api.contextSiteIDs.count

        // Age past the context's own 24h bound and let a valid response arrive.
        clock.advance(minutes: 24 * 60)
        api.contextAsOf = clock.now
        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastUnavailableReason == nil)
        #expect(coordinator.loadPlanningContext != nil)
        #expect(api.contextSiteIDs.count > fetchesAfterFirstLoad)
    }

    /// The same fall-through, reached through *re-validation* rather than the
    /// entry's own 24h lifetime. `sourceAge` is `requestTime - asOf`, so an entry
    /// cached at the exact `maximumAge` edge is the only one that can be inside
    /// `planningContextLifetime` and still fail re-validation a moment later: every
    /// other entry is either comfortably inside `maximumAge` or has already tripped
    /// the lifetime guard first. This is where the audit's "re-rejects the same bad
    /// entry on every read rather than refetching" claim has to be true or false.
    @Test("A cached entry that fails re-validation while still in its lifetime is refetched and replaced")
    func revalidationFailureInsideTheLifetimeRefetchesAndReplaces() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let forecast = DashboardForecastStoreSpy(siteID: "site-1")
        // Exactly at the 24h `maximumAge` edge, which `validating` accepts (`<=`).
        api.contextAsOf = clock.now.addingTimeInterval(-24 * 60 * 60)
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, planningAPI: api, forecastStore: forecast,
            accountScopeID: "local-account", now: { clock.now }, timerInterval: nil
        )
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.loadPlanningContext != nil)
        let fetchesAfterFirstLoad = api.contextSiteIDs.count

        // One minute on: the entry is a minute inside its lifetime, but its own
        // age is now a minute past `maximumAge`, so re-validation must fail.
        clock.advance(minutes: 1)
        api.contextAsOf = clock.now
        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastUnavailableReason == nil)
        #expect(coordinator.loadPlanningContext != nil)
        #expect(api.contextSiteIDs.count > fetchesAfterFirstLoad,
                "A cached entry that fails re-validation must still be refetched.")
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

    @Test("Concurrent refresh calls coalesce each endpoint while its request is in flight")
    func concurrentRefreshesCoalesceInFlightRequests() async throws {
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil)

        let first = Task { await coordinator.refreshAll(trigger: .userGesture) }
        await api.waitUntilLiveRequestStarts()
        var second: Task<Void, Never>?
        await withCheckedContinuation { started in
            second = Task { @MainActor in
                started.resume()
                // The actor cannot resume the test until this reaches its
                // suspension on the held live request.
                await coordinator.refreshAll(trigger: .userGesture)
            }
        }
        let secondRefresh = try #require(second)
        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.isEmpty)
        api.resumeRequests()
        await first.value
        await secondRefresh.value
        #expect(api.liveSiteIDs.count == 1)
        // Bill responses are immediate in this phase. A caller that reaches the
        // bill after it completes may legitimately start a new explicit refresh.

        let billAPI = DashboardAPISpy()
        billAPI.holdBill = true
        let billCoordinator = DashboardCoordinator(siteID: "site-1", api: billAPI, timerInterval: nil)
        let bill1 = Task { await billCoordinator.refreshBill(trigger: .userGesture) }
        await billAPI.waitUntilBillRequestStarts()
        var bill2: Task<Void, Never>?
        await withCheckedContinuation { started in
            bill2 = Task { @MainActor in
                started.resume()
                await billCoordinator.refreshBill(trigger: .userGesture)
            }
        }
        let secondBillRefresh = try #require(bill2)
        #expect(billAPI.billSiteIDs.count == 1)
        billAPI.resumeRequests()
        await bill1.value
        await secondBillRefresh.value
        #expect(billAPI.billSiteIDs.count == 1)
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
        return try Self.liveResponse(siteID: siteID)
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
        return try Self.billResponse(siteID: siteID)
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
        for (siteID, continuation) in livePending {
            do {
                continuation.resume(returning: try Self.liveResponse(siteID: siteID))
            } catch {
                // A broken fixture fails the one test awaiting this continuation,
                // with the decode error attached, instead of trapping the binary.
                continuation.resume(throwing: error)
            }
        }
        let billPending = billContinuations
        billContinuations.removeAll()
        for (siteID, continuation) in billPending {
            do {
                continuation.resume(returning: try Self.billResponse(siteID: siteID))
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    private static func liveResponse(siteID: String) throws -> MobileLiveResponse {
        // A charge reading older than two hours decodes as unknown, so date it now rather than
        // reusing the deliberately stale `liveStatusAt` above.
        let chargeAt = ISO8601DateFormatter().string(from: Date())
        let json = #"{"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"UTC","localDate":"2026-09-23"},"live":{"solarPower":1,"loadPower":2,"batteryPower":3,"gridPower":4},"stateOfCharge":50,"activeTariff":"Peak","today":{"homeKwh":1,"solarKwh":2,"gridNetKwh":3,"batteryNetKwh":4},"todayComplete":true,"currentBill":null,"sources":{"liveStatusAt":"2026-09-23T12:00:00Z","energyDataThrough":null,"stateOfChargeAt":"\#(chargeAt)"}}"#
        return try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data(json.utf8))
    }

    private static func billResponse(siteID: String) throws -> MobileBillResponse {
        let json = #"{"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"UTC"},"currentBill":{"estimatedCost":42,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"sources":{"calculatedAt":"2026-09-23T12:00:00Z","energyDataThrough":null}}"#
        return try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(json.utf8))
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
            slots: (0 ..< 48).map { index in
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
    var lastErrorDescription: String? { "Forecast request failed" }
    func disconnect(accountScopeID: String, siteID: String) throws {}
    func signOut() async throws {}
}

@MainActor
private final class FastDashboardAPISpy: MobileDashboardDataAPI, MobileLivePowerDataAPI {
    let summary = DashboardAPISpy()
    let now: () -> Date
    var powerSiteIDs: [String] = []
    var powerError: (any Error)?
    var holdPower = false
    var pendingPower: CheckedContinuation<MobileLivePowerResponse, any Error>?
    private var pendingSiteID: String?

    init(now: @escaping () -> Date) { self.now = now }

    func fetchLive(siteID: String) async throws -> MobileLiveResponse {
        try await summary.fetchLive(siteID: siteID)
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        try await summary.fetchBill(siteID: siteID)
    }

    func fetchLivePower(siteID: String) async throws -> MobileLivePowerResponse {
        powerSiteIDs.append(siteID)
        if let powerError { throw powerError }
        if holdPower {
            pendingSiteID = siteID
            return try await withCheckedThrowingContinuation { pendingPower = $0 }
        }
        return try response(siteID: siteID)
    }

    func resumePower() {
        let continuation = pendingPower
        pendingPower = nil
        do { continuation?.resume(returning: try response(siteID: pendingSiteID ?? "site-1")) } catch {
            continuation?.resume(throwing: error)
        }
    }

    private func response(siteID: String) throws -> MobileLivePowerResponse {
        let stamp = ISO8601DateFormatter().string(from: now())
        let json = """
        {"version":1,"siteID":"\(siteID)",
         "live":{"solarPower":4000,"loadPower":1000,"batteryPower":-3000,"gridPower":0},
         "stateOfCharge":75,"sources":{"liveStatusAt":"\(stamp)","stateOfChargeAt":"\(stamp)"}}
        """
        let instant = now()
        return try MobileContractDecoder.make(now: { instant }).decode(
            MobileLivePowerResponse.self, from: Data(json.utf8)
        )
    }
}
