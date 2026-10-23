import SwiftUI
import WidgetKit
import Combine
import OSLog
import UIKit

@MainActor
protocol PWUsageApplicationAPI: MobileDashboardDataAPI, MobileLoadPlanningDataAPI, MobileAuthAPI {
    func fetchSites() async throws -> [MobileSite]
}

@main
struct PWUsageApp: App {
    /// Startup maintenance finishes before any model can read persisted credentials.
    private enum Launch {
        case starting
        case ready(PWUsageAppModel)
        case misconfigured(String)
    }

    @State private var launch: Launch = .starting
    private let launchTask: Task<Launch, Never>

    init() {
        launchTask = Task { @MainActor in await Self.prepareLaunch() }
    }

    private static func prepareLaunch() async -> Launch {
        do {
            try await AppLaunchMaintenance.run(
                defaults: .standard,
                buildVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
                hasPersistedForecastState: {
                    try DeviceSolarForecastPersistence.hasPersistedState()
                },
                sweepCredentials: {
                    try await DeviceSolcastCredentialStore.shared.deleteAllCredentials()
                },
                clearSessionCookie: {
                    SharedWebSession.clearSessionCookies()
                },
                reloadControls: {
                    // Rebuild templates only after an update; retain saved site configuration.
                    ControlCenter.shared.reloadControls(ofKind: BatteryHoldControlIdentity.kind)
                }
            )
            let configuration = try AppConfiguration.fromBundle()
            let api = PWUsageAPI(configuration: configuration)
            return .ready(
                PWUsageAppModel(
                    configuration: configuration,
                    api: api,
                    cache: .persistent(apiOrigin: configuration.apiOrigin),
                    controlSiteStore: .shared(),
                    liveActivities: BatteryHoldActivityCoordinator(
                        host: ActivityKitBatteryHoldHost(),
                        api: api,
                        apnsEnvironment: .fromBundle(),
                        store: .init(defaults: .standard)
                    )
                )
            )
        } catch let error as AppConfiguration.ValidationError {
            // A Release build with an unusable origin has no server worth talking
            // to, so refuse rather than guess. Building a client here is exactly
            // the failure this replaces: it silently became a production client.
            PWUsageApp.reportMisconfiguration(error)
            return .misconfigured(
                "This build of pwusage was misconfigured and cannot choose a server. "
                    + "The bundled API origin was rejected as invalid."
            )
        } catch {
            PWUsageApp.reportMisconfiguration(error)
            return .misconfigured("pwusage could not finish secure startup. Close the app and try again.")
        }
    }

    private static func reportMisconfiguration(_ error: Error) {
        Logger(subsystem: "fm.rodeo.pwusage", category: "configuration")
            .error("Refusing to launch: \(String(describing: error), privacy: .public)")
    }

    var body: some Scene {
        WindowGroup {
            switch launch {
            case .starting:
                ProgressView("Starting pwusage…")
                    .task { launch = await launchTask.value }
            case .ready(let model):
                PWUsageRootView()
                    .environmentObject(model)
                    .environment(model.liveActivities)
            case .misconfigured(let message):
                EmptyStateScreen(
                    symbol: "exclamationmark.triangle",
                    title: "pwusage can’t start",
                    message: message,
                    actionTitle: "Copy details",
                    action: { Clipboard.copy(message) }
                )
            }
        }
        .commands {
            if case .ready(let model) = launch {
                PWUsageCommands(model: model)
            }
        }
    }
}

private struct PWUsageCommands: Commands {
    @ObservedObject var model: PWUsageAppModel

