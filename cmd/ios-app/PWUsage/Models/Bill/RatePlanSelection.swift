import Foundation
import PWUsageCore

/// Where a plan's export (sell) rates came from.
enum ExportRateProvenance: String, Codable, Equatable, Sendable {
    case published
    case netMetering = "net_metering"
    case inherited
    case manual
    case tesla
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

struct TariffAiHandoffCommitResponse: Decodable, Equatable, Sendable {
    let selectionIds: [Int]
    let tariffIds: [Int]
    let appliedActualCount: Int
    let appliedReferenceCount: Int
    let unchanged: Bool
    let reattributionRange: TariffReviewDateRange?
    let timeline: SiteTariffsTimelineResponse
}
