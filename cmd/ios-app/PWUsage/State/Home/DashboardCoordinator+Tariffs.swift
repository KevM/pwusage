import Foundation

extension DashboardCoordinator {
    /// Load rate plan timeline only while this coordinator has verified site access.
    func fetchTariffTimeline() async throws -> SiteTariffsTimelineResponse {
        guard let timeline = try await runTariffFetch(knownETag: nil) else {
            throw PWUsageAPIError.invalidResponse
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

    func createReferenceRatePlan(_ body: TariffPlanWriteRequest) async throws -> SiteTariffsTimelineResponse {
        try await runTariffRequest { api, siteID in try await api.createReferenceRatePlan(siteID: siteID, body: body) }
    }

    func updateReferenceRatePlan(
        periodID: Int,
        body: TariffPlanPatchRequest
    ) async throws -> SiteTariffsTimelineResponse {
        try await runTariffRequest { api, siteID in
            try await api.updateReferenceRatePlan(siteID: siteID, periodID: periodID, body: body)
        }
    }

    func deleteReferenceRatePlan(periodID: Int) async throws -> SiteTariffsTimelineResponse {
        try await runTariffRequest { api, siteID in
            try await api.deleteReferenceRatePlan(siteID: siteID, periodID: periodID)
        }
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

    private func runTariffFetch(knownETag: String?) async throws -> SiteTariffsTimelineResponse? {
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
                await saveTimeline(validated, etag: etag, scope: scope)
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
        scope: SolarForecastSiteScope?
    ) async {
        guard let scope else { return }
        let generation = siteGeneration
        try? await ratePlanTimelines.save(timeline, etag: etag, scope: scope)
        await repriceLocalBillIfTimelineChanged(timeline, scope: scope, generation: generation)
        guard !Task.isCancelled,
              siteGeneration == generation,
              tariffScope(siteID: selectedSiteID) == scope else { return }
        await refreshSavings(timeline: timeline)
    }
}
