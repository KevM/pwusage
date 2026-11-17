import Foundation
import Observation

/// What the Home tab bar accessory offers: one estimate setup step, or the rate plan history guide.
enum RateEstimatesAccessoryKind: Equatable, Sendable {
    case setup(RateEstimatesPrompt)
    case historyOffer

    var setupPrompt: RateEstimatesPrompt? {
        if case .setup(let prompt) = self { prompt } else { nil }
    }
}

/// Whether the Home tab bar accessory offers the estimate setup step or the history guide. Pure so the
/// precedence and per-site rules can be tested without the tab view.
enum RateEstimatesAccessoryRule {
    /// The offer to show, or nil when the accessory stays hidden. A setup step outranks the history offer.
    /// `yieldsTo` is true when a higher-precedence accessory (Battery Saver, history, banner) shows.
    static func prompt(
        _ prompt: RateEstimatesPrompt?,
        historyOffer: Bool = false,
        selectedTab: AppTab,
        isDemo: Bool,
        isDismissed: Bool,
        isHistoryOfferDismissed: Bool = false,
        yieldsTo higherPrecedenceShows: Bool
    ) -> RateEstimatesAccessoryKind? {
        guard selectedTab == .home, !isDemo, !higherPrecedenceShows else { return nil }
        if let prompt, !isDismissed { return .setup(prompt) }
        return historyOffer && !isHistoryOfferDismissed ? .historyOffer : nil
    }
}

/// The site ids whose Home accessory the owner dismissed with Not now. Only the accessory is hidden;
/// Bill and Solar System keep offering the same setup. A second store (`historyOffer`) holds the
/// history offer's dismissals, shared by the accessory and the Rate Plans card.
@MainActor
@Observable
final class RateEstimatesAccessoryDismissals {
    static let defaultsKey = "rateEstimates.accessoryDismissedSiteIDs"
    static let historyOfferDefaultsKey = "rateHistory.offerDismissedSiteIDs"

    /// The one history-offer store the Home accessory and the Rate Plans card both read, so a Not Now on
    /// either hides both at once.
    static let sharedHistoryOffer = historyOffer()

    static func historyOffer(defaults: UserDefaults = .standard) -> RateEstimatesAccessoryDismissals {
        RateEstimatesAccessoryDismissals(defaults: defaults, key: historyOfferDefaultsKey)
    }

    private(set) var dismissedSiteIDs: Set<String>
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let key: String

    init(defaults: UserDefaults = .standard, key: String = RateEstimatesAccessoryDismissals.defaultsKey) {
        self.defaults = defaults
        self.key = key
        dismissedSiteIDs = Set(defaults.stringArray(forKey: key) ?? [])
    }

    func isDismissed(siteID: String) -> Bool {
        dismissedSiteIDs.contains(siteID)
    }

    func dismiss(siteID: String) {
        guard dismissedSiteIDs.insert(siteID).inserted else { return }
        defaults.set(dismissedSiteIDs.sorted(), forKey: key)
    }
}