    var body: some Commands {
        CommandMenu("View") {
            Button("Refresh") {
                Task {
                    await model.refreshDashboard(trigger: .scheduled)
                }
            }
            .keyboardShortcut("r", modifiers: .command)
            .disabled(model.screenState != .signedIn)
        }

        CommandGroup(after: .newItem) {
            Button("Switch Site…") {
                model.openSitePicker()
            }
            .keyboardShortcut("k", modifiers: .command)
            .disabled(model.screenState != .signedIn || model.sites.isEmpty)
        }

        CommandGroup(after: .appInfo) {
            Button("Sign Out") {
                Task {
                    await model.signOut()
                }
            }
            .disabled(model.screenState != .signedIn || model.isSigningOut)
        }
    }
}

@MainActor
final class PWUsageAppModel: ObservableObject {
    enum ScreenState: Equatable {
        case bootstrapping
        case signedOut
        case signedIn
        case noSites
        case unavailable
    }

    @Published private(set) var screenState: ScreenState = .bootstrapping
    @Published private(set) var sites: [MobileSite] = []
    @Published private(set) var selectedSiteID: String?
    @Published private(set) var coordinator: DashboardCoordinator?
    @Published private(set) var isSigningIn = false
    @Published private(set) var isSigningOut = false
    @Published private(set) var signInMessage: String?
    @Published var isSitePickerPresented = false
    @Published private(set) var accountScopeID: String?
    /// The tab on screen. Only `selectTab` persists it; an external Battery Saver
    /// launch moves it for one visit, like the saved site.
    @Published private(set) var selectedTab: AppTab

    /// Builds the dashboard coordinator for a site. Injected so tests can control
    /// the polling cadence and the clock.
    typealias CoordinatorFactory = @MainActor (_ siteID: String, _ accountScopeID: String) -> DashboardCoordinator

    let authService: MobileAuthService
    private let api: any PWUsageApplicationAPI
    private let userDefaults: UserDefaults
    private let cache: DashboardCache?
    /// Replaced on each external route (widget, Battery Saver control) so every
    /// tab rebuilds its stack, dropping old paths and tab-local modals.
    @Published private(set) var externalNavigationID: UUID?
    @Published private(set) var pendingBatteryHoldSiteID: String?
    @Published var batteryHoldNavigationMessage: String?
    private let controlSiteStore: BatteryHoldControlSiteStore?
    let liveActivities: BatteryHoldActivityCoordinator?
    private var sessionVerified = false
    private var hasBootstrapAttempted = false
    @Published private var siteRequestCount = 0
    var isBatteryHoldNavigationLoading: Bool { pendingBatteryHoldSiteID != nil && siteRequestCount > 0 }
    private let forecastStore: any SolarForecastManaging
    private let coordinatorFactory: CoordinatorFactory
    private var coordinatorAuthSubscription: AnyCancellable?
    private var sceneIsActive = false

    /// Identifies the attempt that owns the published site state. Every path that
    /// publishes sites claims one, and a superseded attempt discards its own result
    /// rather than overwriting a newer one. See `installAuthorizedSites`.
    private var siteInstallGeneration = 0

