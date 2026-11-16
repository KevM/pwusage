import Foundation
@testable import PWUsage
import Testing

/// Stands in for the utility search and mutation calls. A query can be answered at once, or held
/// open until the test resumes it, so stale-result ordering is exercised deterministically.
@MainActor
private final class UtilityStub {
    private(set) var searched: [String] = []
    private(set) var selected: [String] = []
    private(set) var skipCount = 0
    var immediate: [String: [String]] = [:]
    var pending: [String: CheckedContinuation<[String], any Error>] = [:]
    var setFailure: (any Error)?

    func search(_ term: String) async throws -> [String] {
        searched.append(term)
        if let answer = immediate[term] { return answer }
        return try await withCheckedThrowingContinuation { pending[term] = $0 }
    }

    func setUtility(_ name: String) async throws {
        if let setFailure { throw setFailure }
        selected.append(name)
    }

    func skipUtility() async throws {
        if let setFailure { throw setFailure }
        skipCount += 1
    }

    func model(debounce: Duration = .milliseconds(5)) -> UtilityPickerModel {
        UtilityPickerModel(
            debounce: debounce,
            search: { [self] term in try await search(term) },
            setUtility: { [self] name in try await setUtility(name) },
            skipUtility: { [self] in try await skipUtility() }
        )
    }
}

private struct StubFailure: Error {}

@MainActor
@Suite("Utility picker search and selection")
struct UtilityPickerModelTests {
    @Test("Fewer than two trimmed characters never search")
    func shortQueriesDoNotSearch() async throws {
        let stub = UtilityStub()
        let model = stub.model()
        model.query = " a "
        try await staysTrue(for: .milliseconds(40)) { stub.searched.isEmpty && model.results.isEmpty }
    }

    @Test("A query of two or more characters shows the debounced results")
    func debouncedSearchShowsResults() async throws {
        let stub = UtilityStub()
        stub.immediate["pac"] = ["Pacific Gas & Electric"]
        let model = stub.model()
        model.query = "pac"
        try await eventually { model.results == ["Pacific Gas & Electric"] }
        #expect(stub.searched == ["pac"])
    }

    @Test("Typing quickly coalesces into one search for the latest query")
    func rapidTypingCoalesces() async throws {
        let stub = UtilityStub()
        stub.immediate["abc"] = ["ABC Power"]
        let model = stub.model(debounce: .milliseconds(30))
        model.query = "ab"
        model.query = "abc"
        try await eventually { model.results == ["ABC Power"] }
        #expect(stub.searched == ["abc"])
    }

    @Test("A slower earlier query never overwrites a newer result")
    func staleSearchIsIgnored() async throws {
        let stub = UtilityStub()
        stub.immediate["abc"] = ["Newer"]
        let model = stub.model()
        model.query = "ab"
        try await eventually { stub.searched == ["ab"] }
        model.query = "abc"
        try await eventually { model.results == ["Newer"] }
        stub.pending["ab"]?.resume(returning: ["Older"])
        try await staysTrue(for: .milliseconds(40)) { model.results == ["Newer"] }
    }

    @Test("Clearing the query below two characters clears the results at once")
    func shortQueryClearsResults() async throws {
        let stub = UtilityStub()
        stub.immediate["pac"] = ["Pacific Gas & Electric"]
        let model = stub.model()
        model.query = "pac"
        try await eventually { !model.results.isEmpty }
        model.query = "p"
        #expect(model.results.isEmpty)
    }

    @Test("Choosing a utility saves it and marks the picker done")
    func selectingSavesAndFinishes() async {
        let stub = UtilityStub()
        let model = stub.model()
        await model.select("Pacific Gas & Electric")
        #expect(stub.selected == ["Pacific Gas & Electric"])
        #expect(model.isDone)
        #expect(model.errorMessage == nil)
    }

    @Test("A failed save shows a message and does not finish")
    func failedSelectKeepsPickerOpen() async {
        let stub = UtilityStub()
        stub.setFailure = StubFailure()
        let model = stub.model()
        await model.select("Pacific Gas & Electric")
        #expect(!model.isDone)
        #expect(model.errorMessage != nil)
    }

    @Test("Not listed skips the utility and finishes")
    func skippingFinishes() async {
        let stub = UtilityStub()
        let model = stub.model()
        await model.skip()
        #expect(stub.skipCount == 1)
        #expect(model.isDone)
    }

    @Test("A failed skip shows a message and does not finish")
    func failedSkipKeepsPickerOpen() async {
        let stub = UtilityStub()
        stub.setFailure = StubFailure()
        let model = stub.model()
        await model.skip()
        #expect(!model.isDone)
        #expect(model.errorMessage != nil)
    }
}
