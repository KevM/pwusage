import Foundation
import PWUsageCore

/// How often Rate Plans reloads while the server is still working on the site's rate plans.
/// Re-pricing finishes in seconds. The server starts a pending estimate right after the change
/// that queued it, so it usually settles within seconds too (ready, needs a plan, and so on); if
/// that run fails, the 10-minute scheduled job retries it and polling continues until then.
enum RatePlansPolling {
    static let reattributionInterval: Duration = .seconds(3)
    static let estimatesInterval: Duration = .seconds(5)

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
