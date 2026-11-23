import Foundation

/// PWUsage's plan for today, as the sync would send it, next to Tesla's plan as it stands now.
public struct TeslaSyncPreviewDTO: Decodable, Equatable, Sendable {
    public let fingerprint: String
    public let current: TeslaSyncPlanDTO
    public let proposed: TeslaSyncProposedPlanDTO
    public let adjustments: [TeslaSyncAdjustmentDTO]
    public let problems: [TeslaSyncProblemDTO]
    /// True when the plan comes from public utility rates rather than the owner's own entry.
    public let estimated: Bool
}

public struct TeslaSyncPlanDTO: Decodable, Equatable, Sendable {
    public let name: String
    public let seasons: [TariffSeasonInput]
}

public struct TeslaSyncProposedPlanDTO: Decodable, Equatable, Sendable {
    public let name: String
    public let seasons: [TariffSeasonInput]
    public let source: TariffSource
    public let selectionId: Int?
}

/// One rate Tesla will store differently from PWUsage's own value. `side` is `buy` or `sell`.
public struct TeslaSyncAdjustmentDTO: Decodable, Equatable, Sendable {
    let season: String
    public let period: TariffPeriodName
    public let side: String
    let from: Double
    public let stored: Double
    public let reason: String

    private enum CodingKeys: String, CodingKey {
        case season, period, side, from, reason
        case stored = "to"
    }
}

public struct TeslaSyncProblemDTO: Decodable, Equatable, Sendable {
    let code: String
    let season: String?
    let period: TariffPeriodName?
    public let message: String
}

/// The commit's answer. `outcome` is one of the server's outcome strings; `timeline` comes back on
/// `confirmed` (and may on `unconfirmed`).
public struct TeslaSyncResultDTO: Decodable, Equatable, Sendable {
    public let outcome: String
    public let message: String?
    public let timeline: SiteTariffsTimelineResponse?
}
