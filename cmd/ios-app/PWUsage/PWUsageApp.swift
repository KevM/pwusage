import SwiftUI
import Combine
import OSLog
import UIKit

@MainActor
protocol PWUsageApplicationAPI: MobileDashboardDataAPI, MobileLoadPlanningDataAPI, MobileAuthAPI {
    func fetchSites() async throws -> [MobileSite]
}

@main
struct PWUsageApp: App {
    /// Resolved once, at launch. Either a model to run or a build misconfiguration
    /// to report. It never changes, so no observation is needed to hold on to it.
    private enum Launch {
        case ready(PWUsageAppModel)
        case misconfigured(String)
    }

    private let launch: Launch

    init() {
        do {
            let configuration = try AppConfiguration.fromBundle()
            launch = .ready(
                PWUsageAppModel(
                    configuration: configuration,
                    api: PWUsageAPI(configuration: configuration)
                )
            )
        } catch let error as AppConfiguration.ValidationError {
            // A Release build with an unusable origin has no server worth talking
            // to, so refuse rather than guess. Building a client here is exactly
            // the failure this replaces: it silently became a production client.
            launch = .misconfigured(
                "This build of pwusage was misconfigured and cannot choose a server. "
                    + "The bundled API origin was rejected as invalid."
            )
            PWUsageApp.reportMisconfiguration(error)
        } catch {
            launch = .misconfigured("This build of pwusage was misconfigured and cannot choose a server.")
            PWUsageApp.reportMisconfiguration(error)
        }
    }

    private static func reportMisconfiguration(_ error: Error) {
        Logger(subsystem: "fm.rodeo.pwusage", category: "configuration")
            .error("Refusing to launch: \(String(describing: error), privacy: .public)")
    }

