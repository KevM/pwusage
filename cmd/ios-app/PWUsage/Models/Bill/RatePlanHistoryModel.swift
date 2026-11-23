import Foundation
import Observation
import PWUsageCore

/// The history guide screen's state: loads the walk-back's data, holds the flow while the owner
/// answers, and saves the confirmed periods. The view renders `state` and mutates the flow via `update`.
@MainActor
@Observable
final class RatePlanHistoryModel {
    enum State: Equatable {
        case loading
        case ready(RatePlanHistoryFlow)
        /// The message the retry screen shows.
        case failed(String)
    }

    private(set) var state: State = .loading
    private(set) var isSaving = false
    private(set) var errorMessage: String?
    private(set) var isDone = false

    /// The site's stored fixed comparison periods, which the flow prefills each plan's rows from.
    @ObservationIgnored private let referencePeriods: [TariffPeriodDTO]
    @ObservationIgnored private let loadHistory: () async throws -> RatePlanHistoryDTO
    @ObservationIgnored private let saveHistory: ([RatePlanHistoryPeriod]) async throws -> Void

    init(
        referencePeriods: [TariffPeriodDTO] = [],
        loadHistory: @escaping () async throws -> RatePlanHistoryDTO,
        saveHistory: @escaping ([RatePlanHistoryPeriod]) async throws -> Void
    ) {
        self.referencePeriods = referencePeriods
        self.loadHistory = loadHistory
        self.saveHistory = saveHistory
    }

    /// Loads the history once. A view's `.task` can run again (a sheet re-appears), so an
    /// in-progress flow is never discarded: use `reload()` to start over.
    func load() async {
        if case .ready = state { return }
        await reload()
    }

    /// Fetches the history again and starts the flow over; the Try Again button's path.
    func reload() async {
        state = .loading
        errorMessage = nil
        do {
            let history = try await loadHistory()
            state = .ready(RatePlanHistoryFlow(
                history: history, hasTeslaPlan: history.teslaShape != nil, referencePeriods: referencePeriods
            ))
        } catch {
            // A cancelled load (the view went away) ends as failed too, never stuck at loading.
            state = .failed(RatePlanHistoryPresentation.loadErrorMessage(for: error))
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
