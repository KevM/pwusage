import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Background solar forecast refresh", .serialized)
struct BackgroundSolarForecastTests {
    @Test("Refresh revalidates the saved site without loading the dashboard")
    func headlessRefresh() async throws {
        let harness = try BackgroundForecastHarness()
        let refreshed = await harness.model.refreshBackgroundForecast(
            using: harness.api, now: harness.api.solar.now, lowPowerMode: false
        )
        #expect(refreshed)
        #expect(await harness.provider.refreshes == 1)
        #expect(harness.api.siteFetches == 1)
        #expect(harness.api.solar.layoutSiteIDs == ["site-a"])
        #expect(harness.api.solar.actualsSiteIDs == ["site-a"])
        #expect(harness.model.coordinator == nil)
        #expect(!harness.model.sessionVerified)
    }

    @Test("Low Power Mode and missing account do not issue requests")
    func ineligibleRefresh() async throws {
        let harness = try BackgroundForecastHarness()
        #expect(await !harness.model.refreshBackgroundForecast(
            using: harness.api, now: harness.api.solar.now, lowPowerMode: true
        ))
        harness.defaults.removeObject(forKey: PWUsageAppModel.accountScopeDefaultsKey)
        #expect(await !harness.model.refreshBackgroundForecast(
            using: harness.api, now: harness.api.solar.now, lowPowerMode: false
        ))
        #expect(harness.api.siteFetches == 0)
        #expect(await harness.provider.refreshes == 0)
        #expect(harness.defaults.string(forKey: PWUsageAppModel.accountScopeDefaultsKey) == nil)
    }

    @Test("A revoked site or disabled beta cannot fetch weather")
    func revokedSite() async throws {
        let harness = try BackgroundForecastHarness()
        harness.api.sites = []
        #expect(await !harness.model.refreshBackgroundForecast(
            using: harness.api, now: harness.api.solar.now, lowPowerMode: false
        ))
        harness.api.sites = [MobileSite(id: "site-a", name: "Home", utility: "Test")]
        harness.api.solar.layout = .disabled
        #expect(await !harness.model.refreshBackgroundForecast(
            using: harness.api, now: harness.api.solar.now, lowPowerMode: false
        ))
        #expect(await harness.provider.refreshes == 0)
    }

    @Test("Sign-out during an API await prevents forecast publication")
    func accountFence() async throws {
        let harness = try BackgroundForecastHarness()
        harness.api.solar.holdLayout = true
        let refresh = Task {
            await harness.model.refreshBackgroundForecast(
                using: harness.api, now: harness.api.solar.now, lowPowerMode: false
            )
        }
        try await eventually { harness.api.solar.layoutSiteIDs.count == 1 }
        harness.defaults.removeObject(forKey: PWUsageAppModel.accountScopeDefaultsKey)
        harness.api.solar.resumeLayout()
        #expect(await !refresh.value)
        #expect(await harness.provider.refreshes == 0)
    }

    @Test("Cancelled work never requests weather")
    func cancellation() async throws {
        let harness = try BackgroundForecastHarness()
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return await harness.model.refreshBackgroundForecast(
                using: harness.api, now: harness.api.solar.now, lowPowerMode: false
            )
        }
        #expect(await !task.value)
        #expect(harness.api.siteFetches == 0)
    }
}

@MainActor
private struct BackgroundForecastHarness {
    let api = BackgroundForecastAPI()
    let defaults: UserDefaults
    let provider: StubAutomaticProvider
    let model: PWUsageAppModel

    init() throws {
        guard let savedDefaults = UserDefaults(suiteName: "BackgroundForecastTests.\(UUID().uuidString)") else {
            throw PWUsageAPIError.invalidResponse
        }
        defaults = savedDefaults
        defaults.set("account-a", forKey: PWUsageAppModel.accountScopeDefaultsKey)
        defaults.set("site-a", forKey: PWUsageAppModel.selectedSiteDefaultsKey)
        api.solar.actuals = .enabled(asOf: api.solar.now, hours: [])
        let clock = api.solar.clock
        provider = StubAutomaticProvider(now: { clock.now() })
        let service = SolarForecastService(
            providers: [provider], policy: SolarForecastSelectionPolicy(automaticProviderID: .forecastSolar),
            history: SolarForecastHistory(file: InMemorySolarFile(), clock: clock), clock: clock
        )
        model = PWUsageAppModel(
            configuration: try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true),
            api: api, userDefaults: defaults, forecastStore: FakeSolcastStore(), forecastService: service
        )
    }
}

