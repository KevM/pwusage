import Foundation

public enum SolarHealthConfidence: String, Codable, Equatable, Sendable {
    case initial
    case confident

    public var label: String {
        switch self {
        case .initial: "First estimate"
        case .confident: "Confident"
        }
    }
}

public enum SolarHealthFindingKind: String, Codable, Equatable, Sendable {
    case shading
    case shadingGrowth
    case soiling
    case aging
    case stepFault
    case lowOutput
}

/// One plain-language health observation backed by clear-day evidence.
public struct SolarHealthFinding: Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: SolarHealthFindingKind
    public let title: String
    public let detail: String
    public let clearDays: Int
    public let confidence: SolarHealthConfidence
    /// Findings below minimum evidence are stored but not shown.
    public let meetsMinimumEvidence: Bool
    public let season: SolarSeason?
    public let azimuthFrom: Double?
    public let azimuthTo: Double?

    public init(
        id: String,
        kind: SolarHealthFindingKind,
        title: String,
        detail: String,
        clearDays: Int,
        confidence: SolarHealthConfidence,
        meetsMinimumEvidence: Bool,
        season: SolarSeason? = nil,
        azimuthFrom: Double? = nil,
        azimuthTo: Double? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.detail = detail
        self.clearDays = clearDays
        self.confidence = confidence
        self.meetsMinimumEvidence = meetsMinimumEvidence
        self.season = season
        self.azimuthFrom = azimuthFrom
        self.azimuthTo = azimuthTo
    }
}

public struct SolarHealthShadingEntry: Equatable, Sendable {
    public let season: SolarSeason
    public let azimuthFrom: Double
    public let azimuthTo: Double
    public let maxElevation: Double
    public let clearDays: Int
    public let grew: Bool

    public init(
        season: SolarSeason,
        azimuthFrom: Double,
        azimuthTo: Double,
        maxElevation: Double,
        clearDays: Int,
        grew: Bool
    ) {
        self.season = season
        self.azimuthFrom = azimuthFrom
        self.azimuthTo = azimuthTo
        self.maxElevation = maxElevation
        self.clearDays = clearDays
        self.grew = grew
    }
}

public struct SolarHealthYearEntry: Identifiable, Equatable, Sendable {
    public var id: Int { year }
    public let year: Int
    public let factor: Double
    public let clearDays: Int

    public init(year: Int, factor: Double, clearDays: Int) {
        self.year = year
        self.factor = factor
        self.clearDays = clearDays
    }
}

public struct SolarHealthMonthEntry: Identifiable, Equatable, Sendable {
    public var id: String { "\(year)-\(month)" }
    public let year: Int
    public let month: Int
    public let factor: Double
    public let clearDays: Int

    public init(year: Int, month: Int, factor: Double, clearDays: Int) {
        self.year = year
        self.month = month
        self.factor = factor
        self.clearDays = clearDays
    }
}

/// Classified health report for a site, derived from `SolarHealthResult`.
public struct SolarHealthReport: Equatable, Sendable {
    public struct PotentialVsActual: Equatable, Sendable {
        public let day: String
        public let expectedKwh: Double
        public let actualKwh: Double
        public var isAsNew = false
        public var differenceKwh: Double { actualKwh - expectedKwh }
        public var ratio: Double { expectedKwh > 0 ? actualKwh / expectedKwh : 0 }

        public init(day: String, expectedKwh: Double, actualKwh: Double, isAsNew: Bool = false) {
            self.day = day
            self.expectedKwh = expectedKwh
            self.actualKwh = actualKwh
            self.isAsNew = isAsNew
        }
    }

    public struct HealthScore: Equatable, Sendable {
        public let scoreVsNew: Double
        public let comparedMonths: Int
        public let ratedEfficiency: Double
        public let nameplateKw: Double
        public let bandPercent: Double
        public let perDirection: [SolarHealthCapacity.Direction]
        public let baseline: SolarHealthBaseline
        public var isProvisional: Bool { baseline.isProvisional }
        /// Emphasis colour: frozen and below 100% − band.
        public var isBelowBand: Bool { !isProvisional && scoreVsNew < 1 - bandPercent / 100 }
        /// The check-your-panels prompt: frozen and above the healthy range.
        public let isAboveHealthyRange: Bool
    }

    public struct ShadingSummary: Equatable, Sendable {
        public let entries: [SolarHealthShadingEntry]
        public var isShaded: Bool { !entries.isEmpty }
        public var hasGrowth: Bool { entries.contains(where: \.grew) }

        public init(entries: [SolarHealthShadingEntry]) {
            self.entries = entries
        }
    }

    public struct DirtLevel: Equatable, Sendable {
        public let currentLossPercent: Double?
        public let lastRecoveredDay: String?
        public let isActive: Bool

        public init(currentLossPercent: Double?, lastRecoveredDay: String?, isActive: Bool) {
            self.currentLossPercent = currentLossPercent
            self.lastRecoveredDay = lastRecoveredDay
            self.isActive = isActive
        }
    }

    public struct ChangeOverTime: Equatable, Sendable {
        public let years: [SolarHealthYearEntry]
        public let months: [SolarHealthMonthEntry]
        public let agingPercentPerYear: Double?
        public let expectedAgingPercentPerYear: Double?
        public let agingConfidence: SolarHealthConfidence?
        public let hasEnoughHistoryForTrend: Bool

        public init(
            years: [SolarHealthYearEntry],
            months: [SolarHealthMonthEntry],
            agingPercentPerYear: Double?,
            expectedAgingPercentPerYear: Double?,
            agingConfidence: SolarHealthConfidence?,
            hasEnoughHistoryForTrend: Bool
        ) {
            self.years = years
            self.months = months
            self.agingPercentPerYear = agingPercentPerYear
            self.expectedAgingPercentPerYear = expectedAgingPercentPerYear
            self.agingConfidence = agingConfidence
            self.hasEnoughHistoryForTrend = hasEnoughHistoryForTrend
        }
    }

    public let source: SolarHealthReference.Source
    public let potentialVsActual: PotentialVsActual?
    public let healthScore: HealthScore?
    public let shading: ShadingSummary
    public let dirtLevel: DirtLevel
    public let changeOverTime: ChangeOverTime
    public let dailyRatios: [SolarDailyRatio]
    public let allFindings: [SolarHealthFinding]

    public init(
        source: SolarHealthReference.Source,
        potentialVsActual: PotentialVsActual?,
        healthScore: HealthScore?,
        shading: ShadingSummary,
        dirtLevel: DirtLevel,
        changeOverTime: ChangeOverTime,
        dailyRatios: [SolarDailyRatio],
        allFindings: [SolarHealthFinding]
    ) {
        self.source = source
        self.potentialVsActual = potentialVsActual
        self.healthScore = healthScore
        self.shading = shading
        self.dirtLevel = dirtLevel
        self.changeOverTime = changeOverTime
        self.dailyRatios = dailyRatios
        self.allFindings = allFindings
    }

    public var visibleFindings: [SolarHealthFinding] {
        allFindings.filter(\.meetsMinimumEvidence)
    }

    public var baseline: SolarHealthBaseline? {
        healthScore?.baseline
    }
}

extension SolarSeason {
    public var displayName: String {
        switch self {
        case .winter: "winter"
        case .spring: "spring"
        case .summer: "summer"
        case .autumn: "autumn"
        }
    }

    public var capitalizedName: String {
        displayName.capitalized
    }
}
