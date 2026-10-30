import Foundation

/// Which provider a site uses. Automatic-only beta requests bypass credentials entirely.
/// For legacy requests, a credential provider wins, even
/// while it awaits arrays or fails; otherwise the configured automatic provider; otherwise
/// none, and the caller uses history. A failure never falls through to another provider.
struct SolarForecastSelectionPolicy: Sendable {
    let automaticProviderID: SolarForecastProviderID?
    /// Automatic providers are always corrected; credential providers only when the offline
    /// check showed it helps.
    var correctsCredentialProviders = SolarForecastCorrection.appliesToSolcast
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

    nonisolated var automaticDescriptor: SolarForecastProviderDescriptor? {
        policy.automaticProviderID.flatMap { descriptor(for: $0) }
    }

    nonisolated var correctsCredentialProviders: Bool { policy.correctsCredentialProviders }

    /// Refreshes the selected provider and publishes its batch if it is fresh enough and
    /// covers the request, corrected once when measured `actuals` are given. `nil` means use
    /// history. History always receives the raw batch.
    func publication(
        for request: SolarForecastRequest,
        actuals: [MobileSolarActualsHour]? = nil
    ) async -> SolarForecastPublication? {
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
        var intervals = batch.intervals
        var summary = SolarForecastCorrectionSummary.identity
        let corrects = provider.descriptor.requirement == .detectedLayout || policy.correctsCredentialProviders
        if let actuals, corrects {
            (intervals, summary) = await corrected(
                batch, identity: identity, siteTimeZone: request.siteTimeZone, actuals: actuals
            )
        }
        guard started == generation else { return nil }
        return SolarForecastPublication(
            descriptor: provider.descriptor, intervals: intervals, fetchedAt: batch.fetchedAt,
            coverage: batch.coverage, fingerprint: batch.fingerprint, configurationRevision: batch.cacheRevision,
            outcome: result.outcome, diagnostic: result.diagnostic, correction: summary
        )
    }

    /// Raw intervals scaled by factors trained on this identity's own raw history, separately
    /// per lead-time cohort. Never trains on corrected output.
    func corrected(
        _ batch: SolarForecastRawBatch,
        identity: SolarForecastHistoryIdentity,
        siteTimeZone: TimeZone,
        actuals: [MobileSolarActualsHour]
    ) async -> ([SolarForecastInterval], SolarForecastCorrectionSummary) {
        let now = clock.now()
        let from = now.addingTimeInterval(-SolarForecastHistory.retention)
        var factors: [SolarForecastTrainingCohort: SolarForecastCorrection] = [:]
        for cohort in SolarForecastTrainingCohort.allCases {
            let past = await history.pastForecast(
                identity: identity, cohort: cohort, from: from, to: now, siteTimeZone: siteTimeZone
            )
            factors[cohort] = SolarForecastCorrection.derive(
                pastForecastWh: past, actuals: actuals, siteTimeZone: siteTimeZone, now: now
            )
        }
        let cohorts = SolarForecastCohortCorrection(
            sameDay: factors[.sameDay] ?? .identity, dayAhead: factors[.dayAhead] ?? .identity
        )
        let summary = SolarForecastCorrectionSummary(
            sameDayFactors: cohorts.sameDay.hourFactors, dayAheadFactors: cohorts.dayAhead.hourFactors,
            sameDaySamples: cohorts.sameDay.samples, dayAheadSamples: cohorts.dayAhead.samples
        )
        let applied = cohorts.apply(
            to: batch.intervals, fetchedAt: batch.fetchedAt, siteTimeZone: siteTimeZone, acClipKw: batch.acClipKw
        )
        return (applied, summary)
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
        for provider in providers where !request.automaticOnly && provider.descriptor.requirement == .credential {
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
