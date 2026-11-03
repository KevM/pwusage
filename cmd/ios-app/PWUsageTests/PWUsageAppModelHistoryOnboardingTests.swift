import Foundation
@testable import PWUsage
import Testing

@MainActor
private final class OnboardingAppAPI: PWUsageApplicationAPI {
    static let sites = [
        MobileSite(id: "site-a", name: "Home", utility: "Test"),
        MobileSite(id: "site-b", name: "Cabin", utility: "Test")]

    func fetchSites() async throws -> [MobileSite] { Self.sites }
    func fetchLive(siteID: String) async throws -> MobileLiveResponse { throw PWUsageAPIError.invalidResponse }
    func fetchBill(siteID: String) async throws -> MobileBillResponse { throw PWUsageAPIError.invalidResponse }
    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        throw PWUsageAPIError.invalidResponse
    }
    func exchangeSession(_ exchange: MobileSessionExchange) async throws {}
    func logout() async throws {}
    func clearSiteAuthCookie() async {}
}

@MainActor
private final class ScheduleProbe { var scheduled: [Date?] = [] }

@MainActor
@Suite("App model history onboarding")
struct PWUsageAppModelHistoryOnboardingTests {
    private let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)

    /// Every fill is busy and every wait lasts until cancelled, so a run stays on its first slice.
    private func makeLifecycle(
        _ environment: FakeOnboardingEnvironment, probe: ScheduleProbe
    ) -> SiteHistoryOnboardingLifecycle {
        environment.defaultAnswer = .fill(.busy)
        let store = SiteHistoryOnboardingStore(directory: directory)
        return SiteHistoryOnboardingLifecycle(
            onboarding: SiteHistoryOnboarding(environment: environment, store: store),
            store: store,
            isHistoryEnabled: { _ in true },
            scheduleBackground: { probe.scheduled.append($0) },
            sleep: { _ in try await Task.sleep(for: .seconds(3600)) }
        )
    }

    private func makeModel(
        historyOnboarding: SiteHistoryOnboardingLifecycle, isDemo: Bool = false
    ) throws -> PWUsageAppModel {
        let suite = "PWUsageAppModelHistoryOnboardingTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        return PWUsageAppModel(
            configuration: try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true),
            api: OnboardingAppAPI(), userDefaults: defaults, historyOnboarding: historyOnboarding, isDemo: isDemo
        )
    }

    @Test("A verified foreground session onboards the selected site and follows the selection")
    func onboardsTheSelectedSite() async throws {
        let environment = FakeOnboardingEnvironment()
        let lifecycle = makeLifecycle(environment, probe: ScheduleProbe())
        let model = try makeModel(historyOnboarding: lifecycle)
        model.scenePhaseChanged(isActive: true)
        await model.bootstrap()
        try await eventually { environment.sites == ["site-a"] }
        #expect(lifecycle.lastScope?.accountScopeID == model.accountScopeID)

        try await eventually { model.siteHistoryStatus?.scope.siteID == "site-a" }

        model.selectSite(OnboardingAppAPI.sites[1])
        #expect(model.siteHistoryStatus == nil, "Site A's status must not show for site B")
        try await eventually { environment.sites == ["site-a", "site-b"] }
        #expect(lifecycle.lastScope?.siteID == "site-b")
        try await eventually { model.siteHistoryStatus?.scope.siteID == "site-b" }
        lifecycle.stop()
    }

    @Test("Leaving the foreground asks for background time; signing out withdraws it")
    func backgroundAndSignOut() async throws {
        let environment = FakeOnboardingEnvironment()
        let probe = ScheduleProbe()
        let lifecycle = makeLifecycle(environment, probe: probe)
        let model = try makeModel(historyOnboarding: lifecycle)
        model.scenePhaseChanged(isActive: true)
        await model.bootstrap()
        try await eventually { environment.sites.count == 1 }

        model.scenePhaseChanged(isActive: false)
        try await eventually { probe.scheduled.count == 1 }
        #expect(probe.scheduled.first != nil)
        #expect(lifecycle.foregroundTask == nil)

        await model.signOut()
        #expect(probe.scheduled.last == .some(nil))
        #expect(lifecycle.lastScope == nil)
    }

    @Test("The history accessory opens Site History in Settings")
    func openSiteHistory() throws {
        let model = try makeModel(historyOnboarding: makeLifecycle(FakeOnboardingEnvironment(), probe: ScheduleProbe()))
        model.openSiteHistory()
        #expect(model.selectedTab == .settings)
        #expect(model.settingsPath == [.solarSystem()])
        model.resetNavigation()
        #expect(model.settingsPath.isEmpty)
    }

    #if DEBUG
        @Test("The Debug reset forgets only the selected site's progress and starts again")
        func debugReset() async throws {
            let environment = FakeOnboardingEnvironment()
            let lifecycle = makeLifecycle(environment, probe: ScheduleProbe())
            let model = try makeModel(historyOnboarding: lifecycle)
            model.scenePhaseChanged(isActive: true)
            await model.bootstrap()
            try await eventually { model.siteHistoryStatus?.progress != nil }
            let actions = try #require(model.siteHistoryDebugActions)
            #expect(actions.scope.siteID == "site-a")

            await actions.reset()
            try await eventually { environment.sites == ["site-a", "site-a"] }
            lifecycle.stop()
        }

        @Test("Ignoring the layout is a per-site Debug setting")
        func debugIgnoresLayout() throws {
            let defaults = try #require(UserDefaults(suiteName: "SiteHistoryDebug.\(UUID().uuidString)"))
            let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "s")
            #expect(!SiteHistoryDebugSettings.ignoresLayout(scope, defaults: defaults))
            defaults.set(true, forKey: SiteHistoryDebugSettings.ignoresLayoutKey(scope))
            #expect(SiteHistoryDebugSettings.ignoresLayout(scope, defaults: defaults))
            #expect(!SiteHistoryDebugSettings.ignoresLayout(
                SolarForecastSiteScope(accountScopeID: "a", siteID: "other"), defaults: defaults))
        }
    #endif

    @Test("The demo never onboards")
    func demoHasNoOnboarding() throws {
        let lifecycle = makeLifecycle(FakeOnboardingEnvironment(), probe: ScheduleProbe())
        #expect(try makeModel(historyOnboarding: lifecycle, isDemo: true).historyOnboarding == nil)
    }
}
