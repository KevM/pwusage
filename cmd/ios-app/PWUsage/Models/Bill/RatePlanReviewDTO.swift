import Foundation

// Response side of the rate plan selection contract: the server-built review an owner must
// see before a change applies. Mirrors `TariffSelectionPreviewResponse` and its parts in
// `cmd/next-app/src/lib/tariff-contract.ts`.

struct TariffReviewDateRange: Codable, Equatable, Sendable {
    let fromDate: String
    let toDate: String?
}

enum TariffApproximationKind: String, Codable, Equatable, Sendable {
    case tierBlended = "tier_blended"
    case exportInheritedFromTesla = "export_inherited_from_tesla"
    case exportNetMeteringAssumed = "export_net_metering_assumed"
    case exportFallbackZero = "export_fallback_zero"
    case holidayWeekendSchedule = "holiday_weekend_schedule"
    case other

    /// A kind added on the server later reads as `other`, so the note still shows.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .other
    }
}

struct TariffApproximationNote: Codable, Equatable, Sendable {
    let kind: TariffApproximationKind
    let message: String
}

struct TariffReviewPlanSnapshot: Decodable, Equatable, Sendable {
    let tariffId: Int?
    let version: Int?
    let periodId: Int?
    let selectionId: Int?
    let name: String
    let utilityName: String?
    let source: TariffSource
    let choiceKind: TariffSelectionChoiceKind
    let urdbLabel: String?
    /// Informational only; never a default effective date.
    let revisionStart: String?
    let contentHash: String?
    let exportRateProvenance: ExportRateProvenance
    let holidaysUseWeekendSchedule: Bool
    let seasons: [TariffSeasonInput]
    let approximationNotes: [TariffApproximationNote]
    let verification: TariffVerificationSummary?
}

struct TariffComparisonSlotRate: Decodable, Equatable, Sendable {
    let touName: TariffPeriodName
    let buyRate: Double
    let sellRate: Double
}

struct TariffAlignedTimeRow: Decodable, Equatable, Sendable {
    let fromHour: Int
    let fromMinute: Int
    let toHour: Int
    let toMinute: Int
    let before: TariffComparisonSlotRate?
    let after: TariffComparisonSlotRate?
    let buyRateDelta: Double?
    let sellRateDelta: Double?
    let buyRateChanged: Bool
    let sellRateChanged: Bool
    let rateChanged: Bool
    let periodNameChanged: Bool
}

struct TariffAlignedSeasonComparison: Decodable, Equatable, Sendable {
    let fromMonth: Int
    let fromDay: Int
    let toMonth: Int
    let toDay: Int
    let beforeSeasonName: String?
    let afterSeasonName: String?
    let weekdayRows: [TariffAlignedTimeRow]
    let weekendRows: [TariffAlignedTimeRow]
    let hasBuyRateChanges: Bool
    let hasSellRateChanges: Bool
    let hasRateChanges: Bool
    let hasPeriodNameChanges: Bool
}

struct TariffRestorationOriginalRef: Decodable, Equatable, Sendable {
    let originalSelectionId: Int?
    let tariffId: Int
    let name: String
    let version: Int?
    let contentHash: String?
    let effectiveFrom: String
    let effectiveTo: String?
}

enum TariffIntervalRestorationProvenance: Decodable, Equatable, Sendable {
    case notApplicable
    case preservesTeslaOriginal(TariffRestorationOriginalRef)
    case restoringOriginal(TariffRestorationOriginalRef)
    case unavailable(reason: String)

    private enum CodingKeys: String, CodingKey { case status, original, reason }

