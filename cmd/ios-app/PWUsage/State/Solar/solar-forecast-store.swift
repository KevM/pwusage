import CryptoKit
import Foundation

actor SolarForecastStore {
    static let shared = SolarForecastStore()
    static let foregroundRefreshThreshold: TimeInterval = 3 * 60 * 60
    static let recommendationFreshness: TimeInterval = 6 * 60 * 60
    static let automaticAttemptsPerUTCDay = 8
    static let totalAttemptsPerUTCDay = 10

    let clock: any SolarForecastClock
    let keychain: any SolcastCredentialKeychain
    let files: any SolarForecastPersistence
    let transport: (any SolcastTransport)?
    var state: SolarForecastPersistedState
    var loaded = false
    var generations: [String: Int] = [:]
    struct InFlightRefresh {
        let id: UUID
        let task: Task<SolarForecastRefreshResult, Never>
    }

    var inFlight: [String: InFlightRefresh] = [:]
    var mutatingScopes: Set<String> = []
    /// Scopes whose in-memory state is newer than what is on disk because the last
    /// write failed. The batch is good and the credential is intact, so the scope is
    /// deliberately not quarantined -- but the write still has to happen, and
    /// `performRefresh` is the only code that performs it. Without this set the
    /// `.alreadyFresh` short-circuit below would return early for three hours and the
    /// pending write would never be attempted again.
    var dirtyScopes: Set<String> = []
    var activeAccountScopeID: String?
    internal(set) var lastErrorDescription: String?

    init(
        clock: any SolarForecastClock = SystemSolarForecastClock(),
        keychain: any SolcastCredentialKeychain = DeviceSolcastCredentialStore.shared,
        files: (any SolarForecastPersistence)? = nil,
        transport: (any SolcastTransport)? = nil
    ) {
        self.clock = clock
        self.keychain = keychain
        self.files = files ?? DeviceSolarForecastPersistence()
        self.transport = transport
        state = SolarForecastPersistedState()
    }

    @discardableResult
    func credential(accountScopeID: String, siteID: String) async -> SolarForecastCredential? {
        try? await loadIfNeeded()
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        guard let credential = state.credentials[scope], await credentialHasMatchingKey(credential) else { return nil }
        return credential
    }

    func activateAccountScope(_ accountScopeID: String?) {
        guard accountScopeID != activeAccountScopeID else { return }
        if let previousAccountID = activeAccountScopeID {
            let affectedScopes = state.credentials.compactMap { key, credential in
                credential.accountScopeID == previousAccountID ? key : nil
            }
            for scope in affectedScopes { generations[scope, default: 0] += 1 }
        }
        for scope in Array(inFlight.keys) {
            generations[scope, default: 0] += 1
            inFlight[scope]?.task.cancel()
        }
        inFlight.removeAll()
        activeAccountScopeID = accountScopeID
    }

    func cachedBatch(accountScopeID: String, siteID: String) async -> SolarForecastBatch? {
        try? await loadIfNeeded()
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        guard let credential = state.credentials[scope], await credentialHasMatchingKey(credential),
              state.caches[scope]?.credentialID == credential.credentialID,
              state.caches[scope]?.resourceIDs == credential.resourceIDs else { return nil }
        return state.caches[scope]
    }

    func isRecommendationUsable(accountScopeID: String, siteID: String) async -> Bool {
        do { try await loadIfNeeded() } catch { return false }
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        guard !state.failedScopes.contains(scope), let batch = await cachedBatch(accountScopeID: accountScopeID, siteID: siteID) else { return false }
        let age = clock.now().timeIntervalSince(batch.fetchedAt)
        return age.isFinite && age >= 0 && age <= Self.recommendationFreshness
    }

    func budget(for accountScopeID: String, siteID: String) async -> SolarForecastBudget {
        try? await loadIfNeeded()
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        guard let credentialID = state.budgetLinks[scope] else { return Self.emptyBudget(at: clock.now()) }
        return normalizedBudget(state.budgets[credentialID], at: clock.now())
    }
}
