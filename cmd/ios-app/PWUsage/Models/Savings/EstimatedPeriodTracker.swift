import Foundation

/// Reports whether the plans pricing a slot are estimates. `isEstimated(at:)` runs only when a
/// slot's resolved period differs from the previous slot's, so the per-slot loop stays a comparison.
struct EstimatedPeriodTracker {
    private let actualResolver: RatePeriodResolver
    private let referenceResolver: RatePeriodResolver
    private var actualPeriod: ResolvedRatePeriod?
    private var referencePeriod: ResolvedRatePeriod?
    private var actualIsEstimated = false
    private var referenceIsEstimated = false

    init(actual: RatePeriodResolver, reference: RatePeriodResolver) {
        actualResolver = actual
        referenceResolver = reference
    }

    /// Whether the actual or reference plan pricing `instant` is an estimate.
    mutating func usesEstimate(
        at instant: Date,
        actualPeriod period: ResolvedRatePeriod,
        referencePeriod reference: ResolvedRatePeriod
    ) -> Bool {
        if period != actualPeriod {
            actualPeriod = period
            actualIsEstimated = actualResolver.isEstimated(at: instant)
        }
        if reference != referencePeriod {
            referencePeriod = reference
            referenceIsEstimated = referenceResolver.isEstimated(at: instant)
        }
        return actualIsEstimated || referenceIsEstimated
    }
}
