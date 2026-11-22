import Foundation
import PWUsageCore

/// A public utility plan. The detail fields come from servers with rate plan selection
/// (`PublicUtilityPlanDTO`); older servers send only the label, name and start date.
struct UtilityPlanDTO: Decodable, Equatable, Sendable, Identifiable {
    let label: String
    let name: String
    let startDate: String
    var utilityName: String?
    /// Informational revision start; never a default effective date.
    var revisionStart: String?
    var kind: RatePlanKind?
    var isDefault: Bool?
    var currency: String?
    var holidaysUseWeekendSchedule: Bool?
    var exportRateProvenance: ExportRateProvenance?
    var seasons: [TariffSeasonInput]?
    var approximationNotes: [TariffApproximationNote]?
    var id: String { label }
}

extension SiteTariffsTimelineResponse {
    func validating(siteID: String) throws -> Self {
        let allPeriods = periods + referencePeriods
        let ratesAreFinite = allPeriods.allSatisfy { period in
            period.seasons.allSatisfy { season in
                let windows = season.weekdayPeriods + season.weekendPeriods
                return windows.allSatisfy { $0.buyRate.isFinite && $0.sellRate.isFinite }
            }
        }
        let batteryValid = battery.map {
            $0.nameplateEnergyWh.isFinite && $0.nameplatePowerW.isFinite && $0.backupReservePercent.isFinite
        } ?? true
        guard version == 2,
              siteId == siteID,
              TimeZone(identifier: timezone) != nil,
              ratesAreFinite,
              batteryValid else {
            throw PWUsageAPIError.invalidResponse
        }
        return self
    }

    func activePeriodNow(at now: Date = .now) -> ActiveTariffPeriodMatch? {
        RatePeriodResolver(timeline: self)?.match(at: now)
    }
}

struct RefreshTariffsResponse: Codable, Equatable, Sendable {
    let success: Bool
    let updatedFromTesla: Bool
    let timeline: SiteTariffsTimelineResponse
}

struct TariffPlanWriteRequest: Codable, Equatable, Sendable {
    let name: String
    let effectiveFrom: String
    let effectiveTo: String?
    let seasons: [TariffSeasonInput]

    private enum CodingKeys: String, CodingKey {
        case name, effectiveFrom, effectiveTo, seasons
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(effectiveFrom, forKey: .effectiveFrom)
        try container.encode(effectiveTo, forKey: .effectiveTo)
        try container.encode(seasons, forKey: .seasons)
    }
}

enum EffectiveEndDatePatch: Equatable, Sendable {
    case unchanged
    case set(String?)
}

struct TariffPlanPatchRequest: Encodable, Equatable, Sendable {
    var name: String?
    var effectiveFrom: String?
    var effectiveTo: EffectiveEndDatePatch
    var seasons: [TariffSeasonInput]?

    init(
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

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let name { try container.encode(name, forKey: .name) }
        if let effectiveFrom { try container.encode(effectiveFrom, forKey: .effectiveFrom) }
        if case .set(let date) = effectiveTo {
            try container.encode(date, forKey: .effectiveTo)
        }
        if let seasons { try container.encode(seasons, forKey: .seasons) }
    }
}

enum TimelineFetch: Equatable, Sendable {
    case unchanged
    case changed(SiteTariffsTimelineResponse, etag: String?)
}
