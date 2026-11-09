@testable import PWUsage
import Testing

@Suite("Billing day prompt state")
struct BillingDayPromptStateTests {
    private let unconfirmed = MobileSite(id: "a", name: "Home", utility: "U", billingDay: 1, billingDayConfirmed: false)
    private let confirmed = MobileSite(id: "b", name: "Cabin", utility: "U", billingDay: 12, billingDayConfirmed: true)

    private func shouldPresent(
        _ state: BillingDayPromptState, site: MobileSite?, isDemo: Bool = false,
        sessionVerified: Bool = true, otherSheetPresented: Bool = false
    ) -> Bool {
        state.shouldPresent(
            site: site, isDemo: isDemo, sessionVerified: sessionVerified, otherSheetPresented: otherSheetPresented)
    }

    @Test("Presents for the selected site while nobody has chosen its billing day")
    func presentsForUnconfirmedSite() {
        #expect(shouldPresent(BillingDayPromptState(), site: unconfirmed))
    }

    @Test("Stays quiet for a confirmed site, no site, the demo, an unverified session or another sheet")
    func staysQuiet() {
        let state = BillingDayPromptState()
        #expect(!shouldPresent(state, site: confirmed))
        #expect(!shouldPresent(state, site: nil))
        #expect(!shouldPresent(state, site: unconfirmed, isDemo: true))
        #expect(!shouldPresent(state, site: unconfirmed, sessionVerified: false))
        #expect(!shouldPresent(state, site: unconfirmed, otherSheetPresented: true))
    }

    @Test("Not now silences that site for the run but not another site")
    func dismissalIsPerSite() {
        var state = BillingDayPromptState()
        state.dismiss(siteID: "a")
        #expect(!shouldPresent(state, site: unconfirmed))
        let other = MobileSite(id: "c", name: "Barn", utility: "U", billingDay: 1, billingDayConfirmed: false)
        #expect(shouldPresent(state, site: other))
    }

    @Test("A site confirmed elsewhere is not asked again")
    func confirmedElsewhereClearsThePrompt() {
        let state = BillingDayPromptState()
        #expect(shouldPresent(state, site: unconfirmed))
        #expect(!shouldPresent(state, site: unconfirmed.settingBillingDay(1)))
    }
}
