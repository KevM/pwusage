import Foundation

extension SolarForecastStore {
    func connect(apiKey: String, accountScopeID: String, siteID: String, resourceIDs: [String]? = nil) async throws -> String {
        try await loadIfNeeded()
        guard !apiKey.isEmpty, !accountScopeID.isEmpty, !siteID.isEmpty else { throw StoreError.invalidConfiguration }
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        let previousState = state
        let previousCredential = state.credentials[scope]
        let credentialID = Self.credentialID(for: apiKey)
        let selectedResources = resourceIDs
            ?? (previousCredential?.credentialID == credentialID ? previousCredential?.resourceIDs ?? [] : [])
        guard (0 ... 2).contains(selectedResources.count), Set(selectedResources).count == selectedResources.count,
              selectedResources.allSatisfy({ !$0.isEmpty }) else { throw StoreError.invalidConfiguration }
        activateAccountScope(accountScopeID)
        try beginMutation(scope: scope)
        defer { endMutation(scope: scope) }
        let previousKey = try await keychain.load(accountScopeID: accountScopeID, siteID: siteID)
        let credential = SolarForecastCredential(accountScopeID: accountScopeID, siteID: siteID, credentialID: credentialID, resourceIDs: selectedResources)
        try await keychain.save(key: apiKey, accountScopeID: accountScopeID, siteID: siteID, credentialID: credentialID)
        var nextState = previousState
        if previousCredential?.credentialID != credentialID || previousCredential?.resourceIDs != selectedResources {
            nextState.caches.removeValue(forKey: scope)
        }
        nextState.credentials[scope] = credential
        nextState.budgetLinks[scope] = credentialID
        do {
            try await files.saveState(nextState)
        } catch {
            do {
                if let previousKey {
                    try await keychain.save(key: previousKey.key, accountScopeID: accountScopeID, siteID: siteID, credentialID: previousKey.credentialID)
                } else {
                    try await keychain.delete(accountScopeID: accountScopeID, siteID: siteID)
                }
            } catch {
                state = previousState
                state.credentials.removeValue(forKey: scope)
                state.caches.removeValue(forKey: scope)
                state.budgetLinks.removeValue(forKey: scope)
                state.failedScopes.insert(scope)
                lastErrorDescription = "Forecast credential could not be safely saved"
                try? await persist()
                throw StoreError.cleanupFailed
            }
            state = previousState
            throw StoreError.persistenceFailed
        }
        state = nextState
        // `connect` replaces the whole state for this scope, so anything this scope
        // had pending is either now on disk or gone with the old state.
        dirtyScopes.remove(scope)
        return credentialID
    }

    func disconnect(accountScopeID: String, siteID: String) async throws {
        try await loadIfNeeded()
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        try beginMutation(scope: scope)
        defer { endMutation(scope: scope) }
        do {
            try await keychain.delete(accountScopeID: accountScopeID, siteID: siteID)
        } catch {
            lastErrorDescription = "Forecast credential could not be removed"
            throw StoreError.cleanupFailed
        }
        state.credentials.removeValue(forKey: scope)
        state.caches.removeValue(forKey: scope)
        state.budgetLinks.removeValue(forKey: scope)
        state.failedScopes.remove(scope)
        dirtyScopes.remove(scope)
        lastErrorDescription = nil
        if activeAccountScopeID == accountScopeID,
           !state.credentials.values.contains(where: { $0.accountScopeID == accountScopeID }) {
            activeAccountScopeID = nil
        }
        do { try await persist() } catch { throw StoreError.cleanupFailed }
    }

    func signOut() async throws {
        do { try await loadIfNeeded() } catch { loaded = true }
        let scopes = Set(Array(state.credentials.keys) + Array(state.caches.keys) + Array(inFlight.keys) + Array(generations.keys))
        for scope in scopes {
            generations[scope, default: 0] += 1
            inFlight[scope]?.task.cancel()
            inFlight.removeValue(forKey: scope)
        }
        activeAccountScopeID = nil
        state.credentials.removeAll()
        state.caches.removeAll()
        state.budgetLinks.removeAll()
        state.failedScopes.removeAll()
        dirtyScopes.removeAll()
        lastErrorDescription = nil
        var failed = false
        do { try await persist() } catch { failed = true }
        do { try await keychain.deleteAllCredentials() } catch { failed = true }
        if failed { throw StoreError.cleanupFailed }
    }

    func invalidateRefresh(scope: String) {
        generations[scope, default: 0] += 1
        inFlight[scope]?.task.cancel()
        inFlight.removeValue(forKey: scope)
    }

    func beginMutation(scope: String) throws {
        guard mutatingScopes.insert(scope).inserted else { throw StoreError.cancelled }
        invalidateRefresh(scope: scope)
    }

    func endMutation(scope: String) {
        mutatingScopes.remove(scope)
    }

    func removeRejectedCredential(_ credential: SolarForecastCredential, scope: String) async -> Bool {
        do {
            try await keychain.delete(accountScopeID: credential.accountScopeID, siteID: credential.siteID)
        } catch {
            lastErrorDescription = "Rejected forecast credential could not be removed"
            return false
        }
        var nextState = state
        nextState.credentials.removeValue(forKey: scope)
        nextState.caches.removeValue(forKey: scope)
        nextState.budgetLinks.removeValue(forKey: scope)
        nextState.failedScopes.remove(scope)
        dirtyScopes.remove(scope)
        do {
            try await files.saveState(nextState)
        } catch {
            lastErrorDescription = "Rejected forecast credential cleanup could not be saved"
            return false
        }
        state = nextState
        if activeAccountScopeID == credential.accountScopeID,
           !state.credentials.values.contains(where: { $0.accountScopeID == credential.accountScopeID }) {
            activeAccountScopeID = nil
        }
        lastErrorDescription = "Forecast service rejected the credential"
        return true
    }
}
