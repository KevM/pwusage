import Foundation

extension SolarForecastStore {
    func refresh(accountScopeID: String, siteID: String, manual: Bool = false) async -> SolarForecastRefreshResult {
        do { try await loadIfNeeded() } catch { return .failed(.requestFailed) }
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        guard activeAccountScopeID == accountScopeID else { return .notConfigured }
        guard !mutatingScopes.contains(scope) else { return .cancelled }
        if let existing = inFlight[scope] { return await existing.task.value }
        guard let credential = state.credentials[scope], credential.resourceIDs.count > 0 else { return .notConfigured }
        if !manual,
           let batch = state.caches[scope], batch.credentialID == credential.credentialID,
           clock.now().timeIntervalSince(batch.fetchedAt).isFinite,
           clock.now().timeIntervalSince(batch.fetchedAt) >= 0,
           clock.now().timeIntervalSince(batch.fetchedAt) < Self.foregroundRefreshThreshold {
            // Fresh in memory, but possibly not on disk. Returning .alreadyFresh here
            // would leave the pending write unattempted for the whole freshness window,
            // so the note promising a retry would be a promise nothing keeps. Retry
            // first: it is a file write only, charged to no request budget and making no
            // Solcast call, and it cannot loop -- a failed retry returns .saveFailed
            // without refetching, so the cache does not get re-stamped.
            if dirtyScopes.contains(scope) {
                return await retryPendingWrite(scope: scope) ? .refreshed : .failed(.saveFailed)
            }
            return .alreadyFresh
        }
        if let credentialID = state.budgetLinks[scope],
           normalizedBudget(state.budgets[credentialID], at: clock.now()).deferredUntil.map({ $0 > clock.now() }) == true {
            return .deferred
        }
        let generation = generations[scope] ?? 0
        let refreshID = UUID()
        let task = Task { await self.performRefresh(scope: scope, credential: credential, generation: generation, manual: manual) }
        inFlight[scope] = InFlightRefresh(id: refreshID, task: task)
        let result = await task.value
        if inFlight[scope]?.id == refreshID { inFlight.removeValue(forKey: scope) }
        return result
    }

