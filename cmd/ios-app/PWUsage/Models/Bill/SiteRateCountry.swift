import Foundation
import PWUsageCore

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
