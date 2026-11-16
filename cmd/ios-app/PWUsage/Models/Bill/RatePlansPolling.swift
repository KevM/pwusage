import Foundation

/// How often Rate Plans reloads while the server is still working on the site's rate plans.
/// Re-pricing finishes in seconds. Estimates wait for a background job that runs every 10 minutes,
/// so a pending estimate polls more slowly until it settles (ready, needs a plan, and so on).
enum RatePlansPolling {
    static let reattributionInterval: Duration = .seconds(3)
    static let estimatesInterval: Duration = .seconds(15)

    static func interval(
        reattribution: ReattributionStatusDTO.Status?,
        estimates: SiteRateEstimatesDTO.Status?
    ) -> Duration? {
        if reattribution == .pending || reattribution == .running {
            return reattributionInterval
        }
        return estimates == .pending ? estimatesInterval : nil
    }
}
