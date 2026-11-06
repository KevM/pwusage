import Foundation
@testable import PWUsage
import Testing

/// A layout already at high confidence stops after the recent days and sorts them once.
extension SiteHistoryOnboardingTests {
    @Test func anExistingHighConfidenceLayoutStopsAfterTheRecentDays() async {
        let environment = FakeOnboardingEnvironment()
        environment.confidence = .high
        let outcome = await make(environment).run(scope: scope)
        #expect(outcome == .finished(.layoutAlreadyUsable))
        #expect(environment.requests.map(\.days).reduce(0, +) == 15)
        // Forecast correction reads back to 14 days before today, 2026-10-19.
        #expect(environment.requests.last?.from == "2026-10-18")
        #expect(environment.detectionCount == 0)
    }

    @Test func anExistingHighLayoutSortsOnlyOnceAtTheFinish() async {
        let environment = FakeOnboardingEnvironment()
        environment.confidence = .high
        _ = await make(environment).run(scope: scope)
        #expect(environment.passes.map(\.days.count) == [15])
    }

    @Test func anExistingHighLayoutIsNotRedetectedAtAShortHistoryStart() async {
        let environment = FakeOnboardingEnvironment()
        environment.confidence = .high
        environment.historyStart = "2026-10-25"
        let outcome = await make(environment).run(scope: scope)
        #expect(outcome == .finished(.layoutAlreadyUsable))
        #expect(environment.requests.map(\.days).reduce(0, +) == 8)
        #expect(environment.passes.count == 1)
        #expect(environment.detectionCount == 0)
    }

    @Test func aLayoutThatTurnsHighPastTheRecentDaysStopsAtTheNextSlice() async {
        let environment = FakeOnboardingEnvironment()
        let onboarding = make(environment)
        _ = await onboarding.run(scope: scope, maxSlices: 10)
        let passesBefore = environment.passes.count
        environment.confidence = .high
        let outcome = await onboarding.run(scope: scope)
        #expect(outcome == .finished(.layoutAlreadyUsable))
        #expect(environment.requests.map(\.days).reduce(0, +) == 33)
        #expect(environment.passes.count == passesBefore + 1)
    }

    @Test func aHighLayoutWhoseFinalSortWasLostSortsOnceLater() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.confidence = .high
        environment.lostPasses = 1
        let onboarding = make(environment)
        #expect(await onboarding.run(scope: scope) == .finished(.layoutAlreadyUsable))
        #expect(environment.passes.isEmpty)
        await onboarding.sortDaysIfUnsorted(scope: scope)
        await onboarding.sortDaysIfUnsorted(scope: scope)
        #expect(environment.passes.count == 1)
        #expect(try await ledgers.ledger(scope: scope) != nil)
    }

    @Test func anExistingHighLayoutStillSortsTheDaysForTheStrip() async throws {
        let environment = FakeOnboardingEnvironment()
        environment.confidence = .high
        environment.clearEvery = 2
        let outcome = await make(environment).run(scope: scope)
        #expect(outcome == .finished(.layoutAlreadyUsable))
        #expect(environment.detectionCount == 0)
        // The last pass ran at the finish, so every stored day has its type.
        let ledger = try #require(try await ledgers.ledger(scope: scope))
        #expect(ledger.dayTypes.count == Set(environment.stored.flatMap(\.self)).count)
    }
}
