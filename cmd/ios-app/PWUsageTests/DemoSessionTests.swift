import Foundation
@testable import PWUsage
import Testing

/// The demo model is a second, throwaway model. It must be signed in on the
/// sample home and keep everything it writes to its own suite and folder.
@MainActor
@Suite("Demo session")
struct DemoSessionTests {
    /// Suites run in parallel, so each test owns its suite and folder.
    private let suiteName = "pwusage.demo.tests.\(UUID().uuidString)"

    @Test("Signed in on the demo home, on Home, with no control or Live Activity hooks")
    func signedInOnDemoSite() {
        let model = DemoSession.makeModel(suiteName: suiteName)
        defer { DemoSession.tearDown(suiteName: suiteName) }
        #expect(model.screenState == .signedIn)
        #expect(model.isDemo)
        #expect(model.sites == [DemoFixtures.site])
        #expect(model.selectedTab == .home)
        #expect(model.controlSiteStore == nil)
        #expect(model.liveActivities == nil)
        #expect(model.api is DemoAPI)
        #expect(model.forecastService != nil)
        #expect(model.coordinator?.timerInterval == .seconds(30))
    }

    @Test("A real model is not a demo")
    func realModelIsNotDemo() throws {
        let model = PWUsageAppModel(
            configuration: try AppConfiguration(apiOrigin: AppConfiguration.defaultAPIOrigin), api: DemoAPI(),
            userDefaults: UserDefaults(suiteName: suiteName) ?? .standard
        )
        #expect(!model.isDemo)
        UserDefaults.standard.removePersistentDomain(forName: suiteName)
    }

    @Test("Refreshing the demo leaves standard defaults alone")
    func leavesStandardDefaultsAlone() async throws {
        let before = Set(UserDefaults.standard.dictionaryRepresentation().keys)
        let model = DemoSession.makeModel(suiteName: suiteName)
        defer { DemoSession.tearDown(suiteName: suiteName) }
        let coordinator = try #require(model.coordinator)
        coordinator.scenePhaseChanged(isActive: true)
        coordinator.authenticationRestored()
        await coordinator.refreshAll(trigger: .userGesture)
        await coordinator.loadTimingDetailAppeared()
        model.selectTab(.bill)
        _ = model.makeLoadProfileStore()
        #expect(Set(UserDefaults.standard.dictionaryRepresentation().keys) == before)
    }

    @Test("Smart Shift and the bill read the demo scenario")
    func showsScenario() async throws {
        let model = DemoSession.makeModel(suiteName: suiteName)
        defer { DemoSession.tearDown(suiteName: suiteName) }
        let coordinator = try #require(model.coordinator)
        coordinator.scenePhaseChanged(isActive: true)
        coordinator.authenticationRestored()
        await coordinator.refreshAll(trigger: .userGesture)
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.live.response?.site.name == "Cedar House")
        #expect(coordinator.bill.response?.loadTiming?.nextCheaper?.name == "Off-peak")
        #expect(coordinator.forecastConnectionForConsumers == .ready)
        #expect(coordinator.solarForecastState == .enhanced)
    }

    @Test("The default suite is the demo's own")
    func defaultSuite() {
        #expect(DemoSession.defaultsSuiteName == "pwusage.demo")
    }

    @Test("Tearing down empties the demo suite")
    func tearDownEmptiesSuite() throws {
        let model = DemoSession.makeModel(suiteName: suiteName)
        model.selectTab(.settings)
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        #expect(defaults.string(forKey: PWUsageAppModel.selectedTabDefaultsKey) != nil)
        DemoSession.tearDown(suiteName: suiteName)
        #expect(defaults.dictionaryRepresentation()[PWUsageAppModel.selectedTabDefaultsKey] == nil)
        #expect(!FileManager.default.fileExists(atPath: DemoSession.folder(suiteName: suiteName).path))
    }
}
