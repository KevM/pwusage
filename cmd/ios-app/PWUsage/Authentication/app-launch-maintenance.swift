import Foundation
import Security

/// Installation markers live in the sandbox so deleting the app resets them.
@MainActor
enum AppLaunchMaintenance {
    static let credentialSweepKey = "installationCredentialSweepCompleted"
    static let solcastSweepKey = "legacySolcastSweepCompleted"
    static let controlBuildKey = "lastReloadedControlBuild"

    static func run(
        defaults: UserDefaults,
        buildVersion: String?,
        sweepLegacySolcast: @MainActor () async throws -> Void = { try await Self.sweepLegacySolcast() },
        clearSessionCookie: @MainActor () -> Void,
        reloadControls: @MainActor () -> Void,
        clearDemo: @MainActor () -> Void = {}
    ) async throws {
        // The demo is never persisted, but one killed mid-session never reached
        // Exit Demo and left its defaults suite and temporary files behind.
        clearDemo()
        if !defaults.bool(forKey: credentialSweepKey) {
            clearSessionCookie()
            try await sweepLegacySolcast()
            defaults.set(true, forKey: credentialSweepKey)
            defaults.set(true, forKey: solcastSweepKey)
        } else if !defaults.bool(forKey: solcastSweepKey) {
            try await sweepLegacySolcast()
            defaults.set(true, forKey: solcastSweepKey)
        }
        if let buildVersion, defaults.string(forKey: controlBuildKey) != buildVersion {
            reloadControls()
            defaults.set(buildVersion, forKey: controlBuildKey)
        }
    }

    /// One-time sweep to delete legacy Solcast Keychain items and obsolete solar forecast state files.
    static func sweepLegacySolcast(
        service: String = Bundle.main.bundleIdentifier ?? "fm.rodeo.pwusage",
        fileManager: FileManager = .default
    ) async throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.status(status)
        }

        if let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            let directory = appSupport.appendingPathComponent("SolarForecast", isDirectory: true)
            try? fileManager.removeItem(at: directory)
        }
    }

    enum KeychainError: Error { case status(OSStatus) }
}
