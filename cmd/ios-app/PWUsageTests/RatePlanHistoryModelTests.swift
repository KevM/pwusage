import Foundation
@testable import PWUsage
import Testing

@MainActor
private final class HistoryStub {
    var history = RatePlanHistoryDTO(
        utilityName: "We Energies", historyStart: "2023-11-14", fillThrough: "2026-04-27", teslaShape: .fixed,
        current: [HistoryStub.fixed(2026)],
        years: [RatePlanHistoryYearDTO(year: 2025, askDate: "2025-07-01", plans: [HistoryStub.fixed(2025)])]
    )
    var loadFailure: (any Error)?
    /// When set, `loadHistory` suspends until cancelled instead of returning.
    var loadsUntilCancelled = false
    var saveFailure: (any Error)?
    private(set) var saved: [[RatePlanHistoryPeriod]] = []

    static func fixed(_ year: Int) -> RatePlanHistoryPlanDTO {
        RatePlanHistoryPlanDTO(
            name: "Residential Rg 1", startDate: "\(year)-01-01", kind: .fixed, isDefault: true, closest: false,
            lowRate: 0.18, highRate: 0.18, peakWindows: [], closestWindow: nil, fixedLabel: "Rg 1 \(year)"
        )
    }

    func model() -> RatePlanHistoryModel {
        RatePlanHistoryModel(
            loadHistory: { [self] in
                if loadsUntilCancelled { try await Task.sleep(for: .seconds(60)) }
                if let loadFailure { throw loadFailure }
                return history
            },
            saveHistory: { [self] periods in
                if let saveFailure { throw saveFailure }
                saved.append(periods)
            }
        )
    }
}

private struct StubFailure: Error {}

@MainActor
@Suite("Rate plan history model")
struct RatePlanHistoryModelTests {
    @Test func loadsHistory() async {
        let stub = HistoryStub()
        let model = stub.model()
        #expect(model.state == .loading)
        await model.load()
        #expect(model.state == .ready(RatePlanHistoryFlow(history: stub.history, hasTeslaPlan: true)))
    }

    @Test func loadFailureShowsRetry() async {
        let stub = HistoryStub()
        stub.loadFailure = StubFailure()
        let model = stub.model()
        await model.load()
        #expect(model.state == .failed(RatePlanHistoryPresentation.loadFailureMessage))
        stub.loadFailure = nil
        await model.reload()
        guard case .ready = model.state else {
            Issue.record("expected ready after retry")
            return
        }
    }

    @Test func loadKeepsAnInProgressFlow() async {
        let stub = HistoryStub()
        let model = stub.model()
        await model.load()
        model.update { $0.chooseKind(.fixed) }
        let answered = model.state
        #expect(answered != .ready(RatePlanHistoryFlow(history: stub.history, hasTeslaPlan: true)))
        await model.load()
        #expect(model.state == answered)
    }

    @Test func reloadStartsOver() async {
        let stub = HistoryStub()
        let model = stub.model()
        await model.load()
        model.update { $0.chooseKind(.fixed) }
        await model.reload()
        #expect(model.state == .ready(RatePlanHistoryFlow(history: stub.history, hasTeslaPlan: true)))
    }

    @Test func cancelledLoadDoesNotStayLoading() async {
        let stub = HistoryStub()
        stub.loadsUntilCancelled = true
        let model = stub.model()
        let task = Task { await model.load() }
        task.cancel()
        await task.value
        #expect(model.state == .failed(RatePlanHistoryPresentation.loadFailureMessage))
    }

    @Test func saveSendsPeriodsAndFinishes() async {
        let stub = HistoryStub()
        let model = stub.model()
        await model.load()
        model.update { $0.chooseKind(.fixed) }
        model.update { $0.answerStillOn(true) }
        guard case .ready(let flow) = model.state else {
            Issue.record("expected ready")
            return
        }
        #expect(flow.step == .review)
        await model.save()
        #expect(stub.saved == [flow.periods()])
        #expect(stub.saved.first?.isEmpty == false)
        #expect(model.isDone)
        #expect(model.isSaving == false)
        #expect(model.errorMessage == nil)
    }

    @Test func saveFailureKeepsAnswers() async {
        let stub = HistoryStub()
        stub.saveFailure = StubFailure()
        let model = stub.model()
        await model.load()
        model.update { $0.chooseKind(.fixed) }
        model.update { $0.answerStillOn(true) }
        let answered = model.state
        await model.save()
        #expect(model.state == answered)
        #expect(model.isDone == false)
        #expect(model.isSaving == false)
        #expect(model.errorMessage == RatePlanHistoryPresentation.saveFailureMessage)
        stub.saveFailure = nil
        await model.save()
        #expect(model.isDone)
        #expect(model.errorMessage == nil)
    }

    @Test func serverRejectionIsShownAsIs() async {
        let stub = HistoryStub()
        stub.saveFailure = PWUsageAPIError.requestRejected(statusCode: 409, message: "Rates changed. Reload.")
        let model = stub.model()
        await model.load()
        await model.save()
        #expect(model.errorMessage == "Rates changed. Reload.")
    }

    @Test func loadRejectionIsShownAsIs() async {
        let stub = HistoryStub()
        stub.loadFailure = PWUsageAPIError.requestRejected(statusCode: 409, message: "Choose a utility first.")
        let model = stub.model()
        await model.load()
        #expect(model.state == .failed("Choose a utility first."))
    }

    @Test func teslaPlanComesFromTheHistory() async {
        let stub = HistoryStub()
        let model = stub.model()
        await model.load()
        guard case .ready(let withTesla) = model.state else {
            Issue.record("expected ready")
            return
        }
        #expect(withTesla.hasTeslaPlan)
        // The Default Rate fallback has no shape: the server sends `teslaShape: null`.
        stub.history = RatePlanHistoryDTO(
            utilityName: "We Energies", historyStart: "2023-11-14", fillThrough: nil, teslaShape: nil,
            current: [HistoryStub.fixed(2026)], years: []
        )
        await model.reload()
        guard case .ready(let withoutTesla) = model.state else {
            Issue.record("expected ready")
            return
        }
        #expect(withoutTesla.hasTeslaPlan == false)
    }

    @Test func updatesAreIgnoredBeforeLoading() {
        let model = HistoryStub().model()
        model.update { $0.chooseKind(.fixed) }
        #expect(model.state == .loading)
    }
}
