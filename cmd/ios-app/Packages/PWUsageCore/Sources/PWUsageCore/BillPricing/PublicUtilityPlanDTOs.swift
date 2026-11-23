import Foundation

/// A public utility plan. The detail fields come from servers with rate plan selection
/// (`PublicUtilityPlanDTO`); older servers send only the label, name and start date.
public struct UtilityPlanDTO: Decodable, Equatable, Sendable, Identifiable {
    public let label: String
    public let name: String
    public let startDate: String
    var utilityName: String?
    /// Informational revision start; never a default effective date.
    public var revisionStart: String?
    public var kind: RatePlanKind?
    public var isDefault: Bool?
    var currency: String?
    var holidaysUseWeekendSchedule: Bool?
    var exportRateProvenance: ExportRateProvenance?
    public var seasons: [TariffSeasonInput]?
    var approximationNotes: [TariffApproximationNote]?
    public var id: String { label }

    public init(
        label: String,
        name: String,
        startDate: String,
        utilityName: String? = nil,
        revisionStart: String? = nil,
        kind: RatePlanKind? = nil,
        isDefault: Bool? = nil,
        currency: String? = nil,
        seasons: [TariffSeasonInput]? = nil
    ) {
        self.label = label
        self.name = name
        self.startDate = startDate
        self.utilityName = utilityName
        self.revisionStart = revisionStart
        self.kind = kind
        self.isDefault = isDefault
        self.currency = currency
        self.seasons = seasons
    }
}

/// `PublicUtilityPlansResponse`: public plans in effect on one date, with full rate details.
public struct PublicUtilityPlansResponse: Decodable, Equatable, Sendable {
    let utilityName: String
    let effectiveDate: String
    let currency: String
    public let plans: [UtilityPlanDTO]

    public init(utilityName: String, effectiveDate: String, currency: String, plans: [UtilityPlanDTO]) {
        self.utilityName = utilityName
        self.effectiveDate = effectiveDate
        self.currency = currency
        self.plans = plans
    }
}

/// Where a plan's export (sell) rates came from.
public enum ExportRateProvenance: String, Codable, Equatable, Sendable {
    case published
    case netMetering = "net_metering"
    case inherited
    case manual
    case tesla
}

public enum TariffApproximationKind: String, Codable, Equatable, Sendable {
    case tierBlended = "tier_blended"
    case exportInheritedFromTesla = "export_inherited_from_tesla"
    case exportNetMeteringAssumed = "export_net_metering_assumed"
    case exportFallbackZero = "export_fallback_zero"
    case holidayWeekendSchedule = "holiday_weekend_schedule"
    /// The plan has rules for specific days the weekday/weekend comparison can't show.
    case daySpecificSchedule = "day_specific_schedule"
    case other

    /// A kind added on the server later reads as `other`, so the note still shows.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .other
    }
}

public struct TariffApproximationNote: Codable, Equatable, Sendable {
    public let kind: TariffApproximationKind
    public let message: String
}
