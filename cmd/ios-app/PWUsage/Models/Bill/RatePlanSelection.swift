import Foundation
import PWUsageCore

// Request side of the rate plan selection contract. Mirrors `TariffSelectionRequest` and
// `TariffSelectionCommit` in `cmd/next-app/src/lib/tariff-contract.ts`.

/// Which timeline a selection changes: the plan that prices energy, or the comparison plan.
enum TariffSelectionScope: String, Codable, Equatable, Sendable {
    case actual
    case reference
}

/// Where a plan's export (sell) rates came from.
enum ExportRateProvenance: String, Codable, Equatable, Sendable {
    case published
    case netMetering = "net_metering"
    case inherited
    case manual
    case tesla
}

/// The plan an owner wants to apply. The app never sends published rates for a public plan;
/// the server resolves the label itself.
enum TariffSelectionCandidate: Encodable, Equatable, Sendable {
    case publicPlan(label: String)
    case manual(name: String, seasons: [TariffSeasonInput])
    case restoreTesla(originalSelectionID: Int)

    private enum CodingKeys: String, CodingKey { case kind, label, name, seasons, originalSelectionId }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .publicPlan(let label):
            try container.encode("public", forKey: .kind)
            try container.encode(label, forKey: .label)
        case .manual(let name, let seasons):
            try container.encode("manual", forKey: .kind)
            try container.encode(name, forKey: .name)
            try container.encode(seasons, forKey: .seasons)
        case .restoreTesla(let originalSelectionID):
            try container.encode("restore_tesla", forKey: .kind)
            try container.encode(originalSelectionID, forKey: .originalSelectionId)
        }
    }
}

/// The dates are always explicit: `effectiveTo == nil` means ongoing, and is sent as `null`.
struct TariffSelectionRequest: Encodable, Equatable, Sendable {
    let scope: TariffSelectionScope
    let candidate: TariffSelectionCandidate
    let effectiveFrom: String
    let effectiveTo: String?

    private enum CodingKeys: String, CodingKey { case scope, candidate, effectiveFrom, effectiveTo }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(scope, forKey: .scope)
        try container.encode(candidate, forKey: .candidate)
        try container.encode(effectiveFrom, forKey: .effectiveFrom)
        try container.encode(effectiveTo, forKey: .effectiveTo)
    }
}

/// Applies a reviewed selection. `expectedReviewHash` comes from the preview the owner saw;
/// bill verification is a separate, explicit choice.
struct TariffSelectionCommit: Encodable, Equatable, Sendable {
    let request: TariffSelectionRequest
    let expectedReviewHash: String
    let verifiedAgainstBill: Bool

    private enum CodingKeys: String, CodingKey { case expectedReviewHash, verifiedAgainstBill }

    func encode(to encoder: Encoder) throws {
        try request.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(expectedReviewHash, forKey: .expectedReviewHash)
        try container.encode(verifiedAgainstBill, forKey: .verifiedAgainstBill)
    }
}

struct TariffSelectionCommitResponse: Decodable, Equatable, Sendable {
    let selectionIds: [Int]
    let tariffIds: [Int]
    let createdNewTariffVersion: Bool
    let unchanged: Bool
    let reattributionRange: TariffReviewDateRange?
    let timeline: SiteTariffsTimelineResponse
}

/// Failures of the selection endpoints that the review flow handles specially.
enum RatePlanSelectionError: Error, Equatable {
    /// The timeline changed since the review. Show this fresh review; never apply it automatically.
    case reviewStale(TariffSelectionPreviewResponse)
    /// The timeline changed during AI handoff review. Show this fresh batch review.
    case aiHandoffReviewStale(TariffAiHandoffPreviewResponse)
    /// Public utility plans don't apply to this site (`outside_us`) or its country is unconfirmed.
    case publicPlansUnavailable(RatePlanEligibility)
}

struct TariffAiHandoffExportResponse: Decodable, Equatable, Sendable {
    let markdown: String
    let filename: String
}

struct TariffAiHandoffPreviewRequest: Encodable, Equatable, Sendable {
    let rawInput: String
}

struct TariffAiHandoffPreviewResponse: Decodable, Equatable, Sendable, Identifiable {
    let reviewHash: String
    let siteId: String
    let currency: String
    let unit: String
    let timezone: String
    let notes: [String]
    let sources: [String]
    let unchangedActualCount: Int
    let unchangedReferenceCount: Int
    let actualPreviews: [TariffSelectionPreviewResponse]
    let referencePreviews: [TariffSelectionPreviewResponse]
    let recalculatesHistory: Bool
    let recalculatesFromHistoryStart: Bool
    let recalculationRange: TariffReviewDateRange?
    let affectsPowerwallPlan: Bool

    var id: String { reviewHash }

    var hasChanges: Bool {
        !actualPreviews.isEmpty || !referencePreviews.isEmpty
    }

    func validating(siteID expectedSiteID: String) throws -> Self {
        guard siteId == expectedSiteID else { throw PWUsageAPIError.invalidResponse }
        return self
    }
}

struct TariffAiHandoffCommitRequest: Encodable, Equatable, Sendable {
    let rawInput: String
    let expectedReviewHash: String
    let verifiedAgainstBill: Bool
}

struct TariffAiHandoffCommitResponse: Decodable, Equatable, Sendable {
    let selectionIds: [Int]
    let tariffIds: [Int]
    let appliedActualCount: Int
    let appliedReferenceCount: Int
    let unchanged: Bool
    let reattributionRange: TariffReviewDateRange?
    let timeline: SiteTariffsTimelineResponse
}