    var body: some Scene {
        WindowGroup {
            switch launch {
            case .ready(let model):
                PWUsageRootView()
                    .environmentObject(model)
            case .misconfigured(let message):
                EmptyStateScreen(
                    symbol: "exclamationmark.triangle",
                    title: "pwusage can’t start",
                    message: message,
                    actionTitle: "Copy details",
                    action: { UIPasteboard.general.string = message }
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
                    await model.coordinator?.refreshDue()
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
            .disabled(model.screenState != .signedIn)
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
    @Published private(set) var signInMessage: String?
    @Published var isSitePickerPresented = false
    @Published private(set) var accountScopeID: String?

    /// Builds the dashboard coordinator for a site. Injected so tests can control
    /// the polling cadence and the clock.
    typealias CoordinatorFactory = @MainActor (_ siteID: String, _ accountScopeID: String) -> DashboardCoordinator

    let authService: MobileAuthService
    private let api: any PWUsageApplicationAPI
    private let userDefaults: UserDefaults
    private let forecastStore: any SolarForecastManaging
    private let coordinatorFactory: CoordinatorFactory
    private var coordinatorAuthSubscription: AnyCancellable?
    private var sceneIsActive = false

    init(
        configuration: AppConfiguration,
        api: any PWUsageApplicationAPI,
        userDefaults: UserDefaults = .standard,
        forecastStore: any SolarForecastManaging = SolarForecastStore.shared,
        coordinatorFactory: CoordinatorFactory? = nil
    ) {
        self.api = api
        self.userDefaults = userDefaults
        self.forecastStore = forecastStore
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
        authService = MobileAuthService(
            configuration: configuration,
            api: api,
            forecastCleanup: SolarForecastStoreSessionCleanup(store: forecastStore)
        )
    }

    /// Retries until a terminal state is reached. The `.task` that drives this is
    /// cancelled when the view disappears, which can land inside
    /// `installAuthorizedSites` and leave the screen on the spinner, so a
    /// latch set on entry would strand it with no way back.
    func bootstrap() async {
        switch screenState {
        case .signedIn, .signedOut, .unavailable: return
        case .bootstrapping, .noSites: break
        }
        do {
            let availableSites = try await api.fetchSites()
            await installAuthorizedSites(availableSites)
        } catch let error as PWUsageAPIError {
            if error == .signInRequired {
                await invalidateSession(message: nil)
            } else {
                screenState = .unavailable
            }
        } catch {
            screenState = .unavailable
        }
    }

    func scenePhaseChanged(isActive: Bool) {
        sceneIsActive = isActive
        coordinator?.scenePhaseChanged(isActive: isActive)
    }

    func signIn() async {
        guard !isSigningIn else { return }
        isSigningIn = true
        signInMessage = nil
        defer { isSigningIn = false }
        do {
            try await authService.signIn()
            let availableSites = try await api.fetchSites()
            await installAuthorizedSites(availableSites)
        } catch let error as PWUsageAPIError {
            if error == .signInRequired {
                await invalidateSession(message: "Sign-in expired. Please try again.")
            } else if authService.isAuthenticated {
                screenState = .unavailable
                signInMessage = "You’re signed in, but pwusage could not load your sites. Check your connection and try again."
            } else {
                screenState = .signedOut
                signInMessage = "Could not complete sign-in. Please try again."
            }
        } catch let error as MobileAuthService.AuthError {
            screenState = .signedOut
            signInMessage = error == .cancelled ? nil : "Could not complete sign-in. Please try again."
        } catch {
            screenState = .signedOut
            signInMessage = "Could not connect to pwusage. Please try again."
        }
    }

    func reloadSitesAfterSignIn() async {
        do {
            let availableSites = try await api.fetchSites()
            await installAuthorizedSites(availableSites)
        } catch let error as PWUsageAPIError where error == .signInRequired {
            await invalidateSession(message: "Your session expired. Sign in to continue.")
        } catch {
            screenState = authService.isAuthenticated ? .unavailable : .signedOut
        }
    }

    func selectSite(_ site: MobileSite) {
        guard selectedSiteID != site.id else { return }
        selectedSiteID = site.id
        userDefaults.set(site.id, forKey: Self.selectedSiteDefaultsKey)
        coordinator?.selectSite(site.id)
    }

    func openSitePicker() {
        guard screenState == .signedIn, !sites.isEmpty else { return }
        isSitePickerPresented = true
    }

    func signOut() async {
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
        await clearAccountScopeID()
        screenState = .signedOut
        signInMessage = cleanupFailed ? "Could not clear local solar forecast data. Please try again." : nil
    }

    func sessionExpired() async {
        await invalidateSession(message: "Your session expired. Sign in to continue.")
    }

    private func invalidateSession(message: String?) async {
        teardownCoordinator()
        var cleanupFailed = false
        do { try await authService.invalidateAuthenticatedSession() }
        catch { cleanupFailed = true }
        isSitePickerPresented = false
        coordinator = nil
        coordinatorAuthSubscription = nil
        sites = []
        selectedSiteID = nil
        userDefaults.removeObject(forKey: Self.selectedSiteDefaultsKey)
        await clearAccountScopeID()
        screenState = .signedOut
        signInMessage = cleanupFailed
            ? "Could not clear local solar forecast data. Please try again."
            : message
    }

    /// The coordinator must not outlive the session. `authenticationInvalidated`
    /// discards in-flight work; going inactive is what actually stops the
    /// polling timer, which otherwise keeps a strong reference and keeps asking
    /// for authenticated data after the user has signed out.
    private func teardownCoordinator() {
        coordinator?.authenticationInvalidated()
        coordinator?.scenePhaseChanged(isActive: false)
    }

    private func installAuthorizedSites(_ availableSites: [MobileSite]) async {
        sites = availableSites
        authService.restoreAuthenticatedSession()
        let accountScopeID = ensureAccountScopeID()
        await forecastStore.activateAccountScope(accountScopeID)
        guard !availableSites.isEmpty else {
            coordinator = nil
            selectedSiteID = nil
            screenState = .noSites
            return
        }

        let savedID = userDefaults.string(forKey: Self.selectedSiteDefaultsKey)
        let chosen = availableSites.first(where: { $0.id == savedID }) ?? availableSites[0]
        selectedSiteID = chosen.id
        userDefaults.set(chosen.id, forKey: Self.selectedSiteDefaultsKey)

        if let coordinator, coordinator.selectedSiteID == chosen.id {
            coordinator.authenticationRestored()
            coordinator.scenePhaseChanged(isActive: sceneIsActive)
        } else {
            let nextCoordinator = coordinatorFactory(chosen.id, accountScopeID)
            coordinator = nextCoordinator
            coordinatorAuthSubscription = nextCoordinator.$requiresSignIn
                .removeDuplicates()
                .sink { [weak self] required in
                    guard required else { return }
                    Task { @MainActor in await self?.sessionExpired() }
                }
            nextCoordinator.scenePhaseChanged(isActive: sceneIsActive)
        }
        screenState = .signedIn
    }

    static let selectedSiteDefaultsKey = "pwusage.selectedSiteID"
    static let accountScopeDefaultsKey = "pwusage.localAccountScopeID"

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
                .background(Color(uiColor: .systemGroupedBackground))
            case .signedOut:
                SignInView(isWorking: model.isSigningIn, message: model.signInMessage) {
                    Task { await model.signIn() }
                }
            case .signedIn:
                if let coordinator = model.coordinator,
                   let site = model.sites.first(where: { $0.id == model.selectedSiteID }) {
                    if coordinator.requiresSignIn {
                        SignInView(isWorking: model.isSigningIn, message: "Your session expired. Sign in to continue.") {
                            Task { await model.signIn() }
                        }
                    } else {
                        DashboardView(coordinator: coordinator, site: site, onChooseSite: { model.openSitePicker() }) {
                            Task { await model.signOut() }
                        }
                        .sheet(isPresented: $model.isSitePickerPresented) {
                            SitePickerView(sites: model.sites, selectedSiteID: site.id) { selected in
                                model.selectSite(selected)
                                model.isSitePickerPresented = false
                            }
                            .presentationDetents(model.sites.count > 4 ? [.medium, .large] : [.medium])
                        }
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
        .background(Color(uiColor: .systemGroupedBackground))
    }
}
