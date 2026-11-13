import CryptoKit
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
        timerInterval: Duration? = .seconds(30),
        isDemo: Bool = true
    ) -> PWUsageAppModel {
        let api = DemoAPI()
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        defaults.set(AppTab.home.rawValue, forKey: PWUsageAppModel.selectedTabDefaultsKey)
        let folder = folder(suiteName: suiteName).appendingPathComponent(UUID().uuidString, isDirectory: true)
        let cache = DashboardCache(fileURL: folder.appendingPathComponent("dashboard.json"))
        cache.storeSites([DemoFixtures.site])
        let solar = Solar(folder: folder, suiteName: suiteName)
        let demoProvider = DemoForecastStore()
        let forecastService = SolarForecastService(
            providers: [demoProvider],
            policy: SolarForecastSelectionPolicy(automaticProviderID: .openMeteo),
            history: SolarForecastHistory(file: MemorySolarForecastFile())
        )
        let runner = SolarLayoutDetectionRunner(history: solar.history, records: solar.records, api: api)
        let demoSolarHealth: SolarHealthModel? = isDemo
            ? DemoSolarHealth.makeModel(records: solar.records, defaults: defaults, folder: folder)
            : nil
        demoSolarHealth?.activate(
            scope: SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: DemoFixtures.site.id))
        return PWUsageAppModel(
            configuration: configuration,
            api: api,
            userDefaults: defaults,
            forecastService: forecastService,
            coordinatorFactory: { [solar, runner] siteID, _ in
                DashboardCoordinator(
                    siteID: siteID, api: api, planningAPI: api,
                    accountScopeID: accountScopeID, timerInterval: timerInterval,
                    forecastService: forecastService,
                    history: solar.history, records: solar.records,
                    runner: runner
                )
            },
            cache: cache,
            controlSiteStore: nil,
            liveActivities: nil,
            solarHistory: solar.history,
            solarRecords: solar.records,
            solarRunner: runner,
            demoSolarHealth: demoSolarHealth,
            solarCloudSync: solar.cloudSync,
            isDemo: isDemo
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
            let recordsDir = folder.appendingPathComponent("SolarLayout")
            records = SolarLayoutRecordStore(directory: recordsDir) {
                UserDefaults(suiteName: suiteName)?.string(forKey: scopeKey)
            }
            cloudSync = SolarLayoutCloudSync(
                store: records, userDefaults: UserDefaults(suiteName: suiteName) ?? .standard,
                stateURL: folder.appendingPathComponent("sync-engine-state.json"),
                systemFieldsURL: folder.appendingPathComponent("system-fields.json"),
                pendingScopesURL: folder.appendingPathComponent("pending-scopes.json"),
                transport: nil
            )
            Self.seedDemoRecord(in: recordsDir)
        }

        private static func seedDemoRecord(in directory: URL) {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let scope = "\(DemoSession.accountScopeID)|\(DemoFixtures.site.id)"
            let hash = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
            let fileURL = directory.appendingPathComponent("\(hash).json")
            let location = SolarHomeLocation(latitude: 37.7749, longitude: -122.4194, source: .device)
            let planes = [
                DetectedSolarLayout.Plane(
                    azimuth: 90, tilt: 20, dcKwp: 4.0, effectiveKw: 4.0,
                    azimuthRange90: [85, 95], tiltRange90: [15, 25]
                ),
                DetectedSolarLayout.Plane(
                    azimuth: 270, tilt: 20, dcKwp: 4.0, effectiveKw: 4.0,
                    azimuthRange90: [265, 275], tiltRange90: [15, 25]
                )]
            let result = DetectedSolarLayout(
                status: .detected, confidence: "high", reasons: [],
                planes: planes, acClipKw: nil, historyDays: 90, clearDays: 30,
                firstDay: "2026-01-01", lastDay: "2026-03-31"
            )
            let record = SolarLayoutRecord(
                location: location, locationSetAt: Date(),
                result: result, detectedAt: Date(), attemptedAt: Date(),
                detectorVersion: SolarLayoutDetector.version, resultLocation: location,
                manualLayout: DemoSolarHealth.manualLayout, manualSetAt: Date()
            )
            if let data = try? JSONEncoder().encode(record) {
                try? data.write(to: fileURL)
            }
        }
    }
}
