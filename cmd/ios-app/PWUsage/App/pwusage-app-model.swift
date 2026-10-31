import Combine
import SwiftUI

@MainActor
final class PWUsageAppModel: ObservableObject {
    enum ScreenState: Equatable {
        case bootstrapping
        case signedOut
        case signedIn
        case noSites
        case unavailable
    }

    @Published var screenState: ScreenState = .bootstrapping
    @Published var sites: [MobileSite] = []
    @Published var selectedSiteID: String?
    @Published var coordinator: DashboardCoordinator?
    @Published var isSigningIn = false
    @Published var isSigningOut = false
    @Published var signInMessage: String?
    @Published var isSitePickerPresented = false
    @Published var accountScopeID: String?
    /// The tab on screen. Only `selectTab` persists it; an external Battery Saver
    /// launch moves it for one visit, like the saved site.
    @Published var selectedTab: AppTab

    /// Builds the dashboard coordinator for a site. Injected so tests can control
    /// the polling cadence and the clock.
    typealias CoordinatorFactory = @MainActor (_ siteID: String, _ accountScopeID: String) -> DashboardCoordinator

    let authService: MobileAuthService
    let api: any PWUsageApplicationAPI
    let userDefaults: UserDefaults
    let cache: DashboardCache?
    /// Replaced on each external route (widget, Battery Saver control) so every
    /// tab rebuilds its stack, dropping old paths and tab-local modals.
    @Published var externalNavigationID: UUID?
    @Published var pendingBatteryHoldSiteID: String?
    @Published var batteryHoldNavigationMessage: String?
    let controlSiteStore: BatteryHoldControlSiteStore?
    let liveActivities: BatteryHoldActivityCoordinator?
    var sessionVerified = false
    var hasBootstrapAttempted = false
    @Published var siteRequestCount = 0
    var isBatteryHoldNavigationLoading: Bool { pendingBatteryHoldSiteID != nil && siteRequestCount > 0 }
    let forecastStore: any SolarForecastManaging
    let forecastService: SolarForecastService?
    let solarHistory: SolarHistoryStore
    let solarRecords: SolarLayoutRecordStore
    let solarRunner: SolarLayoutDetectionRunner?
    let solarCloudSync: SolarLayoutCloudSync
    let coordinatorFactory: CoordinatorFactory
    var coordinatorAuthSubscription: AnyCancellable?
    var sceneIsActive = false

    /// Identifies the attempt that owns the published site state. Every path that
    /// publishes sites claims one, and a superseded attempt discards its own result
    /// rather than overwriting a newer one. See `installAuthorizedSites`.
    var siteInstallGeneration = 0

    init(
        configuration: AppConfiguration,
        api: any PWUsageApplicationAPI,
        userDefaults: UserDefaults = .standard,
        forecastStore: any SolarForecastManaging = SolarForecastStore.shared,
        forecastService: SolarForecastService? = nil,
        coordinatorFactory: CoordinatorFactory? = nil,
        cache: DashboardCache? = nil,
        authService: MobileAuthService? = nil,
        controlSiteStore: BatteryHoldControlSiteStore? = nil,
        liveActivities: BatteryHoldActivityCoordinator? = nil,
        solarHistory: SolarHistoryStore = .shared,
        solarRecords: SolarLayoutRecordStore = .shared,
        solarRunner: SolarLayoutDetectionRunner? = nil,
        solarCloudSync: SolarLayoutCloudSync = .shared
    ) {
        self.controlSiteStore = controlSiteStore
        self.liveActivities = liveActivities
        self.api = api
        self.userDefaults = userDefaults
        self.cache = cache
        self.forecastStore = forecastStore
        self.forecastService = forecastService
        self.solarHistory = solarHistory
        self.solarRecords = solarRecords
        self.solarCloudSync = solarCloudSync
        let runner = solarRunner ?? (forecastService != nil ? SolarLayoutDetectionRunner(
            history: solarHistory, records: solarRecords, api: api
        ) : nil)
        self.solarRunner = runner
        Self.wireCloudSyncListener(solarCloudSync, runner: runner)
        selectedTab = userDefaults.string(forKey: Self.selectedTabDefaultsKey).flatMap(AppTab.init(rawValue:)) ?? .home
        if let coordinatorFactory {
            self.coordinatorFactory = coordinatorFactory
        } else {
            self.coordinatorFactory = { [solarHistory, solarRecords, runner] siteID, accountScopeID in
                DashboardCoordinator(
                    siteID: siteID,
                    api: api,
                    planningAPI: api,
                    forecastStore: forecastStore,
                    accountScopeID: accountScopeID,
                    forecastService: forecastService,
                    history: solarHistory,
                    records: solarRecords,
                    runner: runner
                )
            }
        }
        self.authService = authService ?? MobileAuthService(
            configuration: configuration,
            api: api,
            forecastCleanup: SolarForecastStoreSessionCleanup(
                store: forecastStore, service: forecastService,
                historyStore: solarHistory, layoutRecordStore: solarRecords,
                cloudSync: solarCloudSync
            )
        )
        restoreCachedSession()
    }

