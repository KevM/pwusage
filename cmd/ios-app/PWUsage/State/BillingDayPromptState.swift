import Foundation

/// Decides when the app asks for a site's billing day. It asks at most once per site per app run,
/// only for the selected site, and never in the demo or over another sheet. "Not now" is kept in
/// memory only, so the next launch asks again until the day is chosen here or on the web.
struct BillingDayPromptState: Equatable {
    private(set) var dismissedSiteIDs: Set<String> = []

    func shouldPresent(site: MobileSite?, isDemo: Bool, sessionVerified: Bool, otherSheetPresented: Bool) -> Bool {
        guard let site, !isDemo, sessionVerified, !otherSheetPresented else { return false }
        return !site.billingDayConfirmed && !dismissedSiteIDs.contains(site.id)
    }

    mutating func dismiss(siteID: String) {
        dismissedSiteIDs.insert(siteID)
    }
}
