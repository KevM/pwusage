import Foundation
@testable import PWUsage
import Testing

struct RateEstimatesAccessoryRuleTests {
    private static func visible(
        _ prompt: RateEstimatesPrompt? = .pickUtility,
        tab: AppTab = .home,
        isDemo: Bool = false,
        isDismissed: Bool = false,
        historyOffer: Bool = false,
        isHistoryOfferDismissed: Bool = false,
        yieldsTo higherPrecedence: Bool = false
    ) -> RateEstimatesAccessoryKind? {
        RateEstimatesAccessoryRule.prompt(
            prompt,
            historyOffer: historyOffer,
            selectedTab: tab,
            isDemo: isDemo,
            isDismissed: isDismissed,
            isHistoryOfferDismissed: isHistoryOfferDismissed,
            yieldsTo: higherPrecedence
        )
    }

    @Test func showsTheSetupStepOnHome() {
        #expect(Self.visible(.pickUtility) == .setup(.pickUtility))
        #expect(Self.visible(.pickPlan) == .setup(.pickPlan))
    }

    @Test func hiddenWithoutAPrompt() {
        #expect(Self.visible(nil) == nil)
    }

    @Test func hiddenOnOtherTabs() {
        for tab in [AppTab.bill, .smartShift, .settings] {
            #expect(Self.visible(tab: tab) == nil)
        }
    }

    @Test func hiddenInDemoMode() {
        #expect(Self.visible(isDemo: true) == nil)
    }

    @Test func hiddenOnceDismissedForTheSite() {
        #expect(Self.visible(isDismissed: true) == nil)
    }

    @Test func yieldsToAHigherPrecedenceAccessory() {
        #expect(Self.visible(yieldsTo: true) == nil)
    }

    @Test func offersTheHistoryGuideWithoutASetupStep() {
        #expect(Self.visible(nil, historyOffer: true) == .historyOffer)
    }

    @Test func setupPromptsOutrankTheHistoryOffer() {
        #expect(Self.visible(.pickPlan, historyOffer: true) == .setup(.pickPlan))
    }

    @Test func aDismissedSetupStepLetsTheHistoryOfferShow() {
        #expect(Self.visible(.pickPlan, isDismissed: true, historyOffer: true) == .historyOffer)
    }

    @Test func historyOfferYieldsToHistoryAccessories() {
        #expect(Self.visible(nil, historyOffer: true, yieldsTo: true) == nil)
    }

    @Test func historyOfferStaysOnHomeAndOutOfDemo() {
        for tab in [AppTab.bill, .smartShift, .settings] {
            #expect(Self.visible(nil, tab: tab, historyOffer: true) == nil)
        }
        #expect(Self.visible(nil, isDemo: true, historyOffer: true) == nil)
    }

    @Test func dismissedHistoryOfferStaysHidden() {
        #expect(Self.visible(nil, historyOffer: true, isHistoryOfferDismissed: true) == nil)
    }
}

@MainActor
@Suite("Rate estimates accessory dismissals")
struct RateEstimatesAccessoryDismissalsTests {
    private static func makeDefaults() throws -> (UserDefaults, String) {
        let suite = "RateEstimatesAccessoryDismissalsTests.\(UUID().uuidString)"
        return (try #require(UserDefaults(suiteName: suite)), suite)
    }

    @Test func startsUndismissed() throws {
        let (defaults, suite) = try Self.makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let dismissals = RateEstimatesAccessoryDismissals(defaults: defaults)
        #expect(dismissals.isDismissed(siteID: "site-a") == false)
    }

    @Test func dismissalAppliesOnlyToItsSite() throws {
        let (defaults, suite) = try Self.makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let dismissals = RateEstimatesAccessoryDismissals(defaults: defaults)
        dismissals.dismiss(siteID: "site-a")
        #expect(dismissals.isDismissed(siteID: "site-a"))
        #expect(dismissals.isDismissed(siteID: "site-b") == false)
    }

    @Test func dismissalPersistsAcrossStores() throws {
        let (defaults, suite) = try Self.makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        RateEstimatesAccessoryDismissals(defaults: defaults).dismiss(siteID: "site-a")
        let reloaded = RateEstimatesAccessoryDismissals(defaults: defaults)
        #expect(reloaded.isDismissed(siteID: "site-a"))
    }

    @Test func dismissingTwiceKeepsOneRecord() throws {
        let (defaults, suite) = try Self.makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let dismissals = RateEstimatesAccessoryDismissals(defaults: defaults)
        dismissals.dismiss(siteID: "site-a")
        dismissals.dismiss(siteID: "site-a")
        #expect(RateEstimatesAccessoryDismissals(defaults: defaults).dismissedSiteIDs == ["site-a"])
    }

    @Test func historyOfferDismissalsUseTheirOwnKey() throws {
        let (defaults, suite) = try Self.makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let offer = RateEstimatesAccessoryDismissals.historyOffer(defaults: defaults)
        offer.dismiss(siteID: "site-a")
        #expect(defaults.stringArray(forKey: "rateHistory.offerDismissedSiteIDs") == ["site-a"])
        #expect(defaults.stringArray(forKey: RateEstimatesAccessoryDismissals.defaultsKey) == nil)
        #expect(RateEstimatesAccessoryDismissals.historyOffer(defaults: defaults).isDismissed(siteID: "site-a"))
        #expect(RateEstimatesAccessoryDismissals(defaults: defaults).isDismissed(siteID: "site-a") == false)
    }
}
