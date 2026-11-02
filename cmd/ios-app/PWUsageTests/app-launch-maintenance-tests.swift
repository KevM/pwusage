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
                sweepLegacySolcast: { sweeps += 1 },
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

    /// The demo lives in memory, but a session killed mid-demo never reaches
    /// Exit Demo, so its suite and temporary files would outlive the relaunch.
    @Test("Every launch clears what a killed demo left behind")
    func clearsDemoLeftovers() async throws {
        let suite = "AppLaunchMaintenanceTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var demoClears = 0
        for _ in 0 ..< 2 {
            try await AppLaunchMaintenance.run(
                defaults: defaults, buildVersion: "1",
                sweepLegacySolcast: {},
                clearSessionCookie: {},
                reloadControls: {},
                clearDemo: { demoClears += 1 }
            )
        }
        #expect(demoClears == 2)
    }

    @Test("An existing installation runs the legacy sweep once")
    func upgradeRunsLegacySweep() async throws {
        let suite = "AppLaunchMaintenanceTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: AppLaunchMaintenance.credentialSweepKey)
        var sweeps = 0
        var cookieClears = 0
        func launch() async throws {
            try await AppLaunchMaintenance.run(
                defaults: defaults, buildVersion: "2",
                sweepLegacySolcast: { sweeps += 1 },
                clearSessionCookie: { cookieClears += 1 },
                reloadControls: {}
            )
        }
        try await launch()
        #expect(sweeps == 1)
        #expect(cookieClears == 0)
        #expect(defaults.bool(forKey: AppLaunchMaintenance.solcastSweepKey))
        try await launch()
        #expect(sweeps == 1)
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
                sweepLegacySolcast: { throw SweepError.locked },
                clearSessionCookie: {},
                reloadControls: { Issue.record("Must not launch after failed credential sweep") }
            )
        }
        #expect(!defaults.bool(forKey: AppLaunchMaintenance.credentialSweepKey))
        try await AppLaunchMaintenance.run(
            defaults: defaults, buildVersion: "1",
            sweepLegacySolcast: {}, clearSessionCookie: {}, reloadControls: {}
        )
        #expect(defaults.bool(forKey: AppLaunchMaintenance.credentialSweepKey))
    }
}
