import Combine
import Foundation

@MainActor
protocol MobileDashboardDataAPI: Sendable {
    func fetchLive(siteID: String) async throws -> MobileLiveResponse
    func fetchBill(siteID: String) async throws -> MobileBillResponse
}

extension PWUsageAPI: MobileDashboardDataAPI {}

@MainActor
protocol MobileLoadPlanningDataAPI: Sendable {
    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse
}

extension PWUsageAPI: MobileLoadPlanningDataAPI {}

enum SolarForecastEnhancementState: Equatable {
    case basic
    case loadingWithBasic
    case enhanced
    case failedWithBasic
    case disconnectedBasic
}

/// Whether the user has finished setting forecasting up on this device. Kept
/// apart from `SolarForecastEnhancementState` so the UI can stay silent when no
/// key exists and explain itself when one does.
enum SolarForecastConnectionState: Equatable {
    case notConnected
    case awaitingArraySelection
    case ready
}

/// Why forecast enhancement is unavailable, from the device's own request
/// bookkeeping. Kept apart from `SolarForecastRefreshFailure` so a spent daily
/// allowance is not reported as a failed request.
enum SolarForecastUnavailableCause: Equatable {
    case unauthorized
    case rateLimited
    case requestFailed
    case invalidForecast
    case storageFailure
    case cleanupFailure
    case budgetExhausted
    case deferred

    init(_ failure: SolarForecastRefreshFailure) {
        switch failure {
        case .unauthorized: self = .unauthorized
        case .rateLimited: self = .rateLimited
        case .requestFailed: self = .requestFailed
        case .invalidForecast: self = .invalidForecast
        case .storageFailure: self = .storageFailure
        case .cleanupFailure: self = .cleanupFailure
        }
    }

