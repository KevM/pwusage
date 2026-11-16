import Foundation
import Observation

/// The utility picker's search and choice. Queries are debounced and stale results are dropped,
/// so only the latest query can fill the list. Choosing a utility or skipping it finishes the picker.
@MainActor
@Observable
final class UtilityPickerModel {
    /// What the list shows for the current query.
    enum SearchState: Equatable {
        case idle
        case results([String])
        case empty(query: String)
        case failed
    }

    static let minimumQueryLength = 2
    static let saveFailureMessage = "Couldn’t save your utility. Check your connection and try again."
    static let searchFailureMessage = "Couldn’t search utilities. Check your connection and try again."

    var query = "" {
        didSet {
            guard query != oldValue else { return }
            scheduleSearch()
        }
    }

    private(set) var searchState: SearchState = .idle
    private(set) var isSaving = false
    private(set) var errorMessage: String?
    private(set) var isDone = false

    @ObservationIgnored private let debounce: Duration
    @ObservationIgnored private let searchUtilities: (String) async throws -> [String]
    @ObservationIgnored private let setUtility: (String) async throws -> Void
    @ObservationIgnored private let skipUtility: () async throws -> Void
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var searchGeneration = 0

    init(
        debounce: Duration = .milliseconds(300),
        search: @escaping (String) async throws -> [String],
        setUtility: @escaping (String) async throws -> Void,
        skipUtility: @escaping () async throws -> Void
    ) {
        self.debounce = debounce
        searchUtilities = search
        self.setUtility = setUtility
        self.skipUtility = skipUtility
    }

    func select(_ name: String) async {
        await finish { try await setUtility(name) }
    }

    func skip() async {
        await finish { try await skipUtility() }
    }

    /// Drops any in-flight or pending search, so a late answer cannot land after the sheet goes away.
    func cancelSearch() {
        searchGeneration += 1
        searchTask?.cancel()
        searchTask = nil
        searchState = .idle
    }

    private func scheduleSearch() {
        cancelSearch()
        let generation = searchGeneration
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard term.count >= Self.minimumQueryLength else { return }
        searchTask = Task {
            do {
                try await Task.sleep(for: debounce)
                let found = try await searchUtilities(term)
                guard generation == searchGeneration else { return }
                searchState = found.isEmpty ? .empty(query: term) : .results(found)
            } catch {
                guard generation == searchGeneration, !(error is CancellationError) else { return }
                searchState = .failed
            }
        }
    }

    private func finish(_ save: () async throws -> Void) async {
        guard !isSaving else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            try await save()
            isDone = true
        } catch {
            errorMessage = Self.saveFailureMessage
        }
    }
}
