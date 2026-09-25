import Combine
import Foundation

@MainActor
protocol MobileDashboardDataAPI: Sendable {
    func fetchLive(siteID: String) async throws -> MobileLiveResponse
    func fetchBill(siteID: String) async throws -> MobileBillResponse
}

extension PWUsageAPI: MobileDashboardDataAPI {}

struct DashboardEndpointState<Response: Equatable>: Equatable {
    fileprivate(set) var response: Response?
    fileprivate(set) var lastAttempt: Date?
    fileprivate(set) var lastSuccess: Date?
    fileprivate(set) var isUnavailable = false
    fileprivate(set) var unavailableStatusCode: Int?

    fileprivate mutating func reset() {
        response = nil
        lastAttempt = nil
        lastSuccess = nil
        isUnavailable = false
        unavailableStatusCode = nil
    }
}

@MainActor
final class DashboardCoordinator: ObservableObject {
    static let liveInterval: TimeInterval = 5 * 60
    static let billInterval: TimeInterval = 30 * 60

    @Published private(set) var selectedSiteID: String
    @Published private(set) var live = DashboardEndpointState<MobileLiveResponse>()
    @Published private(set) var bill = DashboardEndpointState<MobileBillResponse>()
    @Published private(set) var isForeground = false
    @Published private(set) var requiresSignIn = false

    var pollingTimerIsActive: Bool { timerTask != nil }

    private let api: any MobileDashboardDataAPI
    private let now: () -> Date
    private let timerInterval: Duration?
    private var sceneIsActive = false
    private var timerTask: Task<Void, Never>?
    private var liveTask: Task<Void, Never>?
    private var billTask: Task<Void, Never>?
    private var siteGeneration = 0

    init(
        siteID: String,
        api: any MobileDashboardDataAPI,
        now: @escaping () -> Date = Date.init,
        timerInterval: Duration? = .seconds(30)
    ) {
        selectedSiteID = siteID
        self.api = api
        self.now = now
        self.timerInterval = timerInterval
    }

    func scenePhaseChanged(isActive: Bool) {
        if isActive {
            sceneIsActive = true
            guard !requiresSignIn else { return }
            guard !isForeground else { return }
            isForeground = true
            startTimer()
            Task { await refreshDue() }
        } else {
            sceneIsActive = false
            isForeground = false
            stopTimer()
        }
    }

    /// Call after MobileAuthService completes a successful sign-in exchange.
    func authenticationRestored() {
        guard requiresSignIn else { return }
        requiresSignIn = false
        live.lastAttempt = nil
        bill.lastAttempt = nil
        guard sceneIsActive else { return }
        isForeground = true
        startTimer()
        Task { await refreshDue() }
    }

    func selectSite(_ siteID: String) {
        guard siteID != selectedSiteID else { return }
        selectedSiteID = siteID
        siteGeneration += 1
        liveTask?.cancel()
        billTask?.cancel()
        liveTask = nil
        billTask = nil
        live.reset()
        bill.reset()
        guard isForeground, !requiresSignIn else { return }
        Task { await refreshDue() }
    }

    /// Called by the foreground timer and lifecycle events. Missed intervals collapse to one request.
    func refreshDue() async {
        await refreshAll(force: false)
    }

    /// Refreshes live power readings followed by bill estimates.
    /// When `force` is true, bypasses elapsed cadence checks.
    func refreshAll(force: Bool = true) async {
        guard !requiresSignIn else { return }
        if !force {
            guard isForeground else { return }
        }
        let requestTime = now()
        let generation = siteGeneration

        if liveTask == nil {
            if force || isDue(lastAttempt: live.lastAttempt, interval: Self.liveInterval, at: requestTime) {
                live.lastAttempt = requestTime
                let siteID = selectedSiteID
                liveTask = Task { await performLive(siteID: siteID, generation: generation) }
            }
        }
        // The live endpoint may first import stale energy history. Wait for it
        // before asking the bill endpoint to calculate from that history.
        await liveTask?.value
        guard !requiresSignIn, generation == siteGeneration else { return }
        if !force {
            guard isForeground else { return }
        }

        launchBillTaskIfNeeded(force: force, requestTime: requestTime, generation: generation)

        await billTask?.value
    }

    /// Refreshes the bill estimate.
    /// When `force` is true, bypasses elapsed cadence checks.
    func refreshBill(force: Bool = true) async {
        guard !requiresSignIn else { return }
        if !force {
            guard isForeground else { return }
        }
        let requestTime = now()
        let generation = siteGeneration

        launchBillTaskIfNeeded(force: force, requestTime: requestTime, generation: generation)

        await billTask?.value
    }

    private func launchBillTaskIfNeeded(force: Bool, requestTime: Date, generation: Int) {
        guard billTask == nil else { return }
        if force || isDue(lastAttempt: bill.lastAttempt, interval: Self.billInterval, at: requestTime) {
            bill.lastAttempt = requestTime
            let siteID = selectedSiteID
            billTask = Task { await performBill(siteID: siteID, generation: generation) }
        }
    }

    private func isDue(lastAttempt: Date?, interval: TimeInterval, at date: Date) -> Bool {
        guard let lastAttempt else { return true }
        return date.timeIntervalSince(lastAttempt) >= interval
    }

    private func performLive(siteID: String, generation: Int) async {
        defer {
            if generation == siteGeneration { liveTask = nil }
        }
        do {
            let response = try await api.fetchLive(siteID: siteID)
            guard generation == siteGeneration, !requiresSignIn else { return }
            live.response = response
            live.lastSuccess = now()
            live.isUnavailable = false
            live.unavailableStatusCode = nil
        } catch {
            handle(error, generation: generation, endpoint: .live)
        }
    }

    private func performBill(siteID: String, generation: Int) async {
        defer {
            if generation == siteGeneration { billTask = nil }
        }
        do {
            let response = try await api.fetchBill(siteID: siteID)
            guard generation == siteGeneration, !requiresSignIn else { return }
            bill.response = response
            bill.lastSuccess = now()
            bill.isUnavailable = false
            bill.unavailableStatusCode = nil
        } catch {
            handle(error, generation: generation, endpoint: .bill)
        }
    }

    private enum Endpoint { case live, bill }

    private func handle(_ error: Error, generation: Int, endpoint: Endpoint) {
        guard generation == siteGeneration else { return }
        if error as? PWUsageAPIError == .signInRequired {
            requiresSignIn = true
            isForeground = false
            liveTask?.cancel()
            billTask?.cancel()
            stopTimer()
            return
        }
        switch endpoint {
        case .live:
            live.isUnavailable = true
            live.unavailableStatusCode = (error as? PWUsageAPIError).flatMap {
                guard case let .recoverableServerError(statusCode) = $0 else { return nil }
                return statusCode
            }
        case .bill:
            bill.isUnavailable = true
            bill.unavailableStatusCode = (error as? PWUsageAPIError).flatMap {
                guard case let .recoverableServerError(statusCode) = $0 else { return nil }
                return statusCode
            }
        }
    }

    private func startTimer() {
        guard timerTask == nil, let timerInterval else { return }
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: timerInterval) }
                catch { return }
                guard let self, self.isForeground, !self.requiresSignIn else { return }
                await self.refreshDue()
            }
        }
    }

    private func stopTimer() {
        timerTask?.cancel()
        timerTask = nil
    }
}
