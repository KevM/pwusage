import Combine
import Foundation

@MainActor
protocol MobileDashboardDataAPI: Sendable {
    func fetchLive(siteID: String) async throws -> MobileLiveResponse
    func fetchBill(siteID: String) async throws -> MobileBillResponse
}

/// Optional capability so older servers/preview fixtures retain the combined path.
@MainActor
protocol MobileLivePowerDataAPI: Sendable {
    func fetchLivePower(siteID: String) async throws -> MobileLivePowerResponse
}

@MainActor
protocol MobileLoadPlanningDataAPI: Sendable {
    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse
}

@MainActor
protocol MobileBatteryHoldDataAPI: Sendable {
    func fetchBatteryHold(siteID: String) async throws -> BatteryHoldResponse
    func sendBatteryHoldCommand(siteID: String, command: BatteryHoldCommand) async throws -> BatteryHoldCommandResult
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
    /// The device hasn't read its Solcast setup yet (at launch or after a site switch).
    case checking
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
    /// This device's clock put the server's timestamp outside the age window, so
    /// the payload reads as stale or future-dated. Fixable on the device.
    case contextInvalid
    /// The server answered, but the payload failed contract validation for a reason
    /// no clock change can fix — wrong units, unknown timezone, bad history bounds.
    case contextMalformed
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
    fileprivate(set) var isRestored = false
    fileprivate(set) var isUnavailable = false
    fileprivate(set) var unavailableStatusCode: Int?

    fileprivate mutating func reset() {
        response = nil
        isRestored = false
        lastAttempt = nil
        lastSuccess = nil
        isUnavailable = false
        unavailableStatusCode = nil
    }
}

/// The sheet the dashboard itself owns. There is only one, but it stays a
/// value so an external launch can clear whatever is up in a single write.
/// Rate Plans and About are pages pushed from Settings, not sheets.
enum DashboardSheet: String, Identifiable, CaseIterable {
    case batteryHold

    var id: String { rawValue }
}

@MainActor
final class DashboardCoordinator: ObservableObject {
    /// What asked for a refresh, for both endpoints. Every call site must state
    /// which one it is, because only an explicit gesture bypasses the
    /// elapsed-time cadences: `.userGesture` also skips the live cadence, not
    /// just the bill's.
    enum RefreshTrigger { case userGesture, screenAppearance, scheduled }

    static let liveInterval: TimeInterval = 5 * 60
    static let livePowerInterval: TimeInterval = 60
    static let summaryInterval: TimeInterval = 30 * 60
    static let billInterval: TimeInterval = 30 * 60
    /// Floor under appearance-driven bill refreshes, so opening the Load timing
    /// screen twice in a row does not bill twice but still feels fresh.
    static let billMinimumInterval: TimeInterval = 5 * 60
    /// With Solcast set up, the bill is fetched early once its energy data is this
    /// old, so Smart Shift's forecast comparison (which needs data under an hour
    /// old, or 30 minutes without grid history) doesn't pause between the 30-minute
    /// fetches or after the app returns.
    static let forecastEnergyDataRefreshAge: TimeInterval = 20 * 60
    static let planningContextLifetime: TimeInterval = 24 * 60 * 60

    @Published private(set) var selectedSiteID: String
    @Published private(set) var live = DashboardEndpointState<MobileLiveResponse>()
    @Published private(set) var power = DashboardEndpointState<MobileLivePowerResponse>()
    @Published private(set) var bill = DashboardEndpointState<MobileBillResponse>()
    @Published private(set) var isForeground = false
    @Published private(set) var requiresSignIn = false
    /// The dashboard presents one sheet at a time. Keeping that in a single
    /// published value means an external Battery Hold launch can clear whatever
    /// is on screen, so the root view's alert and loading overlay are not left
    /// stranded underneath a sheet that is still up.
    @Published var presentedSheet: DashboardSheet?

