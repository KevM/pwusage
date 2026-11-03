import AuthenticationServices
import Foundation
@testable import PWUsage
import Testing

extension PWUsageAppModelTests {
    @Test("Relaunch immediately restores the last dashboard before network requests")
    func relaunchRestoresDashboard() async throws {
        let defaults = makeDefaults()
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let cacheURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("dashboard.json")
        defer { try? FileManager.default.removeItem(at: cacheURL.deletingLastPathComponent()) }
        let first = PWUsageAppModel(configuration: try Self.makeConfiguration(), api: api,
                                    userDefaults: defaults, cache: DashboardCache(fileURL: cacheURL))
        first.scenePhaseChanged(isActive: true)
        await first.bootstrap()
        try await waitUntil { first.coordinator?.bill.response != nil }
        first.scenePhaseChanged(isActive: false)

        let offlineAPI = ApplicationAPISpy(sites: [], sitesError: URLError(.notConnectedToInternet))
        let relaunched = PWUsageAppModel(configuration: try Self.makeConfiguration(),
                                         api: offlineAPI, userDefaults: defaults,
                                         cache: DashboardCache(fileURL: cacheURL))
        #expect(relaunched.screenState == .signedIn)
        #expect(relaunched.sites == first.sites)
        #expect(relaunched.coordinator?.live.response == first.coordinator?.live.response)
        #expect(relaunched.coordinator?.bill.response == first.coordinator?.bill.response)
        #expect(offlineAPI.siteFetchCount == 0)
        relaunched.scenePhaseChanged(isActive: true)
        await relaunched.bootstrap()
        #expect(relaunched.screenState == .signedIn)
        #expect(!relaunched.authService.isAuthenticated, "Saved presentation cannot authorize a session.")
        #expect(offlineAPI.liveSiteIDs.isEmpty, "Poll only after sites have been authorized.")
        #expect(relaunched.coordinator?.live.lastAttempt == nil)
        #expect(relaunched.coordinator?.live.isRestored == true)
        offlineAPI.sitesError = nil
        offlineAPI.sites = first.sites
        await relaunched.refreshDashboard()
        try await waitUntil { relaunched.coordinator?.bill.isRestored == false }
        #expect(relaunched.authService.isAuthenticated)
        #expect(!offlineAPI.liveSiteIDs.isEmpty)
        relaunched.scenePhaseChanged(isActive: false)

        offlineAPI.sitesError = PWUsageAPIError.signInRequired
        await relaunched.reloadSitesAfterSignIn()
        #expect(relaunched.screenState == .signedOut)
        #expect(relaunched.coordinator == nil)
        #expect(DashboardCache(fileURL: cacheURL).snapshot.sites.isEmpty)
    }

