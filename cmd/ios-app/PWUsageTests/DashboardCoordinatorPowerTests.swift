import Foundation
@testable import PWUsage
import Testing

extension DashboardCoordinatorTests {
    @Test("A failed refresh still settles; a site switch unsettles until the new site refreshes")
    func failureSettlesAndSiteSwitchUnsettles() async throws {
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        api.powerError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        api.summary.liveError = URLError(.notConnectedToInternet)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
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
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = DashboardCache(fileURL: directory.appendingPathComponent("cache.json"))
        cache.storeSites([MobileSite(id: "site-1", name: "Home", utility: "Utility")])
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, clock: clock, timerInterval: nil, cache: cache
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
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        api.powerError = PWUsageAPIError.requestRejected(statusCode: 404, message: nil)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
        await coordinator.refreshAll(trigger: .userGesture)
        clock.advance(minutes: 5)
        await coordinator.refreshAll(trigger: .screenAppearance)
        #expect(api.powerSiteIDs.count == 1)
        #expect(api.summary.liveSiteIDs.count == 2)
    }

    @Test("On an older server a combined-endpoint failure marks live power unavailable")
    func fallbackFailureMarksLivePowerUnavailable() async {
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        api.powerError = PWUsageAPIError.requestRejected(statusCode: 404, message: nil)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
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
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
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
}
