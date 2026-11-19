import Foundation

@MainActor
protocol MobileTariffDataAPI: Sendable {
    func searchUtilities(siteID: String, query: String) async throws -> [String]
    func setUtility(siteID: String, name: String) async throws -> SiteTariffsTimelineResponse
    func skipUtility(siteID: String) async throws -> SiteTariffsTimelineResponse
    func utilityPlans(siteID: String) async throws -> [UtilityPlanDTO]
    func setUtilityPlan(siteID: String, label: String) async throws -> SiteTariffsTimelineResponse
    func rateHistory(siteID: String) async throws -> RatePlanHistoryDTO
    func saveRateHistory(
        siteID: String,
        periods: [RatePlanHistoryPeriod]
    ) async throws -> SiteTariffsTimelineResponse
    func fetchTariffTimeline(siteID: String) async throws -> SiteTariffsTimelineResponse
    func fetchTariffTimeline(siteID: String, knownETag: String?) async throws -> TimelineFetch
    func refreshTariffsFromTesla(siteID: String) async throws -> SiteTariffsTimelineResponse
    func createTariffPeriod(
        siteID: String,
        body: TariffPlanWriteRequest
    ) async throws -> SiteTariffsTimelineResponse
    func updateTariffPeriod(
        siteID: String,
        periodID: Int,
        body: TariffPlanPatchRequest
    ) async throws -> SiteTariffsTimelineResponse
    func deleteTariffPeriod(siteID: String, periodID: Int) async throws -> SiteTariffsTimelineResponse
    func retryTariffReattribution(siteID: String) async throws -> SiteTariffsTimelineResponse
    func createReferenceRatePlan(
        siteID: String,
        body: TariffPlanWriteRequest
    ) async throws -> SiteTariffsTimelineResponse
    func updateReferenceRatePlan(
        siteID: String,
        periodID: Int,
        body: TariffPlanPatchRequest
    ) async throws -> SiteTariffsTimelineResponse
    func deleteReferenceRatePlan(siteID: String, periodID: Int) async throws -> SiteTariffsTimelineResponse
    func saveSystemCosts(siteID: String, body: SystemCostsWriteRequest) async throws -> SiteTariffsTimelineResponse
    func siteRateCountry(siteID: String) async throws -> SiteRateCountryDTO
    func setSiteRateCountry(
        siteID: String,
        body: SiteRateCountryWriteRequest
    ) async throws -> SiteTariffsTimelineResponse
    func publicUtilityPlans(siteID: String, effectiveDate: String) async throws -> PublicUtilityPlansResponse
    func previewTariffSelection(
        siteID: String,
        request: TariffSelectionRequest
    ) async throws -> TariffSelectionPreviewResponse
    func commitTariffSelection(
        siteID: String,
        commit: TariffSelectionCommit
    ) async throws -> TariffSelectionCommitResponse
    func exportRatePlanAiHandoff(siteID: String) async throws -> TariffAiHandoffExportResponse
    func previewRatePlanAiHandoff(
        siteID: String,
        rawInput: String
    ) async throws -> TariffAiHandoffPreviewResponse
    func commitRatePlanAiHandoff(
        siteID: String,
        commit: TariffAiHandoffCommitRequest
    ) async throws -> TariffAiHandoffCommitResponse
}

extension MobileTariffDataAPI {
    func searchUtilities(siteID _: String, query _: String) async throws -> [String] {
        throw PWUsageAPIError.invalidResponse
    }

    func setUtility(siteID _: String, name _: String) async throws -> SiteTariffsTimelineResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func skipUtility(siteID _: String) async throws -> SiteTariffsTimelineResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func utilityPlans(siteID _: String) async throws -> [UtilityPlanDTO] {
        throw PWUsageAPIError.invalidResponse
    }

    func setUtilityPlan(siteID _: String, label _: String) async throws -> SiteTariffsTimelineResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func fetchTariffTimeline(siteID: String, knownETag: String?) async throws -> TimelineFetch {
        .changed(try await fetchTariffTimeline(siteID: siteID), etag: nil)
    }

    func createReferenceRatePlan(
        siteID _: String,
        body _: TariffPlanWriteRequest
    ) async throws -> SiteTariffsTimelineResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func updateReferenceRatePlan(
        siteID _: String,
        periodID _: Int,
        body _: TariffPlanPatchRequest
    ) async throws -> SiteTariffsTimelineResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func deleteReferenceRatePlan(siteID _: String, periodID _: Int) async throws -> SiteTariffsTimelineResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func siteRateCountry(siteID _: String) async throws -> SiteRateCountryDTO {
        throw PWUsageAPIError.invalidResponse
    }

    func setSiteRateCountry(
        siteID _: String,
        body _: SiteRateCountryWriteRequest
    ) async throws -> SiteTariffsTimelineResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func publicUtilityPlans(siteID _: String, effectiveDate _: String) async throws -> PublicUtilityPlansResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func previewTariffSelection(
        siteID _: String,
        request _: TariffSelectionRequest
    ) async throws -> TariffSelectionPreviewResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func commitTariffSelection(
        siteID _: String,
        commit _: TariffSelectionCommit
    ) async throws -> TariffSelectionCommitResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func exportRatePlanAiHandoff(siteID _: String) async throws -> TariffAiHandoffExportResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func previewRatePlanAiHandoff(
        siteID _: String,
        rawInput _: String
    ) async throws -> TariffAiHandoffPreviewResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func commitRatePlanAiHandoff(
        siteID _: String,
        commit _: TariffAiHandoffCommitRequest
    ) async throws -> TariffAiHandoffCommitResponse {
        throw PWUsageAPIError.invalidResponse
    }
}
