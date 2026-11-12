import Foundation

extension DashboardCoordinator {
    /// Load rate plan timeline only while this coordinator has verified site access.
    func fetchTariffTimeline() async throws -> SiteTariffsTimelineResponse {
        try await runTariffRequest { api, siteID in try await api.fetchTariffTimeline(siteID: siteID) }
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

    private func runTariffRequest(
        _ action: (any MobileTariffDataAPI, String) async throws -> SiteTariffsTimelineResponse
    ) async throws -> SiteTariffsTimelineResponse {
        guard canRequestAccountData else { throw PWUsageAPIError.signInRequired }
        guard let tariffAPI = api as? any MobileTariffDataAPI else { throw PWUsageAPIError.invalidResponse }
        let generation = siteGeneration
        let siteID = selectedSiteID
        do {
            let response = try await action(tariffAPI, siteID)
            guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else {
                throw CancellationError()
            }
            return try response.validating(siteID: siteID)
        } catch {
            if generation == siteGeneration, error as? PWUsageAPIError == .signInRequired {
                authenticationInvalidated()
                isForeground = false
                stopTimer()
            }
            throw error
        }
    }
}
