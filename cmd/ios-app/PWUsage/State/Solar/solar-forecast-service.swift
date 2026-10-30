import Foundation

/// Which provider a site uses. A credential provider the user has set up always wins, even
/// while it awaits arrays or fails; otherwise the configured automatic provider; otherwise
/// none, and the caller uses history. A failure never falls through to another provider.
struct SolarForecastSelectionPolicy: Sendable {
    let automaticProviderID: SolarForecastProviderID?
}

/// The single place forecasts are selected, refreshed, recorded and published.
actor SolarForecastService {
    private let providers: [any SolarForecastProviding]
    private let policy: SolarForecastSelectionPolicy
    private let history: SolarForecastHistory
    private let clock: any SolarForecastClock
    private var generation = 0
    private var accountScopeID: String?

    init(
        providers: [any SolarForecastProviding],
        policy: SolarForecastSelectionPolicy,
        history: SolarForecastHistory,
        clock: any SolarForecastClock = SystemSolarForecastClock()
    ) {
        self.providers = providers
        self.policy = policy
        self.history = history
        self.clock = clock
    }

    nonisolated func descriptor(for id: SolarForecastProviderID) -> SolarForecastProviderDescriptor? {
        providers.first { $0.descriptor.id == id }?.descriptor
    }

    func selectedProviderID(for request: SolarForecastRequest) async -> SolarForecastProviderID? {
        await select(request)?.provider.descriptor.id
    }

    /// Refreshes the selected provider and publishes its batch if it is fresh enough and
    /// covers the request. `nil` means use history.
    func publication(for request: SolarForecastRequest) async -> SolarForecastPublication? {
        let started = generation
        guard let (provider, configuration) = await select(request), configuration.readiness == .ready else {
            return nil
        }
        let result = await provider.refresh(request)
        guard started == generation else { return nil }
        let candidate: SolarForecastRawBatch? = if let batch = result.batch { batch } else {
            await provider.cachedForecast(for: request)
        }
        guard started == generation, let batch = candidate,
              batch.fingerprint == configuration.fingerprint,
              batch.isUsable(for: request, descriptor: provider.descriptor, now: clock.now()) else { return nil }
        let identity = SolarForecastHistoryIdentity(
            accountScopeID: request.scope.accountScopeID, siteID: request.scope.siteID,
            providerID: batch.providerID, fingerprint: batch.fingerprint
        )
        await history.record(identity: identity, intervals: batch.intervals, fetchedAt: batch.fetchedAt)
        guard started == generation else { return nil }
        return SolarForecastPublication(
            descriptor: provider.descriptor, intervals: batch.intervals, fetchedAt: batch.fetchedAt,
            coverage: batch.coverage, fingerprint: batch.fingerprint, configurationRevision: batch.cacheRevision,
            outcome: result.outcome, diagnostic: result.diagnostic
        )
    }

    func activateAccountScope(_ accountScopeID: String?) async {
        if accountScopeID != self.accountScopeID { generation += 1 }
        self.accountScopeID = accountScopeID
        for provider in providers { await provider.activateAccountScope(accountScopeID) }
    }

    /// Fences in-flight work, then clears every provider's account data and history.
    /// Every step runs; the first error is rethrown.
    func clearAccountData() async throws {
        generation += 1
        var firstError: (any Error)?
        for provider in providers {
            do { try await provider.clearAccountData() } catch { firstError = firstError ?? error }
        }
        do { try await history.clearAccountData() } catch { firstError = firstError ?? error }
        if let firstError { throw firstError }
    }

    private func select(
        _ request: SolarForecastRequest
    ) async -> (provider: any SolarForecastProviding, configuration: SolarForecastConfiguration)? {
        for provider in providers where provider.descriptor.requirement == .credential {
            let configuration = await provider.configuration(for: request)
            if configuration.readiness != .notConfigured { return (provider, configuration) }
        }
        guard let automatic = providers.first(where: { $0.descriptor.id == policy.automaticProviderID }) else {
            return nil
        }
        let configuration = await automatic.configuration(for: request)
        return configuration.readiness == .ready ? (automatic, configuration) : nil
    }
}
