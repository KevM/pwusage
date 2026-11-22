import Foundation
import PWUsageCore

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

    func rateHistory(siteID: String) async throws -> RatePlanHistoryDTO {
        let data = try await request(url: makeSiteURL(siteID: siteID, suffix: "utility/history"))
        do {
            return try MobileContractDecoder.make().decode(RatePlanHistoryDTO.self, from: data)
        } catch {
            throw PWUsageAPIError.invalidResponse
        }
    }

    func saveRateHistory(
        siteID: String,
        periods: [RatePlanHistoryPeriod]
    ) async throws -> SiteTariffsTimelineResponse {
        try await performTariffMutation(
            siteID: siteID, suffix: "utility/history", method: "PUT", body: RatePlanHistoryBody(periods: periods)
        )
    }

    private struct RatePlanHistoryBody: Encodable { let periods: [RatePlanHistoryPeriod] }
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

    func saveSystemCosts(siteID: String, body: SystemCostsWriteRequest) async throws -> SiteTariffsTimelineResponse {
        try await performTariffMutation(siteID: siteID, suffix: "system-costs", method: "PUT", body: body)
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

    /// What would be sent to Tesla now. A 409 means nothing can be sent (see `TeslaSyncUnavailability`).
    func previewTeslaSync(siteID: String) async throws -> TeslaSyncPreviewDTO {
        var req = URLRequest(url: try makeSiteURL(siteID: siteID, suffix: "tariffs/tesla-sync/preview"))
        req.httpMethod = "POST"
        let data = try await sendTeslaSync(req)
        return try decodeTeslaSyncPayload(TeslaSyncPreviewDTO.self, from: data)
    }

    /// Sends the reviewed plan. A refused or unconfirmed write is still a result, not an error.
    func commitTeslaSync(siteID: String, fingerprint: String) async throws -> TeslaSyncResultDTO {
        var req = URLRequest(url: try makeSiteURL(siteID: siteID, suffix: "tariffs/tesla-sync"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(TeslaSyncCommitBody(fingerprint: fingerprint))
        let data = try await sendTeslaSync(req)
        let result = try decodeTeslaSyncPayload(TeslaSyncResultDTO.self, from: data)
        if let timeline = result.timeline {
            _ = try timeline.validating(siteID: siteID)
        }
        return result
    }

    private func sendTeslaSync(_ req: URLRequest) async throws -> Data {
        let (data, http) = try await send(req)
        if http.statusCode == 409,
           let body = try? MobileContractDecoder.make().decode(TeslaSyncConflictBody.self, from: data) {
            throw TeslaSyncUnavailability(reason: body.reason, message: body.message)
        }
        return try check(http, data: data)
    }

    private func decodeTeslaSyncPayload<Value: Decodable>(_: Value.Type, from data: Data) throws -> Value {
        do {
            return try MobileContractDecoder.make().decode(Value.self, from: data)
        } catch {
            throw PWUsageAPIError.invalidResponse
        }
    }

    private struct TeslaSyncCommitBody: Encodable { let fingerprint: String }
    private struct TeslaSyncConflictBody: Decodable {
        let reason: String
        let message: String
    }

    private struct EmptyTariffMutationBody: Encodable {}
}
