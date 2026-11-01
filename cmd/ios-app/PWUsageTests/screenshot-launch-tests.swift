#if DEBUG
    import Foundation
    @testable import PWUsage
    import Testing

    /// The App Store screenshots launch the app on demo data. These pin what the
    /// listing would otherwise get wrong without anyone noticing: a placeholder
    /// site, a model that isn't signed in, or demo state leaking into normal runs.
    @MainActor
    @Suite("Screenshot launch")
    struct ScreenshotLaunchTests {
        @Test("Only the screenshot argument turns the mode on")
        func detectsArgument() {
            #expect(ScreenshotLaunch.isRequested(in: ["app", "-PWUsageScreenshotMode"]))
            #expect(!ScreenshotLaunch.isRequested(in: ["app"]))
            #expect(!ScreenshotLaunch.isRequested(in: ["app", "-PWUsageScreenshotModeX"]))
        }

        @Test("The screenshot model is signed in on one realistic site, on Home")
        func showcaseModel() async throws {
            let model = ScreenshotLaunch.makeModel()
            #expect(model.screenState == .signedIn)
            #expect(model.selectedTab == .home)
            #expect(model.sites == [ScreenshotLaunch.site])
            #expect(!ScreenshotLaunch.site.utility.localizedCaseInsensitiveContains("demo"))
            let coordinator = try #require(model.coordinator)
            coordinator.scenePhaseChanged(isActive: true)
            coordinator.authenticationRestored()
            await coordinator.refreshAll(trigger: .userGesture)
            #expect(coordinator.live.response?.site.name == "Cedar House")
            #expect(coordinator.bill.response?.currentBill.estimatedCost == 146.82)
        }

        @Test("The screenshot model never touches standard defaults")
        func isolatedDefaults() {
            let key = PWUsageAppModel.selectedTabDefaultsKey
            let before = UserDefaults.standard.string(forKey: key)
            let model = ScreenshotLaunch.makeModel()
            model.selectTab(.settings)
            #expect(UserDefaults.standard.string(forKey: key) == before)
        }
    }
#endif
