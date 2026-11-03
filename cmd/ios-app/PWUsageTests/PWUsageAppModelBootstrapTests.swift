import AuthenticationServices
import Foundation
@testable import PWUsage
import Testing

extension PWUsageAppModelTests {
    @Test("Bootstrap restores cookie session and fetches sites only once")
    func bootstrapRestoresCookieSessionAndFetchesSitesOnlyOnce() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let defaults = makeDefaults()
        let model = PWUsageAppModel(configuration: try Self.makeConfiguration(), api: api, userDefaults: defaults)
        model.scenePhaseChanged(isActive: true)

        await model.bootstrap()
        try await waitForDashboardRequests(api)
        await model.bootstrap()

        #expect(api.siteFetchCount == 1)
        #expect(model.authService.isAuthenticated)
        #expect(model.screenState == .signedIn)
        #expect(model.selectedSiteID == "site-1")
        #expect(model.coordinator?.selectedSiteID == "site-1")
        #expect(api.liveSiteIDs == ["site-1"])
        #expect(api.billSiteIDs == ["site-1"])
    }

    @Test("Site selection persists and does not refetch site list")
    func siteSelectionPersistsAndDoesNotRefetchSiteList() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1"), Self.site("site-2")])
        let defaults = makeDefaults()
        let model = PWUsageAppModel(configuration: try Self.makeConfiguration(), api: api, userDefaults: defaults)
        model.scenePhaseChanged(isActive: true)
        await model.bootstrap()
        try await waitForDashboardRequests(api)

        model.selectSite(Self.site("site-2"))
        try await waitUntil { api.liveSiteIDs.last == "site-2" && api.billSiteIDs.last == "site-2" }

        #expect(api.siteFetchCount == 1, "Changing dashboard selection must not bootstrap the API again.")
        #expect(model.selectedSiteID == "site-2")
        #expect(defaults.string(forKey: PWUsageAppModel.selectedSiteDefaultsKey) == "site-2")
        #expect(model.coordinator?.selectedSiteID == "site-2")
    }

    @Test("Unauthorized cookie bootstrap clears local session and shows sign-in")
    func unauthorizedCookieBootstrapClearsLocalSessionAndShowsSignIn() async throws {
        let api = ApplicationAPISpy(sites: [], sitesError: PWUsageAPIError.signInRequired)
        let defaults = makeDefaults()
        defaults.set("stale-account-scope", forKey: PWUsageAppModel.accountScopeDefaultsKey)
        let model = PWUsageAppModel(
            configuration: try Self.makeConfiguration(),
            api: api,
            userDefaults: defaults
        )

        await model.bootstrap()

        #expect(model.screenState == .signedOut)
        #expect(!model.authService.isAuthenticated)
        #expect(api.cookieClearCount == 1)
        #expect(model.coordinator == nil)
        #expect(defaults.string(forKey: PWUsageAppModel.accountScopeDefaultsKey) == nil)
    }

    @Test("Authorized account without sites gets distinct empty state")
    func authorizedAccountWithoutSitesGetsDistinctEmptyState() async throws {
        let api = ApplicationAPISpy(sites: [])
        let model = PWUsageAppModel(configuration: try Self.makeConfiguration(), api: api, userDefaults: makeDefaults())

        await model.bootstrap()

        #expect(model.screenState == .noSites)
        #expect(model.authService.isAuthenticated)
        #expect(model.coordinator == nil)
    }

    @Test("Successful site retry after bootstrap failure restores authenticated state")
    func successfulSiteRetryAfterBootstrapFailureRestoresAuthenticatedState() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")],
                                    sitesError: PWUsageAPIError.recoverableServerError(statusCode: 503))
        let model = PWUsageAppModel(configuration: try Self.makeConfiguration(), api: api, userDefaults: makeDefaults())

        await model.bootstrap()
        #expect(model.screenState == .unavailable)
        #expect(!model.authService.isAuthenticated)

        api.sitesError = nil
        await model.reloadSitesAfterSignIn()

        #expect(model.screenState == .signedIn)
        #expect(model.authService.isAuthenticated)
        #expect(api.siteFetchCount == 2)
    }

    @Test("Opaque account scope exists only for the authenticated local session")
    func accountScopeLifecycleFollowsAuthentication() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let defaults = makeDefaults()
        let model = PWUsageAppModel(
            configuration: try Self.makeConfiguration(),
            api: api,
            userDefaults: defaults
        )

        await model.bootstrap()
        let originalScope = try #require(model.accountScopeID)
        #expect(UUID(uuidString: originalScope) != nil)
        #expect(defaults.string(forKey: PWUsageAppModel.accountScopeDefaultsKey) == originalScope)

        await model.signOut()
        #expect(model.accountScopeID == nil)
        #expect(defaults.string(forKey: PWUsageAppModel.accountScopeDefaultsKey) == nil)

        let nextModel = PWUsageAppModel(
            configuration: try Self.makeConfiguration(),
            api: api,
            userDefaults: defaults
        )
        await nextModel.bootstrap()
        let replacementScope = try #require(nextModel.accountScopeID)
        #expect(replacementScope != originalScope)
    }

    @Test("A cancelled bootstrap that never settled retries instead of latching")
    func cancelledBootstrapThatNeverSettledRetries() async throws {
        let api = ApplicationAPISpy(sites: [])
        let model = try makeModel(api: api)

        let cancelled = Task { await model.bootstrap() }
        cancelled.cancel()
        await cancelled.value
        #expect(model.screenState == .noSites)

        await model.bootstrap()

        #expect(api.siteFetchCount == 2, "A bootstrap that never reached a terminal state must be retried.")
    }

    @Test("A cancellation inside installAuthorizedSites leaves a retryable bootstrapping screen")
    func cancellationInsideSiteInstallRetriesOnTheNextBootstrap() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let forecast = ForecastServiceSpy()
        // Park the first bootstrap inside installAuthorizedSites, after `sites`
        // is populated but before `screenState` is settled.
        await forecast.setHoldActivation(true)
        let model = try makeModel(api: api, forecastService: forecast)

        let cancelled = Task { await model.bootstrap() }
        try await waitUntil { await forecast.activationIsParked }
        cancelled.cancel()
        try await waitUntil { !model.sites.isEmpty }

        #expect(model.screenState == .bootstrapping, "The cancellation landed mid-install.")
        #expect(api.siteFetchCount == 1)

        // The retry must go all the way through while the first attempt is still
        // parked, which is exactly the state a re-appearing `.task` would find.
        await model.bootstrap()

        #expect(api.siteFetchCount == 2, "A bootstrap stuck on the spinner must be retried, not latched.")
        #expect(model.screenState == .signedIn)

        // Release the abandoned attempt. This resume is ours, so the await below
        // is bounded by construction.
        await forecast.resumeActivation()
        await cancelled.value
    }

    @Test("A superseded bootstrap attempt cannot overwrite the newer attempt's sites")
    func supersededBootstrapAttemptCannotOverwriteNewerState() async throws {
        // The first attempt parks mid-install; the second completes and installs
        // site-2. When the first finally resumes it must not publish site-1 over it.
        let api = ApplicationAPISpy(sites: [Self.site("site-2")], sitesSequence: [[Self.site("site-1")]])
        let forecast = ForecastServiceSpy()
        await forecast.setHoldActivation(true)
        let model = try makeModel(api: api, forecastService: forecast)

        let stale = Task { await model.bootstrap() }
        try await waitUntil { await forecast.activationIsParked }
        await model.bootstrap()

        #expect(model.screenState == .signedIn)
        #expect(model.selectedSiteID == "site-2")

        await forecast.resumeActivation()
        await stale.value

        #expect(model.screenState == .signedIn, "The stale attempt must not change the published screen state.")
        #expect(model.sites.map(\.id) == ["site-2"], "The stale attempt must not replace the newer site list.")
        #expect(model.selectedSiteID == "site-2", "The stale attempt must not reselect the site it found.")
        #expect(model.coordinator?.selectedSiteID == "site-2",
                "The stale attempt must not replace the newer coordinator.")
    }
}
