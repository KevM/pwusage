import Foundation

/// Whether public (OpenEI) utility rate plans apply to a site. Mirrors `RatePlanEligibility` in
/// `cmd/next-app/src/lib/db-types.ts`. It is separate from estimate processing state.
enum RatePlanEligibility: String, Codable, Equatable, Sendable {
    case unitedStates = "us"
    case outsideUS = "outside_us"
    case unknown
}

/// Where a site's stored country came from. An owner's choice always wins over inference.
enum RateCountrySource: String, Codable, Equatable, Sendable {
    case solarLocation = "solar_location"
    case owner
}

/// `SiteRateCountryDTO` in `tariff-contract.ts`: the site's stored country and its provenance.
struct SiteRateCountryDTO: Codable, Equatable, Sendable {
    let countryCode: String?
    let source: RateCountrySource?
    let updatedAt: String?
    let eligibility: RatePlanEligibility
    var hasIneligiblePublicSelection: Bool?
}

/// `PUT /api/site/[id]/rate-country`. Only a country code and its source are sent, never coordinates.
struct SiteRateCountryWriteRequest: Encodable, Equatable, Sendable {
    let countryCode: String?
    let source: RateCountrySource

    private enum CodingKeys: String, CodingKey { case countryCode, source }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(countryCode, forKey: .countryCode)
        try container.encode(source, forKey: .source)
    }
}