    var isBatteryHoldSheetPresented: Bool {
        get { presentedSheet == .batteryHold }
        set {
            if newValue { presentedSheet = .batteryHold }
            else if presentedSheet == .batteryHold { presentedSheet = nil }
        }
    }
    @Published private(set) var batteryHold = BatteryHoldState()
    /// Told about confirmed hold state only; it can never change the hold.
    weak var batteryHoldActivityObserver: (any BatteryHoldActivityObserving)?
    @Published private(set) var solarForecastState: SolarForecastEnhancementState = .basic
    @Published private(set) var solarForecastConnection: SolarForecastConnectionState = .checking
    @Published private(set) var solarForecastUnavailableCause: SolarForecastUnavailableCause?
    /// This device could not write its forecast state. Not a cause: the forecast
    /// on screen is usable, so it must not claim to be unavailable.
    ///
    /// Re-derived on every path that reaches a refresh *result* — both refresh
    /// paths set it from the result, and set it back to `false` when they fall
    /// back to basic. The early returns that never reach a refresh (no store, no
    /// credential, no array selection) deliberately leave it alone, and that is
    /// inert rather than merely untidy: the overlay reads this only on the
    /// enhanced-and-ready branch, and every one of those returns sets the state to
    /// `.basic` or `.awaitingArraySelection`, which cannot reach it.
    @Published private(set) var solarForecastSaveFailure = false
    @Published private(set) var solarForecastUnavailableReason: SolarForecastEnhancementUnavailableReason?
    @Published private(set) var solarForecastBatch: SolarForecastBatch?
    /// The last forecast refresh's outcome, kept for Smart Shift diagnostics only.
    private(set) var solarForecastLastRefresh: SolarForecastRefreshResult?
    @Published private(set) var loadPlanningContext: LoadTimingForecastEstimator.PlanningContext?
    /// The household pattern with grid history, published whether or not Solcast
    /// is connected, so Smart Shift can project banks from history alone.
    @Published private(set) var householdPattern: LoadTimingForecastEstimator.PlanningContext?

    var pollingTimerIsActive: Bool { timerTask != nil }

