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
    /// Offer to walk the owner through past rate plans; nil when there is nothing to fill.
    var historyGuide: RatePlanHistoryGuideDTO?
    /// Public-plan eligibility from the site's stored country; nil from older servers.
    var eligibility: RatePlanEligibility?
    /// The site's country is unconfirmed: ask for it rather than offering a US utility search.
    var needsCountryConfirmation: Bool?
    /// An owner-chosen public plan remains on a site where public plans no longer apply.
    var hasIneligiblePublicSelection: Bool?
}
