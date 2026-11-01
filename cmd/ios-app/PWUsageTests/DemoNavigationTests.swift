import Foundation
@testable import PWUsage
import Testing

/// A Control Center control, App Intent, widget or link can open the app while
/// it shows the demo. None may navigate to a real site; each shows the In Demo
/// Mode sheet instead.
@MainActor
@Suite("Demo navigation")
struct DemoNavigationTests {
    /// Suites run in parallel, so each test owns its suite and folder.
    private let suiteName = "pwusage.demo.tests.\(UUID().uuidString)"

    @Test("An external launch shows the demo sheet and stays on the demo home", arguments: [
        BatteryHoldLink.url(siteID: "site-123"),
        DashboardLink.url,
        URL(string: "pwusage://battery-hold")!,
        URL(string: "https://pwusage.fm.rodeo/continue?next=%2Fsite%2F123")!])
    func externalNavigationShowsDemoSheet(_ url: URL) async {
        let model = DemoSession.makeModel(suiteName: suiteName)
        defer { DemoSession.tearDown(suiteName: suiteName) }
        let navigationID = model.externalNavigationID
        await model.openNavigationURL(url)
        #expect(model.isDemoSheetPresented)
        #expect(model.pendingBatteryHoldSiteID == nil)
        #expect(model.selectedSiteID == DemoFixtures.site.id)
        #expect(model.batteryHoldNavigationMessage == nil)
        #expect(model.externalNavigationID == navigationID)
        #expect(model.coordinator?.isBatteryHoldSheetPresented != true)
    }

    /// The demo model's auth service would open the real Tesla sign-in, so the
    /// account actions (the keyboard menu's Sign Out among them) show the sheet.
    @Test("Account actions in the demo show the sheet and keep the demo")
    func accountActionsShowDemoSheet() async {
        let model = DemoSession.makeModel(suiteName: suiteName)
        defer { DemoSession.tearDown(suiteName: suiteName) }
        await model.signOut()
        #expect(model.isDemoSheetPresented)
        #expect(model.screenState == .signedIn)
        model.isDemoSheetPresented = false
        await model.signIn()
        #expect(model.isDemoSheetPresented)
        #expect(!model.isSigningIn)
        model.isDemoSheetPresented = false
        await model.reconnectTesla()
        #expect(model.isDemoSheetPresented)
        #expect(model.sites == [DemoFixtures.site])
    }

    @Test("A real model still follows the dashboard link")
    func nonDemoNavigationUnchanged() async throws {
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let model = PWUsageAppModel(
            configuration: try AppConfiguration(apiOrigin: AppConfiguration.defaultAPIOrigin),
            api: DemoAPI(), userDefaults: defaults
        )
        await model.openNavigationURL(DashboardLink.url)
        #expect(!model.isDemoSheetPresented)
        #expect(model.externalNavigationID != nil)
    }
}
