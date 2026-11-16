import Foundation
import Observation

/// The utility picker's search and choice. Queries are debounced and stale results are dropped,
/// so only the latest query can fill the list. Choosing a utility or skipping it finishes the picker.
@MainActor
@Observable
final class UtilityPickerModel {
    static let minimumQueryLength = 2
    static let saveFailureMessage = "Couldn’t save your utility. Check your connection and try again."

    var query = "" {
        didSet {
            guard query != oldValue else { return }
            scheduleSearch()
        }
    }

    private(set) var results: [String] = []
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

    private func scheduleSearch() {
        searchGeneration += 1
        let generation = searchGeneration
        searchTask?.cancel()
        searchTask = nil
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard term.count >= Self.minimumQueryLength else {
            results = []
            return
        }
        searchTask = Task {
            do {
                try await Task.sleep(for: debounce)
                let found = try await searchUtilities(term)
                guard generation == searchGeneration else { return }
                results = found
            } catch {
                guard generation == searchGeneration, !(error is CancellationError) else { return }
                results = []
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
