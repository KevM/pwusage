/// Whether a plan was placed automatically or chosen by an owner.
public enum TariffSelectionChoiceKind: String, Codable, Equatable, Sendable {
    case automatic
    case owner
}

public struct TariffVerificationSummary: Codable, Equatable, Sendable {
    public let verifiedAt: String
    public let verifiedByEmail: String?
    public let verifiedByCurrentUser: Bool

    public init(verifiedAt: String, verifiedByEmail: String?, verifiedByCurrentUser: Bool) {
        self.verifiedAt = verifiedAt
        self.verifiedByEmail = verifiedByEmail
        self.verifiedByCurrentUser = verifiedByCurrentUser
    }
}

/// Offer to walk the owner through past rate plans; mirrors `EstimatesStatusDTO.historyGuide`.
public struct RatePlanHistoryGuideDTO: Codable, Equatable, Sendable {
    public let historyStart: String
    public let fillThrough: String?
    public let unconfirmedDays: Int

    public init(historyStart: String, fillThrough: String?, unconfirmedDays: Int) {
        self.historyStart = historyStart
        self.fillThrough = fillThrough
        self.unconfirmedDays = unconfirmedDays
    }
}

/// Whether public (OpenEI) utility rate plans apply to a site. Mirrors `RatePlanEligibility` in
/// `cmd/next-app/src/lib/db-types.ts`. It is separate from estimate processing state.
public enum RatePlanEligibility: String, Codable, Equatable, Sendable {
    case unitedStates = "us"
    case outsideUS = "outside_us"
    case unknown
}

/// Where a site's stored country came from. An owner's choice always wins over inference.
public enum RateCountrySource: String, Codable, Equatable, Sendable {
    case solarLocation = "solar_location"
    case owner
}

/// `SiteRateCountryDTO` in `tariff-contract.ts`: the site's stored country and its provenance.
public struct SiteRateCountryDTO: Codable, Equatable, Sendable {
    public let countryCode: String?
    public let source: RateCountrySource?
    public let updatedAt: String?
    public let eligibility: RatePlanEligibility
    public var hasIneligiblePublicSelection: Bool?

    public init(
        countryCode: String?,
        source: RateCountrySource?,
        updatedAt: String?,
        eligibility: RatePlanEligibility,
        hasIneligiblePublicSelection: Bool? = nil
    ) {
        self.countryCode = countryCode
        self.source = source
        self.updatedAt = updatedAt
        self.eligibility = eligibility
        self.hasIneligiblePublicSelection = hasIneligiblePublicSelection
    }
}

public struct SiteRateEstimatesDTO: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Equatable, Sendable {
        case pending, ready, skipped, failed
        case needsUtility = "needs_utility"
        case needsPlan = "needs_plan"
    }

    public let status: Status
    public let utilityName: String?
    public let teslaPlanOutOfDate: Bool
    public let newerPlanName: String?
    /// YYYY-MM-DD start of the newer URDB revision behind `teslaPlanOutOfDate`.
    public let newerPlanStart: String?
    /// YYYY-MM-DD start of the newest URDB revision behind the estimate covering today.
    public let newestRevisionStart: String?
    /// True when that newest revision may have missed a rate change.
    public let mayBeOutdated: Bool
    /// Offer to walk the owner through past rate plans; nil when there is nothing to fill.
    public var historyGuide: RatePlanHistoryGuideDTO?
    /// Public-plan eligibility from the site's stored country; nil from older servers.
    public var eligibility: RatePlanEligibility?
    /// The site's country is unconfirmed: ask for it rather than offering a US utility search.
    public var needsCountryConfirmation: Bool?
    /// An owner-chosen public plan remains on a site where public plans no longer apply.
    public var hasIneligiblePublicSelection: Bool?

    public init(
        status: Status,
        utilityName: String?,
        teslaPlanOutOfDate: Bool,
        newerPlanName: String?,
        newerPlanStart: String?,
        newestRevisionStart: String?,
        mayBeOutdated: Bool,
        historyGuide: RatePlanHistoryGuideDTO? = nil,
        eligibility: RatePlanEligibility? = nil,
        needsCountryConfirmation: Bool? = nil,
        hasIneligiblePublicSelection: Bool? = nil
    ) {
        self.status = status
        self.utilityName = utilityName
        self.teslaPlanOutOfDate = teslaPlanOutOfDate
        self.newerPlanName = newerPlanName
        self.newerPlanStart = newerPlanStart
        self.newestRevisionStart = newestRevisionStart
        self.mayBeOutdated = mayBeOutdated
        self.historyGuide = historyGuide
        self.eligibility = eligibility
        self.needsCountryConfirmation = needsCountryConfirmation
        self.hasIneligiblePublicSelection = hasIneligiblePublicSelection
    }
}

/// One component's cost as the site stores it. Money is in the site currency.
public struct SystemCostDTO: Codable, Equatable, Sendable {
    public var installDate: String?
    public var price: Double
    /// Percent of the net price claimed back as a credit; nil when the credit is off.
    public var taxCreditPercent: Double?
    public var incentives: Double

    public init(installDate: String? = nil, price: Double, taxCreditPercent: Double? = nil, incentives: Double) {
        self.installDate = installDate
        self.price = price
        self.taxCreditPercent = taxCreditPercent
        self.incentives = incentives
    }

    private enum CodingKeys: String, CodingKey {
        case installDate, price, taxCreditPercent, incentives
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(installDate, forKey: .installDate)
        try container.encode(price, forKey: .price)
        try container.encode(taxCreditPercent, forKey: .taxCreditPercent)
        try container.encode(incentives, forKey: .incentives)
    }
}

public struct SystemCostsDTO: Codable, Equatable, Sendable {
    /// Site.installed as a site-local YYYY-MM-DD.
    public let siteInstalled: String
    public var solar: SystemCostDTO?
    public var powerwall: SystemCostDTO?

    public init(siteInstalled: String, solar: SystemCostDTO? = nil, powerwall: SystemCostDTO? = nil) {
        self.siteInstalled = siteInstalled
        self.solar = solar
        self.powerwall = powerwall
    }
}

public struct ReattributionStatusDTO: Codable, Equatable, Sendable {
    public let status: Status
    public let fromDate: String
    public let toDate: String?
    public let totalDays: Int
    public let processedDays: Int
    public let updatedDays: Int
    public let lastError: String?
    public let updatedAt: String

    public enum Status: String, Codable, Equatable, Sendable {
        case pending, running, idle, failed
    }

    public init(
        status: Status,
        fromDate: String,
        toDate: String?,
        totalDays: Int,
        processedDays: Int,
        updatedDays: Int,
        lastError: String?,
        updatedAt: String
    ) {
        self.status = status
        self.fromDate = fromDate
        self.toDate = toDate
        self.totalDays = totalDays
        self.processedDays = processedDays
        self.updatedDays = updatedDays
        self.lastError = lastError
        self.updatedAt = updatedAt
    }
}
