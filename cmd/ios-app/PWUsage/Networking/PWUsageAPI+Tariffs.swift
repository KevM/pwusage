import Foundation

extension PWUsageAPI {
    func fetchTariffTimeline(siteID: String) async throws -> SiteTariffsTimelineResponse {
        let url = try makeSiteURL(siteID: siteID, suffix: "tariffs")
        let data = try await request(url: url)
        return try decodeTariffTimeline(data, siteID: siteID)
    }

    func refreshTariffsFromTesla(siteID: String) async throws -> SiteTariffsTimelineResponse {
        var req = URLRequest(url: try makeSiteURL(siteID: siteID, suffix: "refresh-tariffs"))
        req.httpMethod = "POST"
        let data = try await perform(req)
        do {
            return try MobileContractDecoder.make()
                .decode(RefreshTariffsResponse.self, from: data)
                .timeline
                .validating(siteID: siteID)
        } catch let error as PWUsageAPIError {
            throw error
        } catch {
            throw PWUsageAPIError.invalidResponse
        }
    }

    func createTariffPeriod(
        siteID: String,
        body: TariffPlanWriteRequest
    ) async throws -> SiteTariffsTimelineResponse {
        try await performTariffMutation(siteID: siteID, suffix: "tariffs", method: "POST", body: body)
    }

    func updateTariffPeriod(
        siteID: String,
        periodID: Int,
        body: TariffPlanPatchRequest
    ) async throws -> SiteTariffsTimelineResponse {
        try await performTariffMutation(
            siteID: siteID,
            suffix: "tariffs/\(periodID)",
            method: "PATCH",
            body: body
        )
    }

    func deleteTariffPeriod(siteID: String, periodID: Int) async throws -> SiteTariffsTimelineResponse {
        var req = URLRequest(url: try makeSiteURL(siteID: siteID, suffix: "tariffs/\(periodID)"))
        req.httpMethod = "DELETE"
        let data = try await perform(req)
        return try decodeTariffTimeline(data, siteID: siteID)
    }

    func retryTariffReattribution(siteID: String) async throws -> SiteTariffsTimelineResponse {
        try await performTariffMutation(
            siteID: siteID,
            suffix: "tariffs/reattribute",
            method: "POST",
            body: EmptyTariffMutationBody()
        )
    }

    private func performTariffMutation<Body: Encodable>(
        siteID: String,
        suffix: String,
        method: String,
        body: Body
    ) async throws -> SiteTariffsTimelineResponse {
        var req = URLRequest(url: try makeSiteURL(siteID: siteID, suffix: suffix))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let data = try await perform(req)
        return try decodeTariffTimeline(data, siteID: siteID)
    }

    private func decodeTariffTimeline(_ data: Data, siteID: String) throws -> SiteTariffsTimelineResponse {
        do {
            return try MobileContractDecoder.make()
                .decode(SiteTariffsTimelineResponse.self, from: data)
                .validating(siteID: siteID)
        } catch let error as PWUsageAPIError {
            throw error
        } catch {
            throw PWUsageAPIError.invalidResponse
        }
    }

    private struct EmptyTariffMutationBody: Encodable {}
}
