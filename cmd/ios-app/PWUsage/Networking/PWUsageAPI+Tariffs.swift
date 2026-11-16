import Foundation

extension PWUsageAPI {
    func searchUtilities(siteID: String, query: String) async throws -> [String] {
        let base = try makeSiteURL(siteID: siteID, suffix: "utility/search")
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw PWUsageAPIError.invalidResponse
        }
        components.queryItems = [URLQueryItem(name: "q", value: query)]
        guard let url = components.url else { throw PWUsageAPIError.invalidResponse }
        let data = try await request(url: url)
        return try MobileContractDecoder.make().decode(UtilitiesResponse.self, from: data).utilities
    }

    func setUtility(siteID: String, name: String) async throws -> SiteTariffsTimelineResponse {
        try await performTariffMutation(siteID: siteID, suffix: "utility", method: "PUT", body: UtilityName(name: name))
    }

    func skipUtility(siteID: String) async throws -> SiteTariffsTimelineResponse {
        try await performTariffMutation(
            siteID: siteID, suffix: "utility", method: "PUT", body: UtilitySkip(skipped: true)
        )
    }

    func utilityPlans(siteID: String) async throws -> [UtilityPlanDTO] {
        let data = try await request(url: makeSiteURL(siteID: siteID, suffix: "utility/plans"))
        return try MobileContractDecoder.make().decode(UtilityPlansResponse.self, from: data).plans
    }

    func setUtilityPlan(siteID: String, label: String) async throws -> SiteTariffsTimelineResponse {
        try await performTariffMutation(
            siteID: siteID, suffix: "utility/plan", method: "PUT", body: UtilityPlanLabel(label: label)
        )
    }

    private struct UtilitiesResponse: Decodable { let utilities: [String] }
    private struct UtilityPlansResponse: Decodable { let plans: [UtilityPlanDTO] }
    private struct UtilityName: Encodable { let name: String }
    private struct UtilitySkip: Encodable { let skipped: Bool }
    private struct UtilityPlanLabel: Encodable { let label: String }

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
