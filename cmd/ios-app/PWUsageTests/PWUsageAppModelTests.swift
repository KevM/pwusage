import AuthenticationServices
import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("PWUsage App Model Tests", .serialized)
struct PWUsageAppModelTests {
    @Test("Control launch leaves the saved dashboard default alone")
    func controlLaunchKeepsSavedDashboardDefault() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1"), Self.site("site-2")])
        let defaults = makeDefaults()
        defaults.set("site-1", forKey: PWUsageAppModel.selectedSiteDefaultsKey)
        let model = try makeModel(api: api, userDefaults: defaults)
        await model.openBatteryHold(siteID: "site-2")
        #expect(model.selectedSiteID == "site-2")
        #expect(defaults.string(forKey: PWUsageAppModel.selectedSiteDefaultsKey) == "site-1",
                "A control launch is a one-visit detour, not a new dashboard default.")

        // A later reload keeps the site on screen rather than snapping back.
        await model.reloadSitesAfterSignIn()
        #expect(model.selectedSiteID == "site-2")
        #expect(defaults.string(forKey: PWUsageAppModel.selectedSiteDefaultsKey) == "site-1")
    }

    @Test("A picked tab is restored on the next launch")
    func pickedTabPersists() async throws {
        let defaults = makeDefaults()
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let model = try makeModel(api: api, userDefaults: defaults)
        #expect(model.selectedTab == .home)
        model.selectTab(.bill)
        let relaunched = try makeModel(api: api, userDefaults: defaults)
        #expect(relaunched.selectedTab == .bill)
    }

    @Test("An unknown saved tab falls back to Home")
    func unknownSavedTabFallsBack() throws {
        let defaults = makeDefaults()
        defaults.set("loadTiming", forKey: PWUsageAppModel.selectedTabDefaultsKey)
        let model = try makeModel(api: ApplicationAPISpy(sites: [Self.site("site-1")]), userDefaults: defaults)
        #expect(model.selectedTab == .home)
    }

    @Test("A Battery Saver launch shows Smart Shift without changing the saved tab")
    func controlLaunchSelectsSmartShiftOnce() async throws {
        let defaults = makeDefaults()
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let model = try makeModel(api: api, userDefaults: defaults)
        await model.bootstrap()
        model.selectTab(.bill)
        await model.openBatteryHold(siteID: "site-1")
        #expect(model.selectedTab == .smartShift)
        #expect(model.coordinator?.isBatteryHoldSheetPresented == true)
        #expect(defaults.string(forKey: PWUsageAppModel.selectedTabDefaultsKey) == "bill",
                "A control launch is a one-visit detour, like the saved site.")
    }

    @Test("A failed Battery Saver launch leaves the tab alone")
    func removedSiteKeepsTab() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let model = try makeModel(api: api)
        await model.bootstrap()
        model.selectTab(.bill)
        await model.openBatteryHold(siteID: "removed")
        #expect(model.selectedTab == .bill)
    }

    @Test("Switching site closes the Battery Saver sheet")
    func siteSwitchClosesSheet() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1"), Self.site("site-2")])
        let model = try makeModel(api: api)
        await model.bootstrap()
        await model.openBatteryHold(siteID: "site-1")
        model.selectSite(Self.site("site-2"))
        #expect(model.coordinator?.isBatteryHoldSheetPresented == false)
    }

    @Test("Signing out returns the next session to Home")
    func signOutResetsTab() async throws {
        let defaults = makeDefaults()
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let model = try makeModel(api: api, userDefaults: defaults)
        await model.bootstrap()
        model.selectTab(.settings)
        await model.signOut()
        #expect(model.selectedTab == .home)
        #expect(defaults.string(forKey: PWUsageAppModel.selectedTabDefaultsKey) == nil)
    }

    @Test("Dismissing the launcher alert discards the pending request")
    func cancellingControlRequestStopsLaterNavigation() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1"), Self.site("site-2")])
        let defaults = makeDefaults()
        defaults.set("site-1", forKey: PWUsageAppModel.selectedSiteDefaultsKey)
        let model = try makeModel(api: api, userDefaults: defaults)
        await model.bootstrap()
        api.sitesError = URLError(.notConnectedToInternet)
        await model.openBatteryHold(siteID: "site-2")
        #expect(model.pendingBatteryHoldSiteID == "site-2")

        model.cancelBatteryHoldNavigation()
        #expect(model.pendingBatteryHoldSiteID == nil)
        #expect(model.batteryHoldNavigationMessage == nil)

        api.sitesError = nil
        await model.reloadSitesAfterSignIn()
        #expect(model.selectedSiteID == "site-1", "A dismissed request must not move the dashboard later.")
        #expect(model.coordinator?.isBatteryHoldSheetPresented != true)
    }

    @Test("Control launch closes a competing dashboard sheet so its alert is reachable")
    func controlLaunchDismissesCompetingDashboardSheet() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1"), Self.site("site-2")])
        let model = try makeModel(api: api)
        await model.bootstrap()
        model.isSitePickerPresented = true
        api.sitesError = URLError(.notConnectedToInternet)

        await model.openBatteryHold(siteID: "site-2")

        #expect(model.batteryHoldNavigationMessage != nil)
        #expect(model.isSitePickerPresented == false)
        #expect(model.coordinator?.presentedSheet == nil,
                "The root alert and loading overlay cannot be seen underneath a dashboard sheet.")
    }

    @Test("The Battery Saver sheet binding round-trips through the dashboard sheet")
    func batteryHoldSheetBindingRoundTrips() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let model = try makeModel(api: api)
        await model.bootstrap()
        let coordinator = try #require(model.coordinator)

        #expect(DashboardSheet.allCases == [.batteryHold],
                "Rate Plans and About are pushed pages in Settings, not dashboard sheets.")

        coordinator.isBatteryHoldSheetPresented = true
        #expect(coordinator.presentedSheet == .batteryHold)

        coordinator.isBatteryHoldSheetPresented = false
        #expect(coordinator.presentedSheet == nil)
    }

    @Test("External launch replaces navigation presentation identity each time")
    func externalControlResetsNavigation() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let model = try makeModel(api: api)
        await model.bootstrap()
        #expect(model.externalNavigationID == nil)
        await model.openBatteryHold(siteID: "site-1")
        let first = try #require(model.externalNavigationID)
        await model.openBatteryHold(siteID: "site-1")
        #expect(model.externalNavigationID != first)
        let latest = model.externalNavigationID
        await model.openBatteryHold(siteID: "removed")
        #expect(model.externalNavigationID == latest)
        #expect(model.coordinator?.isBatteryHoldSheetPresented == false)
    }

    // `pwusage.test` is a stub host, so the allowlist opt-out is explicit. Built by
    // a throwing helper rather than a force-unwrapped `static let`, so a rejected origin fails
    // the one test that used it instead of trapping the whole binary.
    static func makeConfiguration() throws -> AppConfiguration {
        try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true)
    }

    func makeModel(
        api: ApplicationAPISpy,
        forecastService: (any SolarForecastServing)? = nil,
        timerInterval: Duration? = nil,
        now: @escaping () -> Date = Date.init,
        cadenceNow: @escaping () -> ContinuousClock.Instant = { ContinuousClock().now },
        cache: DashboardCache? = nil,
        userDefaults: UserDefaults? = nil
    ) throws -> PWUsageAppModel {
        PWUsageAppModel(
            configuration: try Self.makeConfiguration(),
            api: api,
            userDefaults: userDefaults ?? makeDefaults(),
            forecastService: forecastService,
            coordinatorFactory: { siteID, accountScopeID in
                DashboardCoordinator(
                    siteID: siteID, api: api,
                    planningAPI: api,
                    accountScopeID: accountScopeID,
                    now: now,
                    cadenceNow: cadenceNow,
                    timerInterval: timerInterval,
                    forecastService: forecastService
                )
            },
            cache: cache
        )
    }

    func makeDefaults() -> UserDefaults {
        let suite = "PWUsageAppModelTests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suite) else {
            preconditionFailure("Test defaults suite '\(suite)' could not be created")
        }
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    func waitForDashboardRequests(_ api: ApplicationAPISpy) async throws {
        try await waitUntil { !api.liveSiteIDs.isEmpty && !api.billSiteIDs.isEmpty }
    }

    /// Bounded on purpose: a condition that never comes true must fail the test
    /// rather than hang the run. Async so it can also observe actor state.
    func waitUntil(_ condition: @MainActor () async -> Bool) async throws {
        for _ in 0 ..< 100 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("Timed out waiting for app coordinator requests")
    }

    static func site(_ id: String) -> MobileSite {
        MobileSite(id: id, name: "Home \(id)", utility: "Utility")
    }
}
