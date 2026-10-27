import SwiftUI
import Combine

struct PWUsageRootView: View {
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
