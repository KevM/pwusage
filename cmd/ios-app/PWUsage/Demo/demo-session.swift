import Foundation

/// Builds the demo's model: signed in on the sample home, answered by
/// `DemoAPI`, with its own defaults suite, a temporary folder for the cache and
/// solar stores, and a cloud sync with no transport. Nothing it touches is the
/// real app's, so the real model, the Control Center site store, standard
/// defaults and iCloud are left exactly as they were.
///
/// Two callers: "Try the demo" on the sign-in screen, and the DEBUG App Store
/// screenshot run, so the listing shows what reviewers see.
enum DemoSession {
    static let defaultsSuiteName = "pwusage.demo"
    static let accountScopeID = "demo-account"

    /// Every session's files live under this folder, so tearing down removes
    /// them all.
    static func folder(suiteName: String = defaultsSuiteName) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(suiteName, isDirectory: true)
    }

    /// A fresh demo, whatever an earlier one left behind.
    @MainActor
    static func makeModel(
        suiteName: String = defaultsSuiteName,
        timerInterval: Duration? = .seconds(30)
    ) -> PWUsageAppModel {
        let api = DemoAPI()
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        defaults.set(AppTab.home.rawValue, forKey: PWUsageAppModel.selectedTabDefaultsKey)
        let folder = folder(suiteName: suiteName).appendingPathComponent(UUID().uuidString, isDirectory: true)
        let cache = DashboardCache(fileURL: folder.appendingPathComponent("dashboard.json"))
        cache.storeSites([DemoFixtures.site])
        let solar = Solar(folder: folder, suiteName: suiteName)
        let forecastStore = DemoForecastStore()
        return PWUsageAppModel(
            configuration: configuration,
            api: api,
            userDefaults: defaults,
            forecastStore: forecastStore,
            forecastService: nil,
            coordinatorFactory: { siteID, _ in
                DashboardCoordinator(
                    siteID: siteID, api: api, planningAPI: api, forecastStore: forecastStore,
                    accountScopeID: accountScopeID, timerInterval: timerInterval,
                    history: solar.history, records: solar.records
                )
            },
            cache: cache,
            controlSiteStore: nil,
            liveActivities: nil,
            solarHistory: solar.history,
            solarRecords: solar.records,
            solarCloudSync: solar.cloudSync,
            isDemo: true
        )
    }

    /// Removes everything any demo session wrote, so a relaunch finds nothing.
    static func tearDown(suiteName: String = defaultsSuiteName) {
        UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName)
        try? FileManager.default.removeItem(at: folder(suiteName: suiteName))
    }

    /// The API is never reached, but the auth service needs a configuration.
    private static var configuration: AppConfiguration {
        AppConfiguration.demo
    }

    /// Solar stores in the session's own folder, and a cloud sync with no transport.
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
}