    private let api: any MobileDashboardDataAPI
    private let planningAPI: (any MobileLoadPlanningDataAPI)?
    private let forecastStore: (any SolarForecastManaging)?
    private let accountScopeID: String?
    private var cache: DashboardCache?
    private var sessionVerified = true
    private var canRequestAccountData: Bool { sessionVerified && !requiresSignIn }
    private let now: () -> Date
    private let timerInterval: Duration?
    private var sceneIsActive = false
    private var timerTask: Task<Void, Never>?
    private var liveTask: Task<Void, Never>?
    private var powerTask: Task<Void, Never>?
    private var livePowerEndpointAvailable = true
    private var usesLivePowerEndpoint: Bool { livePowerEndpointAvailable && api is any MobileLivePowerDataAPI }
    private var billTask: Task<Void, Never>?
    private var siteGeneration = 0
    private var forecastGeneration = 0
    private var billSuccessGeneration = 0
    /// Counts bill launches so a refresh can tell whether another caller
    /// attempted the bill while it waited on live.
    private var billAttempts = 0
    /// Whether the latest bill launch started with no live request pending, so
    /// it calculated from the history live imports.
    private var latestBillAttemptFollowedLive = true
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
        timerInterval: Duration? = .seconds(30),
        cache: DashboardCache? = nil
    ) {
        selectedSiteID = siteID
        self.api = api
        self.planningAPI = planningAPI
        self.forecastStore = forecastStore
        self.accountScopeID = accountScopeID
        self.now = now
        self.timerInterval = timerInterval
        self.cache = cache
        if sessionVerified { cache?.selectWidgetSite(selectedSiteID) }
        restoreCachedReadings()
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

    /// Attach the app-owned snapshot even when a custom coordinator factory is used.
    /// Saved presentation does not authorize account requests; the app must verify
    /// site access before enabling polling, detail refreshes, or forecast setup.
    func restoreLaunchCache(_ cache: DashboardCache?, sessionVerified: Bool = true) {
        self.sessionVerified = sessionVerified
        self.cache = cache
        if sessionVerified { cache?.selectWidgetSite(selectedSiteID) }
        restoreCachedReadings()
    }

    private func restoreCachedReadings() {
        if let reading = cache?.snapshot.live[selectedSiteID], reading.response.site.id == selectedSiteID {
            live.response = reading.response
            live.lastSuccess = reading.savedAt
            live.isRestored = true
        }
        if let reading = cache?.snapshot.bill[selectedSiteID], reading.response.site.id == selectedSiteID {
            bill.response = reading.response
            bill.lastSuccess = reading.savedAt
            bill.isRestored = true
        }
        // Attempts stay nil: every launch/site switch still refreshes immediately.
    }

    func scenePhaseChanged(isActive: Bool) {
        if isActive {
            sceneIsActive = true
            guard canRequestAccountData else { return }
            guard !isForeground else { return }
            isForeground = true
            startTimer()
            Task {
                guard isForeground else { return }
                await refreshPower(force: true)
                await refreshDue()
            }
        } else {
            sceneIsActive = false
            isForeground = false
            batteryHold.isCurrent = false
            stopTimer()
            // Keep fast polls in memory; persist the combined snapshot once on
            // backgrounding instead of encoding the entire bill every minute.
            if let snapshot = live.response, let power = power.response {
                cache?.storeLive(MobileLiveResponse(snapshot: snapshot, power: power), at: now())
            }
        }
    }

    /// Load tariffs only while this coordinator has verified site access.
    func fetchTariffs() async throws -> MobileTariffsResponse {
        guard canRequestAccountData else { throw PWUsageAPIError.signInRequired }
        guard let tariffAPI = api as? any MobileTariffDataAPI else { throw PWUsageAPIError.invalidResponse }
        let generation = siteGeneration
        let siteID = selectedSiteID
        do {
            let response = try await tariffAPI.fetchTariffs(siteID: siteID)
            guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else {
                throw CancellationError()
            }
            return try response.validating(siteID: siteID)
        } catch {
            if generation == siteGeneration, error as? PWUsageAPIError == .signInRequired {
                authenticationInvalidated()
                isForeground = false
                stopTimer()
            }
            throw error
        }
    }

    /// Reads database-backed hold status without making a Tesla request.
    func refreshBatteryHold(force: Bool = true) async {
        guard canRequestAccountData, !Task.isCancelled, !batteryHold.isBusy,
              let holdAPI = api as? any MobileBatteryHoldDataAPI else { return }
        if !force, batteryHold.isCurrent, let fetchedAt = batteryHold.fetchedAt,
           (0..<60).contains(now().timeIntervalSince(fetchedAt)) { return }
        let generation = siteGeneration
        let siteID = selectedSiteID
        batteryHold.isRefreshing = true
        defer { if generation == siteGeneration { batteryHold.isRefreshing = false } }
        do {
            let response = try await holdAPI.fetchBatteryHold(siteID: siteID).validating(siteID: siteID)
            guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else { return }
            batteryHold.response = response
            batteryHold.isCurrent = true
            batteryHold.fetchedAt = now()
            reportBatteryHold(.refreshed(response), siteID: siteID)
            // A DB read cannot tell whether the Tesla token has command permission.
            if batteryHold.failure != .needsReauthentication && batteryHold.failure != .needsChoice {
                batteryHold.failure = nil
            }
        } catch {
            guard generation == siteGeneration, !Task.isCancelled else { return }
            batteryHold.isCurrent = false
            handleBatteryHoldError(error)
        }
    }

    func sendBatteryHoldCommand(_ command: BatteryHoldCommand) async {
        guard canRequestAccountData, !Task.isCancelled, !batteryHold.isBusy,
              batteryHold.statusIsCurrent(at: now()),
              let holdAPI = api as? any MobileBatteryHoldDataAPI else { return }
        if case .park(let choice) = command, !choice.isValid { return }
        let generation = siteGeneration
        let siteID = selectedSiteID
        let previousHoldID = batteryHold.response?.hold?.id
        batteryHold.isSubmitting = true
        batteryHold.failure = nil
        defer { if generation == siteGeneration { batteryHold.isSubmitting = false } }
        do {
            let result = try await holdAPI.sendBatteryHoldCommand(siteID: siteID, command: command)
                .validating(siteID: siteID, command: command)
            guard generation == siteGeneration, canRequestAccountData else { return }
            batteryHold.requiresReserveChoice = false
            // Once a command succeeds, the old snapshot is no longer authoritative.
            // Reconcile from the DB while keeping duplicate commands disabled.
            batteryHold.isCurrent = false
            if case .park = command {
                batteryHold.response = .init(hold: result.hold, notice: batteryHold.response?.notice)
                if let hold = result.hold { reportBatteryHold(.started(hold), siteID: siteID) }
            } else if case .restore = command {
                batteryHold.response = .init(hold: nil, notice: batteryHold.response?.notice)
                if result.status == .ok, let previousHoldID { reportBatteryHold(.stopped(holdID: previousHoldID), siteID: siteID) }
            }
            let response = try await holdAPI.fetchBatteryHold(siteID: siteID).validating(siteID: siteID)
            guard generation == siteGeneration, canRequestAccountData else { return }
            batteryHold.response = response
            batteryHold.isCurrent = true
            batteryHold.fetchedAt = now()
            reportBatteryHold(.refreshed(response), siteID: siteID)
        } catch {
            guard generation == siteGeneration else { return }
            handleBatteryHoldError(error)
        }
    }

    private func reportBatteryHold(_ confirmation: BatteryHoldConfirmation, siteID: String) {
        let timeZone = live.response?.site.timezone ?? bill.response?.site.timezone
        batteryHoldActivityObserver?.batteryHoldConfirmed(confirmation, siteID: siteID, timeZone: timeZone)
    }

    func batteryHoldStateOfCharge(at date: Date) -> Double? {
        if let response = power.response, response.siteID == selectedSiteID, !power.isUnavailable {
            return MobileLiveResponse.validatedStateOfCharge(
                response.stateOfCharge, takenAt: response.sources.stateOfChargeAt, now: date
            )
        }
        guard !live.isUnavailable, let response = live.response,
              response.site.id == selectedSiteID else { return nil }
        return MobileLiveResponse.validatedStateOfCharge(response.stateOfCharge, takenAt: response.sources.stateOfChargeAt, now: date)
    }

    private func handleBatteryHoldError(_ error: any Error) {
        if error as? PWUsageAPIError == .signInRequired {
            authenticationInvalidated()
            isForeground = false
            stopTimer()
            return
        }
        switch error as? PWUsageAPIError {
        case .requestRejected(_, "needs_reauth"):
            batteryHold.failure = .needsReauthentication
        case .requestRejected(_, "reserve_sync_pending"):
            batteryHold.failure = .reserveSyncPending
        case .requestRejected(_, "needs_choice"):
            batteryHold.requiresReserveChoice = true
            batteryHold.failure = .needsChoice
        case .requestRejected(_, "no_soc"):
            batteryHold.failure = .noStateOfCharge
        case .requestRejected(_, "no_active_hold"):
            batteryHold.isCurrent = false
            batteryHold.failure = .noActiveHold
        default:
            // A failed command may have reached Tesla. Never blindly retry it.
            batteryHold.isCurrent = false
            batteryHold.failure = .unavailable
        }
    }

    /// Call after the app verifies both the session and authorized site access.
    func authenticationRestored() {
        guard !canRequestAccountData else { return }
        sessionVerified = true
        requiresSignIn = false
        cache?.selectWidgetSite(selectedSiteID)
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
        presentedSheet = nil
        cache?.selectWidgetSite(nil)
        sessionVerified = false
        forecastGeneration += 1
        siteGeneration += 1
        cancelInFlightRequests()
        batteryHold = BatteryHoldState()
        live.response = nil
        live.isRestored = false
        power.reset()
        bill.response = nil
        bill.isRestored = false
        requiresSignIn = true
        resetForecastEnhancement(state: .basic, connection: .notConnected)
        householdPattern = nil
    }

    func selectSite(_ siteID: String) {
        guard siteID != selectedSiteID else { return }
        presentedSheet = nil
        selectedSiteID = siteID
        if canRequestAccountData { cache?.selectWidgetSite(siteID) }
        siteGeneration += 1
        forecastGeneration += 1
        cancelInFlightRequests()
        batteryHold = BatteryHoldState()
        live.reset()
        power.reset()
        bill.reset()
        restoreCachedReadings()
        // Checking, not "not connected": the new site's setup is read next, and
        // until then the card waits rather than showing a forecast-free answer.
        resetForecastEnhancement(state: .basic, connection: .checking)
        // The pattern belongs to the old site; connecting or disconnecting
        // Solcast leaves it in place.
        householdPattern = nil
        guard isForeground, canRequestAccountData else { return }
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
        guard canRequestAccountData else { return }
        if trigger == .scheduled {
            guard isForeground else { return }
        }
        let generation = siteGeneration
        await refreshPower(force: trigger == .userGesture)
        guard canStillRefresh(trigger: trigger, generation: generation) else { return }
        let requestTime = now()
        let interval = usesLivePowerEndpoint ? Self.summaryInterval : Self.liveInterval

        if liveTask == nil {
            if trigger == .userGesture
                || isDue(lastAttempt: live.lastAttempt, interval: interval, at: requestTime) {
                live.lastAttempt = requestTime
                let siteID = selectedSiteID
                liveTask = Task { await performLive(siteID: siteID, generation: generation) }
            }
        }
        // The live endpoint may first import stale energy history. Wait for it
        // before asking the bill endpoint to calculate from that history.
        let billAttemptsBeforeWait = billAttempts
        await liveTask?.value
        guard canStillRefresh(trigger: trigger, generation: generation) else { return }

        if billAttempts == billAttemptsBeforeWait {
            launchBillTaskIfNeeded(trigger: trigger, requestTime: requestTime, generation: generation, followsLive: true)
        } else if !latestBillAttemptFollowedLive {
            // Another caller attempted the bill while live was still importing
            // history, so that bill is stale. Let it finish, then recalculate
            // once, whichever waiting refresh gets here first.
            await billTask?.value
            guard canStillRefresh(trigger: trigger, generation: generation) else { return }
            if !latestBillAttemptFollowedLive {
                launchBillTaskIfNeeded(trigger: .userGesture, requestTime: now(), generation: generation, followsLive: true)
            }
        }
        // Otherwise a bill already followed this live request. Comparing its
        // newer attempt with the pre-wait time would read as a backwards clock
        // and send a duplicate request.

        await billTask?.value
    }

    private func canStillRefresh(trigger: RefreshTrigger, generation: Int) -> Bool {
        guard canRequestAccountData, generation == siteGeneration else { return false }
        return trigger != .scheduled || isForeground
    }

    /// Refreshes the bill estimate, subject to the trigger's cadence.
    func refreshBill(trigger: RefreshTrigger) async {
        guard canRequestAccountData else { return }
        if trigger == .scheduled {
            guard isForeground else { return }
        }
        let requestTime = now()
        let generation = siteGeneration

        launchBillTaskIfNeeded(trigger: trigger, requestTime: requestTime, generation: generation, followsLive: liveTask == nil)

        await billTask?.value
    }

    /// Handles the retained Smart Shift tab's foreground callback.
    func loadTimingDetailForegrounded(isSelected: Bool) async {
        guard isSelected else { return }
        await loadTimingDetailAppeared()
    }

    /// Billing needs a measured snapshot even when solar forecasting is not configured.
    /// The shared planning path reuses context and solar caches without fetching live Tesla data.
    func billOutlookAppeared() async {
        await refreshBill(trigger: .screenAppearance)
        await loadTimingDetailAppeared()
    }

    /// Starts the optional enhancement only when a local credential and array
    /// selection exist. This path refreshes bill/context data but never live data.
    func loadTimingDetailAppeared() async {
        guard canRequestAccountData else { return }
        let operation = beginForecastOperation()
        guard let forecastStore, let planningAPI, let accountScopeID else {
            solarForecastState = .basic
            solarForecastConnection = .notConnected
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
            await loadHouseholdPattern(siteID: siteID, api: planningAPI, operation: operation)
            return
        }
        guard !credential.resourceIDs.isEmpty else {
            guard operation == forecastGeneration, siteID == selectedSiteID else { return }
            solarForecastState = .basic
            solarForecastConnection = .awaitingArraySelection
            solarForecastUnavailableCause = nil
            solarForecastBatch = nil
            loadPlanningContext = nil
            await loadHouseholdPattern(siteID: siteID, api: planningAPI, operation: operation)
            return
        }
        guard operation == forecastGeneration, siteID == selectedSiteID, canRequestAccountData else { return }
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

        guard operation == forecastGeneration, siteID == selectedSiteID, canRequestAccountData else { return }
        solarForecastLastRefresh = refresh
        // Published even when the forecast half fails, so the card can fall back to history.
        householdPattern = context
        solarForecastUnavailableCause = SolarForecastUnavailableCause(refresh)
        // A save failure is not an unavailable forecast, on this path exactly as
        // on `refreshSolarForecast`. The batch is fresh and in memory — the store
        // kept it deliberately — so tearing the enhancement down here would show
        // "The forecast was too old or incomplete to use. Pull down to refresh it"
        // after a *successful* fetch of a brand-new forecast, which is the symptom
        // §5.5 was filed to remove. This path is the dominant one (pull-to-refresh
        // is the exception), so the omission is the more visible half of the bug.
        let saveFailed = refresh == .failed(.saveFailed)
        // A refused or failed refresh (budget, rate limit, network) doesn't dismiss
        // a forecast the store still trusts: the store disables it only for
        // key or array problems, and it ages out after six hours.
        let usableDespiteRefresh = await forecastStore.isRecommendationUsable(accountScopeID: accountScopeID, siteID: siteID)
        let refreshSucceeded = saveFailed || refresh == .refreshed || refresh == .alreadyFresh || usableDespiteRefresh
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

    /// The forecast store's view of this site, for Smart Shift's "Copy
    /// diagnostics". It reads the store's cached batch rather than
    /// `solarForecastBatch`, which is cleared whenever the card can't use it.
    func solarForecastDiagnostics() async -> SmartShiftDiagnostics.SolarForecast? {
        guard let forecastStore, let accountScopeID else { return nil }
        let siteID = selectedSiteID
        let batch = await forecastStore.cachedBatch(accountScopeID: accountScopeID, siteID: siteID)
        return SmartShiftDiagnostics.SolarForecast(
            batch: batch, now: now(),
            recommendationUsable: await forecastStore.isRecommendationUsable(accountScopeID: accountScopeID, siteID: siteID),
            budget: await forecastStore.budget(for: accountScopeID, siteID: siteID),
            lastErrorDescription: await forecastStore.lastErrorDescription,
            lastRefresh: solarForecastLastRefresh, unavailableCause: solarForecastUnavailableCause,
            connection: solarForecastConnection, state: solarForecastState,
            unavailableReason: solarForecastUnavailableReason)
    }

    func refreshSolarForecast(manual: Bool) async {
        guard canRequestAccountData else { return }
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
        guard operation == forecastGeneration, siteID == selectedSiteID, canRequestAccountData else { return }
        solarForecastConnection = credential.resourceIDs.isEmpty ? .awaitingArraySelection : .ready
        solarForecastState = .loadingWithBasic
        let refresh = await forecastStore.refresh(accountScopeID: accountScopeID, siteID: siteID, manual: manual)
        guard operation == forecastGeneration, siteID == selectedSiteID, canRequestAccountData else { return }
        solarForecastLastRefresh = refresh
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
        // As on the appearance path, a refused refresh leaves a still-usable forecast in place.
        guard await forecastStore.isRecommendationUsable(accountScopeID: accountScopeID, siteID: siteID),
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
        guard canRequestAccountData else { throw PWUsageAPIError.signInRequired }
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
        guard canRequestAccountData else { throw PWUsageAPIError.signInRequired }
        _ = beginForecastOperation()
        guard let forecastStore, let accountScopeID else { throw SolarForecastStore.StoreError.invalidConfiguration }
        return try await forecastStore.discoverSites(
            accountScopeID: accountScopeID,
            siteID: selectedSiteID,
            manual: manual
        )
    }

    func selectSolarArrays(_ resourceIDs: [String]) async throws {
        guard canRequestAccountData else { throw PWUsageAPIError.signInRequired }
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

    /// The forecast-free path's household pattern: the same cached request the
    /// Solcast path makes, so the pattern costs at most one request a day.
    private func loadHouseholdPattern(siteID: String, api: any MobileLoadPlanningDataAPI, operation: Int) async {
        let outcome = await planningContext(siteID: siteID, api: api)
        guard operation == forecastGeneration, siteID == selectedSiteID, canRequestAccountData else { return }
        householdPattern = outcome.context
    }

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
            // Only an unavailable profile has a reason; a usable cached one must not
            // mask why the forecast half failed.
            let context = validated.estimatorContext
            return PlanningContextOutcome(
                context: context,
                unavailableReason: context == nil ? Self.enhancementReason(forReason: validated.unavailableReason) : nil
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
            if let contractError = error as? MobileLoadPlanningContextResponse.ContractError {
                // Only skew is the device's fault, so only skew earns clock advice.
                // Every other contract failure would keep failing with a perfect
                // clock, and telling someone to fix their date is then a dead end.
                reason = contractError == .timestampSkew ? .contextInvalid : .contextMalformed
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
        guard canRequestAccountData else { return }
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
        solarForecastLastRefresh = nil
    }

    private func launchBillTaskIfNeeded(trigger: RefreshTrigger, requestTime: Date, generation: Int, followsLive: Bool) {
        guard billTask == nil else { return }
        let due: Bool
        switch trigger {
        case .userGesture: due = true
        case .screenAppearance:
            due = isDue(lastAttempt: bill.lastAttempt, interval: Self.billMinimumInterval, at: requestTime)
        case .scheduled:
            due = isDue(lastAttempt: bill.lastAttempt, interval: Self.billInterval, at: requestTime)
                || (energyDataIsAgingForForecast(at: requestTime)
                    && isDue(lastAttempt: bill.lastAttempt, interval: Self.billMinimumInterval, at: requestTime))
        }
        guard due else { return }
        bill.lastAttempt = requestTime
        billAttempts += 1
        latestBillAttemptFollowedLive = followsLive
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

    /// Solcast is set up and the bill's energy data is nearly too old for the forecast comparison.
    private func energyDataIsAgingForForecast(at date: Date) -> Bool {
        guard solarForecastConnection == .ready,
              let through = bill.response?.sources.energyDataThrough else { return false }
        return date.timeIntervalSince(through) >= Self.forecastEnergyDataRefreshAge
    }

    /// Whether the bill response on hand was fetched inside the appearance floor.
    private func billIsFresh(at date: Date) -> Bool {
        guard let lastSuccess = bill.lastSuccess else { return false }
        let age = date.timeIntervalSince(lastSuccess)
        return age >= 0 && age < Self.billMinimumInterval
    }

    private func refreshPower(force: Bool) async {
        guard canRequestAccountData, usesLivePowerEndpoint,
              let powerAPI = api as? any MobileLivePowerDataAPI else { return }
        if let powerTask {
            await powerTask.value
            return
        }
        let due = isDue(lastAttempt: power.lastAttempt, interval: Self.livePowerInterval, at: now())
        guard force || due else { return }
        power.lastAttempt = now()
        let generation = siteGeneration
        let siteID = selectedSiteID
        powerTask = Task {
            defer { if generation == siteGeneration { powerTask = nil } }
            do {
                let response = try await powerAPI.fetchLivePower(siteID: siteID).validating(siteID: siteID)
                guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else { return }
                power.response = response
                power.lastSuccess = now()
                power.isUnavailable = false
            } catch {
                guard generation == siteGeneration, canRequestAccountData else { return }
                if error as? PWUsageAPIError == .signInRequired {
                    authenticationInvalidated()
                    isForeground = false
                    stopTimer()
                } else if let rejected = error as? PWUsageAPIError,
                          case .requestRejected(let statusCode, _) = rejected, statusCode == 404 {
                    // An older server can still serve the combined endpoint.
                    livePowerEndpointAvailable = false
                    power.isUnavailable = false
                } else {
                    power.isUnavailable = true
                }
            }
        }
        await powerTask?.value
    }

    private func performLive(siteID: String, generation: Int) async {
        defer {
            if generation == siteGeneration { liveTask = nil }
        }
        do {
            let response = try await api.fetchLive(siteID: siteID)
            guard generation == siteGeneration, canRequestAccountData else { return }
            live.response = response
            let successTime = now()
            live.lastSuccess = successTime
            live.isRestored = false
            if api is any MobileLivePowerDataAPI,
               let source = response.sources.liveStatusAt,
               source >= (power.response?.sources.liveStatusAt ?? .distantPast) {
                power.response = MobileLivePowerResponse(snapshot: response)
                power.isUnavailable = false
            }
            let snapshot = power.response.map { MobileLiveResponse(snapshot: response, power: $0) } ?? response
            cache?.storeLive(snapshot, at: successTime)
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
            guard generation == siteGeneration, canRequestAccountData else { return }
            bill.response = response
            billSuccessGeneration += 1
            let successTime = now()
            bill.lastSuccess = successTime
            bill.isRestored = false
            cache?.storeBill(response, at: successTime)
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
                guard let self, self.isForeground, self.canRequestAccountData else { return }
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
        powerTask?.cancel()
        billTask?.cancel()
        liveTask = nil
        powerTask = nil
        billTask = nil
    }
}