    /// Retries until a terminal state is reached. The `.task` that drives this is
    /// cancelled when the view disappears, which can land inside
    /// `installAuthorizedSites` and leave the screen on the spinner, so a
    /// latch set on entry would strand it with no way back. A generation token
    /// instead: a retry is free to run alongside the attempt it supersedes, and
    /// the older one cannot publish.
    func bootstrap() async {
        hasBootstrapAttempted = true
        switch screenState {
        case .signedIn: if sessionVerified { return }
        case .signedOut, .unavailable: return
        case .bootstrapping, .noSites: break
        }
        siteRequestCount += 1
        defer { siteRequestCount -= 1 }
        let generation = claimSiteInstall()
        do {
            let availableSites = try await api.fetchSites()
            await installAuthorizedSites(availableSites, generation: generation)
        } catch let error as PWUsageAPIError {
            guard generation == siteInstallGeneration else { return }
            if error == .signInRequired {
                let message = pendingBatteryHoldSiteID != nil ? "Your session expired. Sign in to continue." : nil
                await invalidateSession(message: message)
            } else {
                if coordinator == nil { screenState = .unavailable }
                if pendingBatteryHoldSiteID != nil {
                    batteryHoldNavigationMessage = "Could not verify this control’s site. Check your connection and try again."
                }
            }
        } catch {
            guard generation == siteInstallGeneration else { return }
            if coordinator == nil { screenState = .unavailable }
            if pendingBatteryHoldSiteID != nil {
                batteryHoldNavigationMessage = "Could not verify this control’s site. Check your connection and try again."
            }
        }
    }

    func scenePhaseChanged(isActive: Bool) {
        sceneIsActive = isActive
        if sessionVerified {
            coordinator?.scenePhaseChanged(isActive: isActive)
            if isActive { liveActivities?.reconcileInBackground() }
        } else if isActive, hasBootstrapAttempted, coordinator != nil, siteRequestCount == 0 {
            Task { await reloadSitesAfterSignIn() }
        }
    }

    func signIn() async {
        guard !isSigningIn, !isSigningOut else { return }
        isSigningIn = true
        signInMessage = nil
        defer { isSigningIn = false }
        siteRequestCount += 1
        defer { siteRequestCount -= 1 }
        let generation = claimSiteInstall()
        do {
            try await authService.signIn()
            let availableSites = try await api.fetchSites()
            await installAuthorizedSites(availableSites, generation: generation)
        } catch let error as PWUsageAPIError {
            guard generation == siteInstallGeneration else { return }
            if error == .signInRequired {
                await invalidateSession(message: "Sign-in expired. Try again.")
            } else if authService.isAuthenticated {
                screenState = .unavailable
                signInMessage = "You’re signed in, but pwusage could not load your sites. Check your connection and try again."
            } else {
                screenState = .signedOut
                signInMessage = "Could not complete sign-in. Try again."
            }
        } catch let error as MobileAuthService.AuthError {
            screenState = .signedOut
            signInMessage = error == .cancelled ? nil : "Could not complete sign-in. Try again."
        } catch {
            screenState = .signedOut
            signInMessage = "Could not connect to pwusage. Try again."
        }
    }

    /// Reauthorization is optional while the dashboard session is still valid.
    /// Only an authorized API rejecting that session should send the user out.
    func reconnectTesla() async {
        guard screenState == .signedIn, !isSigningIn else { return }
        isSigningIn = true
        signInMessage = nil
        defer { isSigningIn = false }
        siteRequestCount += 1
        defer { siteRequestCount -= 1 }
        let generation = claimSiteInstall()
        let wasAuthenticated = authService.isAuthenticated
        do {
            try await authService.signIn()
        } catch {
            guard generation == siteInstallGeneration else { return }
            // A failed handoff exchange clears the service's local auth flag,
            // even though it does not clear the existing dashboard cookie.
            if wasAuthenticated { authService.restoreAuthenticatedSession() }
            signInMessage = (error as? MobileAuthService.AuthError) == .cancelled
                ? nil : "Could not reconnect Tesla. Try again."
            return
        }
        guard generation == siteInstallGeneration else { return }
        coordinator?.requiresTeslaCommandReauthorization = false
        await reloadSitesAfterSignIn()
    }

    func reloadSitesAfterSignIn() async {
        if pendingBatteryHoldSiteID != nil { batteryHoldNavigationMessage = nil }
        siteRequestCount += 1
        defer { siteRequestCount -= 1 }
        let generation = claimSiteInstall()
        do {
            let availableSites = try await api.fetchSites()
            await installAuthorizedSites(availableSites, generation: generation)
        } catch let error as PWUsageAPIError where error == .signInRequired {
            guard generation == siteInstallGeneration else { return }
            await invalidateSession(message: "Your session expired. Sign in to continue.")
        } catch {
            guard generation == siteInstallGeneration else { return }
            if coordinator == nil { screenState = authService.isAuthenticated ? .unavailable : .signedOut }
            if pendingBatteryHoldSiteID != nil {
                batteryHoldNavigationMessage = "Could not verify this control’s site. Check your connection and try again."
            }
        }
    }

    private func restoreCachedSession() {
        guard let cachedSites = cache?.snapshot.sites, !cachedSites.isEmpty else { return }
        sites = cachedSites
        let savedID = userDefaults.string(forKey: Self.selectedSiteDefaultsKey)
        let chosen = cachedSites.first(where: { $0.id == savedID }) ?? cachedSites[0]
        selectedSiteID = chosen.id
        installCoordinator(siteID: chosen.id, accountScopeID: ensureAccountScopeID())
        screenState = .signedIn
        let sync = solarCloudSync
        Task { await sync.start() }
    }

    private static func wireCloudSyncListener(
        _ cloudSync: SolarLayoutCloudSync, runner: SolarLayoutDetectionRunner?
    ) {
        guard let runner else { return }
        Task { [weak runner] in
            await cloudSync.setOnRemoteRecordApplied { scope in
                Task { @MainActor in
                    runner?.onRecordChanged?(scope)
                    _ = await runner?.runIfDue(scope: scope)
                }
            }
        }
    }
}
