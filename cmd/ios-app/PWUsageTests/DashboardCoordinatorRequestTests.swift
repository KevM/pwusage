import Foundation
@testable import PWUsage
import Testing

extension DashboardCoordinatorTests {
    @Test("A user-gesture refreshAll bypasses interval checks and fetches both live and bill")
    func userGestureRefreshAllBypassesIntervalChecksAndFetchesBoth() async {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1"])
        #expect(api.billSiteIDs == ["site-1"])

        // Advance by only 1 minute (neither live 5m nor bill 30m is due)
        clock.advance(minutes: 1)
        await coordinator.refreshAll(trigger: .userGesture)

        #expect(api.liveSiteIDs == ["site-1", "site-1"])
        #expect(api.billSiteIDs == ["site-1", "site-1"])
        #expect(api.liveRefreshes == [false, true])
    }

    @Test("A pull during an unforced live request still sends its own forced request")
    func pullDuringUnforcedLiveRequestSendsForcedRequest() async throws {
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: Date.init, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let poll = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()
        let pull = Task { await coordinator.refreshAll(trigger: .userGesture) }
        for _ in 0 ..< 10 {
            await Task.yield()
        }
        #expect(api.liveRefreshes == [false], "The pull waits for the running request first.")

        api.resumeRequests()
        await poll.value
        await pull.value

        #expect(api.liveRefreshes == [false, true])
    }

    @Test("A second pull joins a forced live request already running")
    func pullDuringForcedLiveRequestJoinsIt() async {
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: Date.init, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let first = Task { await coordinator.refreshAll(trigger: .userGesture) }
        await api.waitUntilLiveRequestStarts()
        let second = Task { await coordinator.refreshAll(trigger: .userGesture) }
        for _ in 0 ..< 10 {
            await Task.yield()
        }
        api.resumeRequests()
        await first.value
        await second.value

        #expect(api.liveRefreshes == [false, true], "The scene's poll, then one forced request.")
    }

    @Test("Automatic recovery skips the live cadence without forcing a history import")
    func automaticRecoverySkipsCadenceWithoutForcingImport() async {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()

        clock.advance(minutes: 1)
        await coordinator.refreshAll(trigger: .automaticRecovery)

        #expect(api.liveRefreshes == [false, false])
    }

    @Test("A Bill pull imports history, then recalculates the bill from it")
    func billPullImportsHistoryWithoutWaitingToShowABill() async throws {
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: Date.init, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let pull = Task { await coordinator.billOutlookRefreshed() }
        try await eventually { api.billSiteIDs.count == 1 }

        api.resumeRequests()
        await pull.value

        #expect(api.liveRefreshes == [false, true], "The scene's poll, then the pull's history import.")
        #expect(api.billSiteIDs.count == 2, "The bill must also follow the imported history.")
    }

    @Test("A user-gesture refreshBill bypasses interval checks and fetches only bill")
    func userGestureRefreshBillBypassesIntervalChecksAndFetchesOnlyBill() async {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
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
        #expect(api.billSiteIDs.isEmpty)

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
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api,
                                               now: { Date(timeIntervalSince1970: 0) },
                                               timerInterval: nil)

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
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api,
                                               now: { Date(timeIntervalSince1970: 0) },
                                               timerInterval: nil)
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
