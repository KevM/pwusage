import Foundation

struct SiteRateEstimatesDTO: Codable, Equatable, Sendable {
    enum Status: String, Codable, Equatable, Sendable {
        case pending, ready, skipped, failed
        case needsUtility = "needs_utility"
        case needsPlan = "needs_plan"
    }

    let status: Status
    let utilityName: String?
    let teslaPlanOutOfDate: Bool
    let newerPlanName: String?
    /// YYYY-MM-DD start of the newer URDB revision behind `teslaPlanOutOfDate`.
    let newerPlanStart: String?
    /// YYYY-MM-DD start of the newest URDB revision behind the estimate covering today.
    let newestRevisionStart: String?
    /// True when that newest revision may have missed a rate change.
    let mayBeOutdated: Bool
}
