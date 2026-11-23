import Foundation

/// Turns a selection endpoint's 409 body into a typed error.
public enum RatePlanSelectionConflict {
    private struct CodeBody: Decodable {
        let code: String?
        let eligibility: RatePlanEligibility?
    }

    private struct SinglePreviewBody: Decodable {
        let preview: TariffSelectionPreviewResponse
    }

    private struct BatchPreviewBody: Decodable {
        let preview: TariffAiHandoffPreviewResponse
    }

    /// The typed error for a 409 body, or nil when it is another conflict (a changed utility).
    public static func decode(from data: Data) -> RatePlanSelectionError? {
        let decoder = MobileContractDecoder.make()
        guard let body = try? decoder.decode(CodeBody.self, from: data) else { return nil }
        switch body.code {
        case "REVIEW_STALE":
            if let batch = try? decoder.decode(BatchPreviewBody.self, from: data) {
                return .aiHandoffReviewStale(batch.preview)
            }
            if let single = try? decoder.decode(SinglePreviewBody.self, from: data) {
                return .reviewStale(single.preview)
            }
            return nil
        case "PUBLIC_PLANS_UNAVAILABLE":
            return body.eligibility.map(RatePlanSelectionError.publicPlansUnavailable)
        default:
            return nil
        }
    }
}

extension TariffSelectionPreviewResponse {
    public func validating(siteID: String) throws -> Self {
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

extension TariffAiHandoffPreviewResponse {
    public func validating(siteID expectedSiteID: String) throws -> Self {
        guard siteId == expectedSiteID else { throw PWUsageAPIError.invalidResponse }
        return self
    }
}
