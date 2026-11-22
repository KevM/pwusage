import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

struct RatePlansPollingTests {
    @Test func repricingPollsQuickly() {
        #expect(RatePlansPolling.interval(reattribution: .pending, estimates: nil) == .seconds(3))
        #expect(RatePlansPolling.interval(reattribution: .running, estimates: .ready) == .seconds(3))
    }

    /// The server starts the estimate right after the change, so it usually lands within seconds.
    @Test func pendingEstimatesPollEveryFewSeconds() {
        #expect(RatePlansPolling.interval(reattribution: nil, estimates: .pending) == .seconds(5))
    }

    @Test func repricingWinsOverPendingEstimates() {
        #expect(RatePlansPolling.interval(reattribution: .pending, estimates: .pending) == .seconds(3))
    }

    @Test func settledStatesStopPolling() {
        #expect(RatePlansPolling.interval(reattribution: nil, estimates: nil) == nil)
        for status: SiteRateEstimatesDTO.Status in [.ready, .needsPlan, .needsUtility, .skipped, .failed] {
            #expect(RatePlansPolling.interval(reattribution: nil, estimates: status) == nil)
        }
    }
}
