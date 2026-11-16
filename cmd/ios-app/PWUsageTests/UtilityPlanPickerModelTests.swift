import Foundation
@testable import PWUsage
import Testing

@MainActor
private final class PlanStub {
    var plans: [UtilityPlanDTO] = []
    var loadFailure: (any Error)?
    var selectFailure: (any Error)?
    private(set) var loadCount = 0
    private(set) var selected: [String] = []

    func loadPlans() async throws -> [UtilityPlanDTO] {
        loadCount += 1
        if let loadFailure { throw loadFailure }
        return plans
    }

    func selectPlan(_ label: String) async throws {
        if let selectFailure { throw selectFailure }
        selected.append(label)
    }

    func model(confirmationHold: Duration = .zero) -> UtilityPlanPickerModel {
        UtilityPlanPickerModel(
            confirmationHold: confirmationHold,
            loadPlans: { [self] in try await loadPlans() },
            selectPlan: { [self] label in try await selectPlan(label) }
        )
    }
}

private struct PlanStubFailure: Error {}

private let residential = UtilityPlanDTO(
    label: "rs-plan-2026",
    name: "Residential TOU",
    startDate: "2026-01-01"
)

@MainActor
@Suite("Utility plan picker loading and selection")
struct UtilityPlanPickerModelTests {
    @Test("Loading moves from loading to the loaded plans in order")
    func loadsPlans() async {
        let stub = PlanStub()
        stub.plans = [residential, UtilityPlanDTO(label: "ev", name: "EV Plan", startDate: "2025-06-01")]
        let model = stub.model()
        #expect(model.state == .loading)
        await model.load()
        #expect(model.state == .loaded(stub.plans))
    }

    @Test("A failed load moves to failed and a retry can recover")
    func retryAfterFailure() async {
        let stub = PlanStub()
        stub.loadFailure = PlanStubFailure()
        let model = stub.model()
        await model.load()
        #expect(model.state == .failed)

        stub.loadFailure = nil
        stub.plans = [residential]
        await model.load()
        #expect(model.state == .loaded([residential]))
        #expect(stub.loadCount == 2)
    }

    @Test("Choosing a plan saves its label and finishes")
    func selectingSavesAndFinishes() async {
        let stub = PlanStub()
        let model = stub.model()
        await model.select(residential)
        #expect(stub.selected == ["rs-plan-2026"])
        #expect(model.isDone)
        #expect(model.errorMessage == nil)
    }

    @Test("A failed save shows a message and does not finish")
    func failedSelectKeepsPickerOpen() async {
        let stub = PlanStub()
        stub.selectFailure = PlanStubFailure()
        let model = stub.model()
        await model.select(residential)
        #expect(!model.isDone)
        #expect(model.errorMessage != nil)
    }

    @Test("The chosen plan shows as saved for a moment before the picker finishes")
    func chosenPlanIsShownBeforeFinishing() async throws {
        let stub = PlanStub()
        let model = stub.model(confirmationHold: .milliseconds(300))
        let saving = Task { await model.select(residential) }
        try await eventually { model.choice == .saved("rs-plan-2026") }
        #expect(!model.isDone)
        await saving.value
        #expect(model.isDone)
    }

    @Test("A failed plan save clears the choice")
    func failedPlanSaveClearsChoice() async {
        let stub = PlanStub()
        stub.selectFailure = PlanStubFailure()
        let model = stub.model()
        await model.select(residential)
        #expect(model.choice == nil)
    }

    @Test("Each plan reads Since with its start date in display form")
    func sinceLabelUsesDisplayDate() {
        #expect(UtilityPlanPickerModel.sinceLabel(for: residential) == "Since Jan 1, 2026")
    }
}
