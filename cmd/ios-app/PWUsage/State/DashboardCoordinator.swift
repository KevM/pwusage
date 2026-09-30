import Combine
import Foundation

@MainActor
protocol MobileDashboardDataAPI: Sendable {
    func fetchLive(siteID: String) async throws -> MobileLiveResponse
    func fetchBill(siteID: String) async throws -> MobileBillResponse
}

@MainActor
protocol MobileLoadPlanningDataAPI: Sendable {
    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse
}

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
    case unknownResource
    case invalidForecast
    case storageFailure
    case cleanupFailure
    case budgetExhausted
    case deferred

    /// `nil` when the failure does not make the forecast unavailable. A save
    /// failure is deliberately `nil`: the forecast is available in memory, so
    /// `causeNote`'s "Solar forecast unavailable" prefix would be false. It is
    /// surfaced by `DashboardCoordinator.solarForecastSaveFailure` instead.
    init?(_ failure: SolarForecastRefreshFailure) {
        switch failure {
        case .unauthorized: self = .unauthorized
        case .rateLimited: self = .rateLimited
        case .requestFailed: self = .requestFailed
        case .unknownResource: self = .unknownResource
        case .invalidForecast: self = .invalidForecast
        case .storageFailure: self = .storageFailure
        case .cleanupFailure: self = .cleanupFailure
        case .saveFailed: return nil
        }
    }

    /// `nil` when the attempt succeeded or was never a provider failure.
    init?(_ result: SolarForecastRefreshResult) {
        switch result {
        case .failed(let failure):
            guard let cause = SolarForecastUnavailableCause(failure) else { return nil }
            self = cause
        case .budgetExhausted: self = .budgetExhausted
        case .deferred: self = .deferred
        case .refreshed, .alreadyFresh, .notConfigured, .cancelled: return nil
        }
    }
}

/// Why the optional enhancement is not showing, when the connection itself is
/// healthy. Without this every failure collapsed into one sentence that named the
/// forecast, even when our own planning context was the missing piece.
enum SolarForecastEnhancementUnavailableReason: Equatable {
    case contextUnavailable
    /// The server has history, but too few of the most recent days are complete
    /// to build a household profile.
    case insufficientHistory
    /// The server has history, but its timestamps never line up with the site's
    /// local five-minute grid, so no day can be counted.
    case timestampMisaligned
    /// The request itself was rejected, so nothing is known about the profile.
    case requestFailed
    /// The server answered, but the payload failed contract validation.
    case contextInvalid
    /// The server does not have this route, so it predates the app build.
    case serverOutdated
    case forecastNotUsable
    case billUnavailable
    case siteMismatch
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
    /// What asked for a refresh, for both endpoints. Every call site must state
    /// which one it is, because only an explicit gesture bypasses the
    /// elapsed-time cadences: `.userGesture` also skips the live cadence, not
    /// just the bill's.
    enum RefreshTrigger { case userGesture, screenAppearance, scheduled }

    static let liveInterval: TimeInterval = 5 * 60
    static let billInterval: TimeInterval = 30 * 60
    /// Floor under appearance-driven bill refreshes, so opening the Load timing
    /// screen twice in a row does not bill twice but still feels fresh.
    static let billMinimumInterval: TimeInterval = 5 * 60
    static let planningContextLifetime: TimeInterval = 24 * 60 * 60

    @Published private(set) var selectedSiteID: String
    @Published private(set) var live = DashboardEndpointState<MobileLiveResponse>()
    @Published private(set) var bill = DashboardEndpointState<MobileBillResponse>()
    @Published private(set) var isForeground = false
    @Published private(set) var requiresSignIn = false
    @Published private(set) var solarForecastState: SolarForecastEnhancementState = .basic
    @Published private(set) var solarForecastConnection: SolarForecastConnectionState = .notConnected
    @Published private(set) var solarForecastUnavailableCause: SolarForecastUnavailableCause?
    /// The forecast was fetched but could not be written to disk. Not a cause:
    /// the forecast is on screen and usable, so it must not claim to be
    /// unavailable. Re-derived on every refresh outcome that reaches an
    /// enhancement decision — both refresh paths set it explicitly, including
    /// setting it back to `false` when they fall back to basic. The
    /// not-configured and awaiting-array-selection early returns deliberately
    /// leave it alone; that is inert, because the overlay reads this only on the
    /// enhanced path, which neither early return can reach.
    @Published private(set) var solarForecastSaveFailure = false
    @Published private(set) var solarForecastUnavailableReason: SolarForecastEnhancementUnavailableReason?
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

    /// The result of a planning-context fetch, keeping the failure instead of
    /// collapsing it. `try?` here previously discarded the error, which made a
    /// rejected request indistinguishable from an unreachable one.
    private struct PlanningContextFetchResult {
        let response: MobileLoadPlanningContextResponse?
        let error: (any Error)?
    }

