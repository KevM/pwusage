import Foundation
@testable import PWUsage
import Testing

extension DashboardCoordinatorTests {
    @Test("Screen appearances put a five minute floor under the bill request")
    func screenAppearancesFloorTheBillRequest() async throws {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, planningAPI: api,
            accountScopeID: "local-account", clock: clock, timerInterval: nil
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

    @Test("Reopening the detail inside the bill floor keeps household pattern")
    func reopeningInsideTheBillFloorKeepsTheEnhancement() async {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, planningAPI: api,
            accountScopeID: "local-account", clock: clock, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.householdPattern != nil)
        clock.advance(minutes: 1)
        await coordinator.loadTimingDetailAppeared()

        #expect(api.billSiteIDs == ["site-1"], "The floor suppresses the second request.")
        #expect(coordinator.householdPattern != nil,
                "A bill fetched inside the floor is fresh, so the household pattern must not be dropped.")
    }

    @Test("Manual refresh with a missing planning context re-fetches the context")
    func manualRefreshRefetchesAMissingPlanningContext() async throws {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, planningAPI: api,
            accountScopeID: "local-account", clock: clock, timerInterval: nil
        )
        coordinator.scenePhaseChanged(isActive: true)

        api.contextError = PWUsageAPIError.requestRejected(statusCode: 404, message: nil)
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.householdPattern == nil)
        #expect(api.contextSiteIDs == ["site-1"])

        api.contextError = nil
        await coordinator.loadTimingDetailRefreshed()

        #expect(api.contextSiteIDs == ["site-1", "site-1"],
                "A pull must re-fetch the household profile instead of failing forever.")
        #expect(coordinator.householdPattern != nil)
        #expect(api.liveRefreshes == [true])
    }

    @Test("Regression pin: a non-manual forecast refresh does not re-fetch a missing planning context")
    func automaticRefreshDoesNotRefetchAMissingPlanningContext() async {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, planningAPI: api,
            accountScopeID: "local-account", clock: clock, timerInterval: nil
        )
        api.contextError = URLError(.notConnectedToInternet)
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.householdPattern == nil)
        #expect(api.contextSiteIDs == ["site-1"])

        api.contextError = nil
        await coordinator.refreshSolarForecast(manual: false)

        #expect(api.contextSiteIDs == ["site-1"],
                "Only a manual refresh may re-fetch the household profile.")
        #expect(coordinator.householdPattern == nil)
    }

    /// The cache self-heals: an entry the device clock has carried past the
    /// context's own 24h bound is refetched and replaced, so a bad entry never
    /// sticks. `revalidationFailureInsideTheLifetimeRefetchesAndReplaces` isolates
    /// the *re-validation* half of the same fall-through, which needs a different
    /// construction; this one covers the far more common lifetime expiry.
    @Test("A cached entry that has aged out is replaced by the next fetch")
    func poisonedCacheEntryIsReplacedOnNextFetch() async {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        api.contextAsOf = clock.now.addingTimeInterval(-60)
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, planningAPI: api,
            accountScopeID: "local-account", clock: clock, timerInterval: nil
        )
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.householdPattern != nil)
        let fetchesAfterFirstLoad = api.contextSiteIDs.count

        // Age past the context's own 24h bound and let a valid response arrive.
        clock.advance(minutes: 24 * 60)
        api.contextAsOf = clock.now
        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.householdPattern != nil)
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
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        // Exactly at the 24h `maximumAge` edge, which `validating` accepts (`<=`).
        api.contextAsOf = clock.now.addingTimeInterval(-24 * 60 * 60)
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, planningAPI: api,
            accountScopeID: "local-account", clock: clock, timerInterval: nil
        )
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.householdPattern != nil)
        let fetchesAfterFirstLoad = api.contextSiteIDs.count

        // One minute on: the entry is a minute inside its lifetime, but its own
        // age is now a minute past `maximumAge`, so re-validation must fail.
        clock.advance(minutes: 1)
        api.contextAsOf = clock.now
        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastUnavailableReason == nil)
        #expect(coordinator.householdPattern != nil)
        #expect(api.contextSiteIDs.count > fetchesAfterFirstLoad,
                "A cached entry that fails re-validation must still be refetched.")
    }
}
