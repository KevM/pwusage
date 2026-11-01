#if DEBUG
    import Foundation

    /// Launches the app signed in on demo data for the App Store screenshot run
    /// (`fastlane ios screenshots`). DEBUG-only so a Release build can't reach it.
    enum ScreenshotLaunch {
        static let argument = "-PWUsageScreenshotMode"

        /// A plausible home for the listing: the fixtures' "Demo utility" would
        /// show on screen.
        static let site = MobileSite(id: "preview-home", name: "Cedar House", utility: "Hill Country Electric")

        static func isRequested(in arguments: [String]) -> Bool {
            arguments.contains(argument)
        }

        /// Uses its own defaults suite, a temporary cache and folder, and solar
        /// stores with no CloudKit transport, so a capture run leaves normal Debug
        /// state alone even on a simulator signed in to iCloud.
        @MainActor
        static func makeModel() -> PWUsageAppModel {
            let api = API()
            let suiteName = "pwusage.screenshots"
            let defaults = UserDefaults(suiteName: suiteName) ?? .standard
            defaults.removePersistentDomain(forName: suiteName)
            defaults.set(AppTab.home.rawValue, forKey: PWUsageAppModel.selectedTabDefaultsKey)
            let folder = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(suiteName)-\(UUID().uuidString)", isDirectory: true)
            let cache = DashboardCache(fileURL: folder.appendingPathComponent("dashboard.json"))
            cache.storeSites([site])
            let solar = Solar(folder: folder, suiteName: suiteName)
            let forecastStore = PreviewForecastStore(mode: .combinedArrays, now: api.launchedAt)
            return PWUsageAppModel(
                configuration: AppConfiguration.screenshotConfiguration,
                api: api,
                userDefaults: defaults,
                forecastStore: forecastStore,
                coordinatorFactory: { siteID, _ in
                    DashboardCoordinator(
                        siteID: siteID, api: api, planningAPI: api, forecastStore: forecastStore,
                        accountScopeID: "preview-account", timerInterval: nil,
                        history: solar.history, records: solar.records
                    )
                },
                cache: cache,
                solarHistory: solar.history,
                solarRecords: solar.records,
                solarCloudSync: solar.cloudSync
            )
        }

        /// Solar stores in the run's own folder, and a cloud sync with no transport.
        private struct Solar {
            let history: SolarHistoryStore
            let records: SolarLayoutRecordStore
            let cloudSync: SolarLayoutCloudSync

            init(folder: URL, suiteName: String) {
                let scopeKey = PWUsageAppModel.accountScopeDefaultsKey
                history = SolarHistoryStore(directory: folder.appendingPathComponent("SolarHistory"))
                records = SolarLayoutRecordStore(directory: folder.appendingPathComponent("SolarLayout")) {
                    UserDefaults(suiteName: suiteName)?.string(forKey: scopeKey)
                }
                cloudSync = SolarLayoutCloudSync(
                    store: records, userDefaults: UserDefaults(suiteName: suiteName) ?? .standard,
                    stateURL: folder.appendingPathComponent("sync-engine-state.json"),
                    systemFieldsURL: folder.appendingPathComponent("system-fields.json"),
                    pendingScopesURL: folder.appendingPathComponent("pending-scopes.json"),
                    transport: nil
                )
            }
        }

        /// One fixture built at launch, so every fetch reports the same source
        /// instant, a little before the clock the screen renders with.
        @MainActor
        final class API: PWUsageApplicationAPI {
            /// The demo data's source instant, shared by every fixture.
            let launchedAt: Date
            private let dashboard: DashboardPreviewAPI
            private let planning: PreviewPlanningAPI

            init() {
                // Two minutes back: minute timelines render with the minute's
                // start, so a source inside it would read as in the future.
                launchedAt = Date(timeIntervalSince1970: floor(Date.now.timeIntervalSince1970) - 120)
                dashboard = DashboardPreviewAPI(mode: .normal, site: ScreenshotLaunch.site, asOf: launchedAt)
                planning = PreviewPlanningAPI(mode: .combinedArrays, now: launchedAt)
            }

            func fetchSites() async throws -> [MobileSite] { [ScreenshotLaunch.site] }
            func fetchLive(siteID: String) async throws -> MobileLiveResponse {
                try await dashboard.fetchLive(siteID: siteID)
            }

            func fetchBill(siteID: String) async throws -> MobileBillResponse {
                try await dashboard.fetchBill(siteID: siteID)
            }

            func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
                try await planning.fetchLoadPlanningContext(siteID: siteID)
            }

            func fetchSolarHistory(
                siteID: String, from: String, changedSince: Date?
            ) async throws -> MobileSolarHistoryResponse {
                .disabled
            }

            func exchangeSession(_ exchange: MobileSessionExchange) async throws {}
            func logout() async throws {}
            func clearSiteAuthCookie() async {}
        }
    }

    private extension AppConfiguration {
        static var screenshotConfiguration: AppConfiguration {
            // The debug fallback origin is a constant this initializer accepts.
            // swiftlint:disable:next force_try
            try! AppConfiguration(apiOriginString: debugFallbackAPIOrigin.absoluteString, isRelease: false)
        }
    }
#endif
