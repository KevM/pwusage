import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

@MainActor
@Suite("Sync to Tesla keeps PWUsage's copy of Tesla's plan current")
struct TeslaSyncPullTests {
    static let timelineJSON = TeslaSyncModelTests.timelineJSON

    @Test("When Tesla already has the plan, the model pulls from Tesla and hands back the new timeline")
    func noDifferencePullsTimeline() async throws {
        let spy = TeslaSyncModelTests.Spy()
        spy.previewError = TeslaSyncUnavailability(reason: "no_difference", message: "Tesla already has this plan.")
        var handedBack: SiteTariffsTimelineResponse?
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { handedBack = $0 })
        await model.load()
        #expect(spy.pulls == 1)
        #expect(handedBack != nil, "The banner clears from the pulled timeline")
        #expect(spy.commits.isEmpty)
        guard case .unavailable = model.phase else {
            Issue.record("Expected unavailable, got \(model.phase)")
            return
        }
    }

    @Test("Other unavailable reasons do not pull")
    func otherReasonsDoNotPull() async throws {
        let spy = TeslaSyncModelTests.Spy()
        spy.previewError = TeslaSyncUnavailability(reason: "needs_reauth", message: "Reconnect Tesla.")
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { _ in })
        await model.load()
        #expect(spy.pulls == 0)
    }

    @Test("An unconfirmed write pulls from Tesla and hands back that timeline")
    func unconfirmedPulls() async throws {
        let spy = TeslaSyncModelTests.Spy()
        spy.commitResult = try TeslaSyncModelTests.result("unconfirmed")
        var handedBack: [SiteTariffsTimelineResponse] = []
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { handedBack.append($0) })
        await model.load()
        await model.confirm()
        #expect(spy.pulls == 1)
        #expect(handedBack == [spy.pulledTimeline])
    }

    @Test("An unconfirmed write falls back to the plain refetch when the pull fails")
    func unconfirmedFallsBackToRefetch() async throws {
        let spy = TeslaSyncModelTests.Spy()
        spy.commitResult = try TeslaSyncModelTests.result("unconfirmed")
        spy.pullError = TeslaSyncUnavailability(reason: "tesla_unavailable", message: "x")
        var handedBack: SiteTariffsTimelineResponse?
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { handedBack = $0 })
        await model.load()
        await model.confirm()
        #expect(spy.refreshes == 1)
        #expect(handedBack == spy.refreshedTimeline)
    }

    @Test("A commit that throws still refetches the timeline, since the write may have landed")
    func thrownCommitRefreshesTimeline() async throws {
        let spy = TeslaSyncModelTests.Spy()
        spy.commitError = URLError(.timedOut)
        var handedBack: SiteTariffsTimelineResponse?
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { handedBack = $0 })
        await model.load()
        await model.confirm()
        #expect(spy.refreshes == 1)
        #expect(handedBack != nil)
        guard case .failed = model.phase else {
            Issue.record("Expected failed, got \(model.phase)")
            return
        }
    }

    @Test("A cancelled commit does not refetch")
    func cancelledCommitDoesNotRefresh() async throws {
        let spy = TeslaSyncModelTests.Spy()
        spy.commitError = CancellationError()
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { _ in })
        await model.load()
        await model.confirm()
        #expect(spy.refreshes == 0)
    }

    @Test("A conflict keeps the conflict text above the reloaded review")
    func conflictKeepsNotice() async throws {
        let spy = TeslaSyncModelTests.Spy()
        spy.previewQueue = [
            try TeslaSyncModelTests.preview(fingerprint: "fp-1"),
            try TeslaSyncModelTests.preview(fingerprint: "fp-2")
        ]
        spy.commitResult = try TeslaSyncModelTests.result("conflict")
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { _ in })
        await model.load()
        #expect(model.notice == nil)
        await model.confirm()
        #expect(model.notice == TeslaSyncCopy.conflict)
    }

    @Test("Only an unconfirmed last sync asks the sheet to pull from Tesla once on open")
    func pullsOnOpenOnlyWhenUnconfirmed() throws {
        func timeline(status: String?) throws -> SiteTariffsTimelineResponse {
            let attempt = status.map { "{\"status\": \"\($0)\", \"at\": \"2026-11-19T10:00:00Z\"}" } ?? "null"
            let json = Self.timelineJSON
                .replacingOccurrences(of: "\"lastSync\": null", with: "\"lastSync\": \(attempt)")
            return try MobileContractDecoder.make().decode(SiteTariffsTimelineResponse.self, from: Data(json.utf8))
        }
        #expect(TeslaSyncPrompt.shouldPullOnOpen(try timeline(status: "unconfirmed")))
        #expect(!TeslaSyncPrompt.shouldPullOnOpen(try timeline(status: "confirmed")))
        #expect(!TeslaSyncPrompt.shouldPullOnOpen(try timeline(status: nil)))
    }
}
