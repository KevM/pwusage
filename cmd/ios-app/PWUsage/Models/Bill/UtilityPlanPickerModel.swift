import Foundation
import Observation

/// The plans on the chosen utility's residential schedule, and the owner's pick among them.
@MainActor
@Observable
final class UtilityPlanPickerModel {
    enum State: Equatable {
        case loading
        case loaded([UtilityPlanDTO])
        case failed
    }

    static let saveFailureMessage = "Couldn’t save your rate plan. Check your connection and try again."

    private(set) var state: State = .loading
    private(set) var isSaving = false
    private(set) var errorMessage: String?
    private(set) var isDone = false

    @ObservationIgnored private let loadPlans: () async throws -> [UtilityPlanDTO]
    @ObservationIgnored private let selectPlan: (String) async throws -> Void

    init(
        loadPlans: @escaping () async throws -> [UtilityPlanDTO],
        selectPlan: @escaping (String) async throws -> Void
    ) {
        self.loadPlans = loadPlans
        self.selectPlan = selectPlan
    }

    static func sinceLabel(for plan: UtilityPlanDTO) -> String {
        "Since \(RatePlanTimelineFormatting.displayDate(plan.startDate))"
    }

    func load() async {
        state = .loading
        do {
            state = .loaded(try await loadPlans())
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed
        }
    }

    func select(_ plan: UtilityPlanDTO) async {
        guard !isSaving else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            try await selectPlan(plan.label)
            isDone = true
        } catch {
            errorMessage = Self.saveFailureMessage
        }
    }
}