    func performRefresh(scope: String, credential: SolarForecastCredential, generation: Int, manual: Bool) async -> SolarForecastRefreshResult {
        guard let storedKey = try? await keychain.load(accountScopeID: credential.accountScopeID, siteID: credential.siteID),
              storedKey.credentialID == credential.credentialID,
              Self.credentialID(for: storedKey.key) == credential.credentialID else {
            let outcome = await persistFailureState(scope: scope, credential: credential, description: "Forecast credential is unavailable")
            switch outcome {
            case .persisted: return .notConfigured
            case .quarantined: return .failed(.storageFailure)
            case .cleanupFailed: return .failed(.cleanupFailure)
            }
        }
        guard (generations[scope] ?? 0) == generation, activeAccountScopeID == credential.accountScopeID,
              state.credentials[scope]?.credentialID == credential.credentialID else { return .cancelled }
        let requestCount = credential.resourceIDs.count
        guard reserveRequests(requestCount, credentialID: credential.credentialID, manual: manual) else {
            let outcome = await persistRefusal(scope: scope, credential: credential, description: "Forecast request budget is exhausted")
            return Self.refreshResult(for: outcome, ordinaryResult: .budgetExhausted)
        }
        do { try await persist() } catch {
            // A disk failure is not a forecast failure, and the forecast has not
            // been fetched yet, so there is nothing about this credential to
            // distrust. Escalating to `persistFailureState` would reach
            // `quarantineCredential`, whose own failing write deletes a key that
            // has just been proven to work. Same shape and same reasoning as the
            // budget save in `discoverSites` and the post-fetch save below.
            //
            // Reported as a save failure rather than a request failure, because
            // that is what it is: no Solcast request was made and the cached data
            // is untouched. Reporting `.requestFailed` here told the user "Solcast
            // could not be reached. Retry when you have a connection" — a network
            // remedy for a full disk.
            //
            // The scope is deliberately NOT marked failed. An earlier revision did,
            // on the argument that an unpersisted budget cannot be enforced across
            // a relaunch. That argument does not survive its own premise: the disk
            // that would have recorded the budget is the disk that just failed, so
            // `failedScopes` is not persisted either and the marking is
            // session-only. It therefore delivers none of the cross-relaunch
            // protection it was justified by, while `isRecommendationUsable` gates
            // on it — so it hid a perfectly good forecast for the rest of the
            // session over a disk error. Same self-defeating shape D4 identified for
            // the post-fetch save: the data is fine, only the counter failed to
            // write, and `failedScopes` cannot say that.
            dirtyScopes.insert(scope)
            lastErrorDescription = "Forecast request budget could not be saved"
            return .failed(.saveFailed)
        }
        guard (generations[scope] ?? 0) == generation, activeAccountScopeID == credential.accountScopeID,
              state.credentials[scope]?.credentialID == credential.credentialID else {
            // Invalidated while the reservation was being saved: nothing was sent.
            await refundCancelledRequests(requestCount, credentialID: credential.credentialID, manual: manual, scope: scope)
            return .cancelled
        }
        let client = SolcastClient(apiKey: storedKey.key, transport: transport)
        let intervals: [SolarForecastInterval]
        var arrays: [[SolcastForecastPoint]] = []
        do {
            for resourceID in credential.resourceIDs {
                try Task.checkCancellation()
                arrays.append(try await client.fetchForecast(resourceID: resourceID))
            }
            try Task.checkCancellation()
            guard (generations[scope] ?? 0) == generation, activeAccountScopeID == credential.accountScopeID,
                  state.credentials[scope]?.credentialID == credential.credentialID else { return .cancelled }
            intervals = try SolarForecast.combine(arrays)
        } catch is CancellationError {
            // Checked first: cancellation is not a Solcast failure, so it records no
            // failure description and charges only the requests that completed.
            await refundCancelledRequests(requestCount - arrays.count, credentialID: credential.credentialID, manual: manual, scope: scope)
            return .cancelled
        } catch let error as SolcastClientError {
            guard (generations[scope] ?? 0) == generation, activeAccountScopeID == credential.accountScopeID else { return .cancelled }
            recordRateLimit(error, credentialID: credential.credentialID)
            guard Self.disablesCachedForecast(error) else {
                let outcome = await persistRefusal(scope: scope, credential: credential, description: Self.safeDescription(error))
                return Self.refreshResult(for: outcome, ordinaryResult: Self.refreshFailure(error))
            }
            let outcome = await persistFailureState(scope: scope, credential: credential, description: Self.safeDescription(error))
            return outcome == .persisted ? Self.refreshFailure(error) : Self.refreshResult(for: outcome, ordinaryResult: Self.refreshFailure(error))
        } catch {
            guard (generations[scope] ?? 0) == generation, activeAccountScopeID == credential.accountScopeID else { return .cancelled }
            // A new response that can't be combined says nothing against the forecast already saved.
            let outcome = await persistRefusal(scope: scope, credential: credential, description: "Forecast request failed")
            let failure: SolarForecastRefreshFailure = (error as? SolarForecastError) == nil ? .requestFailed : .invalidForecast
            return Self.refreshResult(for: outcome, ordinaryResult: .failed(failure))
        }

        state.caches[scope] = SolarForecastBatch(credentialID: credential.credentialID, resourceIDs: credential.resourceIDs, intervals: intervals, fetchedAt: clock.now())
        state.failedScopes.remove(scope)
        lastErrorDescription = nil
        do {
            try await persist()
        } catch {
            // A disk failure is not a forecast failure. The intervals above are
            // good and the credential is untouched, so the cache is kept in memory
            // and the scope is deliberately NOT marked failed — isRecommendationUsable
            // gates on failedScopes, so marking it would hide the data we just
            // fetched. Never quarantine here: the write is retried (see dirtyScopes),
            // and destroying a working key over a full disk loses the user's setup.
            dirtyScopes.insert(scope)
            lastErrorDescription = "Forecast could not be saved to this device"
            return .failed(.saveFailed)
        }
        dirtyScopes.remove(scope)
        return .refreshed
    }

    /// A request that was refused or failed (budget, rate limit, network, server,
    /// an unreadable response) says nothing against the forecast already saved,
    /// so it stays usable until it ages out. Only the description and the budget
    /// are recorded. If that record can't be saved, a relaunch could spend
    /// requests the budget or a rate limit has refused, so this falls back to
    /// `persistFailureState` exactly as before.
    func credentialHasMatchingKey(_ credential: SolarForecastCredential) async -> Bool {
        do {
            guard let stored = try await keychain.load(accountScopeID: credential.accountScopeID, siteID: credential.siteID),
                  stored.credentialID == credential.credentialID,
                  Self.credentialID(for: stored.key) == credential.credentialID else {
                state.failedScopes.insert(SolarForecastScope.key(credential.accountScopeID, credential.siteID))
                return false
            }
            return true
        } catch {
            state.failedScopes.insert(SolarForecastScope.key(credential.accountScopeID, credential.siteID))
            return false
        }
    }
}
