import Foundation

public struct RefreshTariffsResponse: Codable, Equatable, Sendable {
    let success: Bool
    let updatedFromTesla: Bool
    public let timeline: SiteTariffsTimelineResponse
}

public struct TariffPlanWriteRequest: Codable, Equatable, Sendable {
    public let name: String
    public let effectiveFrom: String
    public let effectiveTo: String?
    public let seasons: [TariffSeasonInput]

    public init(name: String, effectiveFrom: String, effectiveTo: String?, seasons: [TariffSeasonInput]) {
        self.name = name
        self.effectiveFrom = effectiveFrom
        self.effectiveTo = effectiveTo
        self.seasons = seasons
    }

    private enum CodingKeys: String, CodingKey {
        case name, effectiveFrom, effectiveTo, seasons
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(effectiveFrom, forKey: .effectiveFrom)
        try container.encode(effectiveTo, forKey: .effectiveTo)
        try container.encode(seasons, forKey: .seasons)
    }
}

public enum EffectiveEndDatePatch: Equatable, Sendable {
    case unchanged
    case set(String?)
}

public struct TariffPlanPatchRequest: Encodable, Equatable, Sendable {
    public var name: String?
    public var effectiveFrom: String?
    public var effectiveTo: EffectiveEndDatePatch
    public var seasons: [TariffSeasonInput]?

    public init(
        name: String? = nil,
        effectiveFrom: String? = nil,
        effectiveTo: EffectiveEndDatePatch = .unchanged,
        seasons: [TariffSeasonInput]? = nil
    ) {
        self.name = name
        self.effectiveFrom = effectiveFrom
        self.effectiveTo = effectiveTo
        self.seasons = seasons
    }

    private enum CodingKeys: String, CodingKey {
        case name, effectiveFrom, effectiveTo, seasons
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let name { try container.encode(name, forKey: .name) }
        if let effectiveFrom { try container.encode(effectiveFrom, forKey: .effectiveFrom) }
        if case .set(let date) = effectiveTo {
            try container.encode(date, forKey: .effectiveTo)
        }
        if let seasons { try container.encode(seasons, forKey: .seasons) }
    }
}

/// `PUT /api/site/[id]/rate-country`. Only a country code and its source are sent, never coordinates.
public struct SiteRateCountryWriteRequest: Encodable, Equatable, Sendable {
    public let countryCode: String?
    public let source: RateCountrySource

    public init(countryCode: String?, source: RateCountrySource) {
        self.countryCode = countryCode
        self.source = source
    }

    private enum CodingKeys: String, CodingKey { case countryCode, source }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(countryCode, forKey: .countryCode)
        try container.encode(source, forKey: .source)
    }
}

/// Replaces both components at once; a nil component is sent as an explicit null.
public struct SystemCostsWriteRequest: Encodable, Sendable {
    public let solar: SystemCostDTO?
    public let powerwall: SystemCostDTO?

    public init(solar: SystemCostDTO?, powerwall: SystemCostDTO?) {
        self.solar = solar
        self.powerwall = powerwall
    }

    private enum CodingKeys: String, CodingKey {
        case solar, powerwall
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(solar, forKey: .solar)
        try container.encode(powerwall, forKey: .powerwall)
    }
}
