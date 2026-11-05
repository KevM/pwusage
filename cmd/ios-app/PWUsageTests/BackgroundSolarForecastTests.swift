import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Background solar forecast refresh", .serialized)
struct BackgroundSolarForecastTests {
    @Test("Refresh revalidates the saved site without loading the dashboard")
    func headlessRefresh() async throws {
        let harness = try await BackgroundForecastHarness()
        let refreshed = await harness.model.refreshBackgroundForecast(
            using: harness.api, now: harness.api.clock.now(), lowPowerMode: false
        )
        #expect(refreshed)
        #expect(await harness.provider.refreshes == 1)
        #expect(harness.api.siteFetches == 1)
        #expect(harness.model.coordinator == nil)
        #expect(!harness.model.sessionVerified)
    }

    @Test("Automatic provider refreshes background forecast")
    func automaticProviderIgnoresSavedCredentials() async throws {
        let harness = try await BackgroundForecastHarness()
        let refreshed = await harness.model.refreshBackgroundForecast(
            using: harness.api, now: harness.api.clock.now(), lowPowerMode: false
        )
        #expect(refreshed)
        #expect(await harness.provider.refreshes == 1)
    }

    @Test("Missing layout does not refresh")
    func missingLayoutUsesHistory() async throws {
        let harness = try await BackgroundForecastHarness()
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")
        try await harness.records.remove(scope: scope)
        try await harness.records.setLocation(SolarProviderFixture.location, scope: scope)
        #expect(await !harness.model.refreshBackgroundForecast(
            using: harness.api, now: harness.api.clock.now(), lowPowerMode: false
        ))
        #expect(await harness.provider.refreshes == 0)
    }

    @Test("An automatic forecast failure returns false")
    func failedAutomaticUsesHistory() async throws {
        let harness = try await BackgroundForecastHarness()
        await harness.provider.setFailing(true)
        #expect(await !harness.model.refreshBackgroundForecast(
            using: harness.api, now: harness.api.clock.now(), lowPowerMode: false
        ))
        #expect(await harness.provider.refreshes == 1)
    }

    @Test("Low Power Mode and missing account do not issue requests")
    func ineligibleRefresh() async throws {
        let harness = try await BackgroundForecastHarness()
        #expect(await !harness.model.refreshBackgroundForecast(
            using: harness.api, now: harness.api.clock.now(), lowPowerMode: true
        ))
        harness.defaults.removeObject(forKey: PWUsageAppModel.accountScopeDefaultsKey)
        #expect(await !harness.model.refreshBackgroundForecast(
            using: harness.api, now: harness.api.clock.now(), lowPowerMode: false
        ))
        #expect(harness.api.siteFetches == 0)
        #expect(await harness.provider.refreshes == 0)
        #expect(harness.defaults.string(forKey: PWUsageAppModel.accountScopeDefaultsKey) == nil)
    }

    @Test("A revoked site or disabled beta cannot fetch weather")
    func revokedSite() async throws {
        let harness = try await BackgroundForecastHarness()
        harness.api.sites = []
        #expect(await !harness.model.refreshBackgroundForecast(
            using: harness.api, now: harness.api.clock.now(), lowPowerMode: false
        ))
        harness.api.sites = [MobileSite(id: "site-a", name: "Home", utility: "Test")]
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")
        try await harness.records.remove(scope: scope)
        #expect(await !harness.model.refreshBackgroundForecast(
            using: harness.api, now: harness.api.clock.now(), lowPowerMode: false
        ))
        #expect(await harness.provider.refreshes == 0)
    }

    @Test("Persisted disabled beta status skips automatic background forecast even with detected record")
    func persistedDisabledBetaStatusPreventsBackgroundForecast() async throws {
        let harness = try await BackgroundForecastHarness()
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")
        harness.api.solarHistoryResponse = .disabled
        _ = try await harness.historyStore.sync(scope: scope, api: harness.api, now: harness.api.clock.now())
        #expect(try await harness.historyStore.isEnabled(scope: scope) == false)
        #expect(try await harness.historyStore.isSynced(scope: scope, within: 86_400, now: harness.api.clock.now()))

        let refreshed = await harness.model.refreshBackgroundForecast(
            using: harness.api, now: harness.api.clock.now(), lowPowerMode: false
        )
        #expect(!refreshed)
        #expect(await harness.provider.refreshes == 0)
    }

    @Test("Sign-out during an API await prevents forecast publication")
    func accountFence() async throws {
        let harness = try await BackgroundForecastHarness()
        harness.api.holdPlanningContext = true
        let refresh = Task {
            await harness.model.refreshBackgroundForecast(
                using: harness.api, now: harness.api.clock.now(), lowPowerMode: false
            )
        }
        try await eventually { harness.api.planningContextFetches == 1 }
        harness.defaults.removeObject(forKey: PWUsageAppModel.accountScopeDefaultsKey)
        harness.api.resumePlanningContext()
        #expect(await !refresh.value)
        #expect(await harness.provider.refreshes == 0)
    }

    @Test("Cancelled work never requests weather")
    func cancellation() async throws {
        let harness = try await BackgroundForecastHarness()
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return await harness.model.refreshBackgroundForecast(
                using: harness.api, now: harness.api.clock.now(), lowPowerMode: false
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
    let records: SolarLayoutRecordStore
    let historyStore: SolarHistoryStore
    let model: PWUsageAppModel

    init() async throws {
        guard let savedDefaults = UserDefaults(suiteName: "BackgroundForecastTests.\(UUID().uuidString)") else {
            throw PWUsageAPIError.invalidResponse
        }
        defaults = savedDefaults
        defaults.set("account-a", forKey: PWUsageAppModel.accountScopeDefaultsKey)
        defaults.set("site-a", forKey: PWUsageAppModel.selectedSiteDefaultsKey)
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(
            "bg-\(UUID().uuidString)", isDirectory: true
        )
        records = SolarLayoutRecordStore(directory: tempDir.appendingPathComponent("SolarLayout"))
        historyStore = SolarHistoryStore(directory: tempDir.appendingPathComponent("SolarHistory"))
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")
        let date = Date(timeIntervalSince1970: 1_790_000_000)
        try await records.setLocation(SolarProviderFixture.location, scope: scope, at: date)
        let plane = DetectedSolarLayout.Plane(
            azimuth: 180, tilt: 30, dcKwp: 5, effectiveKw: 4.25,
            azimuthRange90: [175, 185], tiltRange90: [25, 35]
        )
        let result = DetectedSolarLayout(
            status: .detected, confidence: "high", reasons: [],
            planes: [plane], acClipKw: nil,
            historyDays: 365, clearDays: 100, firstDay: "2025-01-01", lastDay: "2026-01-01"
        )
        try await records.saveResult(result, scope: scope, for: SolarProviderFixture.location, at: date)
        let clock = api.clock
        provider = StubAutomaticProvider(now: { clock.now() })
        let service = SolarForecastService(
            providers: [provider],
            policy: SolarForecastSelectionPolicy(automaticProviderID: .openMeteo),
            history: SolarForecastHistory(file: InMemorySolarFile(), clock: clock), clock: clock
        )
        model = PWUsageAppModel(
            configuration: try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true),
            api: api, userDefaults: defaults, forecastService: service,
            solarHistory: historyStore, solarRecords: records
        )
    }
}

