import Combine
import Foundation

extension DashboardCoordinator {
    /// The forecast store's view of this site, for Smart Shift's "Copy
    /// diagnostics". It reads the store's cached batch rather than
    /// `solarForecastBatch`, which is cleared whenever the card can't use it.
    func solarForecastDiagnostics() async -> SmartShiftDiagnostics.SolarForecast? {
        guard let forecastStore, let accountScopeID else { return nil }
        let siteID = selectedSiteID
        // An automatic forecast has its own rolling-hour budget; the Solcast daily one says nothing about it.
        let automatic = solarForecastPublication
        let legacy = !usesAutomaticSolarForecast
        let batch = automatic == nil && legacy
            ? await forecastStore.cachedBatch(accountScopeID: accountScopeID, siteID: siteID) : nil
        var diagnostics = SmartShiftDiagnostics.SolarForecast(
            batch: batch, now: now(),
            recommendationUsable: legacy
                ? await forecastStore.isRecommendationUsable(accountScopeID: accountScopeID, siteID: siteID)
                : automatic != nil,
            budget: automatic == nil && legacy ? await forecastStore.budget(for: accountScopeID, siteID: siteID) : nil,
            lastErrorDescription: legacy ? await forecastStore.lastErrorDescription : nil,
            lastRefresh: solarForecastLastRefresh, unavailableCause: solarForecastUnavailableCause,
            connection: solarForecastConnection, state: solarForecastState,
            unavailableReason: solarForecastUnavailableReason)
        diagnostics.automaticProviderID = legacy ? nil : solarForecastAttempt?.providerID?.rawValue
        diagnostics.automaticRefreshOutcome = legacy ? nil : solarForecastAttempt.map { "\($0.outcome)" }
        diagnostics.automaticDiagnostic = legacy ? nil : solarForecastAttempt?.diagnostic
        diagnostics.source = automatic.map { SmartShiftForecastSource(publication: $0, now: now()) }
        return diagnostics
    }

    func refreshSolarForecast(manual: Bool) async {
        guard canRequestAccountData else { return }
        let operation = beginForecastOperation()
        forecastOperationPending = true
        defer { if operation == forecastGeneration { forecastOperationPending = false } }
        guard forecastStore != nil, accountScopeID != nil else {
            solarForecastState = .basic
            return
        }
        let siteID = selectedSiteID
        let status = await solarLayoutLookup(siteID: siteID, operation: operation)
        guard operation == forecastGeneration, siteID == selectedSiteID, canRequestAccountData else { return }
        if runner != nil, status != .disabled {
            guard let planningAPI else {
                clearAutomaticPublication()
                return
            }
            await loadAutomaticForecast(
                siteID: siteID, api: planningAPI, operation: operation, status: status, manual: manual)
            return
        }
        await refreshLegacySolarForecast(manual: manual, siteID: siteID, operation: operation)
    }

    private func refreshLegacySolarForecast(manual: Bool, siteID: String, operation: Int) async {
        guard let forecastStore, let accountScopeID else { return }
        solarForecastPublication = nil
        solarForecastAttempt = nil
        solarForecastSource = nil
        guard let credential = await forecastStore.credential(accountScopeID: accountScopeID, siteID: siteID) else {
            guard operation == forecastGeneration, siteID == selectedSiteID else { return }
            resetForecastEnhancement(state: .basic, connection: .notConnected)
            return
        }
        guard operation == forecastGeneration, siteID == selectedSiteID, canRequestAccountData else { return }
        solarForecastConnection = credential.resourceIDs.isEmpty ? .awaitingArraySelection : .ready
        solarForecastState = .loadingWithBasic
        let refresh = await forecastStore.refresh(accountScopeID: accountScopeID, siteID: siteID, manual: manual)
        guard operation == forecastGeneration, siteID == selectedSiteID, canRequestAccountData else { return }
        solarForecastLastRefresh = refresh
        if loadPlanningContext == nil {
            solarForecastUnavailableCause = SolarForecastUnavailableCause(refresh)
            solarForecastBatch = nil
            if manual {
                // The missing half is our own household profile, not the
                // forecast, and this path is the only place a person can ask for
                // it. The note on screen tells them to pull down to refresh, so a
                // pull has to actually re-fetch the context. The appearance path
                // re-derives `solarForecastUnavailableReason`, so a `serverOutdated`
                // or `contextInvalid` diagnosis survives a repeat failure.
                await loadTimingDetailAppeared(surface: nil)
                return
            }
            solarForecastState = .failedWithBasic
            return
        }
        // A save failure is not an unavailable forecast: the batch is fresh and in
        // memory, so the enhancement stays up behind its own note rather than being
        // torn down behind a "Solar forecast unavailable" sentence.
        let saveFailed = refresh == .failed(.saveFailed)
        // As on the appearance path, a refused refresh leaves a still-usable forecast in place.
        guard await forecastStore.isRecommendationUsable(accountScopeID: accountScopeID, siteID: siteID),
              let batch = await forecastStore.cachedBatch(accountScopeID: accountScopeID, siteID: siteID) else {
            solarForecastUnavailableCause = SolarForecastUnavailableCause(refresh)
            solarForecastBatch = nil
            solarForecastState = .failedWithBasic
            solarForecastSaveFailure = false
            return
        }
        solarForecastBatch = batch
        solarForecastSource = .solcast
        solarForecastUnavailableCause = nil
        solarForecastState = .enhanced
        solarForecastSaveFailure = saveFailed
    }

