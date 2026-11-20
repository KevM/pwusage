import Foundation

enum TariffSource: String, Codable, Equatable, Sendable {
    case tesla
    case manual
    case estimated
}

enum TariffSelectionCandidateKind: String, Codable, Equatable, Sendable {
    case teslaSync = "tesla_sync"
    case automaticEstimate = "automatic_estimate"
    case manual
    case publicPlan = "public"
    case restoreTesla = "restore_tesla"
    case aiHandoff = "ai_handoff"
}

enum TariffStartSource: String, Codable, Equatable, Sendable {
    case urdb
    case teslaFirstSeen = "tesla_first_seen"
    case assumedJan1 = "assumed_jan_1"
    case historyStart = "history_start"
}

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

enum TariffPeriodName: String, Codable, Equatable, Sendable, CaseIterable, Hashable {
    // Declared in Tesla's order (cheapest first), which is also the picker order.
    case superOffPeak = "SUPER_OFF_PEAK"
    case offPeak = "OFF_PEAK"
    case partialPeak = "PARTIAL_PEAK"
    case onPeak = "ON_PEAK"

    var displayName: String {
        switch self {
        case .onPeak: "Peak"
        case .partialPeak: "Mid-Peak"
        case .offPeak: "Off-Peak"
        case .superOffPeak: "Super Off-Peak"
        }
    }
}

struct TimePeriodWindowInput: Codable, Equatable, Sendable, Hashable {
    let touName: TariffPeriodName
    let fromHour: Int
    let fromMinute: Int
    let toHour: Int
    let toMinute: Int
    let buyRate: Double
    let sellRate: Double
}

struct TariffSeasonInput: Codable, Equatable, Sendable, Hashable {
    let name: String
    let fromMonth: Int
    let toMonth: Int
    let weekdayPeriods: [TimePeriodWindowInput]
    let weekendPeriods: [TimePeriodWindowInput]
    /// Day-of-month bounds, sent for plans synced from Tesla whose seasons can start mid-month.
    /// Nil means a whole-month season (and older servers), as the plan editor writes them.
    var fromDay: Int?
    var toDay: Int?
}

struct TariffUpdatedByDTO: Codable, Equatable, Sendable {
    let email: String?
    let isCurrentUser: Bool
}

struct TariffPeriodDTO: Codable, Equatable, Sendable, Identifiable {
    let periodId: Int
    let tariffId: Int
    let name: String
    let version: Int
    let source: TariffSource
    let effectiveFrom: String
    let effectiveTo: String?
    let isCurrentToday: Bool
    let updatedBy: TariffUpdatedByDTO?
    let seasons: [TariffSeasonInput]
    var startSource: TariffStartSource?
    /// Selection provenance, from servers with rate plan selection.
    var selectionId: Int?
    var choiceKind: TariffSelectionChoiceKind?
    var candidateKind: TariffSelectionCandidateKind?
    var urdbLabel: String?
    var verification: TariffVerificationSummary?

    var id: Int { periodId }
}

struct TeslaSyncAttemptDTO: Codable, Equatable, Sendable {
    /// `sending`, `confirmed`, `unconfirmed`, `rejected`, `failed` or `not_allowed`.
    let status: String
    /// When the attempt finished, or when it started while it is still sending. Wire key `at`.
    let timestamp: String

    private enum CodingKeys: String, CodingKey {
        case status
        case timestamp = "at"
    }
}

struct TeslaSyncDTO: Codable, Equatable, Sendable {
    let latestTariffId: Int?
    let latestTariffName: String?
    let latestUpdatedAt: String?
    /// When the active custom plan was saved; nil from servers that predate the field.
    let activeManualUpdatedAt: String?
    let differsFromActiveManual: Bool
    /// True when Sync to Tesla can send today's plan now.
    let syncAvailable: Bool
    /// Why Sync to Tesla is unavailable (`no_difference`, `not_tou_capable`, `no_tesla_plan` or
    /// `no_active_plan`); nil when available.
    let syncUnavailableReason: String?
    /// The site's latest Sync to Tesla attempt, or nil when none was made.
    let lastSync: TeslaSyncAttemptDTO?
}

