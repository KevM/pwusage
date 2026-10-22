import Foundation
import Testing
@testable import PWUsage

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
        func launch(_ build: String?) async throws {
            try await AppLaunchMaintenance.run(
                defaults: defaults, buildVersion: build,
                sweepCredentials: { sweeps += 1 }, reloadControls: { reloads += 1 }
            )
        }

        try await launch("1")
        #expect(sweeps == 1)
        #expect(reloads == 1)
        try await launch("1")
        #expect(sweeps == 1)
        #expect(reloads == 1)
        try await launch("2")
        #expect(sweeps == 1)
        #expect(reloads == 2)
        try await launch(nil)
        #expect(reloads == 2)
        #expect(defaults.string(forKey: "controlSite") == "saved-site")

        // A reinstall removes sandbox defaults while Keychain items may remain.
        defaults.removePersistentDomain(forName: suite)
        try await launch("2")
        #expect(sweeps == 2)
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
                sweepCredentials: { throw SweepError.locked },
                reloadControls: { Issue.record("Must not launch after failed credential sweep") }
            )
        }
        #expect(!defaults.bool(forKey: AppLaunchMaintenance.credentialSweepKey))
        try await AppLaunchMaintenance.run(
            defaults: defaults, buildVersion: "1",
            sweepCredentials: {}, reloadControls: {}
        )
        #expect(defaults.bool(forKey: AppLaunchMaintenance.credentialSweepKey))
    }
}