@MainActor
private final class BackgroundForecastAPI: PWUsageApplicationAPI {
    let clock = MutableSolarClock(Date(timeIntervalSince1970: 1_800_000_000))
    var sites = [MobileSite(id: "site-a", name: "Home", utility: "Test")]
    private(set) var siteFetches = 0
    var holdPlanningContext = false
    private(set) var planningContextFetches = 0
    private var planningContinuations: [CheckedContinuation<Void, Never>] = []

    func fetchSites() async throws -> [MobileSite] { siteFetches += 1; return sites }
    func fetchLive(siteID: String, refresh: Bool) async throws -> MobileLiveResponse {
        throw PWUsageAPIError.invalidResponse
    }
    func fetchBill(siteID: String) async throws -> MobileBillResponse { throw PWUsageAPIError.invalidResponse }
    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        planningContextFetches += 1
        if holdPlanningContext { await withCheckedContinuation { planningContinuations.append($0) } }
        return MobileLoadPlanningContextResponse(
            version: 1, site: .init(id: siteID, timezone: "UTC"),
            units: .init(power: "kW", localMinute: "minute-of-day"),
            asOf: clock.now(), availability: .available, unavailableReason: nil, usableDayCount: 14,
            historyStart: clock.now().addingTimeInterval(-14 * 86400),
            historyEnd: clock.now().addingTimeInterval(-60),
            slots: (0 ..< 48).map {
                .init(localMinute: $0 * 30, homeKw: 1, batteryNetChargeKw: 0, sampleCount: 14, coverage: 1)
            }
        )
    }

    func resumePlanningContext() {
        holdPlanningContext = false
        let pending = planningContinuations
        planningContinuations.removeAll()
        pending.forEach { $0.resume() }
    }

    var solarHistoryResponse: MobileSolarHistoryResponse = .enabled(timeZone: .gmt, days: [], nextFrom: nil)

    func fetchSolarHistory(
        siteID: String, from: String, changedSince: Date?
    ) async throws -> MobileSolarHistoryResponse {
        solarHistoryResponse
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
