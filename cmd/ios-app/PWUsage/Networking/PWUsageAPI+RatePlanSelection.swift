import Foundation
import PWUsageCore

extension PWUsageAPI {
    func siteRateCountry(siteID: String) async throws -> SiteRateCountryDTO {
        let data = try await request(url: makeSiteURL(siteID: siteID, suffix: "rate-country"))
        return try decodeSelectionPayload(SiteRateCountryDTO.self, from: data)
    }

    /// Sends only a country code and its source; coordinates never leave the device.
    func setSiteRateCountry(
        siteID: String,
        body: SiteRateCountryWriteRequest
    ) async throws -> SiteTariffsTimelineResponse {
        let data = try await sendSelectionRequest(siteID: siteID, suffix: "rate-country", method: "PUT", body: body)
        return try decodeSelectionPayload(SiteTariffsTimelineResponse.self, from: data).validating(siteID: siteID)
    }

    func publicUtilityPlans(siteID: String, effectiveDate: String) async throws -> PublicUtilityPlansResponse {
        let base = try makeSiteURL(siteID: siteID, suffix: "utility/plans")
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw PWUsageAPIError.invalidResponse
        }
        components.queryItems = [URLQueryItem(name: "effectiveDate", value: effectiveDate)]
        guard let url = components.url else { throw PWUsageAPIError.invalidResponse }
        let data = try await sendSelectionRequest(URLRequest(url: url))
        return try decodeSelectionPayload(PublicUtilityPlansResponse.self, from: data)
    }

    func previewTariffSelection(
        siteID: String,
        request: TariffSelectionRequest
    ) async throws -> TariffSelectionPreviewResponse {
        let data = try await sendSelectionRequest(
            siteID: siteID, suffix: "tariffs/selection/preview", method: "POST", body: request
        )
        return try decodeSelectionPayload(TariffSelectionPreviewResponse.self, from: data).validating(siteID: siteID)
    }

    /// A stale review comes back as `RatePlanSelectionError.reviewStale` with the fresh review.
    func commitTariffSelection(
        siteID: String,
        commit: TariffSelectionCommit
    ) async throws -> TariffSelectionCommitResponse {
        let data = try await sendSelectionRequest(
            siteID: siteID, suffix: "tariffs/selection", method: "POST", body: commit
        )
        let response = try decodeSelectionPayload(TariffSelectionCommitResponse.self, from: data)
        _ = try response.timeline.validating(siteID: siteID)
        return response
    }

    func exportRatePlanAiHandoff(siteID: String) async throws -> TariffAiHandoffExportResponse {
        let data = try await request(url: makeSiteURL(siteID: siteID, suffix: "tariffs/ai-handoff"))
        return try decodeSelectionPayload(TariffAiHandoffExportResponse.self, from: data)
    }

    func previewRatePlanAiHandoff(
        siteID: String,
        rawInput: String
    ) async throws -> TariffAiHandoffPreviewResponse {
        let data = try await sendSelectionRequest(
            siteID: siteID,
            suffix: "tariffs/ai-handoff/preview",
            method: "POST",
            body: TariffAiHandoffPreviewRequest(rawInput: rawInput)
        )
        return try decodeSelectionPayload(TariffAiHandoffPreviewResponse.self, from: data).validating(siteID: siteID)
    }

    func commitRatePlanAiHandoff(
        siteID: String,
        commit: TariffAiHandoffCommitRequest
    ) async throws -> TariffAiHandoffCommitResponse {
        let data = try await sendSelectionRequest(
            siteID: siteID,
            suffix: "tariffs/ai-handoff/commit",
            method: "POST",
            body: commit
        )
        let response = try decodeSelectionPayload(TariffAiHandoffCommitResponse.self, from: data)
        _ = try response.timeline.validating(siteID: siteID)
        return response
    }

    private func sendSelectionRequest(
        siteID: String,
        suffix: String,
        method: String,
        body: some Encodable
    ) async throws -> Data {
        var req = URLRequest(url: try makeSiteURL(siteID: siteID, suffix: suffix))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        return try await sendSelectionRequest(req)
    }

    /// Like `perform`, but turns the selection endpoints' 409 bodies into typed errors.
    private func sendSelectionRequest(_ req: URLRequest) async throws -> Data {
        let (data, http) = try await send(req)
        if http.statusCode == 409, let conflict = RatePlanSelectionConflict.decode(from: data) {
            throw conflict
        }
        return try check(http, data: data)
    }

    private func decodeSelectionPayload<Value: Decodable>(_: Value.Type, from data: Data) throws -> Value {
        do {
            return try MobileContractDecoder.make().decode(Value.self, from: data)
        } catch {
            throw PWUsageAPIError.invalidResponse
        }
    }
}
