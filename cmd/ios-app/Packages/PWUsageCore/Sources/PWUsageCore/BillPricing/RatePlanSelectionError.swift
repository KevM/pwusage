import Foundation

/// Failures of the selection endpoints that the review flow handles specially.
public enum RatePlanSelectionError: Error, Equatable, Sendable {
    /// The timeline changed since the review. Show this fresh review; never apply it automatically.
    case reviewStale(TariffSelectionPreviewResponse)
    /// The timeline changed during AI handoff review. Show this fresh batch review.
    case aiHandoffReviewStale(TariffAiHandoffPreviewResponse)
    /// Public utility plans don't apply to this site (`outside_us`) or its country is unconfirmed.
    case publicPlansUnavailable(RatePlanEligibility)
}
