import Foundation
@testable import PWUsage

actor HistoryAPI: MobileSolarHistoryDataAPI {
    struct Request: Sendable { let from: String; let changedSince: Date? }
    private var responses: [MobileSolarHistoryResponse]
    private let failAt: Int?
    private let failure: any Error
    private(set) var requests: [Request] = []

    init(responses: [MobileSolarHistoryResponse], failAt: Int? = nil, failure: any Error = HistoryFailure.injected) {
        self.responses = responses
        self.failAt = failAt
        self.failure = failure
    }

    func fetchSolarHistory(
        siteID: String,
        from: String,
        changedSince: Date?
    ) async throws -> MobileSolarHistoryResponse {
        requests.append(Request(from: from, changedSince: changedSince))
        if requests.count == failAt { throw failure }
        return responses.isEmpty ? .disabled : responses.removeFirst()
    }
}

enum HistoryFailure: Error { case injected }

actor SuspendedHistoryAPI: MobileSolarHistoryDataAPI {
    private var responseContinuation: CheckedContinuation<MobileSolarHistoryResponse, Never>?
    private var requestContinuation: CheckedContinuation<Void, Never>?
    private var requested = false

    func fetchSolarHistory(
        siteID: String,
        from: String,
        changedSince: Date?
    ) async throws -> MobileSolarHistoryResponse {
        requested = true
        requestContinuation?.resume()
        requestContinuation = nil
        return await withCheckedContinuation { responseContinuation = $0 }
    }

    func waitUntilRequested() async {
        guard !requested else { return }
        await withCheckedContinuation { requestContinuation = $0 }
    }

    func resume(with response: MobileSolarHistoryResponse) {
        responseContinuation?.resume(returning: response)
        responseContinuation = nil
    }
}
