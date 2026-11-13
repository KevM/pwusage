import Foundation

enum SolarHealthConfidence: String, Codable, Equatable, Sendable {
    case initial
    case confident

    var label: String {
        switch self {
        case .initial: "First estimate"
        case .confident: "Confident"
        }
    }
}

enum SolarHealthFindingKind: String, Codable, Equatable, Sendable {
    case shading
    case shadingGrowth
    case soiling
    case aging
    case stepFault
    case lowOutput
}

/// One plain-language health observation backed by clear-day evidence.
struct SolarHealthFinding: Identifiable, Equatable, Sendable {
    let id: String
    let kind: SolarHealthFindingKind
    let title: String
    let detail: String
    let clearDays: Int
    let confidence: SolarHealthConfidence
    /// Findings below minimum evidence are stored but not shown.
    let meetsMinimumEvidence: Bool
    let season: SolarSeason?
    let azimuthFrom: Double?
    let azimuthTo: Double?
}

struct SolarHealthShadingEntry: Equatable, Sendable {
    let season: SolarSeason
    let azimuthFrom: Double
    let azimuthTo: Double
    let maxElevation: Double
    let clearDays: Int
    let grew: Bool
}

struct SolarHealthYearEntry: Identifiable, Equatable, Sendable {
    var id: Int { year }
    let year: Int
    let factor: Double
    let clearDays: Int
}

struct SolarHealthMonthEntry: Identifiable, Equatable, Sendable {
    var id: String { "\(year)-\(month)" }
    let year: Int
    let month: Int
    let factor: Double
    let clearDays: Int
}

/// Classified health report for a site, derived from `SolarHealthResult`.
struct SolarHealthReport: Equatable, Sendable {
    struct PotentialVsActual: Equatable, Sendable {
        let day: String
        let expectedKwh: Double
        let actualKwh: Double
        var isAsNew = false
        var differenceKwh: Double { actualKwh - expectedKwh }
        var ratio: Double { expectedKwh > 0 ? actualKwh / expectedKwh : 0 }
    }

    struct HealthScore: Equatable, Sendable {
        let scoreVsNew: Double
        let comparedMonths: Int
        let ratedEfficiency: Double
        let nameplateKw: Double
        let bandPercent: Double
        let perDirection: [SolarHealthCapacity.Direction]
        let baseline: SolarHealthBaseline
        var isProvisional: Bool { baseline.isProvisional }
        /// Emphasis colour: frozen and below 100% − band.
        var isBelowBand: Bool { !isProvisional && scoreVsNew < 1 - bandPercent / 100 }
        /// The check-your-panels prompt: frozen and above the healthy range.
        let isAboveHealthyRange: Bool
    }

    struct ShadingSummary: Equatable, Sendable {
        let entries: [SolarHealthShadingEntry]
        var isShaded: Bool { !entries.isEmpty }
        var hasGrowth: Bool { entries.contains(where: \.grew) }
    }

    struct DirtLevel: Equatable, Sendable {
        let currentLossPercent: Double?
        let lastRecoveredDay: String?
        let isActive: Bool
    }

    struct ChangeOverTime: Equatable, Sendable {
        let years: [SolarHealthYearEntry]
        let months: [SolarHealthMonthEntry]
        let agingPercentPerYear: Double?
        let expectedAgingPercentPerYear: Double?
        let agingConfidence: SolarHealthConfidence?
        let hasEnoughHistoryForTrend: Bool
    }

    let source: SolarHealthReference.Source
    let potentialVsActual: PotentialVsActual?
    let healthScore: HealthScore?
    let shading: ShadingSummary
    let dirtLevel: DirtLevel
    let changeOverTime: ChangeOverTime
    let dailyRatios: [SolarDailyRatio]
    let allFindings: [SolarHealthFinding]

    var visibleFindings: [SolarHealthFinding] {
        allFindings.filter(\.meetsMinimumEvidence)
    }

    var baseline: SolarHealthBaseline? {
        healthScore?.baseline
    }
}

extension SolarSeason {
    var displayName: String {
        switch self {
        case .winter: "winter"
        case .spring: "spring"
        case .summer: "summer"
        case .autumn: "autumn"
        }
    }

    var capitalizedName: String {
        displayName.capitalized
    }
}
