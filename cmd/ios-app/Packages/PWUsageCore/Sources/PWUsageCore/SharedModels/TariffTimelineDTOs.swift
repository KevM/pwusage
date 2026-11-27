public enum TariffSource: String, Codable, Equatable, Sendable {
    case tesla
    case manual
    case estimated
}

public enum TariffSelectionCandidateKind: String, Codable, Equatable, Sendable {
    case teslaSync = "tesla_sync"
    case automaticEstimate = "automatic_estimate"
    case manual
    case publicPlan = "public"
    case restoreTesla = "restore_tesla"
    case aiHandoff = "ai_handoff"
}

public enum TariffStartSource: String, Codable, Equatable, Sendable {
    case urdb
    case teslaFirstSeen = "tesla_first_seen"
    case assumedJan1 = "assumed_jan_1"
    case historyStart = "history_start"
}

public enum TariffPeriodName: String, Codable, Equatable, Sendable, CaseIterable, Hashable {
    // Declared in Tesla's order (cheapest first), which is also the picker order.
    case superOffPeak = "SUPER_OFF_PEAK"
    case offPeak = "OFF_PEAK"
    case partialPeak = "PARTIAL_PEAK"
    case onPeak = "ON_PEAK"

    public var displayName: String {
        switch self {
        case .onPeak: "Peak"
        case .partialPeak: "Mid-Peak"
        case .offPeak: "Off-Peak"
        case .superOffPeak: "Super Off-Peak"
        }
    }
}

public struct TimePeriodWindowInput: Codable, Equatable, Sendable, Hashable {
    public let touName: TariffPeriodName
    public let fromHour: Int
    public let fromMinute: Int
    public let toHour: Int
    public let toMinute: Int
    public let buyRate: Double
    public let sellRate: Double

    public init(
        touName: TariffPeriodName,
        fromHour: Int,
        fromMinute: Int,
        toHour: Int,
        toMinute: Int,
        buyRate: Double,
        sellRate: Double
    ) {
        self.touName = touName
        self.fromHour = fromHour
        self.fromMinute = fromMinute
        self.toHour = toHour
        self.toMinute = toMinute
        self.buyRate = buyRate
        self.sellRate = sellRate
    }
}

public struct TariffSeasonInput: Codable, Equatable, Sendable, Hashable {
    public let name: String
    public let fromMonth: Int
    public let toMonth: Int
    public let weekdayPeriods: [TimePeriodWindowInput]
    public let weekendPeriods: [TimePeriodWindowInput]
    /// Day-of-month bounds, sent for plans synced from Tesla whose seasons can start mid-month.
    /// Nil means a whole-month season (and older servers), as the plan editor writes them.
    public var fromDay: Int?
    public var toDay: Int?

    public init(
        name: String,
        fromMonth: Int,
        toMonth: Int,
        weekdayPeriods: [TimePeriodWindowInput],
        weekendPeriods: [TimePeriodWindowInput],
        fromDay: Int? = nil,
        toDay: Int? = nil
    ) {
        self.name = name
        self.fromMonth = fromMonth
        self.toMonth = toMonth
        self.weekdayPeriods = weekdayPeriods
        self.weekendPeriods = weekendPeriods
        self.fromDay = fromDay
        self.toDay = toDay
    }
}

public struct TariffUpdatedByDTO: Codable, Equatable, Sendable {
    public let email: String?
    public let isCurrentUser: Bool

    public init(email: String?, isCurrentUser: Bool) {
        self.email = email
        self.isCurrentUser = isCurrentUser
    }
}

public struct TariffPeriodDTO: Codable, Equatable, Sendable, Identifiable {
    public let periodId: Int
    public let tariffId: Int
    public let name: String
    public let version: Int
    public let source: TariffSource
    public let effectiveFrom: String
    public let effectiveTo: String?
    public let isCurrentToday: Bool
    public let updatedBy: TariffUpdatedByDTO?
    public let seasons: [TariffSeasonInput]
    public var startSource: TariffStartSource?
    /// Selection provenance, from servers with rate plan selection.
    public var selectionId: Int?
    public var choiceKind: TariffSelectionChoiceKind?
    public var candidateKind: TariffSelectionCandidateKind?
    public var urdbLabel: String?
    public var verification: TariffVerificationSummary?

    public var id: Int { periodId }

