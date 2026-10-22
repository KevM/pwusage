import Foundation

/// Installation markers live in the sandbox so deleting the app resets them.
@MainActor
enum AppLaunchMaintenance {
    static let credentialSweepKey = "installationCredentialSweepCompleted"
    static let controlBuildKey = "lastReloadedControlBuild"

    static func run(
        defaults: UserDefaults,
        buildVersion: String?,
        hasPersistedForecastState: @MainActor () throws -> Bool,
        sweepCredentials: @MainActor () async throws -> Void,
        reloadControls: @MainActor () -> Void
    ) async throws {
        if !defaults.bool(forKey: credentialSweepKey) {
            // The marker is also absent on an upgrade from an older app. Existing
            // sandbox metadata owns valid credentials, so migrate without deleting them.
            if try !hasPersistedForecastState() {
                try await sweepCredentials()
            }
            // Failed/locked keychain operations must be retried on the next launch.
            defaults.set(true, forKey: credentialSweepKey)
        }
        if let buildVersion, defaults.string(forKey: controlBuildKey) != buildVersion {
            reloadControls()
            defaults.set(buildVersion, forKey: controlBuildKey)
        }
    }
}
