import SwiftUI
import Combine

@MainActor
protocol PWUsageApplicationAPI: MobileDashboardDataAPI, MobileAuthAPI {
    func fetchSites() async throws -> [MobileSite]
}

extension PWUsageAPI: PWUsageApplicationAPI {}

@main
struct PWUsageApp: App {
    @StateObject private var model: PWUsageAppModel

    init() {
        let configuration = (try? AppConfiguration.fromBundle()) ?? (try! AppConfiguration())
        let apiClient = PWUsageAPI(configuration: configuration)
        _model = StateObject(wrappedValue: PWUsageAppModel(configuration: configuration, api: apiClient))
    }

    var body: some Scene {
        WindowGroup {
            PWUsageRootView()
                .environmentObject(model)
        }
        .commands {
            PWUsageCommands(model: model)
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

    let authService: MobileAuthService
    private let api: any PWUsageApplicationAPI
    private let userDefaults: UserDefaults
    private var coordinatorAuthSubscription: AnyCancellable?
    private var didBootstrap = false
    private var sceneIsActive = false

    init(configuration: AppConfiguration, api: any PWUsageApplicationAPI, userDefaults: UserDefaults = .standard) {
        self.api = api
        self.userDefaults = userDefaults
        authService = MobileAuthService(configuration: configuration, api: api)
    }

    func bootstrap() async {
        guard !didBootstrap else { return }
        didBootstrap = true
        do {
            let availableSites = try await api.fetchSites()
            await installAuthorizedSites(availableSites)
        } catch let error as PWUsageAPIError {
            if error == .signInRequired {
                await authService.invalidateAuthenticatedSession()
                screenState = .signedOut
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
                await authService.invalidateAuthenticatedSession()
                screenState = .signedOut
                signInMessage = "Sign-in expired. Please try again."
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
            await authService.invalidateAuthenticatedSession()
            screenState = .signedOut
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
        do { try await authService.logout() }
        catch { /* The local cookie and sign-in state are cleared by MobileAuthService even on network failure. */ }
        coordinator = nil
        coordinatorAuthSubscription = nil
        sites = []
        selectedSiteID = nil
        isSitePickerPresented = false
        userDefaults.removeObject(forKey: Self.selectedSiteDefaultsKey)
        screenState = .signedOut
        signInMessage = nil
    }

    func sessionExpired() async {
        await authService.invalidateAuthenticatedSession()
        isSitePickerPresented = false
        screenState = .signedOut
        signInMessage = "Your session expired. Sign in to continue."
    }

    private func installAuthorizedSites(_ availableSites: [MobileSite]) async {
        sites = availableSites
        authService.restoreAuthenticatedSession()
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
            let nextCoordinator = DashboardCoordinator(siteID: chosen.id, api: api)
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
