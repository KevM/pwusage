import Foundation

public struct TariffSelectionCommitResponse: Decodable, Equatable, Sendable {
    let selectionIds: [Int]
    let tariffIds: [Int]
    let createdNewTariffVersion: Bool
    let unchanged: Bool
    let reattributionRange: TariffReviewDateRange?
    public let timeline: SiteTariffsTimelineResponse

    public init(
        selectionIds: [Int],
        tariffIds: [Int],
        createdNewTariffVersion: Bool,
        unchanged: Bool,
        reattributionRange: TariffReviewDateRange? = nil,
        timeline: SiteTariffsTimelineResponse
    ) {
        self.selectionIds = selectionIds
        self.tariffIds = tariffIds
        self.createdNewTariffVersion = createdNewTariffVersion
        self.unchanged = unchanged
        self.reattributionRange = reattributionRange
        self.timeline = timeline
    }
}

public struct TariffAiHandoffExportResponse: Decodable, Equatable, Sendable {
    public let markdown: String
    public let filename: String

    public init(markdown: String, filename: String) {
        self.markdown = markdown
        self.filename = filename
    }
}

public struct TariffAiHandoffPreviewResponse: Decodable, Equatable, Sendable, Identifiable {
    public let reviewHash: String
    public let siteId: String
    public let currency: String
    let unit: String
    let timezone: String
    public let notes: [String]
    public let sources: [String]
    let unchangedActualCount: Int
    let unchangedReferenceCount: Int
    public let actualPreviews: [TariffSelectionPreviewResponse]
    public let referencePreviews: [TariffSelectionPreviewResponse]
    let recalculatesHistory: Bool
    let recalculatesFromHistoryStart: Bool
    let recalculationRange: TariffReviewDateRange?
    let affectsPowerwallPlan: Bool

    public var id: String { reviewHash }

    public var hasChanges: Bool {
        !actualPreviews.isEmpty || !referencePreviews.isEmpty
    }
}

public struct TariffAiHandoffCommitResponse: Decodable, Equatable, Sendable {
    let selectionIds: [Int]
    let tariffIds: [Int]
    let appliedActualCount: Int
    let appliedReferenceCount: Int
    let unchanged: Bool
    let reattributionRange: TariffReviewDateRange?
    public let timeline: SiteTariffsTimelineResponse
}
