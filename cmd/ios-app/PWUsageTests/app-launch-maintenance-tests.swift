import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("App launch maintenance")
struct AppLaunchMaintenanceTests {
    @Test("First launch sweeps once and controls reload only when the build changes")
    func installationAndBuildMarkers() async throws {
        let suite = "AppLaunchMaintenanceTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("saved-site", forKey: "controlSite")
        var sweeps = 0
        var reloads = 0
        var cookieClears = 0
        func launch(_ build: String?) async throws {
            try await AppLaunchMaintenance.run(
                defaults: defaults, buildVersion: build,
                hasPersistedForecastState: { false },
                sweepCredentials: { sweeps += 1 },
                clearSessionCookie: { cookieClears += 1 },
                reloadControls: { reloads += 1 }
            )
        }

        try await launch("1")
        #expect(sweeps == 1)
        #expect(cookieClears == 1)
        #expect(reloads == 1)
        try await launch("1")
        #expect(sweeps == 1)
        #expect(cookieClears == 1)
        #expect(reloads == 1)
        try await launch("2")
        #expect(sweeps == 1)
        #expect(cookieClears == 1)
        #expect(reloads == 2)
        try await launch(nil)
        #expect(reloads == 2)
        #expect(defaults.string(forKey: "controlSite") == "saved-site")

        // A reinstall removes sandbox defaults while Keychain items and the
        // app-group cookie jar may remain.
        defaults.removePersistentDomain(forName: suite)
        try await launch("2")
        #expect(sweeps == 2)
        #expect(cookieClears == 2)
    }

    @Test("An existing installation migrates its marker without deleting valid credentials")
    func upgradePreservesCredentials() async throws {
        let suite = "AppLaunchMaintenanceTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var sweeps = 0
        var cookieClears = 0
        var hasState = true
        func launch() async throws {
            try await AppLaunchMaintenance.run(
                defaults: defaults, buildVersion: "2",
                hasPersistedForecastState: { hasState },
                sweepCredentials: { sweeps += 1 },
                clearSessionCookie: { cookieClears += 1 },
                reloadControls: {}
            )
        }
        try await launch()
        #expect(sweeps == 0)
        #expect(cookieClears == 0)
        #expect(defaults.bool(forKey: AppLaunchMaintenance.credentialSweepKey))
        // Later loss of forecast metadata must not turn an upgrade into a reinstall.
        hasState = false
        try await launch()
        #expect(sweeps == 0)
        #expect(cookieClears == 0)
        defaults.removePersistentDomain(forName: suite)
        try await launch()
        #expect(sweeps == 1)
        #expect(cookieClears == 1)
    }

    @Test("An unreadable sandbox prevents sweeping and leaves migration pending")
    func unreadableStateDoesNotDeleteCredentials() async throws {
        let suite = "AppLaunchMaintenanceTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        enum StateError: Error { case locked }
        await #expect(throws: StateError.locked) {
            try await AppLaunchMaintenance.run(
                defaults: defaults, buildVersion: "2",
                hasPersistedForecastState: { throw StateError.locked },
                sweepCredentials: { Issue.record("An unreadable sandbox must preserve credentials") },
                clearSessionCookie: { Issue.record("An unreadable sandbox must preserve the session cookie") },
                reloadControls: {}
            )
        }
        #expect(!defaults.bool(forKey: AppLaunchMaintenance.credentialSweepKey))
    }

    @Test("Failed sweep does not mark installation complete and retries next launch")
    func failedSweepRetries() async throws {
        let suite = "AppLaunchMaintenanceTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        enum SweepError: Error { case locked }
        await #expect(throws: SweepError.locked) {
            try await AppLaunchMaintenance.run(
                defaults: defaults, buildVersion: "1",
                hasPersistedForecastState: { false },
                sweepCredentials: { throw SweepError.locked },
                clearSessionCookie: {},
                reloadControls: { Issue.record("Must not launch after failed credential sweep") }
            )
        }
        #expect(!defaults.bool(forKey: AppLaunchMaintenance.credentialSweepKey))
        try await AppLaunchMaintenance.run(
            defaults: defaults, buildVersion: "1",
            hasPersistedForecastState: { false },
            sweepCredentials: {}, clearSessionCookie: {}, reloadControls: {}
        )
        #expect(defaults.bool(forKey: AppLaunchMaintenance.credentialSweepKey))
    }
}
