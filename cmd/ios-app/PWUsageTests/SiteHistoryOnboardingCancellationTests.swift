import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Site history final assessment cancellation")
struct SiteHistoryOnboardingCancellationTests {
    @Test(arguments: [false, true])
    func cancellationAtTheBoundLeavesAssessmentRetryable(duringDetection: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "site")
        let store = SiteHistoryOnboardingStore(directory: directory)
        let environment = FakeOnboardingEnvironment()
        environment.historyStart = "2026-09-10"
        environment.stored = [(1 ... 53).compactMap { SiteLocalDays.adding(-$0, to: "2026-11-02", timeZone: .gmt) }]
        var progress = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
        progress.oldestChecked = environment.historyStart
        progress.historyStart = environment.historyStart
        progress.lastAssessedCheckedDays = 42
        try await store.save(progress, scope: scope)
        let onboarding = SiteHistoryOnboarding(
            environment: environment, store: store, ledgers: SiteHistoryDayLedgerStore(directory: directory))
        var run: Task<SiteHistoryOnboarding.Outcome, Never>?
        if duringDetection {
            environment.onDetect = { run?.cancel() }
        } else {
            environment.onClassify = { run?.cancel() }
        }
        run = Task { await onboarding.run(scope: scope) }
        #expect(await run?.value == .stopped)
        #expect(try await store.progress(scope: scope) == progress)
        environment.onClassify = nil
        environment.onDetect = nil
        #expect(await onboarding.run(scope: scope) == .finished(.reachedHistoryStart))
        #expect(environment.passes.count == 2)
        #expect(environment.detectionCount == (duringDetection ? 2 : 1))
        #expect(environment.requests.isEmpty)
    }
}
