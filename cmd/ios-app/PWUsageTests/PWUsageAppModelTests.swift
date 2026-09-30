import Foundation
import Testing
@testable import PWUsage

@MainActor
@Suite("PWUsage App Model Tests", .serialized)
struct PWUsageAppModelTests {
    @Test("Bootstrap restores cookie session and fetches sites only once")
    func bootstrapRestoresCookieSessionAndFetchesSitesOnlyOnce() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let defaults = makeDefaults()
        let model = PWUsageAppModel(configuration: Self.configuration, api: api, userDefaults: defaults)
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
        let model = PWUsageAppModel(configuration: Self.configuration, api: api, userDefaults: defaults)
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
    func unauthorizedCookieBootstrapClearsLocalSessionAndShowsSignIn() async {
        let api = ApplicationAPISpy(sites: [], sitesError: PWUsageAPIError.signInRequired)
        let defaults = makeDefaults()
        defaults.set("stale-account-scope", forKey: PWUsageAppModel.accountScopeDefaultsKey)
        let forecast = AppForecastManagerSpy()
        let model = PWUsageAppModel(
            configuration: Self.configuration,
            api: api,
            userDefaults: defaults,
            forecastStore: forecast
        )

        await model.bootstrap()

        #expect(model.screenState == .signedOut)
        #expect(!model.authService.isAuthenticated)
        #expect(api.cookieClearCount == 1)
        #expect(model.coordinator == nil)
        #expect(defaults.string(forKey: PWUsageAppModel.accountScopeDefaultsKey) == nil)
        #expect(await forecast.activations == [nil])
    }

    @Test("Authorized account without sites gets distinct empty state")
    func authorizedAccountWithoutSitesGetsDistinctEmptyState() async {
        let api = ApplicationAPISpy(sites: [])
        let model = PWUsageAppModel(configuration: Self.configuration, api: api, userDefaults: makeDefaults())

        await model.bootstrap()

        #expect(model.screenState == .noSites)
        #expect(model.authService.isAuthenticated)
        #expect(model.coordinator == nil)
    }

    @Test("Successful site retry after bootstrap failure restores authenticated state")
    func successfulSiteRetryAfterBootstrapFailureRestoresAuthenticatedState() async {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")], sitesError: PWUsageAPIError.recoverableServerError(statusCode: 503))
        let model = PWUsageAppModel(configuration: Self.configuration, api: api, userDefaults: makeDefaults())

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
        let forecast = AppForecastManagerSpy()
        let model = PWUsageAppModel(
            configuration: Self.configuration,
            api: api,
            userDefaults: defaults,
            forecastStore: forecast
        )

        await model.bootstrap()
        let originalScope = try #require(model.accountScopeID)
        #expect(UUID(uuidString: originalScope) != nil)
        #expect(defaults.string(forKey: PWUsageAppModel.accountScopeDefaultsKey) == originalScope)
        let signedInActivations = await forecast.activations
        #expect(signedInActivations == [originalScope])

        await model.signOut()
        #expect(model.accountScopeID == nil)
        #expect(defaults.string(forKey: PWUsageAppModel.accountScopeDefaultsKey) == nil)
        let signedOutActivations = await forecast.activations
        #expect(signedOutActivations.count == 2)
        #expect(signedOutActivations[1] == nil)

        let nextModel = PWUsageAppModel(
            configuration: Self.configuration,
            api: api,
            userDefaults: defaults,
            forecastStore: forecast
        )
        await nextModel.bootstrap()
        let replacementScope = try #require(nextModel.accountScopeID)
        #expect(replacementScope != originalScope)
    }

    @Test("Signing out clears the injected forecast store rather than the shared one")
    func signOutUsesTheInjectedForecastStore() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let defaults = makeDefaults()
        let forecast = AppForecastManagerSpy()
        let model = PWUsageAppModel(
            configuration: Self.configuration,
            api: api,
            userDefaults: defaults,
            forecastStore: forecast
        )

        await model.bootstrap()
        await model.signOut()

