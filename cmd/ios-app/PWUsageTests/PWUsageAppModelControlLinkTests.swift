import AuthenticationServices
import Foundation
@testable import PWUsage
import Testing

extension PWUsageAppModelTests {
    @Test("Warm launcher reports failed site validation and keeps a retryable request")
    func warmControlSiteLoadingRetry() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1"), Self.site("site-2")])
        let model = try makeModel(api: api)
        await model.bootstrap()
        api.sitesError = URLError(.notConnectedToInternet)
        await model.openBatteryHold(siteID: "site-2")
        #expect(model.coordinator?.isBatteryHoldSheetPresented != true)
        #expect(model.pendingBatteryHoldSiteID == "site-2")
        #expect(model.batteryHoldNavigationMessage != nil)
        api.sitesError = nil
        await model.reloadSitesAfterSignIn()
        #expect(model.selectedSiteID == "site-2")
        #expect(model.batteryHoldNavigationMessage == nil)
        #expect(model.coordinator?.isBatteryHoldSheetPresented == true)
    }

    @Test("Cold launcher with cached sites reports failed validation when bootstrap races control reload")
    func coldControlLoadingRetryWithCachedSites() async throws {
        let defaults = makeDefaults()
        let cacheURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("dashboard.json")
        defer { try? FileManager.default.removeItem(at: cacheURL.deletingLastPathComponent()) }
        let cache = DashboardCache(fileURL: cacheURL)
        cache.storeSites([Self.site("site-1"), Self.site("site-2")])

        let api = ApplicationAPISpy(sites: [Self.site("site-1"), Self.site("site-2")])
        api.holdSites = true

        let model = try makeModel(api: api, cache: cache, userDefaults: defaults)

        // 1. Control launcher starts and claims generation 1, then parks in fetchSites
        let hold = Task { await model.openBatteryHold(siteID: "site-2") }
        try await waitUntil { api.siteFetchCount == 1 }

        // 2. Root view bootstrap starts and claims generation 2, superseding hold's generation 1
        let bootstrap = Task { await model.bootstrap() }
        try await waitUntil { api.siteFetchCount == 2 }

        // 3. Network fails
        api.sitesError = URLError(.notConnectedToInternet)
        api.resumeSites()
        await hold.value
        await bootstrap.value

        #expect(model.coordinator?.isBatteryHoldSheetPresented != true)
        #expect(model.pendingBatteryHoldSiteID == "site-2")
        #expect(model.batteryHoldNavigationMessage != nil)

        api.sitesError = nil
        await model.reloadSitesAfterSignIn()
        #expect(model.selectedSiteID == "site-2")
        #expect(model.batteryHoldNavigationMessage == nil)
        #expect(model.coordinator?.isBatteryHoldSheetPresented == true)
    }

    @Test("Cold launcher keeps the pending request when bootstrap supersedes the control reload")
    func coldControlLoadingSignInRequiredWithCachedSites() async throws {
        let defaults = makeDefaults()
        let cacheURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("dashboard.json")
        defer { try? FileManager.default.removeItem(at: cacheURL.deletingLastPathComponent()) }
        let cache = DashboardCache(fileURL: cacheURL)
        cache.storeSites([Self.site("site-1"), Self.site("site-2")])

        let api = ApplicationAPISpy(sites: [Self.site("site-1"), Self.site("site-2")])
        api.holdSites = true

        let model = try makeModel(api: api, cache: cache, userDefaults: defaults)

        let hold = Task { await model.openBatteryHold(siteID: "site-2") }
        try await waitUntil { api.siteFetchCount == 1 }

        let bootstrap = Task { await model.bootstrap() }
        try await waitUntil { api.siteFetchCount == 2 }

        api.sitesError = PWUsageAPIError.signInRequired
        api.resumeSites()
        await hold.value
        await bootstrap.value

        #expect(model.screenState == .signedOut)
        #expect(model.pendingBatteryHoldSiteID == "site-2")
        #expect(model.signInMessage == "Your session expired. Sign in to continue.")
    }

    @Test("Launching an already-active hold opens its status without commands")
    func controlOpensActiveHoldWithoutCommands() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        api.batteryHoldResponse = .init(
            hold: try MobileContractDecoder.make().decode(BatteryHold.self,
                                                          from: Data(BatteryHoldTests.holdJSON.utf8)),
            notice: nil)
        let model = try makeModel(api: api)
        await model.openBatteryHold(siteID: "site-1")
        let coordinator = try #require(model.coordinator)
        await coordinator.refreshBatteryHold()
        #expect(coordinator.isBatteryHoldSheetPresented)
        #expect(coordinator.batteryHold.response?.hold?.status == .active)
        #expect(api.holdCommands.isEmpty)
    }

    @Test("Live Activities follow the verified sites and are cleared on sign-out")
    func liveActivitiesFollowSession() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1"), Self.site("site-2")])
        let host = FakeActivityHost()
        let activityAPI = FakeActivityAPI()
        let live = BatteryHoldActivityCoordinator(
            host: host, api: activityAPI, apnsEnvironment: .sandbox,
            store: .init(defaults: makeDefaults()), sleep: { _ in })
        let model = PWUsageAppModel(configuration: try Self.makeConfiguration(), api: api,
                                    userDefaults: makeDefaults(), liveActivities: live)
        await model.bootstrap()
        let coordinator = try #require(model.coordinator)
        #expect(coordinator.batteryHoldActivityObserver === live)
        let hold = try MobileContractDecoder.make().decode(BatteryHold.self, from: Data(BatteryHoldTests.holdJSON.utf8))
        live.show(hold, siteID: "site-1", timeZone: nil)
        live.show(try MobileContractDecoder.make().decode(BatteryHold.self, from: Data(BatteryHoldTests.holdJSON
                .replacingOccurrences(of: #""id":1"#, with: #""id":2"#)
                .replacingOccurrences(of: "site-1", with: "site-2").utf8)), siteID: "site-2", timeZone: nil)
        #expect(host.handles.map(\.attributes.siteID) == ["site-1", "site-2"])
        #expect(host.handles[1].attributes.holdID == 2)

        // Losing access to a site clears its activity from the Lock Screen.
        api.sites = [Self.site("site-1")]
        await model.reloadSitesAfterSignIn()
        try await eventually { host.handles[1].ends.count == 1 }
        #expect(host.handles[1].ends.first?.immediately == true)
        #expect(host.handles[0].ends.isEmpty)

        await model.signOut()
        #expect(activityAPI.removals.map(\.registrationID).contains(host.handles[0].attributes.registrationID))
        #expect(host.handles[0].ends.first?.immediately == true)
    }

    @Test("Explicit sign-out discards a pending launcher request")
    func signOutClearsControlRequest() async throws {
        let api = ApplicationAPISpy(sites: [], sitesError: PWUsageAPIError.signInRequired)
        let model = try makeModel(api: api)
        await model.openBatteryHold(siteID: "site-2")
        await model.signOut()
        api.sitesError = nil
        api.sites = [Self.site("site-2")]
        await model.reloadSitesAfterSignIn()
        #expect(model.coordinator?.isBatteryHoldSheetPresented != true)
    }

    @Test("Control launch waits for sites and overrides saved selection")
    func controlLaunchWaitsForSites() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1"), Self.site("site-2")])
        api.holdSites = true
        let defaults = makeDefaults()
        defaults.set("site-1", forKey: PWUsageAppModel.selectedSiteDefaultsKey)
        let model = PWUsageAppModel(configuration: try Self.makeConfiguration(), api: api, userDefaults: defaults)
        let launch = Task { await model.openBatteryHold(siteID: "site-2") }
        try await waitUntil { api.siteFetchCount == 1 }
        #expect(model.coordinator?.isBatteryHoldSheetPresented != true)
        api.resumeSites()
        await launch.value
        #expect(model.selectedSiteID == "site-2")
        #expect(model.coordinator?.selectedSiteID == "site-2")
        #expect(model.coordinator?.isBatteryHoldSheetPresented == true)
    }

    @Test("Control request survives sign-in and loads the requested site")
    func controlRequestSurvivesSignIn() async throws {
        let api = ApplicationAPISpy(sites: [], sitesError: PWUsageAPIError.signInRequired)
        let model = try makeModel(api: api)
        await model.openBatteryHold(siteID: "site-2")
        #expect(model.screenState == .signedOut)
        #expect(model.pendingBatteryHoldSiteID == "site-2")
        api.sitesError = nil
        api.sites = [Self.site("site-1"), Self.site("site-2")]
        await model.reloadSitesAfterSignIn()
        #expect(model.selectedSiteID == "site-2")
        #expect(model.coordinator?.isBatteryHoldSheetPresented == true)
        #expect(model.pendingBatteryHoldSiteID == nil)
    }

    @Test("Removed control site never opens a different site's hold sheet")
    func removedControlSiteDoesNotFallBack() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1"), Self.site("site-2")])
        let model = try makeModel(api: api)
        await model.bootstrap()
        api.sites = [Self.site("site-1")]
        await model.openBatteryHold(siteID: "site-2")
        #expect(model.coordinator?.isBatteryHoldSheetPresented != true)
        #expect(model.batteryHoldNavigationMessage != nil)
        #expect(model.pendingBatteryHoldSiteID == nil)
    }

    @Test("Malformed control links cannot use global site selection")
    func malformedControlLinks() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let model = try makeModel(api: api)
        await model.bootstrap()
        for link in ["pwusage://battery-hold", "pwusage://battery-hold?site=", "pwusage://battery-hold?site=a&site=b"] {
            await model.openNavigationURL(try #require(URL(string: link)))
            #expect(model.coordinator?.isBatteryHoldSheetPresented != true)
            #expect(model.batteryHoldNavigationMessage != nil)
        }
        #expect(api.siteFetchCount == 1)
    }

    @Test("Energy widget links open the Home tab")
    func dashboardLinkOpensHome() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let model = try makeModel(api: api)
        await model.bootstrap()
        model.selectTab(.settings)
        model.isSitePickerPresented = true
        let before = model.externalNavigationID
        let selectedSite = model.selectedSiteID
        await model.openNavigationURL(DashboardLink.url)
        #expect(model.selectedTab == .home)
        // Tab-local modals survive a tab switch, so the stacks must be rebuilt.
        #expect(model.externalNavigationID != before)
        #expect(model.selectedSiteID == selectedSite)
        #expect(model.isSitePickerPresented == false)
        #expect(model.batteryHoldNavigationMessage == nil)
        #expect(api.siteFetchCount == 1)
    }

    @Test("Failed site loading preserves the request for retry")
    func controlSiteLoadingRetry() async throws {
        let api = ApplicationAPISpy(sites: [], sitesError: PWUsageAPIError.recoverableServerError(statusCode: 503))
        let model = try makeModel(api: api)
        await model.openBatteryHold(siteID: "site-2")
        #expect(model.pendingBatteryHoldSiteID == "site-2")
        #expect(model.coordinator == nil)
        api.sitesError = nil
        api.sites = [Self.site("site-2")]
        await model.reloadSitesAfterSignIn()
        #expect(model.coordinator?.isBatteryHoldSheetPresented == true)
    }
}
