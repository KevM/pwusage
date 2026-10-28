import Foundation

extension SolarForecastStore {
    func discoverSites(accountScopeID: String, siteID: String, manual: Bool = false) async throws -> [SolcastSite] {
        try await loadIfNeeded()
        guard activeAccountScopeID == accountScopeID else { throw StoreError.notConfigured }
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        guard let credential = state.credentials[scope],
              let storedKey = try await keychain.load(accountScopeID: accountScopeID, siteID: siteID),
              credential.credentialID == storedKey.credentialID,
              Self.credentialID(for: storedKey.key) == credential.credentialID else { throw StoreError.notConfigured }
        let generation = generations[scope] ?? 0
        if let deferredUntil = normalizedBudget(state.budgets[credential.credentialID], at: clock.now()).deferredUntil,
           deferredUntil > clock.now() { throw StoreError.deferred }
        guard reserveRequests(1, credentialID: credential.credentialID, manual: manual) else {
            let outcome = await persistRefusal(scope: scope, credential: credential, description: "Forecast request budget is exhausted")
            throw Self.discoveryError(for: outcome, ordinaryError: .budgetExhausted)
        }
        do { try await persist() } catch {
            // A disk failure is not a forecast failure, and it is emphatically not
            // a bad credential: discovery has not run yet, and the key in the
            // Keychain is the one the user just typed. Escalating to
            // `persistFailureState` would reach `quarantineCredential`, whose
            // second failing write deletes that key — on the *first-run* path, where
            // the user has no other copy of it. That is the same defect class §5.5
            // fixed on the post-fetch persist, so it gets the same shape: describe
            // it and stop.
            //
            // Not marked failed, for the same reason and with the same reasoning as
            // the matching save in `performRefresh`: the marking would be
            // session-only, would deliver none of the cross-relaunch protection it
            // was justified by, and would hide a working forecast.
            dirtyScopes.insert(scope)
            lastErrorDescription = "Forecast request budget could not be saved"
            throw StoreError.persistenceFailed
        }
        guard (generations[scope] ?? 0) == generation, activeAccountScopeID == accountScopeID,
              state.credentials[scope]?.credentialID == credential.credentialID else {
            // Invalidated while the reservation was being saved: nothing was sent.
            await refundCancelledRequests(1, credentialID: credential.credentialID, manual: manual, scope: scope)
            throw StoreError.cancelled
        }
        do {
            let sites = try await SolcastClient(apiKey: storedKey.key, transport: transport).discoverSites()
            guard (generations[scope] ?? 0) == generation, activeAccountScopeID == accountScopeID,
                  state.credentials[scope]?.credentialID == credential.credentialID else { throw StoreError.cancelled }
            return sites
        } catch is CancellationError {
            await refundCancelledRequests(1, credentialID: credential.credentialID, manual: manual, scope: scope)
            throw StoreError.cancelled
        } catch let error as SolcastClientError {
            guard (generations[scope] ?? 0) == generation, activeAccountScopeID == accountScopeID else { throw StoreError.cancelled }
            recordRateLimit(error, credentialID: credential.credentialID)
            if Self.failureKind(error) == .unauthorized {
                try beginMutation(scope: scope)
                defer { endMutation(scope: scope) }
                guard await removeRejectedCredential(credential, scope: scope) else { throw StoreError.cleanupFailed }
                throw StoreError.discoveryFailed(.unauthorized)
            }
            if Self.disablesCachedForecast(error) {
                let outcome = await persistFailureState(scope: scope, credential: credential, description: Self.safeDescription(error))
                guard outcome == .persisted else { throw Self.discoveryError(for: outcome, ordinaryError: .persistenceFailed) }
            } else {
                let outcome = await persistRefusal(scope: scope, credential: credential, description: Self.safeDescription(error))
                guard outcome == .persisted else { throw Self.discoveryError(for: outcome, ordinaryError: .persistenceFailed) }
            }
            throw StoreError.discoveryFailed(Self.failureKind(error))
        } catch {
            guard (generations[scope] ?? 0) == generation, activeAccountScopeID == accountScopeID else { throw StoreError.cancelled }
            let outcome = await persistRefusal(scope: scope, credential: credential, description: "Forecast request failed")
            guard outcome == .persisted else { throw Self.discoveryError(for: outcome, ordinaryError: .persistenceFailed) }
            throw StoreError.discoveryFailed(.requestFailed)
        }
    }

    func selectArrays(_ resourceIDs: [String], accountScopeID: String, siteID: String) async throws {
        try await loadIfNeeded()
        guard activeAccountScopeID == accountScopeID,
              (1 ... 2).contains(resourceIDs.count), Set(resourceIDs).count == resourceIDs.count,
              resourceIDs.allSatisfy({ !$0.isEmpty }) else { throw StoreError.invalidConfiguration }
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        guard let currentCredential = state.credentials[scope] else { throw StoreError.notConfigured }
        try beginMutation(scope: scope)
        defer { endMutation(scope: scope) }
        guard await credentialHasMatchingKey(currentCredential) else { throw StoreError.notConfigured }
        var nextState = state
        nextState.credentials[scope] = SolarForecastCredential(accountScopeID: accountScopeID, siteID: siteID, credentialID: currentCredential.credentialID, resourceIDs: resourceIDs)
        nextState.caches.removeValue(forKey: scope)
        do { try await files.saveState(nextState) } catch { throw StoreError.persistenceFailed }
        dirtyScopes.remove(scope)
        state = nextState
    }
}
