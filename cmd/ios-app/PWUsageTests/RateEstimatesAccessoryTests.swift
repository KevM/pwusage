import Foundation
@testable import PWUsage
import Testing

struct RateEstimatesAccessoryRuleTests {
    private static func visible(
        _ prompt: RateEstimatesPrompt? = .pickUtility,
        tab: AppTab = .home,
        isDemo: Bool = false,
        isDismissed: Bool = false,
        yieldsTo higherPrecedence: Bool = false
    ) -> RateEstimatesPrompt? {
        RateEstimatesAccessoryRule.prompt(
            prompt,
            selectedTab: tab,
            isDemo: isDemo,
            isDismissed: isDismissed,
            yieldsTo: higherPrecedence
        )
    }

    @Test func showsTheSetupStepOnHome() {
        #expect(Self.visible(.pickUtility) == .pickUtility)
        #expect(Self.visible(.pickPlan) == .pickPlan)
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
}
