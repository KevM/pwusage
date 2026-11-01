import BackgroundTasks
import Foundation
import os
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

actor ScopeSwitchingHistoryAPI: MobileSolarHistoryDataAPI {
    private let page: MobileSolarHistoryResponse
    private var requestContinuation: CheckedContinuation<Void, Never>?
    private var resumeContinuation: CheckedContinuation<MobileSolarHistoryResponse, Never>?
    private var requestCount = 0

    init(page: MobileSolarHistoryResponse) {
        self.page = page
    }

    func fetchSolarHistory(
        siteID: String,
        from: String,
        changedSince: Date?
    ) async throws -> MobileSolarHistoryResponse {
        requestCount += 1
        if requestCount == 1 {
            requestContinuation?.resume()
            requestContinuation = nil
            return await withCheckedContinuation { resumeContinuation = $0 }
        }
        return page
    }

    func waitUntilRequested() async {
        guard requestCount == 0 else { return }
        await withCheckedContinuation { requestContinuation = $0 }
    }

    func resumeScopeA() {
        resumeContinuation?.resume(returning: page)
        resumeContinuation = nil
    }
}

final class FakeBackgroundTask: BackgroundLayoutDetectingTask, @unchecked Sendable {
    var expirationHandler: (() -> Void)?
    private let completionLock = OSAllocatedUnfairLock(initialState: [Bool]())
    var completedCount: Int { completionLock.withLock { $0.count } }
    var lastSuccess: Bool? { completionLock.withLock { $0.last } }
    func setTaskCompleted(success: Bool) { completionLock.withLock { $0.append(success) } }
}

final class DetectionGate: @unchecked Sendable {
    private struct State {
        var callCount = 0
        var startedContinuation: CheckedContinuation<Void, Never>?
    }
    private let lock = OSAllocatedUnfairLock(initialState: State())
    private let resumeSemaphore = DispatchSemaphore(value: 0)

    var callCount: Int { lock.withLock { $0.callCount } }

    func onDetect() {
        let shouldWait = lock.withLock { state -> Bool in
            state.callCount += 1
            if state.callCount == 1 {
                let cont = state.startedContinuation
                state.startedContinuation = nil
                cont?.resume()
                return true
            }
            return false
        }
        if shouldWait {
            resumeSemaphore.wait()
        }
    }

    func waitUntilStarted() async {
        if lock.withLock({ $0.callCount > 0 }) { return }
        await withCheckedContinuation { cont in
            if lock.withLock({ state -> Bool in
                if state.callCount > 0 { return true }
                state.startedContinuation = cont
                return false
            }) { cont.resume() }
        }
    }

    func proceed() { resumeSemaphore.signal() }
}
