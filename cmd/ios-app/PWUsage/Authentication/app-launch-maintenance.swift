import Foundation

/// Installation markers live in the sandbox so deleting the app resets them.
@MainActor
enum AppLaunchMaintenance {
    static let credentialSweepKey = "installationCredentialSweepCompleted"
    static let controlBuildKey = "lastReloadedControlBuild"

    static func run(
        defaults: UserDefaults,
        buildVersion: String?,
        sweepCredentials: @MainActor () async throws -> Void,
        reloadControls: @MainActor () -> Void
    ) async throws {
        if !defaults.bool(forKey: credentialSweepKey) {
            try await sweepCredentials()
            // Failed/locked keychain operations must be retried on the next launch.
            defaults.set(true, forKey: credentialSweepKey)
        }
        if let buildVersion, defaults.string(forKey: controlBuildKey) != buildVersion {
            reloadControls()
            defaults.set(buildVersion, forKey: controlBuildKey)
        }
    }

}
