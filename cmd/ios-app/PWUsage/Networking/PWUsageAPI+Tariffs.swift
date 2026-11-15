import Foundation

extension PWUsageAPI {
    func fetchTariffTimeline(siteID: String) async throws -> SiteTariffsTimelineResponse {
        guard case .changed(let timeline, _) = try await fetchTariffTimeline(siteID: siteID, knownETag: nil) else {
            throw PWUsageAPIError.invalidResponse
        }
        return timeline
    }

    func fetchTariffTimeline(siteID: String, knownETag: String?) async throws -> TimelineFetch {
        var req = URLRequest(url: try makeSiteURL(siteID: siteID, suffix: "tariffs"))
        if let knownETag, !knownETag.isEmpty {
            req.setValue(knownETag, forHTTPHeaderField: "If-None-Match")
        }
        let (data, http) = try await send(req)
        if http.statusCode == 304 {
            return .unchanged
        }
        let verifiedData = try check(http, data: data)
        let timeline = try decodeTariffTimeline(verifiedData, siteID: siteID)
        return .changed(timeline, etag: http.value(forHTTPHeaderField: "ETag"))
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
        try await deleteTariff(siteID: siteID, suffix: "tariffs/\(periodID)")
    }

    func retryTariffReattribution(siteID: String) async throws -> SiteTariffsTimelineResponse {
        try await performTariffMutation(
            siteID: siteID,
            suffix: "tariffs/reattribute",
            method: "POST",
            body: EmptyTariffMutationBody()
        )
    }

    func createReferenceRatePlan(
        siteID: String,
        body: TariffPlanWriteRequest
    ) async throws -> SiteTariffsTimelineResponse {
        try await performTariffMutation(
            siteID: siteID,
            suffix: "tariffs/reference",
            method: "POST",
            body: body
        )
    }

    func updateReferenceRatePlan(
        siteID: String,
        periodID: Int,
        body: TariffPlanPatchRequest
    ) async throws -> SiteTariffsTimelineResponse {
        try await performTariffMutation(
            siteID: siteID,
            suffix: "tariffs/reference/\(periodID)",
            method: "PATCH",
            body: body
        )
    }

    func deleteReferenceRatePlan(siteID: String, periodID: Int) async throws -> SiteTariffsTimelineResponse {
        try await deleteTariff(siteID: siteID, suffix: "tariffs/reference/\(periodID)")
    }

    private func deleteTariff(siteID: String, suffix: String) async throws -> SiteTariffsTimelineResponse {
        var req = URLRequest(url: try makeSiteURL(siteID: siteID, suffix: suffix))
        req.httpMethod = "DELETE"
        let data = try await perform(req)
        return try decodeTariffTimeline(data, siteID: siteID)
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
