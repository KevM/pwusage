import Foundation
import PWUsageCore

extension DashboardCoordinator {
    /// Load rate plan timeline only while this coordinator has verified site access. Rate Plans
    /// shows what this returns, so it waits for the inferred country to be reported: otherwise the
    /// screen would keep asking for a country the app already knows.
    func fetchTariffTimeline() async throws -> SiteTariffsTimelineResponse {
        guard let timeline = try await runTariffFetch(knownETag: nil, syncsCountryInBackground: false) else {
            throw PWUsageAPIError.invalidResponse
        }
        if let stored = timeline.rateCountry, stored.source != .owner,
           let updated = await syncSiteRateCountry(stored: stored) {
            return updated
        }
        return timeline
    }

    /// Revalidate the saved rate plan timeline using its stored ETag.
    /// Keeps the saved copy on 304 Not Modified and replaces it on 200 OK.
    @discardableResult
    func revalidateTariffTimeline() async throws -> SiteTariffsTimelineResponse? {
        let scope = tariffScope(siteID: selectedSiteID)
        let saved = await savedTimeline(for: scope)
        return try await runTariffFetch(knownETag: saved?.etag) ?? saved?.timeline
    }

    func refreshTariffsFromTesla() async throws -> SiteTariffsTimelineResponse {
        try await runTariffRequest { api, siteID in try await api.refreshTariffsFromTesla(siteID: siteID) }
    }

    /// What Sync to Tesla would send now. Read-only.
    func previewTeslaSync() async throws -> TeslaSyncPreviewDTO {
        try await runTariffQuery { api, siteID in
            try await Self.teslaSyncAPI(api).previewTeslaSync(siteID: siteID)
        }
    }

    /// Sends the reviewed plan. The fingerprint must be the one the owner reviewed.
    func commitTeslaSync(fingerprint: String) async throws -> TeslaSyncResultDTO {
        try await runTariffQuery { api, siteID in
            try await Self.teslaSyncAPI(api).commitTeslaSync(siteID: siteID, fingerprint: fingerprint)
        }
    }

    private static func teslaSyncAPI(_ api: any MobileTariffDataAPI) throws -> any MobileTeslaSyncAPI {
        guard let syncAPI = api as? any MobileTeslaSyncAPI else { throw PWUsageAPIError.invalidResponse }
        return syncAPI
    }

    func createTariffPeriod(_ body: TariffPlanWriteRequest) async throws -> SiteTariffsTimelineResponse {
        try await runTariffRequest { api, siteID in try await api.createTariffPeriod(siteID: siteID, body: body) }
    }

    func updateTariffPeriod(periodID: Int, body: TariffPlanPatchRequest) async throws -> SiteTariffsTimelineResponse {
        try await runTariffRequest { api, siteID in
            try await api.updateTariffPeriod(siteID: siteID, periodID: periodID, body: body)
        }
    }

    func deleteTariffPeriod(periodID: Int) async throws -> SiteTariffsTimelineResponse {
        try await runTariffRequest { api, siteID in
            try await api.deleteTariffPeriod(siteID: siteID, periodID: periodID)
        }
    }

    func retryTariffReattribution() async throws -> SiteTariffsTimelineResponse {
        try await runTariffRequest { api, siteID in try await api.retryTariffReattribution(siteID: siteID) }
    }

    func putSystemCosts(_ body: SystemCostsWriteRequest) async throws -> SiteTariffsTimelineResponse {
        try await runTariffRequest { api, siteID in try await api.saveSystemCosts(siteID: siteID, body: body) }
    }

    func searchUtilities(query: String) async throws -> [String] {
        try await runTariffQuery { api, siteID in try await api.searchUtilities(siteID: siteID, query: query) }
    }

    func setUtility(name: String) async throws -> SiteTariffsTimelineResponse {
        try await runTariffRequest { api, siteID in try await api.setUtility(siteID: siteID, name: name) }
    }

    func skipUtility() async throws -> SiteTariffsTimelineResponse {
        try await runTariffRequest { api, siteID in try await api.skipUtility(siteID: siteID) }
    }

    func utilityPlans() async throws -> [UtilityPlanDTO] {
        try await runTariffQuery { api, siteID in try await api.utilityPlans(siteID: siteID) }
    }

    func setUtilityPlan(label: String) async throws -> SiteTariffsTimelineResponse {
        try await runTariffRequest { api, siteID in try await api.setUtilityPlan(siteID: siteID, label: label) }
    }

    func loadRateHistory() async throws -> RatePlanHistoryDTO {
        try await runTariffQuery { api, siteID in try await api.rateHistory(siteID: siteID) }
    }

    func saveRateHistory(_ periods: [RatePlanHistoryPeriod]) async throws -> SiteTariffsTimelineResponse {
        try await runTariffRequest { api, siteID in
            try await api.saveRateHistory(siteID: siteID, periods: periods)
        }
    }

    /// Builds the server's review of a change; nothing is saved.
    func previewTariffSelection(_ request: TariffSelectionRequest) async throws -> TariffSelectionPreviewResponse {
        try await runTariffQuery { api, siteID in
            try await api.previewTariffSelection(siteID: siteID, request: request).validating(siteID: siteID)
        }
    }

    /// Applies a reviewed change. A stale review throws `RatePlanSelectionError.reviewStale`.
    func commitTariffSelection(_ commit: TariffSelectionCommit) async throws -> TariffSelectionCommitResponse {
        var committed: TariffSelectionCommitResponse?
        _ = try await runTariffRequest { api, siteID in
            let response = try await api.commitTariffSelection(siteID: siteID, commit: commit)
            committed = response
            return response.timeline
        }
        guard let committed else { throw PWUsageAPIError.invalidResponse }
        return committed
    }

