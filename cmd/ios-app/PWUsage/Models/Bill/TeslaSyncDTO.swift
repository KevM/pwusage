import Foundation

/// PWUsage's plan for today, as the sync would send it, next to Tesla's plan as it stands now.
struct TeslaSyncPreviewDTO: Decodable, Equatable, Sendable {
    let fingerprint: String
    let current: TeslaSyncPlanDTO
    let proposed: TeslaSyncProposedPlanDTO
    let adjustments: [TeslaSyncAdjustmentDTO]
    let problems: [TeslaSyncProblemDTO]
    /// True when the plan comes from public utility rates rather than the owner's own entry.
    let estimated: Bool
}

struct TeslaSyncPlanDTO: Decodable, Equatable, Sendable {
    let name: String
    let seasons: [TariffSeasonInput]
}

struct TeslaSyncProposedPlanDTO: Decodable, Equatable, Sendable {
    let name: String
    let seasons: [TariffSeasonInput]
    let source: TariffSource
    let selectionId: Int?
}

/// One rate Tesla will store differently from PWUsage's own value. `side` is `buy` or `sell`.
struct TeslaSyncAdjustmentDTO: Decodable, Equatable, Sendable {
    let season: String
    let period: TariffPeriodName
    let side: String
    let from: Double
    let stored: Double
    let reason: String

    private enum CodingKeys: String, CodingKey {
        case season, period, side, from, reason
        case stored = "to"
    }
}

struct TeslaSyncProblemDTO: Decodable, Equatable, Sendable {
    let code: String
    let season: String?
    let period: TariffPeriodName?
    let message: String
}

/// The commit's answer. `outcome` is one of the server's outcome strings; `timeline` comes back on
/// `confirmed` (and may on `unconfirmed`).
struct TeslaSyncResultDTO: Decodable, Equatable, Sendable {
    let outcome: String
    let message: String?
    let timeline: SiteTariffsTimelineResponse?
}

/// A 409 from the preview: nothing can be sent right now. `reason` is the server's stable code.
struct TeslaSyncUnavailability: LocalizedError, Equatable, Sendable {
    let reason: String
    let message: String

    var errorDescription: String? { message }
}
