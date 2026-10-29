import Combine
import Foundation

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

    @Published var selectedSiteID: String
    @Published var live = DashboardEndpointState<MobileLiveResponse>()
    @Published var power = DashboardEndpointState<MobileLivePowerResponse>()
    @Published var bill = DashboardEndpointState<MobileBillResponse>()
    @Published var isForeground = false
    /// False from a raise, site switch or sign-in until that refresh finishes,
    /// successful or not, so a stale-data notice waits for it instead of flashing
    /// over cached readings that are about to be replaced.
    @Published var refreshSettled = false
    @Published var requiresSignIn = false
    /// The dashboard presents one sheet at a time. Keeping that in a single
    /// published value means an external Battery Hold launch can clear whatever
    /// is on screen, so the root view's alert and loading overlay are not left
    /// stranded underneath a sheet that is still up.
    @Published var presentedSheet: DashboardSheet?

    var isBatteryHoldSheetPresented: Bool {
        get { presentedSheet == .batteryHold }
        set {
            if newValue { presentedSheet = .batteryHold } else if presentedSheet == .batteryHold { presentedSheet = nil }
        }
    }
    @Published var batteryHold = BatteryHoldState()
    /// Told about confirmed hold state only; it can never change the hold.
    weak var batteryHoldActivityObserver: (any BatteryHoldActivityObserving)?
    @Published var solarForecastState: SolarForecastEnhancementState = .basic
    @Published var solarForecastConnection: SolarForecastConnectionState = .checking
    @Published var solarForecastUnavailableCause: SolarForecastUnavailableCause?
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
    @Published var solarForecastSaveFailure = false
    @Published var solarForecastUnavailableReason: SolarForecastEnhancementUnavailableReason?
    @Published var solarForecastBatch: SolarForecastBatch?
    /// The last forecast refresh's outcome, kept for Smart Shift diagnostics only.
    var solarForecastLastRefresh: SolarForecastRefreshResult?
    @Published var loadPlanningContext: LoadTimingForecastEstimator.PlanningContext?
    /// The household pattern with grid history, published whether or not Solcast
    /// is connected, so Smart Shift can project banks from history alone.
    @Published var householdPattern: LoadTimingForecastEstimator.PlanningContext?

    var pollingTimerIsActive: Bool { timerTask != nil }
    /// Whichever endpoint supplies Home's power readings owns their availability:
    /// on an older server without the fast route, the combined endpoint does.
    var livePowerIsUnavailable: Bool { usesLivePowerEndpoint ? power.isUnavailable : live.isUnavailable }

    let api: any MobileDashboardDataAPI
    let planningAPI: (any MobileLoadPlanningDataAPI)?
    let forecastStore: (any SolarForecastManaging)?
    let accountScopeID: String?
    var cache: DashboardCache?
    var sessionVerified = true
    var canRequestAccountData: Bool { sessionVerified && !requiresSignIn }
    let now: () -> Date
    let timerInterval: Duration?
    var sceneIsActive = false
    var timerTask: Task<Void, Never>?
    var liveTask: Task<Void, Never>?
    var powerTask: Task<Void, Never>?
    var livePowerEndpointAvailable = true
    var usesLivePowerEndpoint: Bool { livePowerEndpointAvailable && api is any MobileLivePowerDataAPI }
    var billTask: Task<Void, Never>?
    var siteGeneration = 0
    var forecastGeneration = 0
    var billSuccessGeneration = 0
    /// Counts bill launches so a refresh can tell whether another caller
    /// attempted the bill while it waited on live.
    var billAttempts = 0
    /// Whether the latest bill launch started with no live request pending, so
    /// it calculated from the history live imports.
    var latestBillAttemptFollowedLive = true
    var planningContextCache: [String: PlanningContextCacheEntry] = [:]
    var planningContextTasks: [String: PlanningContextTask] = [:]

    struct PlanningContextCacheEntry {
        let response: MobileLoadPlanningContextResponse
        let fetchedAt: Date
    }

    /// The result of a planning-context fetch, keeping the failure instead of
    /// collapsing it. `try?` here previously discarded the error, which made a
    /// rejected request indistinguishable from an unreachable one.
    struct PlanningContextFetchResult {
        let response: MobileLoadPlanningContextResponse?
        let error: (any Error)?
    }

    struct PlanningContextTask {
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

    func restoreCachedReadings() {
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
            refreshSettled = false
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
        refreshSettled = false
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
        refreshSettled = false
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
        refreshSettled = false
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
}
