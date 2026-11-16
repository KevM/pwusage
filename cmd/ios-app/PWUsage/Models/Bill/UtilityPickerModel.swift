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
    /// The utility being saved or just saved; nil while nothing is chosen.
    private(set) var choice: PickerChoice?
    private(set) var isSaving = false
    private(set) var errorMessage: String?
    private(set) var isDone = false

    @ObservationIgnored private let debounce: Duration
    @ObservationIgnored private let confirmationHold: Duration
    @ObservationIgnored private let searchUtilities: (String) async throws -> [String]
    @ObservationIgnored private let setUtility: (String) async throws -> Void
    @ObservationIgnored private let skipUtility: () async throws -> Void
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var searchGeneration = 0

    init(
        debounce: Duration = .milliseconds(300),
        confirmationHold: Duration = PickerChoice.defaultConfirmationHold,
        search: @escaping (String) async throws -> [String],
        setUtility: @escaping (String) async throws -> Void,
        skipUtility: @escaping () async throws -> Void
    ) {
        self.debounce = debounce
        self.confirmationHold = confirmationHold
        searchUtilities = search
        self.setUtility = setUtility
        self.skipUtility = skipUtility
    }

    func select(_ name: String) async {
        await finish(choosing: name) { try await setUtility(name) }
    }

    func skip() async {
        await finish(choosing: nil) { try await skipUtility() }
    }

    /// Drops any in-flight or pending search, so a late answer cannot land after the sheet goes away.
    func cancelSearch() {
        searchGeneration += 1
        searchTask?.cancel()
        searchTask = nil
        searchState = .idle
    }

    /// Server names in their order, without repeats, so each row has a distinct identity.
    static func uniqueNames(_ names: [String]) -> [String] {
        var seen: Set<String> = []
        return names.filter { seen.insert($0).inserted }
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
                let names = Self.uniqueNames(found)
                searchState = names.isEmpty ? .empty(query: term) : .results(names)
            } catch {
                guard generation == searchGeneration, !(error is CancellationError) else { return }
                searchState = .failed
            }
        }
    }

    /// Saves, then holds a chosen row checked for a moment so the owner sees what they picked.
    private func finish(choosing name: String?, _ save: () async throws -> Void) async {
        guard !isSaving else { return }
        isSaving = true
        errorMessage = nil
        choice = name.map(PickerChoice.saving)
        defer { isSaving = false }
        do {
            try await save()
            if let name {
                choice = .saved(name)
                try? await Task.sleep(for: confirmationHold)
            }
            isDone = true
        } catch {
            choice = nil
            errorMessage = Self.saveFailureMessage
        }
    }
}