    @Test("Restored detail actions wait for site authorization, including offline and pending launches")
    func restoredDetailActionsWaitForAuthorization() async throws {
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: fileURL) }
        let cache = DashboardCache(fileURL: fileURL)
        cache.storeSites([Self.site("site-1"), Self.site("site-2")])
        let api = ApplicationAPISpy(sites: [Self.site("site-1"), Self.site("site-2")],
                                    sitesError: URLError(.notConnectedToInternet))
        let forecast = ForecastServiceSpy()
        let model = PWUsageAppModel(
            configuration: try Self.makeConfiguration(), api: api, userDefaults: makeDefaults(),
            forecastService: forecast, cache: cache
        )
        let coordinator = try #require(model.coordinator)

        func attemptDetailActions() async {
            await coordinator.refreshAll(trigger: .userGesture)
            await coordinator.refreshBill(trigger: .screenAppearance)
            await coordinator.loadTimingDetailAppeared()
            await coordinator.loadTimingDetailRefreshed()
            await coordinator.refreshSolarForecast(manual: true)
        }

        await attemptDetailActions()
        await model.bootstrap()
        model.selectSite(Self.site("site-2"))
        await attemptDetailActions()
        api.sitesError = nil
        api.holdSites = true
        let retry = Task { await model.reloadSitesAfterSignIn() }
        try await waitUntil { api.siteFetchCount == 2 }
        await attemptDetailActions()

        #expect(model.screenState == .signedIn)
        #expect(!coordinator.requiresSignIn, "Unverified saved presentation should not force sign-in.")
        #expect(api.liveSiteIDs.isEmpty)
        #expect(api.billSiteIDs.isEmpty)
        #expect(api.contextSiteIDs.isEmpty)
        #expect(!coordinator.pollingTimerIsActive)
        #expect(coordinator.live.lastAttempt == nil)
        #expect(coordinator.bill.lastAttempt == nil)

        api.resumeSites()
        await retry.value
        #expect(model.coordinator === coordinator)
        await coordinator.loadTimingDetailAppeared()
        #expect(api.billSiteIDs == ["site-2"])
        #expect(api.contextSiteIDs == ["site-2"])
        #expect(await forecast.refreshCount == 0)
        await coordinator.refreshAll(trigger: .userGesture)
        #expect(api.liveSiteIDs == ["site-2"])
    }

    @Test("Malformed launch snapshot falls back to normal bootstrap")
    func malformedSnapshotFallsBack() async throws {
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: fileURL) }
        try Data("broken snapshot".utf8).write(to: fileURL)
        let model = PWUsageAppModel(
            configuration: try Self.makeConfiguration(),
            api: ApplicationAPISpy(sites: [Self.site("site-1")]),
            userDefaults: makeDefaults(),
            cache: DashboardCache(fileURL: fileURL)
        )
        #expect(model.screenState == .bootstrapping)
        await model.bootstrap()
        #expect(model.screenState == .signedIn)
    }

    @Test("A site request finishing after sign-out cannot restore the session")
    func pendingBootstrapCannotUndoSignOut() async throws {
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: fileURL) }
        let cache = DashboardCache(fileURL: fileURL)
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        api.holdSites = true
        let model = PWUsageAppModel(configuration: try Self.makeConfiguration(), api: api,
                                    userDefaults: makeDefaults(), cache: cache)
        let bootstrap = Task { await model.bootstrap() }
        try await waitUntil { api.siteFetchCount == 1 }
        await model.signOut()
        api.resumeSites()
        await bootstrap.value
        #expect(model.screenState == .signedOut)
        #expect(model.coordinator == nil)
        #expect(!model.authService.isAuthenticated)
        #expect(cache.snapshot.sites.isEmpty)
        #expect(DashboardCache(fileURL: fileURL).snapshot.sites.isEmpty)
    }

    @Test("Reconnect cancellation and web failures preserve the signed-in dashboard", arguments: [
        ASWebAuthenticationSessionError.Code.canceledLogin,
        .presentationContextInvalid
    ])
    func reconnectFailurePreservesSession(code: ASWebAuthenticationSessionError.Code) async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let session = AppAuthWebSession()
        let model = PWUsageAppModel(
            configuration: try Self.makeConfiguration(),
            api: api,
            userDefaults: makeDefaults(),
            authService: MobileAuthService(
                configuration: try Self.makeConfiguration(),
                api: api,
                sessionFactory: { _, _, completion in
                    session.completion = completion
                    return session
                }
            )
        )
        await model.bootstrap()
        let coordinator = try #require(model.coordinator)
        let accountScope = model.accountScopeID
        let reconnect = Task { await model.reconnectTesla() }
        try await waitUntil { session.completion != nil }
        session.completion?(nil, ASWebAuthenticationSessionError(code))
        await reconnect.value

        #expect(model.screenState == .signedIn)
        #expect(model.authService.isAuthenticated)
        #expect(model.coordinator === coordinator)
        #expect(!coordinator.requiresSignIn)
        #expect(model.selectedSiteID == "site-1")
        #expect(model.accountScopeID == accountScope)
        #expect(api.cookieClearCount == 0)
        #expect(api.siteFetchCount == 1)
        #expect(!model.isSigningIn)
    }

    @Test("Reconnect handles exchange, site reload and confirmed expiry", arguments: [
        "exchangeFailure", "siteFailure", "success", "expired"
    ])
    func reconnectCompletion(outcome: String) async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let session = AppAuthWebSession()
        let model = PWUsageAppModel(
            configuration: try Self.makeConfiguration(),
            api: api,
            userDefaults: makeDefaults(),
            authService: MobileAuthService(
                configuration: try Self.makeConfiguration(),
                api: api,
                sessionFactory: { url, _, completion in
                    session.loginURL = url
                    session.completion = completion
                    return session
                }
            )
        )
        await model.bootstrap()
        let coordinator = try #require(model.coordinator)
        let accountScope = model.accountScopeID
        if outcome == "exchangeFailure" { api.exchangeError = URLError(.notConnectedToInternet) }
        if outcome == "siteFailure" { api.sitesError = PWUsageAPIError.invalidResponse }
        if outcome == "expired" { api.sitesError = PWUsageAPIError.signInRequired }
        if outcome == "success" { api.sites = [Self.site("site-1"), Self.site("site-2")] }

        let reconnect = Task { await model.reconnectTesla() }
        try await waitUntil { session.completion != nil }
        let url = try #require(session.loginURL)
        let state = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "mobile_state" })?.value)
        let callback = try #require(URL(string:
            "pwusage://auth/callback?code=opaque&attempt=9b47b05a-3f0b-498e-b604-9e43fa7df015&state=\(state)"))
        session.completion?(callback, nil)
        await reconnect.value

        if outcome == "expired" {
            #expect(model.screenState == .signedOut)
            #expect(!model.authService.isAuthenticated)
            #expect(model.coordinator == nil)
            #expect(api.cookieClearCount == 1)
        } else {
            #expect(model.screenState == .signedIn)
            #expect(model.authService.isAuthenticated)
            #expect(model.coordinator === coordinator)
            #expect(model.selectedSiteID == "site-1")
            #expect(model.accountScopeID == accountScope)
            #expect(api.cookieClearCount == 0)
            #expect(model.sites.count == (outcome == "success" ? 2 : 1))
        }
        #expect(!model.isSigningIn)
    }
}
