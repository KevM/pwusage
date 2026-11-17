import Foundation

/// One component's cost as the site stores it. Money is in the site currency.
struct SystemCostDTO: Codable, Equatable, Sendable {
    var installDate: String?
    var price: Double
    /// Percent of the net price claimed back as a credit; nil when the credit is off.
    var taxCreditPercent: Double?
    var incentives: Double

    private enum CodingKeys: String, CodingKey {
        case installDate, price, taxCreditPercent, incentives
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(installDate, forKey: .installDate)
        try container.encode(price, forKey: .price)
        try container.encode(taxCreditPercent, forKey: .taxCreditPercent)
        try container.encode(incentives, forKey: .incentives)
    }
}

struct SystemCostsDTO: Codable, Equatable, Sendable {
    /// Site.installed as a site-local YYYY-MM-DD.
    let siteInstalled: String
    var solar: SystemCostDTO?
    var powerwall: SystemCostDTO?
}

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