        #expect(await forecast.signOutCount == 1)
    }

    @Test("A failing forecast sign-out is reported to the user instead of silently ignored")
    func forecastSignOutFailureSurfaces() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let defaults = makeDefaults()
        let forecast = AppForecastManagerSpy()
        await forecast.setSignOutError(.cleanupFailed)
        let model = PWUsageAppModel(
            configuration: Self.configuration,
            api: api,
            userDefaults: defaults,
            forecastStore: forecast
        )

        await model.bootstrap()
        try #require(model.signInMessage == nil)
        await model.signOut()

        #expect(await forecast.signOutCount == 1)
        #expect(model.signInMessage?.contains("Could not clear local solar forecast data") == true)
        #expect(model.screenState == .signedOut)
    }

    private static let configuration = try! AppConfiguration(apiOriginString: "https://pwusage.test")

    private func makeDefaults() -> UserDefaults {
        let suite = "PWUsageAppModelTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func waitForDashboardRequests(_ api: ApplicationAPISpy) async throws {
        try await waitUntil { !api.liveSiteIDs.isEmpty && !api.billSiteIDs.isEmpty }
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<100 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("Timed out waiting for app coordinator requests")
    }

    private static func site(_ id: String) -> MobileSite {
        MobileSite(id: id, name: "Home \(id)", utility: "Utility")
    }
}

@MainActor
private final class ApplicationAPISpy: PWUsageApplicationAPI {
    let sites: [MobileSite]
    var sitesError: Error?
    private(set) var siteFetchCount = 0
    private(set) var liveSiteIDs: [String] = []
    private(set) var billSiteIDs: [String] = []
    private(set) var cookieClearCount = 0

    init(sites: [MobileSite], sitesError: Error? = nil) {
        self.sites = sites
        self.sitesError = sitesError
    }

    func fetchSites() async throws -> [MobileSite] {
        siteFetchCount += 1
        if let sitesError { throw sitesError }
        return sites
    }

    func fetchLive(siteID: String) async throws -> MobileLiveResponse {
        liveSiteIDs.append(siteID)
        return try Self.liveResponse(siteID: siteID)
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        billSiteIDs.append(siteID)
        return try Self.billResponse(siteID: siteID)
    }

    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func exchangeSession(_ exchange: MobileSessionExchange) async throws {}
    func logout() async throws {}
    func clearSiteAuthCookie() async { cookieClearCount += 1 }

    private static func liveResponse(siteID: String) throws -> MobileLiveResponse {
        let json = #"{"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"UTC","localDate":"2026-09-23"},"live":{"solarPower":100,"loadPower":200,"batteryPower":0,"gridPower":100},"stateOfCharge":50,"activeTariff":"Peak","today":{"homeKwh":1,"solarKwh":2,"gridNetKwh":3,"batteryNetKwh":4},"todayComplete":true,"currentBill":null,"sources":{"liveStatusAt":"2026-09-23T12:00:00Z","energyDataThrough":"2026-09-23T12:00:00Z"}}"#
        return try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data(json.utf8))
    }

    private static func billResponse(siteID: String) throws -> MobileBillResponse {
        let json = #"{"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"UTC"},"currentBill":{"estimatedCost":42,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"sources":{"calculatedAt":"2026-09-23T12:00:00Z","energyDataThrough":null}}"#
        return try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(json.utf8))
    }
}

private actor AppForecastManagerSpy: SolarForecastManaging {
    private(set) var activations: [String?] = []
    private(set) var signOutCount = 0
    private var signOutError: SolarForecastStore.StoreError?

    func setSignOutError(_ error: SolarForecastStore.StoreError?) { signOutError = error }
    func activateAccountScope(_ accountScopeID: String?) { activations.append(accountScopeID) }
    func signOut() async throws {
        signOutCount += 1
        if let signOutError { throw signOutError }
    }
    func credential(accountScopeID: String, siteID: String) -> SolarForecastCredential? { nil }
    func connect(apiKey: String, accountScopeID: String, siteID: String, resourceIDs: [String]?) throws -> String {
        throw SolarForecastStore.StoreError.invalidConfiguration
    }
    func discoverSites(accountScopeID: String, siteID: String, manual: Bool) throws -> [SolcastSite] { [] }
    func selectArrays(_ resourceIDs: [String], accountScopeID: String, siteID: String) throws {}
    func refresh(accountScopeID: String, siteID: String, manual: Bool) -> SolarForecastRefreshResult { .notConfigured }
    func cachedBatch(accountScopeID: String, siteID: String) -> SolarForecastBatch? { nil }
    func isRecommendationUsable(accountScopeID: String, siteID: String) -> Bool { false }
    func budget(for accountScopeID: String, siteID: String) -> SolarForecastBudget {
        SolarForecastBudget(utcDay: Date(timeIntervalSince1970: 0), totalAttempts: 0, automaticAttempts: 0, deferredUntil: nil)
    }
    func disconnect(accountScopeID: String, siteID: String) throws {}
}
