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

        model.selectSite(OnboardingAppAPI.sites[1])
        try await eventually { environment.sites == ["site-a", "site-b"] }
        #expect(lifecycle.lastScope?.siteID == "site-b")
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

    @Test("The demo never onboards")
    func demoHasNoOnboarding() throws {
        let lifecycle = makeLifecycle(FakeOnboardingEnvironment(), probe: ScheduleProbe())
        #expect(try makeModel(historyOnboarding: lifecycle, isDemo: true).historyOnboarding == nil)
    }
}