    private struct PlanningContextTask {
        let id: UUID
        let task: Task<PlanningContextFetchResult, Never>
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

    /// Stops the polling timer. That cancel is the only one with any effect: the
    /// timer loop captures `self` weakly, so it is the one task that can still be
    /// running when the last strong reference goes away. `liveTask`/`billTask`
    /// capture `self` strongly, so they keep the coordinator alive until they
    /// finish — by the time `deinit` runs they are already complete or nil and
    /// cancelling them would be a no-op. Dropping an in-flight authenticated
    /// response after sign-out is prevented by `authenticationInvalidated()`,
    /// which the app model calls explicitly; that, not this `deinit`, is what
    /// delivers the backstop.
    deinit {
        timerTask?.cancel()
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

    /// Invalidates all in-flight authenticated work before the app state is
    /// discarded: optional forecast work, plus any live or bill request that is
    /// still on the wire. Without this a response that lands after sign-out
    /// repopulates a coordinator the user has already left.
    func authenticationInvalidated() {
        forecastGeneration += 1
        siteGeneration += 1
        cancelInFlightRequests()
        resetForecastEnhancement(state: .basic, connection: .notConnected)
    }

    func selectSite(_ siteID: String) {
        guard siteID != selectedSiteID else { return }
        selectedSiteID = siteID
        siteGeneration += 1
        forecastGeneration += 1
        cancelInFlightRequests()
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
        await refreshAll(trigger: .scheduled)
    }

    /// Refreshes live power readings followed by bill estimates.
    func refreshAll(trigger: RefreshTrigger) async {
        guard !requiresSignIn else { return }
        if trigger == .scheduled {
            guard isForeground else { return }
        }
        let requestTime = now()
        let generation = siteGeneration

        if liveTask == nil {
            if trigger == .userGesture
                || isDue(lastAttempt: live.lastAttempt, interval: Self.liveInterval, at: requestTime) {
                live.lastAttempt = requestTime
                let siteID = selectedSiteID
                liveTask = Task { await performLive(siteID: siteID, generation: generation) }
            }
        }
        // The live endpoint may first import stale energy history. Wait for it
        // before asking the bill endpoint to calculate from that history.
        await liveTask?.value
        guard !requiresSignIn, generation == siteGeneration else { return }
        if trigger == .scheduled {
            guard isForeground else { return }
        }

        launchBillTaskIfNeeded(trigger: trigger, requestTime: requestTime, generation: generation)

        await billTask?.value
    }

    /// Refreshes the bill estimate, subject to the trigger's cadence.
    func refreshBill(trigger: RefreshTrigger) async {
        guard !requiresSignIn else { return }
        if trigger == .scheduled {
            guard isForeground else { return }
        }
        let requestTime = now()
        let generation = siteGeneration

        launchBillTaskIfNeeded(trigger: trigger, requestTime: requestTime, generation: generation)

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
        async let billRefresh: Void = refreshBill(trigger: .screenAppearance)
        async let refreshResult = forecastStore.refresh(accountScopeID: accountScopeID, siteID: siteID, manual: false)
        async let contextResult = planningContext(siteID: siteID, api: planningAPI)
        let (refresh, outcome) = await (refreshResult, contextResult)
        let context = outcome.context
        await billRefresh

        guard operation == forecastGeneration, siteID == selectedSiteID, !requiresSignIn else { return }
        solarForecastUnavailableCause = SolarForecastUnavailableCause(refresh)
        // A save failure is not an unavailable forecast, on this path exactly as
        // on `refreshSolarForecast`. The batch is fresh and in memory — the store
        // kept it deliberately — so tearing the enhancement down here would show
        // "The forecast was too old or incomplete to use. Pull down to refresh it"
        // after a *successful* fetch of a brand-new forecast, which is the symptom
        // §5.5 was filed to remove. This path is the dominant one (pull-to-refresh
        // is the exception), so the omission is the more visible half of the bug.
        let saveFailed = refresh == .failed(.saveFailed)
        let refreshSucceeded = saveFailed || refresh == .refreshed || refresh == .alreadyFresh
        // The appearance-driven bill refresh is floored, so a bill fetched
        // moments ago by an earlier appearance, a site switch, or a pull is
        // already fresh. Requiring a brand new success here would drop the
        // enhancement every time the screen is reopened inside the floor.
        // Measured at the decision point, not before the awaits, so a slow
        // planning-context fetch cannot age a stale bill back into freshness.
        let billSucceeded = billSuccessGeneration > billSuccessBeforeRefresh || billIsFresh(at: now())
        let siteMatches = bill.response?.site.id == siteID
        let timeZoneMatches = context != nil && bill.response?.site.timezone == context?.timeZone
        let forecastUsable = await forecastStore.isRecommendationUsable(accountScopeID: accountScopeID, siteID: siteID)
        let batch = await forecastStore.cachedBatch(accountScopeID: accountScopeID, siteID: siteID)
        guard refreshSucceeded, billSucceeded, siteMatches, timeZoneMatches,
              forecastUsable, let batch, let context else {
            // The server's wire reason is more specific than anything inferred
            // locally, so it takes priority when present.
            solarForecastUnavailableReason = outcome.unavailableReason
                ?? Self.enhancementUnavailableReason(
                    refreshSucceeded: refreshSucceeded,
                    billSucceeded: billSucceeded,
                    siteMatches: siteMatches,
                    timeZoneMatches: timeZoneMatches,
                    forecastUsable: forecastUsable,
                    hasBatch: batch != nil,
                    hasContext: context != nil
                )
            solarForecastBatch = nil
            loadPlanningContext = nil
            solarForecastState = .failedWithBasic
            solarForecastSaveFailure = false
            return
        }
        solarForecastBatch = batch
        loadPlanningContext = context
        solarForecastUnavailableReason = nil
        solarForecastState = .enhanced
        solarForecastSaveFailure = saveFailed
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
        if loadPlanningContext == nil {
            solarForecastUnavailableCause = SolarForecastUnavailableCause(refresh)
            solarForecastBatch = nil
            if manual {
                // The missing half is our own household profile, not the
                // forecast, and this path is the only place a person can ask for
                // it. The note on screen tells them to pull down to refresh, so a
                // pull has to actually re-fetch the context. The appearance path
                // re-derives `solarForecastUnavailableReason`, so a `serverOutdated`
                // or `contextInvalid` diagnosis survives a repeat failure.
                await loadTimingDetailAppeared()
                return
            }
            solarForecastState = .failedWithBasic
            return
        }
        // A save failure is not an unavailable forecast: the batch is fresh and in
        // memory, so the enhancement stays up behind its own note rather than being
        // torn down behind a "Solar forecast unavailable" sentence.
        let saveFailed = refresh == .failed(.saveFailed)
        guard saveFailed || refresh == .refreshed || refresh == .alreadyFresh,
              await forecastStore.isRecommendationUsable(accountScopeID: accountScopeID, siteID: siteID),
              let batch = await forecastStore.cachedBatch(accountScopeID: accountScopeID, siteID: siteID) else {
            solarForecastUnavailableCause = SolarForecastUnavailableCause(refresh)
            solarForecastBatch = nil
            solarForecastState = .failedWithBasic
            solarForecastSaveFailure = false
            return
        }
        solarForecastBatch = batch
        solarForecastUnavailableCause = nil
        solarForecastState = .enhanced
        solarForecastSaveFailure = saveFailed
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

    private struct PlanningContextOutcome {
        let context: LoadTimingForecastEstimator.PlanningContext?
        let unavailableReason: SolarForecastEnhancementUnavailableReason?
    }

    private func planningContext(
        siteID: String,
        api: any MobileLoadPlanningDataAPI
    ) async -> PlanningContextOutcome {
        let requestTime = now()
        if let cached = planningContextCache[siteID],
           requestTime.timeIntervalSince(cached.fetchedAt) >= 0,
           requestTime.timeIntervalSince(cached.fetchedAt) < Self.planningContextLifetime,
           let validated = try? cached.response.validating(siteID: siteID, now: requestTime) {
            return PlanningContextOutcome(
                context: validated.estimatorContext,
                unavailableReason: Self.enhancementReason(forReason: validated.unavailableReason)
            )
        }
        let pending: PlanningContextTask
        if let existing = planningContextTasks[siteID] {
            pending = existing
        } else {
            let id = UUID()
            let task = Task {
                do {
                    return PlanningContextFetchResult(
                        response: try await api.fetchLoadPlanningContext(siteID: siteID),
                        error: nil
                    )
                } catch {
                    return PlanningContextFetchResult(response: nil, error: error)
                }
            }
            pending = PlanningContextTask(id: id, task: task)
            planningContextTasks[siteID] = pending
        }
        do {
            let fetched = await pending.task.value
            let receiveTime = now()
            if planningContextTasks[siteID]?.id == pending.id { planningContextTasks.removeValue(forKey: siteID) }
            guard let response = fetched.response else {
                if let error = fetched.error { throw error }
                return PlanningContextOutcome(context: nil, unavailableReason: .requestFailed)
            }
            let validated = try response.validating(siteID: siteID, now: receiveTime)
            let reason = Self.enhancementReason(forReason: validated.unavailableReason)
            guard validated.availability == .available, let context = validated.estimatorContext else {
                return PlanningContextOutcome(context: nil, unavailableReason: reason)
            }
            planningContextCache[siteID] = PlanningContextCacheEntry(response: validated, fetchedAt: receiveTime)
            return PlanningContextOutcome(context: context, unavailableReason: nil)
        } catch {
            if planningContextTasks[siteID]?.id == pending.id { planningContextTasks.removeValue(forKey: siteID) }
            // A thrown error means we never learned anything about the profile.
            // Reporting it as an unreadable profile would be a guess, and the
            // user is already frustrated by guesses.
            let reason: SolarForecastEnhancementUnavailableReason
            if error is MobileLoadPlanningContextResponse.ContractError {
                reason = .contextInvalid
            } else if let rejected = error as? PWUsageAPIError,
                case .requestRejected(let statusCode, _) = rejected, statusCode == 404 {
                reason = .serverOutdated
            } else {
                reason = .requestFailed
            }
            return PlanningContextOutcome(context: nil, unavailableReason: reason)
        }
    }

    /// Pull to refresh on the Load timing screen. This is the only place a person
    /// can ask for a new forecast, so it must genuinely do that rather than
    /// refreshing bill data alone.
    func loadTimingDetailRefreshed() async {
        await refreshBill(trigger: .userGesture)
        if solarForecastConnection != .notConnected {
            await refreshSolarForecast(manual: true)
        } else {
            await loadTimingDetailAppeared()
        }
    }

    /// Map the server's wire reason onto our own vocabulary so the note can be
    /// specific about which half of the household profile is missing.
    private static func enhancementReason(
        forReason reason: String?
    ) -> SolarForecastEnhancementUnavailableReason? {
        switch reason {
        case "insufficient-history": return .insufficientHistory
        case "timestamp-misaligned": return .timestampMisaligned
        default: return .contextUnavailable
        }
    }

    private static func enhancementUnavailableReason(
        refreshSucceeded: Bool,
        billSucceeded: Bool,
        siteMatches: Bool,
        timeZoneMatches: Bool,
        forecastUsable: Bool,
        hasBatch: Bool,
        hasContext: Bool
    ) -> SolarForecastEnhancementUnavailableReason? {
        if !refreshSucceeded { return nil }
        if !billSucceeded { return .billUnavailable }
        // A missing context is checked before the timezone comparison, otherwise
        // the absent value looks like a mismatch and names the wrong cause.
        if !hasContext { return .contextUnavailable }
        if !siteMatches || !timeZoneMatches { return .siteMismatch }
        if !forecastUsable || !hasBatch { return .forecastNotUsable }
        return nil
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
        solarForecastUnavailableReason = nil
        solarForecastSaveFailure = false
    }

    private func launchBillTaskIfNeeded(trigger: RefreshTrigger, requestTime: Date, generation: Int) {
        guard billTask == nil else { return }
        let due: Bool
        switch trigger {
        case .userGesture: due = true
        case .screenAppearance:
            due = isDue(lastAttempt: bill.lastAttempt, interval: Self.billMinimumInterval, at: requestTime)
        case .scheduled:
            due = isDue(lastAttempt: bill.lastAttempt, interval: Self.billInterval, at: requestTime)
        }
        guard due else { return }
        bill.lastAttempt = requestTime
        let siteID = selectedSiteID
        billTask = Task { await performBill(siteID: siteID, generation: generation) }
    }

    private func isDue(lastAttempt: Date?, interval: TimeInterval, at date: Date) -> Bool {
        guard let lastAttempt else { return true }
        let elapsed = date.timeIntervalSince(lastAttempt)
        // A negative elapsed time means the device clock moved backwards, so real
        // elapsed time is unknown. Treat it as due: a spurious poll costs one
        // request, while stalling freezes live and bill data indefinitely with no
        // error and nothing on screen to explain it.
        guard elapsed.isFinite else { return true }
        return elapsed < 0 || elapsed >= interval
    }

    /// Whether the bill response on hand was fetched inside the appearance floor.
    private func billIsFresh(at date: Date) -> Bool {
        guard let lastSuccess = bill.lastSuccess else { return false }
        let age = date.timeIntervalSince(lastSuccess)
        return age >= 0 && age < Self.billMinimumInterval
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
            // Already nil and cancelled in here; cancelling again would imply
            // the sign-in-required path does something extra that it does not.
            authenticationInvalidated()
            requiresSignIn = true
            isForeground = false
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

    /// The one place that drops in-flight endpoint requests. Both site switches
    /// and sign-out need it, and the task handles must be nil'd as well as
    /// cancelled so the next trigger does not join a doomed request.
    private func cancelInFlightRequests() {
        liveTask?.cancel()
        billTask?.cancel()
        liveTask = nil
        billTask = nil
    }
}
