import Foundation

extension SolarForecastStore {
    func persistRefusal(scope: String, credential: SolarForecastCredential,
                        description: String) async -> FailurePersistenceOutcome {
        lastErrorDescription = description
        do {
            try await persist()
            return .persisted
        } catch {
            state.failedScopes.insert(scope)
            return await quarantineAfterFailedSave(credential)
        }
    }

    /// Problems with the key or the selected arrays: the saved forecast can no
    /// longer be trusted to belong to this setup, so it is disabled.
    static func disablesCachedForecast(_ error: SolcastClientError) -> Bool {
        switch failureKind(error) {
        case .unauthorized, .unknownResource: true
        default: error == .invalidResourceID
        }
    }

    func persistFailureState(scope: String, credential: SolarForecastCredential, description: String) async -> FailurePersistenceOutcome {
        state.failedScopes.insert(scope)
        lastErrorDescription = description
        do {
            try await persist()
            return .persisted
        } catch {
            return await quarantineAfterFailedSave(credential)
        }
    }

    /// A failure record that can't be saved can't be enforced after a relaunch,
    /// so the credential is quarantined rather than trusted.
    func quarantineAfterFailedSave(_ credential: SolarForecastCredential) async -> FailurePersistenceOutcome {
        guard await quarantineCredential(accountScopeID: credential.accountScopeID, siteID: credential.siteID) else {
            lastErrorDescription = "Forecast data could not be safely disabled"
            return .cleanupFailed
        }
        lastErrorDescription = "Forecast data was disabled because it could not be saved"
        return .quarantined
    }

    func quarantineCredential(accountScopeID: String, siteID: String) async -> Bool {
        do {
            try await keychain.delete(accountScopeID: accountScopeID, siteID: siteID)
            return true
        } catch {
            do {
                guard let stored = try await keychain.load(accountScopeID: accountScopeID, siteID: siteID) else { return true }
                try await keychain.save(
                    key: stored.key,
                    accountScopeID: accountScopeID,
                    siteID: siteID,
                    credentialID: Self.quarantinedCredentialID
                )
                return true
            } catch {
                return false
            }
        }
    }

    static let quarantinedCredentialID = "credential-quarantined"

    enum FailurePersistenceOutcome: Equatable {
        case persisted
        case quarantined
        case cleanupFailed
    }

    static func refreshResult(for outcome: FailurePersistenceOutcome, ordinaryResult: SolarForecastRefreshResult) -> SolarForecastRefreshResult {
        switch outcome {
        case .persisted: ordinaryResult
        case .quarantined: .failed(.storageFailure)
        case .cleanupFailed: .failed(.cleanupFailure)
        }
    }

    static func discoveryError(for outcome: FailurePersistenceOutcome, ordinaryError: StoreError) -> StoreError {
        switch outcome {
        case .persisted: ordinaryError
        case .quarantined: .persistenceFailed
        case .cleanupFailed: .cleanupFailed
        }
    }

    func loadIfNeeded() async throws {
        guard !loaded else { return }
        state = try await files.loadState()
        loaded = true
    }

    func persist() async throws { try await files.saveState(state) }

    /// Re-attempts the write left pending by a failed persist. Returns whether the
    /// state on disk now matches memory. Deliberately does not escalate on failure:
    /// the fault is still the filesystem's, and the credential has done nothing wrong.
    ///
    /// The caller reports a successful retry as `.refreshed` even though no request
    /// was made, because the caller's contract is "did the on-disk state catch up",
    /// not "did a forecast arrive". Both call sites test that result in the same
    /// `||` as `.alreadyFresh`, and `SolarForecastUnavailableCause` maps both to
    /// `nil`, so nothing downstream can tell the difference. Clearing the stale
    /// `lastErrorDescription` here is deliberate: the condition it describes is
    /// gone, and leaving it would make the store report a fault that no longer
    /// exists.
    func retryPendingWrite(scope: String) async -> Bool {
        do {
            try await persist()
            dirtyScopes.remove(scope)
            lastErrorDescription = nil
            return true
        } catch {
            return false
        }
    }

    enum StoreError: Error, Equatable { case invalidConfiguration, notConfigured, budgetExhausted, deferred, requestFailed, discoveryFailed(SolarForecastRefreshFailure), persistenceFailed, cleanupFailed, cancelled }
}
