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

        @Test("Smart Shift reaches the solar forecast, not the Connect Solcast note")
        func smartShiftHasForecast() async throws {
            let model = ScreenshotLaunch.makeModel()
            let coordinator = try #require(model.coordinator)
            coordinator.scenePhaseChanged(isActive: true)
            coordinator.authenticationRestored()
            await coordinator.refreshAll(trigger: .userGesture)
            await coordinator.loadTimingDetailAppeared()
            #expect(coordinator.solarForecastConnection == .ready)
            #expect(coordinator.solarForecastState == .enhanced)
        }

        /// Minute timelines render with the minute's start, so a source inside the
        /// current minute reads "Source time is in the future". Two minutes back
        /// keeps every label on "updated … ago".
        @Test("Every fetch reports one source instant, before the current minute")
        func sourceTimeIsFixedBeforeLaunchMinute() async throws {
            let api = ScreenshotLaunch.API()
            let launchedBy = Date.now
            try await Task.sleep(for: .milliseconds(1100))
            let first = try await api.fetchLive(siteID: ScreenshotLaunch.site.id).sources.liveStatusAt
            let second = try await api.fetchBill(siteID: ScreenshotLaunch.site.id).sources.energyDataThrough
            let live = try #require(first)
            #expect(live == second)
            #expect(live <= launchedBy.addingTimeInterval(-60))
        }

        @Test("Smart Shift jobs come from the model's defaults, not standard defaults")
        func jobsUseModelDefaults() throws {
            let key = LoadProfileStore.storageKey
            let before = UserDefaults.standard.data(forKey: key)
            let model = ScreenshotLaunch.makeModel()
            let store = model.makeLoadProfileStore()
            #expect(!store.profiles.isEmpty)
            #expect(model.userDefaults.data(forKey: key) != nil)
            #expect(UserDefaults.standard.data(forKey: key) == before)
        }

        /// A simulator signed in to iCloud would otherwise start CloudKit sync and
        /// write the normal app's solar files and defaults.
        @Test("Solar stores and cloud sync are the screenshot run's own")
        func solarDependenciesAreIsolated() {
            let model = ScreenshotLaunch.makeModel()
            #expect(model.solarCloudSync !== SolarLayoutCloudSync.shared)
            #expect(model.solarRecords !== SolarLayoutRecordStore.shared)
            #expect(model.solarHistory !== SolarHistoryStore.shared)
            #expect(model.forecastStore is PreviewForecastStore)
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
