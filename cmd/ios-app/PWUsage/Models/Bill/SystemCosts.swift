import Foundation
import PWUsageCore

/// Replaces both components at once; a nil component is sent as an explicit null.
struct SystemCostsWriteRequest: Encodable, Sendable {
    let solar: SystemCostDTO?
    let powerwall: SystemCostDTO?

    private enum CodingKeys: String, CodingKey {
        case solar, powerwall
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(solar, forKey: .solar)
        try container.encode(powerwall, forKey: .powerwall)
    }
}

extension MobileTariffDataAPI {
    func saveSystemCosts(
        siteID _: String,
        body _: SystemCostsWriteRequest
    ) async throws -> SiteTariffsTimelineResponse {
        throw PWUsageAPIError.invalidResponse
    }
}
