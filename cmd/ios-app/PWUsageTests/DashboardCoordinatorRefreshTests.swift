import Foundation
@testable import PWUsage
import Testing

extension DashboardCoordinatorTests {
    @Test("Initial foreground load and exact sixty minute request counts")
    func initialForegroundLoadAndExactSixtyMinuteRequestCounts() async throws {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)

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
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
        coordinator.isForeground = true
        await coordinator.refreshAll(trigger: .scheduled)
        #expect(api.liveSiteIDs == ["site-1"])

        // The user's clock jumps back an hour. Cadence is monotonic, so the jump
        // neither triggers a poll nor resets the retry window.
        clock.advanceWallClock(minutes: -60)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1"])

        // A forwards jump cannot make a poll due early either.
        clock.advanceWallClock(minutes: 120)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1"])

        // Real elapsed time still makes the next poll due.
        clock.advance(minutes: 5)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1", "site-1"])
    }

    @Test("A cancelled live or bill fetch leaves endpoint state untouched")
    func cancelledFetchLeavesEndpointStateUntouched() async {
        for error in [CancellationError(), URLError(.cancelled)] as [any Error] {
            let api = DashboardAPISpy()
            api.liveError = error
            api.billError = error
            let coordinator = DashboardCoordinator(
                siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil
            )

            await coordinator.refreshAll(trigger: .userGesture)

            #expect(!coordinator.live.isUnavailable)
            #expect(!coordinator.bill.isUnavailable)
            #expect(coordinator.live.lastAttempt == nil)
            #expect(coordinator.bill.lastAttempt == nil)
            #expect(coordinator.live.lastSuccess == nil)
        }
    }

    @Test("Cadence starts when the request finishes, not when it starts")
    func cadenceStartsWhenTheRequestFinishes() async {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
        coordinator.isForeground = true

        let first = Task { await coordinator.refreshAll(trigger: .scheduled) }
        await api.waitUntilLiveRequestStarts()
        clock.advance(minutes: 4)
        api.resumeRequests()
        await first.value
        #expect(api.liveSiteIDs.count == 1)

        clock.advance(minutes: 2)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs.count == 1, "Only two minutes have elapsed since the request completed.")

        clock.advance(minutes: 3)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs.count == 2)
    }

    @Test("Background suspends polling and foreground return makes one due request")
    func backgroundSuspendsPollingAndForegroundReturnMakesOneDueRequest() async {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock,
                                               timerInterval: .seconds(3_600))
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
        #expect(api.liveSiteIDs.count == 2,
                "Returning after missed intervals performs one refresh, not catch-up calls.")
        #expect(api.billSiteIDs.count == 2)
    }

    @Test("Duplicate scene and timer events do not fetch before endpoint is due")
    func duplicateSceneAndTimerEventsDoNotFetchBeforeEndpointIsDue() async {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
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
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api,
                                               now: { Date(timeIntervalSince1970: 0) },
                                               timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let first = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()
        let second = Task { await coordinator.refreshDue() }
        await Task.yield()
        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.isEmpty)

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
        #expect(api.billSiteIDs.isEmpty)

        api.resumeRequests()
        await first.value
        #expect(api.billSiteIDs.count == 1)
    }

    @Test("A bill fetched while live was still importing history is recalculated once after live")
    func billFetchedDuringLiveWaitIsRecalculatedAfterLive() async {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
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
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        api.holdLive = true
        api.holdBill = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
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
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        api.holdLive = true
        api.holdBill = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
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
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api,
                                               now: { Date(timeIntervalSince1970: 0) },
                                               timerInterval: nil)
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
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
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
        #expect(api.liveSiteIDs.count == 2)

        api.liveError = URLError(.notConnectedToInternet)
        clock.advance(minutes: 5)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs.count == 3)
        #expect(coordinator.live.response == priorLive)
        #expect(coordinator.live.lastSuccess == priorSuccess)
        #expect(coordinator.live.isUnavailable)

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
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api,
                                               now: { Date(timeIntervalSince1970: 0) },
                                               timerInterval: .milliseconds(20))
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
}
