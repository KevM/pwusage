import Foundation
@testable import PWUsage
import Testing

struct RatePlanAddFormRuleTests {
    @Test func opensOnceTheTimelineHasLoaded() {
        #expect(RatePlanAddFormRule.shouldOpen(startsAddingPlan: true, timelineLoaded: true, alreadyOpened: false))
    }

    @Test func waitsForTheTimeline() {
        #expect(!RatePlanAddFormRule.shouldOpen(startsAddingPlan: true, timelineLoaded: false, alreadyOpened: false))
    }

    @Test func neverReopensAfterOpening() {
        #expect(!RatePlanAddFormRule.shouldOpen(startsAddingPlan: true, timelineLoaded: true, alreadyOpened: true))
    }

    @Test func staysClosedWithoutTheRequest() {
        #expect(!RatePlanAddFormRule.shouldOpen(startsAddingPlan: false, timelineLoaded: true, alreadyOpened: false))
    }
}
