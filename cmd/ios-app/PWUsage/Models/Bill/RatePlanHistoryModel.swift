import Foundation
import Observation

/// The history guide screen's state: loads the walk-back's data, holds the flow while the owner
/// answers, and saves the confirmed periods. The view renders `state` and mutates the flow via `update`.
@MainActor
@Observable
final class RatePlanHistoryModel {
    enum State: Equatable {
        case loading
        case ready(RatePlanHistoryFlow)
        case failed
    }

    private(set) var state: State = .loading
    private(set) var isSaving = false
    private(set) var errorMessage: String?
    private(set) var isDone = false

    @ObservationIgnored private let hasTeslaPlan: Bool
    @ObservationIgnored private let loadHistory: () async throws -> RatePlanHistoryDTO
    @ObservationIgnored private let saveHistory: ([RatePlanHistoryPeriod]) async throws -> Void

    init(
        hasTeslaPlan: Bool,
        loadHistory: @escaping () async throws -> RatePlanHistoryDTO,
        saveHistory: @escaping ([RatePlanHistoryPeriod]) async throws -> Void
    ) {
        self.hasTeslaPlan = hasTeslaPlan
        self.loadHistory = loadHistory
        self.saveHistory = saveHistory
    }

    func load() async {
        state = .loading
        errorMessage = nil
        do {
            let history = try await loadHistory()
            state = .ready(RatePlanHistoryFlow(history: history, hasTeslaPlan: hasTeslaPlan))
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed
        }
    }

    /// Applies an answer to the flow; ignored until the history has loaded or while saving.
    func update(_ change: (inout RatePlanHistoryFlow) -> Void) {
        guard case .ready(var flow) = state, !isSaving else { return }
        change(&flow)
        state = .ready(flow)
        errorMessage = nil
    }

    func save() async {
        guard case .ready(let flow) = state, !isSaving else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            try await saveHistory(flow.periods())
            isDone = true
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = RatePlanHistoryPresentation.saveErrorMessage(for: error)
        }
    }
}
