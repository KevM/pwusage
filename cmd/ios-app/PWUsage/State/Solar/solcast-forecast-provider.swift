import Foundation

/// Solcast through the existing store, which keeps its own credentials, cache, coalescing and
/// daily budget. This adapter only translates.
struct SolcastForecastProvider: SolarForecastProviding {
    static let modelVersion = "solcast-1"
    let descriptor = SolarForecastProviderDescriptor(
        id: .solcast,
        displayName: "Solcast",
        attribution: "Forecast by Solcast.",
        requirement: .credential,
        providesCautiousPower: true,
        refreshThreshold: SolarForecastStore.foregroundRefreshThreshold,
        maximumUsableAge: SolarForecastStore.recommendationFreshness,
        modelVersion: SolcastForecastProvider.modelVersion
    )

    let store: any SolarForecastManaging

    /// Non-secret: the credential ID is a hash, and resources are sorted so a reordered
    /// selection keeps its history. Solcast intervals are instants, so the site timezone is
    /// applied at correction time and is not part of the identity.
    static func fingerprint(credentialID: String, resourceIDs: [String]) -> String {
        SolarForecastConfiguration.fingerprint(
            [SolarForecastProviderID.solcast.rawValue, modelVersion, credentialID] + resourceIDs.sorted()
        )
    }

    func configuration(for request: SolarForecastRequest) async -> SolarForecastConfiguration {
        guard let credential = await store.credential(
            accountScopeID: request.scope.accountScopeID, siteID: request.scope.siteID
        ) else {
            return SolarForecastConfiguration(readiness: .notConfigured, fingerprint: "", cacheRevision: "")
        }
        let fingerprint = Self.fingerprint(credentialID: credential.credentialID, resourceIDs: credential.resourceIDs)
        return SolarForecastConfiguration(
            readiness: credential.resourceIDs.isEmpty ? .setupRequired : .ready,
            fingerprint: fingerprint, cacheRevision: fingerprint
        )
    }

    func refresh(_ request: SolarForecastRequest) async -> SolarForecastProviderResult {
        let result = await store.refresh(
            accountScopeID: request.scope.accountScopeID, siteID: request.scope.siteID, manual: request.manual
        )
        return await SolarForecastProviderResult(
            batch: cachedForecast(for: request), outcome: Self.outcome(result),
            diagnostic: store.lastErrorDescription
        )
    }

    func cachedForecast(for request: SolarForecastRequest) async -> SolarForecastRawBatch? {
        let scope = request.scope
        guard await store.isRecommendationUsable(accountScopeID: scope.accountScopeID, siteID: scope.siteID),
              let batch = await store.cachedBatch(accountScopeID: scope.accountScopeID, siteID: scope.siteID) else {
            return nil
        }
        let fingerprint = Self.fingerprint(credentialID: batch.credentialID, resourceIDs: batch.resourceIDs)
        return SolarForecastRawBatch(
            providerID: descriptor.id, fingerprint: fingerprint, cacheRevision: fingerprint,
            intervals: batch.intervals, fetchedAt: batch.fetchedAt, acClipKw: nil
        )
    }

    func activateAccountScope(_ accountScopeID: String?) async {
        await store.activateAccountScope(accountScopeID)
    }

    /// The store is signed out by the existing session cleanup, which owns its keychain.
    func clearAccountData() async throws {}

    static func outcome(_ result: SolarForecastRefreshResult) -> SolarForecastRefreshOutcome {
        switch result {
        case .refreshed, .failed(.saveFailed): .refreshed
        case .alreadyFresh: .fresh
        case .deferred, .failed(.rateLimited): .deferred(until: nil)
        case .budgetExhausted: .budgetExhausted
        case .notConfigured: .setupRequired
        case .cancelled: .cancelled
        case .failed(.unauthorized): .failed(.access)
        case .failed(.requestFailed): .failed(.transient)
        case .failed(.unknownResource), .failed(.storageFailure), .failed(.cleanupFailure): .failed(.configuration)
        case .failed(.invalidForecast): .failed(.invalidResponse)
        }
    }
}
