@testable import PWUsage
import Testing

@Suite("Busy button rule")
struct BusyButtonRuleTests {
    @Test func idleAndEnabledRunsInColour() {
        let rule = BusyButtonRule(isEnabled: true, isBusy: false)
        #expect(!rule.isGreyedOut)
        #expect(rule.runsAction)
    }

    @Test func busyKeepsColourButIgnoresTaps() {
        // A running save must stay coloured so its spinner shows, even when the caller's
        // "can save" check turns false while the work runs.
        for isEnabled in [true, false] {
            let rule = BusyButtonRule(isEnabled: isEnabled, isBusy: true)
            #expect(!rule.isGreyedOut)
            #expect(!rule.runsAction)
        }
    }

    @Test func notReadyGreysOut() {
        let rule = BusyButtonRule(isEnabled: false, isBusy: false)
        #expect(rule.isGreyedOut)
        #expect(!rule.runsAction)
    }
}
