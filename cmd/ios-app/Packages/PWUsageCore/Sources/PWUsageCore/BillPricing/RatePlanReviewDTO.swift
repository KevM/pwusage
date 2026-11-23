import Foundation

// Response side of the rate plan selection contract: the server-built review an owner must
// see before a change applies. Mirrors `TariffSelectionPreviewResponse` and its parts in
// `cmd/next-app/src/lib/tariff-contract.ts`.

public struct TariffReviewDateRange: Codable, Equatable, Sendable {
    public let fromDate: String
    let toDate: String?
}

public struct TariffReviewPlanSnapshot: Decodable, Equatable, Sendable {
    let tariffId: Int?
    let version: Int?
    let periodId: Int?
    let selectionId: Int?
    public let name: String
    let utilityName: String?
    public let source: TariffSource
    let choiceKind: TariffSelectionChoiceKind
    let urdbLabel: String?
    /// Informational only; never a default effective date.
    public let revisionStart: String?
    let contentHash: String?
    let exportRateProvenance: ExportRateProvenance
    let holidaysUseWeekendSchedule: Bool
    public let seasons: [TariffSeasonInput]
    let approximationNotes: [TariffApproximationNote]
    let verification: TariffVerificationSummary?

    /// A plan snapshot assembled locally without server identity or verification.
    public init(
        name: String,
        utilityName: String? = nil,
        source: TariffSource,
        choiceKind: TariffSelectionChoiceKind,
        urdbLabel: String? = nil,
        exportRateProvenance: ExportRateProvenance,
        seasons: [TariffSeasonInput]
    ) {
        tariffId = nil
        version = nil
        periodId = nil
        selectionId = nil
        self.name = name
        self.utilityName = utilityName
        self.source = source
        self.choiceKind = choiceKind
        self.urdbLabel = urdbLabel
        revisionStart = nil
        contentHash = nil
        self.exportRateProvenance = exportRateProvenance
        holidaysUseWeekendSchedule = false
        self.seasons = seasons
        approximationNotes = []
        verification = nil
    }
}

public struct TariffComparisonSlotRate: Decodable, Equatable, Sendable {
    public let touName: TariffPeriodName
    public let buyRate: Double
    public let sellRate: Double
}

public struct TariffAlignedTimeRow: Decodable, Equatable, Sendable {
    public let fromHour: Int
    public let fromMinute: Int
    public let toHour: Int
    public let toMinute: Int
    public let before: TariffComparisonSlotRate?
    public let after: TariffComparisonSlotRate?
    let buyRateDelta: Double?
    let sellRateDelta: Double?
    public let buyRateChanged: Bool
    public let sellRateChanged: Bool
    let rateChanged: Bool
    let periodNameChanged: Bool
}

public struct TariffAlignedSeasonComparison: Decodable, Equatable, Sendable {
    public let fromMonth: Int
    public let fromDay: Int
    public let toMonth: Int
    public let toDay: Int
    public let beforeSeasonName: String?
    public let afterSeasonName: String?
    public let weekdayRows: [TariffAlignedTimeRow]
    public let weekendRows: [TariffAlignedTimeRow]
    let hasBuyRateChanges: Bool
    let hasSellRateChanges: Bool
    let hasRateChanges: Bool
    let hasPeriodNameChanges: Bool
}

public struct TariffRestorationOriginalRef: Decodable, Equatable, Sendable {
    let originalSelectionId: Int?
    let tariffId: Int
    public let name: String
    let version: Int?
    let contentHash: String?
    let effectiveFrom: String
    let effectiveTo: String?
}

public enum TariffIntervalRestorationProvenance: Decodable, Equatable, Sendable {
    case notApplicable
    case preservesTeslaOriginal(TariffRestorationOriginalRef)
    case restoringOriginal(TariffRestorationOriginalRef)
    case unavailable(reason: String)

    private enum CodingKeys: String, CodingKey { case status, original, reason }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .status) {
        case "not_applicable":
            self = .notApplicable
        case "preserves_tesla_original":
            self = .preservesTeslaOriginal(try container.decode(TariffRestorationOriginalRef.self, forKey: .original))
        case "restoring_original":
            self = .restoringOriginal(try container.decode(TariffRestorationOriginalRef.self, forKey: .original))
        case "unavailable":
            self = .unavailable(reason: try container.decode(String.self, forKey: .reason))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .status, in: container, debugDescription: "Unknown restoration status")
        }
    }
}

public enum TariffReviewAffectedIntervalKind: String, Decodable, Equatable, Sendable {
    case replace
    case fillGap = "fill_gap"
    case restore
    case restoreUnavailable = "restore_unavailable"
}

public struct TariffReviewAffectedInterval: Decodable, Equatable, Sendable {
    public let effectiveFrom: String
    public let effectiveTo: String?
    public let kind: TariffReviewAffectedIntervalKind
    public let before: TariffReviewPlanSnapshot?
    /// A gap billed today with a borrowed plan (the nearest earlier one, or else the earliest), so
    /// `before` is that plan rather than one saved for these dates.
    public let beforeIsFallback: Bool
    public let after: TariffReviewPlanSnapshot?
    public let seasons: [TariffAlignedSeasonComparison]
    let hasBuyRateChanges: Bool
    let hasSellRateChanges: Bool
    public let hasRateChanges: Bool
    public let hasPeriodNameChanges: Bool
    public let restoration: TariffIntervalRestorationProvenance