    func exportRatePlanAiHandoff() async throws -> TariffAiHandoffExportResponse {
        try await runTariffQuery { api, siteID in
            try await api.exportRatePlanAiHandoff(siteID: siteID)
        }
    }

    func previewRatePlanAiHandoff(rawInput: String) async throws -> TariffAiHandoffPreviewResponse {
        try await runTariffQuery { api, siteID in
            try await api.previewRatePlanAiHandoff(siteID: siteID, rawInput: rawInput).validating(siteID: siteID)
        }
    }

    func commitRatePlanAiHandoff(_ commit: TariffAiHandoffCommitRequest) async throws -> TariffAiHandoffCommitResponse {
        var committed: TariffAiHandoffCommitResponse?
        _ = try await runTariffRequest { api, siteID in
            let response = try await api.commitRatePlanAiHandoff(siteID: siteID, commit: commit)
            committed = response
            return response.timeline
        }
        guard let committed else { throw PWUsageAPIError.invalidResponse }
        return committed
    }

    /// Public plans in effect on `effectiveDate` (YYYY-MM-DD), with their full rates.
    func publicUtilityPlans(effectiveDate: String) async throws -> PublicUtilityPlansResponse {
        try await runTariffQuery { api, siteID in
            try await api.publicUtilityPlans(siteID: siteID, effectiveDate: effectiveDate)
        }
    }

    /// Stores the site's country. Only the code and its source are sent.
    func setSiteRateCountry(
        _ countryCode: String?,
        source: RateCountrySource = .owner
    ) async throws -> SiteTariffsTimelineResponse {
        let body = SiteRateCountryWriteRequest(countryCode: countryCode, source: source)
        return try await runTariffRequest { api, siteID in
            try await api.setSiteRateCountry(siteID: siteID, body: body)
        }
    }

    private func runTariffFetch(
        knownETag: String?,
        syncsCountryInBackground: Bool = true
    ) async throws -> SiteTariffsTimelineResponse? {
        guard canRequestAccountData else { throw PWUsageAPIError.signInRequired }
        guard let tariffAPI = api as? any MobileTariffDataAPI else { throw PWUsageAPIError.invalidResponse }
        let generation = siteGeneration
        let siteID = selectedSiteID
        let scope = tariffScope(siteID: siteID)
        do {
            let fetch = try await tariffAPI.fetchTariffTimeline(siteID: siteID, knownETag: knownETag)
            guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else {
                throw CancellationError()
            }
            switch fetch {
            case .unchanged:
                return nil
            case .changed(let response, let etag):
                let validated = try response.validating(siteID: siteID)
                await saveTimeline(
                    validated, etag: etag, scope: scope, syncsCountryInBackground: syncsCountryInBackground
                )
                return validated
            }
        } catch {
            handleTariffError(error, generation: generation)
            throw error
        }
    }

    private func runTariffRequest(
        _ action: (any MobileTariffDataAPI, String) async throws -> SiteTariffsTimelineResponse
    ) async throws -> SiteTariffsTimelineResponse {
        guard canRequestAccountData else { throw PWUsageAPIError.signInRequired }
        guard let tariffAPI = api as? any MobileTariffDataAPI else { throw PWUsageAPIError.invalidResponse }
        let generation = siteGeneration
        let siteID = selectedSiteID
        let scope = tariffScope(siteID: siteID)
        do {
            let response = try await action(tariffAPI, siteID)
            guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else {
                throw CancellationError()
            }
            let validated = try response.validating(siteID: siteID)
            await saveTimeline(validated, etag: nil, scope: scope)
            return validated
        } catch {
            handleTariffError(error, generation: generation)
            throw error
        }
    }

    /// Reads from the utility endpoints, which return their own values rather than a timeline.
    private func runTariffQuery<Value>(
        _ action: (any MobileTariffDataAPI, String) async throws -> Value
    ) async throws -> Value {
        guard canRequestAccountData else { throw PWUsageAPIError.signInRequired }
        guard let tariffAPI = api as? any MobileTariffDataAPI else { throw PWUsageAPIError.invalidResponse }
        let generation = siteGeneration
        let siteID = selectedSiteID
        do {
            let value = try await action(tariffAPI, siteID)
            guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else {
                throw CancellationError()
            }
            return value
        } catch {
            handleTariffError(error, generation: generation)
            throw error
        }
    }

    private func handleTariffError(_ error: any Error, generation: Int) {
        if generation == siteGeneration, error as? PWUsageAPIError == .signInRequired {
            authenticationInvalidated()
            isForeground = false
            stopTimer()
        }
    }

    func tariffScope(siteID: String) -> SolarForecastSiteScope? {
        accountScopeID.map { SolarForecastSiteScope(accountScopeID: $0, siteID: siteID) }
    }

    func savedTimeline(for scope: SolarForecastSiteScope?) async -> SavedRatePlanTimeline? {
        guard let scope else { return nil }
        return try? await ratePlanTimelines.saved(scope: scope)
    }

    private func saveTimeline(
        _ timeline: SiteTariffsTimelineResponse,
        etag: String?,
        scope: SolarForecastSiteScope?,
        syncsCountryInBackground: Bool = true
    ) async {
        guard let scope else { return }
        let generation = siteGeneration
        try? await ratePlanTimelines.save(timeline, etag: etag, scope: scope)
        await repriceLocalBillIfTimelineChanged(timeline, scope: scope, generation: generation)
        guard !Task.isCancelled,
              siteGeneration == generation,
              tariffScope(siteID: selectedSiteID) == scope else { return }
        await refreshSavings(timeline: timeline)
        if syncsCountryInBackground, let stored = timeline.rateCountry, stored.source != .owner {
            Task { [weak self] in await self?.syncSiteRateCountry(stored: stored) }
        }
    }
}