struct ActiveTariffPeriodMatch: Equatable, Sendable {
    let period: TariffPeriodDTO
    let season: TariffSeasonInput
    let window: TimePeriodWindowInput
}

struct SiteBatteryDTO: Codable, Equatable, Sendable {
    let nameplateEnergyWh: Double
    let nameplatePowerW: Double
    let backupReservePercent: Double
}

struct SiteTariffsTimelineResponse: Codable, Equatable, Sendable {
    let version: Int
    let siteId: String
    let timezone: String
    let currency: String
    let periods: [TariffPeriodDTO]
    let referencePeriods: [TariffPeriodDTO]
    let battery: SiteBatteryDTO?
    let reattribution: ReattributionStatusDTO?
    /// Observed holidays (site-local YYYY-MM-DD); they follow the weekend schedule. Nil from older servers.
    var holidayDates: [String]?
    let teslaSync: TeslaSyncDTO
    var estimates: SiteRateEstimatesDTO?
    var systemCosts: SystemCostsDTO?
    /// The site's stored country and public-plan eligibility; nil from older servers.
    var rateCountry: SiteRateCountryDTO?

    private enum CodingKeys: String, CodingKey {
        case version
        case siteId
        case timezone
        case currency
        case periods
        case referencePeriods
        case battery
        case reattribution
        case holidayDates
        case teslaSync
        case estimates
        case systemCosts
        case rateCountry
    }

    init(
        version: Int,
        siteId: String,
        timezone: String,
        currency: String,
        periods: [TariffPeriodDTO],
        referencePeriods: [TariffPeriodDTO] = [],
        battery: SiteBatteryDTO? = nil,
        reattribution: ReattributionStatusDTO?,
        holidayDates: [String]? = nil,
        teslaSync: TeslaSyncDTO,
        estimates: SiteRateEstimatesDTO? = nil,
        systemCosts: SystemCostsDTO? = nil,
        rateCountry: SiteRateCountryDTO? = nil
    ) {
        self.version = version
        self.siteId = siteId
        self.timezone = timezone
        self.currency = currency
        self.periods = periods
        self.referencePeriods = referencePeriods
        self.battery = battery
        self.reattribution = reattribution
        self.holidayDates = holidayDates
        self.teslaSync = teslaSync
        self.estimates = estimates
        self.systemCosts = systemCosts
        self.rateCountry = rateCountry
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        siteId = try container.decode(String.self, forKey: .siteId)
        timezone = try container.decode(String.self, forKey: .timezone)
        currency = try container.decode(String.self, forKey: .currency)
        periods = try container.decode([TariffPeriodDTO].self, forKey: .periods)
        referencePeriods = try container.decodeIfPresent([TariffPeriodDTO].self, forKey: .referencePeriods) ?? []
        battery = try container.decodeIfPresent(SiteBatteryDTO.self, forKey: .battery)
        reattribution = try container.decodeIfPresent(ReattributionStatusDTO.self, forKey: .reattribution)
        holidayDates = try container.decodeIfPresent([String].self, forKey: .holidayDates)
        teslaSync = try container.decode(TeslaSyncDTO.self, forKey: .teslaSync)
        estimates = try container.decodeIfPresent(SiteRateEstimatesDTO.self, forKey: .estimates)
        systemCosts = try container.decodeIfPresent(SystemCostsDTO.self, forKey: .systemCosts)
        rateCountry = try container.decodeIfPresent(SiteRateCountryDTO.self, forKey: .rateCountry)
    }

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

    /// Servers with reviewed rate plan selection always send the site's country.
    var supportsRatePlanSelection: Bool { rateCountry != nil }

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
