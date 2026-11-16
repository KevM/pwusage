import Foundation
import Observation

/// Whether the Home tab bar accessory offers the estimate setup step. Pure so the precedence and
/// per-site rules can be tested without the tab view.
enum RateEstimatesAccessoryRule {
    /// The step to offer, or nil when the accessory stays hidden.
    /// `yieldsTo` is true when a higher-precedence accessory (Battery Saver, history, banner) shows.
    static func prompt(
        _ prompt: RateEstimatesPrompt?,
        selectedTab: AppTab,
        isDemo: Bool,
        isDismissed: Bool,
        yieldsTo higherPrecedenceShows: Bool
    ) -> RateEstimatesPrompt? {
        guard let prompt, selectedTab == .home, !isDemo, !isDismissed, !higherPrecedenceShows else {
            return nil
        }
        return prompt
    }
}

/// The site ids whose Home accessory the owner dismissed with Not now. Only the accessory is hidden;
/// Bill and Solar System keep offering the same setup.
@MainActor
@Observable
final class RateEstimatesAccessoryDismissals {
    static let defaultsKey = "rateEstimates.accessoryDismissedSiteIDs"

    private(set) var dismissedSiteIDs: Set<String>
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        dismissedSiteIDs = Set(defaults.stringArray(forKey: Self.defaultsKey) ?? [])
    }

    func isDismissed(siteID: String) -> Bool {
        dismissedSiteIDs.contains(siteID)
    }

    func dismiss(siteID: String) {
        guard dismissedSiteIDs.insert(siteID).inserted else { return }
        defaults.set(dismissedSiteIDs.sorted(), forKey: Self.defaultsKey)
    }
}