    /// A locally assembled interval without aligned comparisons or restoration information.
    public init(
        selection: TariffSelectionRequest,
        kind: TariffReviewAffectedIntervalKind,
        before: TariffReviewPlanSnapshot?,
        after: TariffReviewPlanSnapshot?,
        hasBuyRateChanges: Bool,
        hasSellRateChanges: Bool = false
    ) {
        effectiveFrom = selection.effectiveFrom
        effectiveTo = selection.effectiveTo
        self.kind = kind
        self.before = before
        beforeIsFallback = false
        self.after = after
        seasons = []
        self.hasBuyRateChanges = hasBuyRateChanges
        self.hasSellRateChanges = hasSellRateChanges
        hasRateChanges = hasBuyRateChanges || hasSellRateChanges
        hasPeriodNameChanges = before?.name != after?.name
        restoration = .notApplicable
    }
}

public struct TariffReviewUnchangedPeriod: Decodable, Equatable, Sendable {
    enum Relation: String, Decodable, Equatable, Sendable {
        case beforeRange = "before_range"
        case afterRange = "after_range"
    }

    public let effectiveFrom: String
    public let effectiveTo: String?
    let relation: Relation
    let wasTrimmed: Bool
    let originalEffectiveFrom: String
    let originalEffectiveTo: String?
    public let plan: TariffReviewPlanSnapshot
}

struct TariffReviewUnavailableRange: Decodable, Equatable, Sendable {
    let effectiveFrom: String
    let effectiveTo: String?
    let reason: String
}

public struct TariffReviewRestorationSummary: Decodable, Equatable, Sendable {
    let preservedOriginals: [TariffRestorationOriginalRef]
    let restoredOriginals: [TariffRestorationOriginalRef]
    let unavailableRanges: [TariffReviewUnavailableRange]
    public let canApplyRestoration: Bool
}

struct TariffReviewSummary: Decodable, Equatable, Sendable {
    let hasBuyRateChanges: Bool
    let hasSellRateChanges: Bool
    let hasRateChanges: Bool
    let hasPeriodNameChanges: Bool
    let fillsGap: Bool
    let replacesExistingPlan: Bool
}

public struct TariffSelectionPreviewResponse: Decodable, Equatable, Sendable {
    public let reviewHash: String
    public let siteId: String
    public let scope: TariffSelectionScope
    public let effectiveFrom: String
    public let effectiveTo: String?
    public let currency: String
    public let unit: String
    public let timezone: String
    public let holidaysUseWeekendSchedule: Bool
    public let recalculatesHistory: Bool
    /// The change reaches the earliest plan, so every earlier day is repriced too; the range's
    /// start is then the server's internal history floor, not a date to show.
    public let recalculatesFromHistoryStart: Bool
    public let recalculationRange: TariffReviewDateRange?
    /// Always false: saving in PWUsage never changes the plan on the Powerwall.
    public let affectsPowerwallPlan: Bool
    public let candidatePlan: TariffReviewPlanSnapshot?
    public let affectedIntervals: [TariffReviewAffectedInterval]
    public let unchangedOutsidePeriods: [TariffReviewUnchangedPeriod]
    public let restoration: TariffReviewRestorationSummary
    public let approximationNotes: [TariffApproximationNote]
    let summary: TariffReviewSummary

    /// A locally assembled review for one interval, with no historical repricing.
    public init(
        reviewHash: String,
        siteID: String,
        timeline: SiteTariffsTimelineResponse,
        selection: TariffSelectionRequest,
        affectedInterval: TariffReviewAffectedInterval
    ) {
        self.reviewHash = reviewHash
        siteId = siteID
        scope = selection.scope
        effectiveFrom = selection.effectiveFrom
        effectiveTo = selection.effectiveTo
        currency = timeline.currency
        unit = "kWh"
        timezone = timeline.timezone
        holidaysUseWeekendSchedule = affectedInterval.after?.holidaysUseWeekendSchedule ?? false
        recalculatesHistory = false
        recalculatesFromHistoryStart = false
        recalculationRange = nil
        affectsPowerwallPlan = false
        candidatePlan = affectedInterval.after
        affectedIntervals = [affectedInterval]
        unchangedOutsidePeriods = []
        restoration = TariffReviewRestorationSummary(
            preservedOriginals: [], restoredOriginals: [], unavailableRanges: [], canApplyRestoration: false
        )
        approximationNotes = []
        summary = TariffReviewSummary(
            hasBuyRateChanges: affectedInterval.hasBuyRateChanges,
            hasSellRateChanges: affectedInterval.hasSellRateChanges,
            hasRateChanges: affectedInterval.hasRateChanges,
            hasPeriodNameChanges: affectedInterval.hasPeriodNameChanges,
            fillsGap: affectedInterval.kind == .fillGap,
            replacesExistingPlan: affectedInterval.kind == .replace
        )
    }
}