    init(from decoder: Decoder) throws {
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

enum TariffReviewAffectedIntervalKind: String, Decodable, Equatable, Sendable {
    case replace
    case fillGap = "fill_gap"
    case restore
    case restoreUnavailable = "restore_unavailable"
}

struct TariffReviewAffectedInterval: Decodable, Equatable, Sendable {
    let effectiveFrom: String
    let effectiveTo: String?
    let kind: TariffReviewAffectedIntervalKind
    let before: TariffReviewPlanSnapshot?
    /// A gap billed today with a borrowed plan (the nearest earlier one, or else the earliest), so
    /// `before` is that plan rather than one saved for these dates.
    let beforeIsFallback: Bool
    let after: TariffReviewPlanSnapshot?
    let seasons: [TariffAlignedSeasonComparison]
    let hasBuyRateChanges: Bool
    let hasSellRateChanges: Bool
    let hasRateChanges: Bool
    let hasPeriodNameChanges: Bool
    let restoration: TariffIntervalRestorationProvenance
}

struct TariffReviewUnchangedPeriod: Decodable, Equatable, Sendable {
    enum Relation: String, Decodable, Equatable, Sendable {
        case beforeRange = "before_range"
        case afterRange = "after_range"
    }

    let effectiveFrom: String
    let effectiveTo: String?
    let relation: Relation
    let wasTrimmed: Bool
    let originalEffectiveFrom: String
    let originalEffectiveTo: String?
    let plan: TariffReviewPlanSnapshot
}

struct TariffReviewUnavailableRange: Decodable, Equatable, Sendable {
    let effectiveFrom: String
    let effectiveTo: String?
    let reason: String
}

struct TariffReviewRestorationSummary: Decodable, Equatable, Sendable {
    let preservedOriginals: [TariffRestorationOriginalRef]
    let restoredOriginals: [TariffRestorationOriginalRef]
    let unavailableRanges: [TariffReviewUnavailableRange]
    let canApplyRestoration: Bool
}

struct TariffReviewSummary: Decodable, Equatable, Sendable {
    let hasBuyRateChanges: Bool
    let hasSellRateChanges: Bool
    let hasRateChanges: Bool
    let hasPeriodNameChanges: Bool
    let fillsGap: Bool
    let replacesExistingPlan: Bool
}

struct TariffSelectionPreviewResponse: Decodable, Equatable, Sendable {
    let reviewHash: String
    let siteId: String
    let scope: TariffSelectionScope
    let effectiveFrom: String
    let effectiveTo: String?
    let currency: String
    let unit: String
    let timezone: String
    let holidaysUseWeekendSchedule: Bool
    let recalculatesHistory: Bool
    /// The change reaches the earliest plan, so every earlier day is repriced too; the range's
    /// start is then the server's internal history floor, not a date to show.
    let recalculatesFromHistoryStart: Bool
    let recalculationRange: TariffReviewDateRange?
    /// Always false: saving in PWUsage never changes the plan on the Powerwall.
    let affectsPowerwallPlan: Bool
    let candidatePlan: TariffReviewPlanSnapshot?
    let affectedIntervals: [TariffReviewAffectedInterval]
    let unchangedOutsidePeriods: [TariffReviewUnchangedPeriod]
    let restoration: TariffReviewRestorationSummary
    let approximationNotes: [TariffApproximationNote]
    let summary: TariffReviewSummary

    func validating(siteID: String) throws -> Self {
        let snapshots = affectedIntervals.flatMap { [$0.before, $0.after] } + [candidatePlan]
        let ratesAreFinite = snapshots.compactMap(\.self).allSatisfy { plan in
            plan.seasons.allSatisfy { season in
                (season.weekdayPeriods + season.weekendPeriods)
                    .allSatisfy { $0.buyRate.isFinite && $0.sellRate.isFinite }
            }
        }
        guard siteId == siteID, !reviewHash.isEmpty, !affectsPowerwallPlan,
              TimeZone(identifier: timezone) != nil, ratesAreFinite else {
            throw PWUsageAPIError.invalidResponse
        }
        return self
    }
}

/// `PublicUtilityPlansResponse`: public plans in effect on one date, with full rate details.
struct PublicUtilityPlansResponse: Decodable, Equatable, Sendable {
    let utilityName: String
    let effectiveDate: String
    let currency: String
    let plans: [UtilityPlanDTO]
}