@MainActor
private final class BackgroundForecastAPI: PWUsageApplicationAPI {
    let solar = AutomaticForecastAPISpy()
    var sites = [MobileSite(id: "site-a", name: "Home", utility: "Test")]
    private(set) var siteFetches = 0
    func fetchSites() async throws -> [MobileSite] { siteFetches += 1; return sites }
    func fetchLive(siteID: String) async throws -> MobileLiveResponse { throw PWUsageAPIError.invalidResponse }
    func fetchBill(siteID: String) async throws -> MobileBillResponse { throw PWUsageAPIError.invalidResponse }
    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        try await solar.fetchLoadPlanningContext(siteID: siteID)
    }
    func fetchSolarLayout(siteID: String) async throws -> MobileSolarLayoutResponse {
        try await solar.fetchSolarLayout(siteID: siteID)
    }
    func fetchSolarActuals(siteID: String) async throws -> MobileSolarActualsResponse {
        try await solar.fetchSolarActuals(siteID: siteID)
    }
    func postSolarLocation(siteID: String, latitude: Double, longitude: Double) async throws {
        throw PWUsageAPIError.invalidResponse
    }
    func exchangeSession(_ exchange: MobileSessionExchange) async throws { throw PWUsageAPIError.invalidResponse }
    func logout() async throws {}
    func clearSiteAuthCookie() async {}
}

@Suite("Background forecast scheduling and file protection")
struct BackgroundForecastPolicyTests {
    @Test("Refresh scheduling is a three-hour lower bound")
    func schedulingHint() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let request = BackgroundSolarForecastRefresh.request(now: now)
        #expect(request.identifier == BackgroundSolarForecastRefresh.identifier)
        #expect(request.earliestBeginDate == now.addingTimeInterval(3 * 3600))
    }

    @Test("Background metadata has an isolated after-first-unlock directory")
    func protectedDirectories() async {
        let foreground = ProtectedSolarForecastFile<[String]>(name: "test.json")
        let background = ProtectedSolarForecastFile<[String]>(name: "test.json", backgroundAccessible: true)
        #expect(await foreground.fileURL.deletingLastPathComponent().lastPathComponent == "SolarForecast")
        #expect(await background.fileURL.deletingLastPathComponent().lastPathComponent == "SolarForecastBackground")
    }
}

@Suite("Background forecast credential metadata eligibility")
struct BackgroundForecastEligibilityTests {
    @Test("A configured Solcast site stays preferred without reading its key")
    func credentialMetadataWins() async {
        var state = SolarForecastPersistedState()
        state.credentials[SolarForecastScope.key("account-a", "site-a")] = SolarForecastCredential(
            accountScopeID: "account-a", siteID: "site-a", credentialID: "synthetic", resourceIDs: []
        )
        let store = SolarForecastStore(files: BackgroundEligibilityFiles(state: state, inaccessible: false))
        #expect(await !store.allowsAutomaticBackgroundRefresh(accountScopeID: "account-a", siteID: "site-a"))
        #expect(await store.allowsAutomaticBackgroundRefresh(accountScopeID: "account-a", siteID: "site-b"))
    }

    @Test("Unreadable locked metadata conservatively prevents automatic refresh")
    func unreadableMetadata() async {
        let store = SolarForecastStore(files: BackgroundEligibilityFiles(state: .init(), inaccessible: true))
        #expect(await !store.allowsAutomaticBackgroundRefresh(accountScopeID: "account-a", siteID: "site-a"))
    }
}

private actor BackgroundEligibilityFiles: SolarForecastPersistence {
    let state: SolarForecastPersistedState
    let inaccessible: Bool
    init(state: SolarForecastPersistedState, inaccessible: Bool) {
        self.state = state
        self.inaccessible = inaccessible
    }
    func loadState() throws -> SolarForecastPersistedState {
        if inaccessible { throw CocoaError(.fileReadNoPermission) }
        return state
    }
    func saveState(_ state: SolarForecastPersistedState) {}
}
