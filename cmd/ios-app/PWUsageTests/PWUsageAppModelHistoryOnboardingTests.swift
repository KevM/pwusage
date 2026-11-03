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
        _ environment: FakeOnboardingEnvironment, probe: ScheduleProbe,
        store customStore: SiteHistoryOnboardingStore? = nil
    ) -> SiteHistoryOnboardingLifecycle {
        environment.defaultAnswer = .fill(.busy)
        let store = customStore ?? SiteHistoryOnboardingStore(directory: directory)
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
        let recordsDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let records = SolarLayoutRecordStore(directory: recordsDir)
        let sync = SolarLayoutCloudSync(store: records)
        return PWUsageAppModel(
            configuration: try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true),
            api: OnboardingAppAPI(), userDefaults: defaults,
            solarRecords: records, historyOnboarding: historyOnboarding,
            solarCloudSync: sync, isDemo: isDemo
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

    @Test func savingHomeLocationRestartsBlockedOnboarding() async throws {
        let environment = FakeOnboardingEnvironment()
        let store = SiteHistoryOnboardingStore(directory: directory)
        let lifecycle = makeLifecycle(environment, probe: ScheduleProbe(), store: store)
        environment.defaultAnswer = .disabled
        let model = try makeModel(historyOnboarding: lifecycle)
        model.scenePhaseChanged(isActive: true)
        await model.bootstrap()
        try await eventually { lifecycle.status?.progress?.phase == .finished(.historyUnavailable) }
        await lifecycle.foregroundTask?.value
        let scope = try #require(lifecycle.lastScope)
        var progress = try #require(try await store.progress(scope: scope))
        progress.phase = .finished(.detectorNeedsOtherAction)
        try await store.save(progress, scope: scope)
        environment.defaultAnswer = .fill(.busy)
        model.homeLocationSaved()
        try await eventually { environment.requests.count == 2 }
        #expect(try await store.progress(scope: scope)?.oldestChecked == progress.oldestChecked)
        lifecycle.stop()
    }

    @Test func remoteLocationRefreshesStatusAndRestartsBlockedOnboarding() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.location = false
        let lifecycle = makeLifecycle(environment, probe: ScheduleProbe())
        environment.defaultAnswer = .fill(.complete)
        let model = try makeModel(historyOnboarding: lifecycle)
        model.scenePhaseChanged(isActive: true)
        await model.bootstrap()
        defer { lifecycle.stop() }
        try await eventually { lifecycle.status?.progress?.phase == .finished(.locationNeeded) }
        await lifecycle.foregroundTask?.value
        let scope = try #require(lifecycle.lastScope)
        let session = try #require(model.solarCloudSession)
        let requests = environment.requests.count
        #expect(lifecycle.status?.location == SiteHistoryStatus.LocationState.none)
        environment.location = true
        environment.defaultAnswer = .fill(.busy)
        environment.storedResult = DetectedSolarLayout(
            status: .notEnoughHistory, confidence: nil, reasons: [], planes: [], acClipKw: nil,
            historyDays: 90, clearDays: 0, firstDay: nil, lastDay: nil)
        let other = SolarForecastSiteScope(accountScopeID: scope.accountScopeID, siteID: "site-b")
        await model.solarLayoutRecordChanged(other, from: session)
        await model.solarLayoutRecordChanged(scope, from: SolarCloudSession(accountScopeID: scope.accountScopeID))
        #expect(lifecycle.status?.location == SiteHistoryStatus.LocationState.none)
        #expect(environment.requests.count == requests)
        await model.solarLayoutRecordChanged(scope, from: session)
        #expect(lifecycle.status?.location == .exact)
        #expect(lifecycle.status?.result == environment.storedResult)
        try await eventually { environment.requests.count > requests }
        #expect(environment.requests.last?.from != environment.requests.first?.from)
    }

    @Test("A missing location waits for iCloud records; a saved one never does")
    func missingLocationWaitsForCloudRecords() {
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")
        let progress = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
        let missing = SiteHistoryStatus(scope: scope, progress: progress, throttledUntil: nil)
        let saved = SiteHistoryStatus(
            scope: scope, progress: progress, throttledUntil: nil,
            homeLocation: SolarHomeLocation(latitude: 43.4, longitude: -87.9, source: .device))
        #expect(PWUsageAppModel.visibleHistoryStatus(missing, awaitingCloudRecords: true) == nil)
        #expect(PWUsageAppModel.visibleHistoryStatus(missing, awaitingCloudRecords: false) == missing)
        #expect(PWUsageAppModel.visibleHistoryStatus(saved, awaitingCloudRecords: true) == saved)
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

    @Test("The banner opens Solar System in Settings, at the location step when asked")
    func openSolarSystem() throws {
        let model = try makeModel(historyOnboarding: makeLifecycle(FakeOnboardingEnvironment(), probe: ScheduleProbe()))
        model.openSolarSystem()
        #expect(model.selectedTab == .settings)
        #expect(model.settingsPath == [.solarSystem()])
        model.openSolarSystem(focusingLocation: true)
        #expect(model.settingsPath == [.solarSystem(startsAtLocation: true)])
        model.resetNavigation()
        #expect(model.settingsPath.isEmpty)
    }

    @Test("The banner hides while Solar System is on screen")
    func bannerHidesOnSolarSystem() throws {
        let model = try makeModel(historyOnboarding: makeLifecycle(FakeOnboardingEnvironment(), probe: ScheduleProbe()))
        #expect(!model.isShowingSolarSystem)
        model.openSolarSystem()
        #expect(model.isShowingSolarSystem)
        model.selectTab(.home)
        #expect(!model.isShowingSolarSystem)
        model.selectTab(.settings)
        model.settingsPath = [.ratePlans]
        #expect(!model.isShowingSolarSystem)
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

        @Test("The Debug clear cloud layout purges the site's record and refreshes status")
        func debugClearCloudLayout() async throws {
            let environment = FakeOnboardingEnvironment()
            let lifecycle = makeLifecycle(environment, probe: ScheduleProbe())
            let model = try makeModel(historyOnboarding: lifecycle)
            model.scenePhaseChanged(isActive: true)
            await model.bootstrap()
            try await eventually { model.coordinator != nil }
            let actions = try #require(model.siteHistoryDebugActions)
            let scope = actions.scope
            let coordinator = try #require(model.coordinator)
            let result = await coordinator.saveHomeLocation(
                SolarHomeLocation(latitude: 40, longitude: -75, source: .device), confirmedSiteID: "site-a")
            #expect(result == .shared)
            #expect(try await model.solarRecords.record(scope: scope) != nil)

            await actions.clearCloudLayout()
            #expect(try await model.solarRecords.record(scope: scope) == nil)
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