    @discardableResult
    func connectSolarForecast(apiKey: String) async throws -> String {
        guard canRequestAccountData else { throw PWUsageAPIError.signInRequired }
        let operation = beginForecastOperation()
        guard let forecastStore, let accountScopeID else { throw SolarForecastStore.StoreError.invalidConfiguration }
        let siteID = selectedSiteID
        let credentialID = try await forecastStore.connect(
            apiKey: apiKey,
            accountScopeID: accountScopeID,
            siteID: siteID,
            resourceIDs: nil
        )
        if operation == forecastGeneration, siteID == selectedSiteID {
            resetForecastEnhancement(state: .basic, connection: .awaitingArraySelection)
        }
        return credentialID
    }

    func discoverSolarSites(manual: Bool = true) async throws -> [SolcastSite] {
        guard canRequestAccountData else { throw PWUsageAPIError.signInRequired }
        _ = beginForecastOperation()
        guard let forecastStore, let accountScopeID else { throw SolarForecastStore.StoreError.invalidConfiguration }
        return try await forecastStore.discoverSites(
            accountScopeID: accountScopeID,
            siteID: selectedSiteID,
            manual: manual
        )
    }

    func selectSolarArrays(_ resourceIDs: [String]) async throws {
        guard canRequestAccountData else { throw PWUsageAPIError.signInRequired }
        let operation = beginForecastOperation()
        guard let forecastStore, let accountScopeID else { throw SolarForecastStore.StoreError.invalidConfiguration }
        let siteID = selectedSiteID
        try await forecastStore.selectArrays(resourceIDs, accountScopeID: accountScopeID, siteID: siteID)
        if operation == forecastGeneration, siteID == selectedSiteID {
            resetForecastEnhancement(state: .basic, connection: .ready)
        }
    }

    func solarForecastCredential() async -> SolarForecastCredential? {
        guard let forecastStore, let accountScopeID else { return nil }
        return await forecastStore.credential(accountScopeID: accountScopeID, siteID: selectedSiteID)
    }

    func solarForecastBudget() async -> SolarForecastBudget? {
        guard let forecastStore, let accountScopeID else { return nil }
        return await forecastStore.budget(for: accountScopeID, siteID: selectedSiteID)
    }

    func disconnectSolarForecast() async throws {
        let operation = beginForecastOperation()
        guard let forecastStore, let accountScopeID else { throw SolarForecastStore.StoreError.invalidConfiguration }
        let siteID = selectedSiteID
        try await forecastStore.disconnect(accountScopeID: accountScopeID, siteID: siteID)
        guard operation == forecastGeneration, siteID == selectedSiteID else { return }
        resetForecastEnhancement(state: .disconnectedBasic, connection: .notConnected)
    }

    /// Settings text edits and profile comparisons are deliberately local.
    func solarForecastSettingsDidEdit() {}
    func loadProfileDidEdit() {}

    func beginForecastOperation() -> Int {
        forecastOperationPending = false
        forecastGeneration += 1
        return forecastGeneration
    }

    func resetForecastEnhancement(state: SolarForecastEnhancementState, connection: SolarForecastConnectionState) {
        solarForecastBatch = nil
        loadPlanningContext = nil
        solarForecastState = state
        solarForecastConnection = connection
        solarForecastUnavailableCause = nil
        solarForecastUnavailableReason = nil
        solarForecastSaveFailure = false
        solarForecastLastRefresh = nil
        solarForecastSource = nil
        solarForecastPublication = nil
        solarForecastAttempt = nil
    }
}
