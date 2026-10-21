import Foundation
import Testing
@testable import PWUsage

@Suite("Load Timing Affordance Tests")
struct LoadTimingAffordanceTests {
    @Test("Start-now estimate is described as an estimate, never guaranteed free or covered")
    func estimateLanguageDoesNotGuaranteeCoverage() {
        let estimate = LoadTimingEstimator.StartNowEstimate(
            total: 2.34,
            finishTime: Date(timeIntervalSince1970: 1_800_000_000),
            batteryKwh: 0,
            wallKwh: 8,
            durationHours: 2,
            segments: [],
            hasUnobservedBalance: false
        )

        let summary = LoadTimingPresentation.startNowSummary(estimate, currencyCode: "USD", timeZone: "UTC")
        #expect(summary.total == "Estimated $2.34 to start now")
        #expect(!summary.total.localizedCaseInsensitiveContains("free"))
        #expect(!summary.total.localizedCaseInsensitiveContains("covered"))
        #expect(summary.energy == "About 8.0 kWh from the wall")
        #expect(summary.finish.contains("Finishes"))
        #expect(summary.finish.contains("about 2.0 hours"))
    }

    @Test("Missing cycle balance is called out while retaining the estimate")
    func missingBalanceNoteIsExplicit() {
        #expect(LoadTimingPresentation.missingBalanceNote(hasUnobservedBalance: true) == "Missing rate period bank data is estimated at the full rate.")
        #expect(LoadTimingPresentation.missingBalanceNote(hasUnobservedBalance: false) == nil)
    }

    @Test("Unavailable reasons and zero-charge state are clear")
    func unavailableAndZeroChargeStates() {
        #expect(LoadTimingPresentation.unavailableMessage(.incompleteTimeline) == "Rate plan timing is incomplete, so a start-now cost estimate is unavailable.")
        #expect(LoadTimingPresentation.unavailableMessage(.invalidInput) == "Job settings or rate plan values are invalid, so a start-now estimate is unavailable.")
        #expect(LoadTimingPresentation.noChargeMessage == "No charging needed at this target.")
    }

    @Test("No cycle observations remain visible as an informational note")
    func noCycleDataNote() {
        #expect(LoadTimingPresentation.cycleObservationMessage(hasCycleData: false) == "Billing cycle observations are unavailable. The start-now estimate uses the full rate where no bank has been observed.")
        #expect(LoadTimingPresentation.cycleObservationMessage(hasCycleData: true) == nil)
    }
}