    public init(
        periodId: Int,
        tariffId: Int,
        name: String,
        version: Int,
        source: TariffSource,
        effectiveFrom: String,
        effectiveTo: String?,
        isCurrentToday: Bool,
        updatedBy: TariffUpdatedByDTO?,
        seasons: [TariffSeasonInput],
        startSource: TariffStartSource? = nil,
        selectionId: Int? = nil,
        choiceKind: TariffSelectionChoiceKind? = nil,
        candidateKind: TariffSelectionCandidateKind? = nil,
        urdbLabel: String? = nil,
        verification: TariffVerificationSummary? = nil
    ) {
        self.periodId = periodId
        self.tariffId = tariffId
        self.name = name
        self.version = version
        self.source = source
        self.effectiveFrom = effectiveFrom
        self.effectiveTo = effectiveTo
        self.isCurrentToday = isCurrentToday
        self.updatedBy = updatedBy
        self.seasons = seasons
        self.startSource = startSource
        self.selectionId = selectionId
        self.choiceKind = choiceKind
        self.candidateKind = candidateKind
        self.urdbLabel = urdbLabel
        self.verification = verification
    }
}

public struct TeslaSyncAttemptDTO: Codable, Equatable, Sendable {
    /// `sending`, `confirmed`, `unconfirmed`, `rejected`, `failed` or `not_allowed`.
    public let status: String
    /// When the attempt finished, or when it started while it is still sending. Wire key `at`.
    public let timestamp: String

    public init(status: String, timestamp: String) {
        self.status = status
        self.timestamp = timestamp
    }

    private enum CodingKeys: String, CodingKey {
        case status
        case timestamp = "at"
    }
}

public struct TeslaSyncDTO: Codable, Equatable, Sendable {
    public let latestTariffId: Int?
    public let latestTariffName: String?
    public let latestUpdatedAt: String?
    /// When the active custom plan was saved; nil from servers that predate the field.
    public let activeManualUpdatedAt: String?
    public let differsFromActiveManual: Bool
    /// True when Sync to Tesla can send today's plan now.
    public let syncAvailable: Bool
    /// Why Sync to Tesla is unavailable (`no_difference`, `not_tou_capable`, `no_tesla_plan` or
    /// `no_active_plan`); nil when available.
    public let syncUnavailableReason: String?
    /// The site's latest Sync to Tesla attempt, or nil when none was made.
    public let lastSync: TeslaSyncAttemptDTO?

    public init(
        latestTariffId: Int?,
        latestTariffName: String?,
        latestUpdatedAt: String?,
        activeManualUpdatedAt: String?,
        differsFromActiveManual: Bool,
        syncAvailable: Bool,
        syncUnavailableReason: String?,
        lastSync: TeslaSyncAttemptDTO?
    ) {
        self.latestTariffId = latestTariffId
        self.latestTariffName = latestTariffName
        self.latestUpdatedAt = latestUpdatedAt
        self.activeManualUpdatedAt = activeManualUpdatedAt
        self.differsFromActiveManual = differsFromActiveManual
        self.syncAvailable = syncAvailable
        self.syncUnavailableReason = syncUnavailableReason
        self.lastSync = lastSync
    }
}

public struct ActiveTariffPeriodMatch: Equatable, Sendable {
    public let period: TariffPeriodDTO
    public let season: TariffSeasonInput
    public let window: TimePeriodWindowInput

    public init(period: TariffPeriodDTO, season: TariffSeasonInput, window: TimePeriodWindowInput) {
        self.period = period
        self.season = season
        self.window = window
    }
}

public struct SiteBatteryDTO: Codable, Equatable, Sendable {
    public let nameplateEnergyWh: Double
    public let nameplatePowerW: Double
    public let backupReservePercent: Double

    public init(nameplateEnergyWh: Double, nameplatePowerW: Double, backupReservePercent: Double) {
        self.nameplateEnergyWh = nameplateEnergyWh
        self.nameplatePowerW = nameplatePowerW
        self.backupReservePercent = backupReservePercent
    }
}

public struct SiteTariffsTimelineResponse: Codable, Equatable, Sendable {
    public let version: Int
    public let siteId: String
    public let timezone: String
    public let currency: String
    public let periods: [TariffPeriodDTO]
    public let referencePeriods: [TariffPeriodDTO]
    public let battery: SiteBatteryDTO?
    public let reattribution: ReattributionStatusDTO?
    /// Observed holidays (site-local YYYY-MM-DD); they follow the weekend schedule. Nil from older servers.
    public var holidayDates: [String]?
    public let teslaSync: TeslaSyncDTO
    public var estimates: SiteRateEstimatesDTO?
    public var systemCosts: SystemCostsDTO?
    /// The site's stored country and public-plan eligibility; nil from older servers.
    public var rateCountry: SiteRateCountryDTO?

    /// Servers with reviewed rate plan selection always send the site's country.
    public var supportsRatePlanSelection: Bool { rateCountry != nil }

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

    public init(
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

    public init(from decoder: Decoder) throws {
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
}
