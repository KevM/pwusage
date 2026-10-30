import Foundation

protocol SolarForecastBackgroundEligibility: Sendable {
    func allowsAutomaticBackgroundRefresh(accountScopeID: String, siteID: String) async -> Bool
}

extension SolarForecastStore: SolarForecastBackgroundEligibility {
    /// Failure to read protected Solcast metadata is not evidence of no credential.
    /// A cold locked launch skips refresh until that metadata has been read unlocked.
    /// This intentionally never asks Keychain to validate or expose a saved key.
    func allowsAutomaticBackgroundRefresh(accountScopeID: String, siteID: String) async -> Bool {
        do { try await loadIfNeeded() } catch { return false }
        return state.credentials[SolarForecastScope.key(accountScopeID, siteID)] == nil
    }
}