    /// `nil` when the attempt succeeded or was never a provider failure.
    init?(_ result: SolarForecastRefreshResult) {
        switch result {
        case .failed(let failure): self = SolarForecastUnavailableCause(failure)
        case .budgetExhausted: self = .budgetExhausted
        case .deferred: self = .deferred
        case .refreshed, .alreadyFresh, .notConfigured, .cancelled: return nil
        }
    }
}

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
    static let planningContextLifetime: TimeInterval = 24 * 60 * 60

    @Published private(set) var selectedSiteID: String
    @Published private(set) var live = DashboardEndpointState<MobileLiveResponse>()
    @Published private(set) var bill = DashboardEndpointState<MobileBillResponse>()
    @Published private(set) var isForeground = false
    @Published private(set) var requiresSignIn = false
    @Published private(set) var solarForecastState: SolarForecastEnhancementState = .basic
    @Published private(set) var solarForecastConnection: SolarForecastConnectionState = .notConnected
    @Published private(set) var solarForecastUnavailableCause: SolarForecastUnavailableCause?
    @Published private(set) var solarForecastBatch: SolarForecastBatch?
    @Published private(set) var loadPlanningContext: LoadTimingForecastEstimator.PlanningContext?

    var pollingTimerIsActive: Bool { timerTask != nil }

    private let api: any MobileDashboardDataAPI
    private let planningAPI: (any MobileLoadPlanningDataAPI)?
    private let forecastStore: (any SolarForecastManaging)?
    private let accountScopeID: String?
    private let now: () -> Date
    private let timerInterval: Duration?
    private var sceneIsActive = false
    private var timerTask: Task<Void, Never>?
    private var liveTask: Task<Void, Never>?
    private var billTask: Task<Void, Never>?
    private var siteGeneration = 0
    private var forecastGeneration = 0
    private var billSuccessGeneration = 0
    private var planningContextCache: [String: PlanningContextCacheEntry] = [:]
    private var planningContextTasks: [String: PlanningContextTask] = [:]

    private struct PlanningContextCacheEntry {
        let response: MobileLoadPlanningContextResponse
        let fetchedAt: Date
    }

    private struct PlanningContextTask {
        let id: UUID
        let task: Task<MobileLoadPlanningContextResponse?, Never>
    }

    init(
        siteID: String,
        api: any MobileDashboardDataAPI,
        planningAPI: (any MobileLoadPlanningDataAPI)? = nil,
        forecastStore: (any SolarForecastManaging)? = nil,
        accountScopeID: String? = nil,
        now: @escaping () -> Date = Date.init,
        timerInterval: Duration? = .seconds(30)
    ) {
        selectedSiteID = siteID
        self.api = api
        self.planningAPI = planningAPI
        self.forecastStore = forecastStore
        self.accountScopeID = accountScopeID
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

    /// Invalidates optional forecast work before the authenticated app state is
    /// discarded. Late provider/context completions must never restore it.
    func authenticationInvalidated() {
        forecastGeneration += 1
        resetForecastEnhancement(state: .basic, connection: .notConnected)
    }

    func selectSite(_ siteID: String) {
        guard siteID != selectedSiteID else { return }
        selectedSiteID = siteID
        siteGeneration += 1
        forecastGeneration += 1
        liveTask?.cancel()
        billTask?.cancel()
        liveTask = nil
        billTask = nil
        live.reset()
        bill.reset()
        resetForecastEnhancement(state: .basic, connection: .notConnected)
        guard isForeground, !requiresSignIn else { return }
        Task { await refreshDue() }
        // The destination view is not re-inserted on a site switch, so re-run the
        // optional enhancement here or the new site stays on the basic estimate.
        Task { await loadTimingDetailAppeared() }
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

    /// Starts the optional enhancement only when a local credential and array
    /// selection exist. This path refreshes bill/context data but never live data.
    func loadTimingDetailAppeared() async {
        let operation = beginForecastOperation()
        guard let forecastStore, let planningAPI, let accountScopeID else {
            solarForecastState = .basic
            return
        }
        let siteID = selectedSiteID
        guard let credential = await forecastStore.credential(accountScopeID: accountScopeID, siteID: siteID) else {
            guard operation == forecastGeneration, siteID == selectedSiteID else { return }
            solarForecastState = .basic
            solarForecastConnection = .notConnected
            solarForecastUnavailableCause = nil
            solarForecastBatch = nil
            loadPlanningContext = nil
            return
        }
        guard !credential.resourceIDs.isEmpty else {
            guard operation == forecastGeneration, siteID == selectedSiteID else { return }
            solarForecastState = .basic
            solarForecastConnection = .awaitingArraySelection
            solarForecastUnavailableCause = nil
            solarForecastBatch = nil
            loadPlanningContext = nil
            return
        }
        guard operation == forecastGeneration, siteID == selectedSiteID, !requiresSignIn else { return }
        solarForecastState = .loadingWithBasic
        solarForecastConnection = .ready
        solarForecastUnavailableCause = nil

        let billSuccessBeforeRefresh = billSuccessGeneration
        async let billRefresh: Void = refreshBill(force: true)
        async let refreshResult = forecastStore.refresh(accountScopeID: accountScopeID, siteID: siteID, manual: false)
        async let contextResult = planningContext(siteID: siteID, api: planningAPI)
        let (refresh, context) = await (refreshResult, contextResult)
        await billRefresh

        guard operation == forecastGeneration, siteID == selectedSiteID, !requiresSignIn else { return }
        guard refresh == .refreshed || refresh == .alreadyFresh,
              billSuccessGeneration > billSuccessBeforeRefresh,
              bill.response?.site.id == siteID,
              bill.response?.site.timezone == context?.timeZone,
              await forecastStore.isRecommendationUsable(accountScopeID: accountScopeID, siteID: siteID),
              let batch = await forecastStore.cachedBatch(accountScopeID: accountScopeID, siteID: siteID),
              let context else {
            solarForecastUnavailableCause = SolarForecastUnavailableCause(refresh)
            solarForecastBatch = nil
            loadPlanningContext = nil
            solarForecastState = .failedWithBasic
            return
        }
        solarForecastBatch = batch
        loadPlanningContext = context
        solarForecastState = .enhanced
    }

    func refreshSolarForecast(manual: Bool) async {
        let operation = beginForecastOperation()
        guard let forecastStore, let accountScopeID else {
            solarForecastState = .basic
            return
        }
        let siteID = selectedSiteID
        guard let credential = await forecastStore.credential(accountScopeID: accountScopeID, siteID: siteID) else {
            guard operation == forecastGeneration, siteID == selectedSiteID else { return }
            solarForecastState = .basic
            solarForecastConnection = .notConnected
            return
        }
        solarForecastConnection = credential.resourceIDs.isEmpty ? .awaitingArraySelection : .ready
        solarForecastState = .loadingWithBasic
        let refresh = await forecastStore.refresh(accountScopeID: accountScopeID, siteID: siteID, manual: manual)
        guard operation == forecastGeneration, siteID == selectedSiteID, !requiresSignIn else { return }
        guard refresh == .refreshed || refresh == .alreadyFresh,
              await forecastStore.isRecommendationUsable(accountScopeID: accountScopeID, siteID: siteID),
              let batch = await forecastStore.cachedBatch(accountScopeID: accountScopeID, siteID: siteID),
              loadPlanningContext != nil else {
            solarForecastUnavailableCause = SolarForecastUnavailableCause(refresh)
            solarForecastBatch = nil
            solarForecastState = .failedWithBasic
            return
        }
        solarForecastBatch = batch
        solarForecastUnavailableCause = nil
        solarForecastState = .enhanced
    }

    @discardableResult
    func connectSolarForecast(apiKey: String) async throws -> String {
        let operation = beginForecastOperation()
        guard let forecastStore, let accountScopeID else { throw SolarForecastStore.StoreError.invalidConfiguration }
        let siteID = selectedSiteID
        let credentialID = try await forecastStore.connect(
            apiKey: apiKey,
            accountScopeID: accountScopeID,
            siteID: siteID,
            resourceIDs: nil
        )
        if operation == forecastGeneration, siteID == selectedSiteID {
            resetForecastEnhancement(state: .basic, connection: .awaitingArraySelection)
        }
        return credentialID
    }

    func discoverSolarSites(manual: Bool = true) async throws -> [SolcastSite] {
        _ = beginForecastOperation()
        guard let forecastStore, let accountScopeID else { throw SolarForecastStore.StoreError.invalidConfiguration }
        return try await forecastStore.discoverSites(
            accountScopeID: accountScopeID,
            siteID: selectedSiteID,
            manual: manual
        )
    }

    func selectSolarArrays(_ resourceIDs: [String]) async throws {
        let operation = beginForecastOperation()
        guard let forecastStore, let accountScopeID else { throw SolarForecastStore.StoreError.invalidConfiguration }
        let siteID = selectedSiteID
        try await forecastStore.selectArrays(resourceIDs, accountScopeID: accountScopeID, siteID: siteID)
        if operation == forecastGeneration, siteID == selectedSiteID {
            resetForecastEnhancement(state: .basic, connection: .ready)
        }
    }

    func solarForecastCredential() async -> SolarForecastCredential? {
        guard let forecastStore, let accountScopeID else { return nil }
        return await forecastStore.credential(accountScopeID: accountScopeID, siteID: selectedSiteID)
    }

    func solarForecastBudget() async -> SolarForecastBudget? {
        guard let forecastStore, let accountScopeID else { return nil }
        return await forecastStore.budget(for: accountScopeID, siteID: selectedSiteID)
    }

    func disconnectSolarForecast() async throws {
        let operation = beginForecastOperation()
        guard let forecastStore, let accountScopeID else { throw SolarForecastStore.StoreError.invalidConfiguration }
        let siteID = selectedSiteID
        try await forecastStore.disconnect(accountScopeID: accountScopeID, siteID: siteID)
        guard operation == forecastGeneration, siteID == selectedSiteID else { return }
        resetForecastEnhancement(state: .disconnectedBasic, connection: .notConnected)
    }

    /// Settings text edits and profile comparisons are deliberately local.
    func solarForecastSettingsDidEdit() {}
    func loadProfileDidEdit() {}

    private func planningContext(
        siteID: String,
        api: any MobileLoadPlanningDataAPI
    ) async -> LoadTimingForecastEstimator.PlanningContext? {
        let requestTime = now()
        if let cached = planningContextCache[siteID],
           requestTime.timeIntervalSince(cached.fetchedAt) >= 0,
           requestTime.timeIntervalSince(cached.fetchedAt) < Self.planningContextLifetime,
           let validated = try? cached.response.validating(siteID: siteID, now: requestTime) {
            return validated.estimatorContext
        }
        let pending: PlanningContextTask
        if let existing = planningContextTasks[siteID] {
            pending = existing
        } else {
            let id = UUID()
            let task = Task { try? await api.fetchLoadPlanningContext(siteID: siteID) }
            pending = PlanningContextTask(id: id, task: task)
            planningContextTasks[siteID] = pending
        }
        do {
            let response = await pending.task.value
            let receiveTime = now()
            if planningContextTasks[siteID]?.id == pending.id { planningContextTasks.removeValue(forKey: siteID) }
            guard let response else { return nil }
            let validated = try response.validating(siteID: siteID, now: receiveTime)
            guard validated.availability == .available, let context = validated.estimatorContext else { return nil }
            planningContextCache[siteID] = PlanningContextCacheEntry(response: validated, fetchedAt: receiveTime)
            return context
        } catch {
            if planningContextTasks[siteID]?.id == pending.id { planningContextTasks.removeValue(forKey: siteID) }
            return nil
        }
    }

    private func beginForecastOperation() -> Int {
        forecastGeneration += 1
        return forecastGeneration
    }

    private func resetForecastEnhancement(state: SolarForecastEnhancementState, connection: SolarForecastConnectionState) {
        solarForecastBatch = nil
        loadPlanningContext = nil
        solarForecastState = state
        solarForecastConnection = connection
        solarForecastUnavailableCause = nil
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
            billSuccessGeneration += 1
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
            authenticationInvalidated()
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