    init(
        configuration: AppConfiguration,
        api: any PWUsageApplicationAPI,
        userDefaults: UserDefaults = .standard,
        forecastStore: any SolarForecastManaging = SolarForecastStore.shared,
        coordinatorFactory: CoordinatorFactory? = nil,
        cache: DashboardCache? = nil,
        authService: MobileAuthService? = nil,
        controlSiteStore: BatteryHoldControlSiteStore? = nil,
        liveActivities: BatteryHoldActivityCoordinator? = nil
    ) {
        self.controlSiteStore = controlSiteStore
        self.liveActivities = liveActivities
        self.api = api
        self.userDefaults = userDefaults
        self.cache = cache
        self.forecastStore = forecastStore
        selectedTab = userDefaults.string(forKey: Self.selectedTabDefaultsKey).flatMap(AppTab.init(rawValue:)) ?? .home
        if let coordinatorFactory {
            self.coordinatorFactory = coordinatorFactory
        } else {
            self.coordinatorFactory = { siteID, accountScopeID in
                DashboardCoordinator(
                    siteID: siteID,
                    api: api,
                    planningAPI: api,
                    forecastStore: forecastStore,
                    accountScopeID: accountScopeID
                )
            }
        }
        self.authService = authService ?? MobileAuthService(
            configuration: configuration,
            api: api,
            forecastCleanup: SolarForecastStoreSessionCleanup(store: forecastStore)
        )
        if let cachedSites = cache?.snapshot.sites, !cachedSites.isEmpty {
            sites = cachedSites
            let savedID = userDefaults.string(forKey: Self.selectedSiteDefaultsKey)
            let chosen = cachedSites.first(where: { $0.id == savedID }) ?? cachedSites[0]
            selectedSiteID = chosen.id
            installCoordinator(siteID: chosen.id, accountScopeID: ensureAccountScopeID())
            screenState = .signedIn
        }
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

    func refreshDashboard(trigger: DashboardCoordinator.RefreshTrigger = .userGesture) async {
        if sessionVerified {
            await coordinator?.refreshAll(trigger: trigger)
        } else {
            await reloadSitesAfterSignIn()
        }
    }

    func selectSite(_ site: MobileSite) {
        guard selectedSiteID != site.id else { return }
        selectedSiteID = site.id
        userDefaults.set(site.id, forKey: Self.selectedSiteDefaultsKey)
        coordinator?.selectSite(site.id)
    }

    func selectTab(_ tab: AppTab) {
        selectedTab = tab
        userDefaults.set(tab.rawValue, forKey: Self.selectedTabDefaultsKey)
    }

    func openNavigationURL(_ url: URL) async {
        if url == DashboardLink.url {
            dismissCompetingPresentations()
            externalNavigationID = UUID()
            selectTab(.home)
            return
        }
        guard url.scheme == "pwusage", url.host == "battery-hold" else { return }
        guard let siteID = BatteryHoldLink.siteID(from: url) else {
            pendingBatteryHoldSiteID = nil
            dismissCompetingPresentations()
            batteryHoldNavigationMessage = "Choose a site in the Battery Saver control’s configuration, then try again."
            return
        }
        await openBatteryHold(siteID: siteID)
    }

    func openBatteryHold(siteID: String) async {
        pendingBatteryHoldSiteID = siteID
        batteryHoldNavigationMessage = nil
        dismissCompetingPresentations()
        // Even a warm launch rechecks the current account's sites. A saved picker
        // entry and the dashboard cache are never evidence of current access.
        await reloadSitesAfterSignIn()
    }

    /// The loading overlay and the launcher alert both live on the root view, so
    /// anything already presented above it would hide them. An external launch
    /// closes those before it starts waiting on the network.
    private func dismissCompetingPresentations() {
        isSitePickerPresented = false
        coordinator?.presentedSheet = nil
    }

    /// Dismissing the launcher alert abandons the request. Without this the
    /// pending site survives and hijacks the next successful site load.
    func cancelBatteryHoldNavigation() {
        pendingBatteryHoldSiteID = nil
        batteryHoldNavigationMessage = nil
    }

    private func resolveBatteryHoldNavigation() {
        guard let requestedID = pendingBatteryHoldSiteID else { return }
        pendingBatteryHoldSiteID = nil
        guard let site = sites.first(where: { $0.id == requestedID }) else {
            batteryHoldNavigationMessage = "This control’s site is no longer available to this account. Choose an available site in the control’s configuration."
            return
        }
        selectSite(site)
        // Rebuild only for an external route: this drops the old navigation path
        // and every dashboard/detail modal before the new host opens the sheet.
        externalNavigationID = UUID()
        selectedTab = .smartShift
        coordinator?.isBatteryHoldSheetPresented = true
    }

    func openSitePicker() {
        guard screenState == .signedIn, !sites.isEmpty else { return }
        isSitePickerPresented = true
    }

    func signOut() async {
        guard !isSigningOut else { return }
        isSigningOut = true
        defer { isSigningOut = false }
        // First, while the session cookie can still unregister this device's pushes.
        await liveActivities?.signOut()
        pendingBatteryHoldSiteID = nil
        batteryHoldNavigationMessage = nil
        screenState = .signedOut
        signInMessage = nil
        teardownCoordinator()
        var cleanupFailed = false
        do { try await authService.logout() }
        catch let error as MobileAuthService.AuthError where error == .forecastCleanupFailed { cleanupFailed = true }
        catch { /* A remote logout failure does not prevent local sign-out. */ }
        coordinator = nil
        coordinatorAuthSubscription = nil
        sites = []
        selectedSiteID = nil
        isSitePickerPresented = false
        userDefaults.removeObject(forKey: Self.selectedSiteDefaultsKey)
        clearSelectedTab()
        await clearAccountScopeID()
        screenState = .signedOut
        signInMessage = cleanupFailed ? "Could not clear local solar forecast data. Try again." : nil
    }

    func sessionExpired() async {
        guard !isSigningOut else { return }
        await invalidateSession(message: "Your session expired. Sign in to continue.")
    }

    private func invalidateSession(message: String?) async {
        guard !isSigningOut else { return }
        teardownCoordinator()
        await liveActivities?.sessionInvalidated()
        var cleanupFailed = false
        do { try await authService.invalidateAuthenticatedSession() }
        catch { cleanupFailed = true }
        isSitePickerPresented = false
        coordinator = nil
        coordinatorAuthSubscription = nil
        sites = []
        selectedSiteID = nil
        userDefaults.removeObject(forKey: Self.selectedSiteDefaultsKey)
        clearSelectedTab()
        await clearAccountScopeID()
        screenState = .signedOut
        signInMessage = cleanupFailed
            ? "Could not clear local solar forecast data. Try again."
            : message
    }

    /// The coordinator must not outlive the session. `authenticationInvalidated`
    /// discards in-flight work; going inactive is what actually stops the
    /// polling timer, which otherwise keeps a strong reference and keeps asking
    /// for authenticated data after the user has signed out.
    private func teardownCoordinator() {
        siteInstallGeneration += 1
        sessionVerified = false
        cache?.clear()
        controlSiteStore?.clear()
        coordinatorAuthSubscription = nil
        coordinator?.authenticationInvalidated()
        coordinator?.scenePhaseChanged(isActive: false)
    }

    /// Claims ownership of the published site state, superseding any attempt that has
    /// not finished. A retry is deliberately *not* blocked on the attempt it replaces —
    /// §3.2 requires it to run to completion while the older attempt is still parked —
    /// so the guard is on publishing, not on entry.
    private func claimSiteInstall() -> Int {
        siteInstallGeneration += 1
        return siteInstallGeneration
    }

    /// Publishes `availableSites`, unless `generation` has been superseded.
    ///
    /// Two attempts can be in flight at once — the root `.task` is cancelled on
    /// disappear, but an API or actor call that ignores cancellation keeps running,
    /// and the re-appearing `.task` starts a second one — so the losing attempt
    /// reaches this function too. A single check on entry is therefore not enough:
    /// a loser that is already inside when the winner starts publishing resumes
    /// *after* the winner and overwrites the selected site and the coordinator.
    /// The generation is compared again after the `await` for that reason.
    ///
    /// The pre-`await` writes are deliberately left unguarded. §3.2 requires
    /// `sites` to be populated while the state is still `.bootstrapping`, because
    /// that is what makes the screen retryable rather than a permanent spinner;
    /// a superseded attempt reaching them has already lost a race the newer
    /// attempt wins again immediately afterwards.
    private func installAuthorizedSites(_ availableSites: [MobileSite], generation: Int) async {
        guard generation == siteInstallGeneration else { return }
        sites = availableSites
        authService.restoreAuthenticatedSession()
        let accountScopeID = ensureAccountScopeID()
        await forecastStore.activateAccountScope(accountScopeID)
        guard generation == siteInstallGeneration else { return }
        cache?.storeSites(availableSites)
        sessionVerified = true
        controlSiteStore?.save(availableSites.map { BatteryHoldControlSite(id: $0.id, name: $0.name) })
        liveActivities?.sitesAuthorized(availableSites)
        guard !availableSites.isEmpty else {
            resolveBatteryHoldNavigation()
            coordinatorAuthSubscription = nil
            coordinator?.authenticationInvalidated()
            coordinator?.scenePhaseChanged(isActive: false)
            coordinator = nil
            selectedSiteID = nil
            screenState = .noSites
            return
        }

        // The saved default belongs to the user and only `selectSite` changes it.
        // A control launch moves the dashboard for this visit, and an ordinary
        // reload keeps whatever is already on screen, so neither rewrites it.
        let savedID = userDefaults.string(forKey: Self.selectedSiteDefaultsKey)
        let defaultSite = availableSites.first(where: { $0.id == savedID }) ?? availableSites[0]
        let chosen = availableSites.first(where: { $0.id == pendingBatteryHoldSiteID })
            ?? availableSites.first(where: { $0.id == selectedSiteID })
            ?? defaultSite
        selectedSiteID = chosen.id
        userDefaults.set(defaultSite.id, forKey: Self.selectedSiteDefaultsKey)

        if let coordinator, coordinator.selectedSiteID == chosen.id {
            coordinator.authenticationRestored()
            coordinator.scenePhaseChanged(isActive: sceneIsActive)
        } else {
            coordinatorAuthSubscription = nil
            coordinator?.authenticationInvalidated()
            coordinator?.scenePhaseChanged(isActive: false)
            installCoordinator(siteID: chosen.id, accountScopeID: accountScopeID)
            coordinator?.scenePhaseChanged(isActive: sceneIsActive)
        }
        screenState = .signedIn
        resolveBatteryHoldNavigation()
    }

    private func installCoordinator(siteID: String, accountScopeID: String) {
        let nextCoordinator = coordinatorFactory(siteID, accountScopeID)
        nextCoordinator.restoreLaunchCache(cache, sessionVerified: sessionVerified)
        nextCoordinator.batteryHoldActivityObserver = liveActivities
        coordinator = nextCoordinator
        coordinatorAuthSubscription = nextCoordinator.$requiresSignIn
            .removeDuplicates()
            .sink { [weak self] required in
                guard required else { return }
                Task { @MainActor in await self?.sessionExpired() }
            }
    }

    static let selectedSiteDefaultsKey = "pwusage.selectedSiteID"
    static let accountScopeDefaultsKey = "pwusage.localAccountScopeID"
    static let selectedTabDefaultsKey = "pwusage.selectedTab"

    /// The next session starts on Home, not on whatever tab this one ended on.
    private func clearSelectedTab() {
        selectedTab = .home
        userDefaults.removeObject(forKey: Self.selectedTabDefaultsKey)
    }

    private func ensureAccountScopeID() -> String {
        if let existing = userDefaults.string(forKey: Self.accountScopeDefaultsKey), !existing.isEmpty {
            accountScopeID = existing
            return existing
        }
        let created = UUID().uuidString.lowercased()
        userDefaults.set(created, forKey: Self.accountScopeDefaultsKey)
        accountScopeID = created
        return created
    }

    private func clearAccountScopeID() async {
        accountScopeID = nil
        userDefaults.removeObject(forKey: Self.accountScopeDefaultsKey)
        await forecastStore.activateAccountScope(nil)
    }
}

private struct PWUsageRootView: View {
    @StateObject private var navigationInbox = BatteryHoldNavigationInbox.shared
    @EnvironmentObject private var model: PWUsageAppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch model.screenState {
            case .bootstrapping:
                VStack(spacing: 14) {
                    ProgressView()
                    Text("Connecting to pwusage…").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(SectionTheme.groupedBackground)
            case .signedOut:
                SignInView(
                    isWorking: model.isSigningIn || model.isSigningOut,
                    workingTitle: model.isSigningOut ? "Signing out…" : "Connecting…",
                    message: model.signInMessage
                ) {
                    Task { await model.signIn() }
                }
            case .signedIn:
                if let coordinator = model.coordinator,
                   let site = model.sites.first(where: { $0.id == model.selectedSiteID }) {
                    if coordinator.requiresSignIn {
                        SignInView(
                            isWorking: model.isSigningIn || model.isSigningOut,
                            workingTitle: model.isSigningOut ? "Signing out…" : "Connecting…",
                            message: "Your session expired. Sign in to continue."
                        ) {
                            Task { await model.signIn() }
                        }
                    } else {
                        AppTabView(model: model, coordinator: coordinator, site: site)
                        .environment(\.reconnectTesla, TeslaReconnectAction(owner: model) { await model.reconnectTesla() })
                    }
                } else {
                    errorState
                }
            case .noSites:
                EmptyStateScreen(
                    symbol: "house.badge.exclamationmark",
                    title: "No sites available",
                    message: "This account does not have a pwusage site yet.",
                    actionTitle: "Sign out",
                    action: { Task { await model.signOut() } }
                )
            case .unavailable:
                errorState
            }
        }
        .task {
            configureWindowSizeRestrictions()
            model.scenePhaseChanged(isActive: scenePhase == .active)
            await model.bootstrap()
        }
        .task(id: navigationInbox.request?.id) {
            if let url = navigationInbox.take() { await model.openNavigationURL(url) }
        }
        .onOpenURL { navigationInbox.send($0) }
        .overlay(alignment: .top) {
            if model.isBatteryHoldNavigationLoading {
                ProgressView("Loading this control’s site…")
                    .padding().background(.regularMaterial, in: Capsule())
                    .padding()
            }
        }
        .alert("Battery Saver", isPresented: Binding(
            get: { model.batteryHoldNavigationMessage != nil },
            // Only the buttons dismiss this alert; "OK" is what abandons the
            // request, so the binding must not cancel out from under "Try Again".
            set: { if !$0 { model.batteryHoldNavigationMessage = nil } }
        )) {
            if model.pendingBatteryHoldSiteID != nil {
                Button("Try Again") { Task { await model.reloadSitesAfterSignIn() } }
            }
            Button("OK", role: .cancel) { model.cancelBatteryHoldNavigation() }
        } message: {
            Text(model.batteryHoldNavigationMessage ?? "")
        }
        .onChange(of: scenePhase) { _, phase in
            model.scenePhaseChanged(isActive: phase == .active)
        }
        .onAppear {
            configureWindowSizeRestrictions()
            model.scenePhaseChanged(isActive: scenePhase == .active)
        }
    }

    private func configureWindowSizeRestrictions() {
        #if canImport(UIKit)
        for scene in UIApplication.shared.connectedScenes {
            if let windowScene = scene as? UIWindowScene {
                windowScene.sizeRestrictions?.minimumSize = CGSize(width: 380, height: 520)
            }
        }
        #endif
    }

    private var errorState: some View {
        EmptyStateScreen(
            symbol: "wifi.exclamationmark",
            title: "Can’t connect right now",
            message: "Check your connection and try loading your sites again.",
            actionTitle: "Try again",
            action: { Task { await model.reloadSitesAfterSignIn() } }
        )
    }
}

private struct EmptyStateScreen: View {
    let symbol: String
    let title: String
    let message: String
    let actionTitle: String
    let action: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: symbol)
                .font(.system(size: 42))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(title).font(.title2.bold()).multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
            Text(message).font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button(actionTitle, action: action).buttonStyle(.borderedProminent).tint(.green)
        }
        .padding(32)
        .frame(maxWidth: 500)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(SectionTheme.groupedBackground)
    }
}
