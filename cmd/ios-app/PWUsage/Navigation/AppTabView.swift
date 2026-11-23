import SwiftUI

/// The signed-in root: one tab per `AppTab`, a sidebar on iPad and a
/// tab bar on iPhone and Mac. Sheets that must show over any tab live here, not on a
/// tab's content, so an external launch can clear them from the model.
struct AppTabView: View {
    @ObservedObject var model: PWUsageAppModel
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite
    @Environment(\.demoMode) private var demoMode
    private var defaultTabPlacement: AdaptableTabBarPlacement {
        ProcessInfo.processInfo.isiOSAppOnMac ? .tabBar : .sidebar
    }
    /// The banner's motion outlives its content, which the tab bar recreates as it updates.
    @State private var bannerClocks = SolarSystemBannerClocks()
    @State private var accessoryDismissals = RateEstimatesAccessoryDismissals()
    private let historyOfferDismissals = RateEstimatesAccessoryDismissals.sharedHistoryOffer

    var body: some View {
        Group {
            if coordinator.requiresTeslaReconnect {
                SignInView(
                    isWorking: model.isSigningIn,
                    message: model.signInMessage,
                    onSignIn: { Task { await model.reconnectTesla() } },
                    title: "Reconnect Tesla",
                    subtitle: "Reconnect your Tesla account to update your energy data.",
                    buttonTitle: "Reconnect Tesla"
                )
            } else if model.isDemo {
                // Stacked rather than a safe-area inset: the floating tab bar ignores
                // an inset and would sit under the bar. Below the tab bar on iPhone,
                // across the window's foot under the sidebar on iPad.
                // Ignoring the keyboard keeps the TabView's frame fixed when a sheet's
                // keyboard opens or closes, avoiding a UITabBarController layout loop.
                VStack(spacing: 0) {
                    tabs
                    DemoModeBar { model.presentDemoSheet() }
                }
                .ignoresSafeArea(.keyboard)
            } else {
                tabs
            }
        }
    }

    @ViewBuilder private var tabs: some View {
        // As in Settings: without the beta, the banner would open a screen with nothing to show.
        let status = coordinator.solarLayoutStatus == .disabled ? nil : model.siteHistoryStatus
        let presentation = SiteHistoryPresentation(status: status, now: .now)
        if #available(iOS 26.1, *) {
            let banner = SolarSystemBannerModel(presentation: presentation, status: status)
            let showsBanner = presentation.showsBanner && !model.isDemo && !model.isShowingSolarSystem
            // One accessory slot: a running Battery Saver session outranks the banner on its own tab.
            let hold = model.selectedTab == .smartShift
                ? BatteryHoldAccessoryModel(state: coordinator.batteryHold, now: .now) : nil
            // Loading older history is the user's choice and runs after the layout import.
            let deep = model.historyOnboarding?.deepHistory.flatMap {
                $0.status.isLoading && !model.isDemo && !model.isShowingSolarSystem
                    ? SiteDeepHistoryPresentation(status: $0.status) : nil
            }
            // Setup for estimated rate plans comes last: it yields to every history accessory.
            let guide = coordinator.savingsTimeline?.estimates?.historyGuide
            let estimate = RateEstimatesAccessoryRule.prompt(
                RateEstimatesPresentation.prompt(coordinator.savingsTimeline?.estimates),
                historyOffer: guide != nil,
                selectedTab: model.selectedTab,
                isDemo: model.isDemo,
                isDismissed: accessoryDismissals.isDismissed(siteID: site.id),
                isHistoryOfferDismissed: historyOfferDismissals.isDismissed(siteID: site.id),
                yieldsTo: hold != nil || deep != nil || showsBanner
            )
            tabView.tabViewBottomAccessory(isEnabled: hold != nil || deep != nil || showsBanner || estimate != nil) {
                if let hold {
                    BatteryHoldAccessory(model: hold) { coordinator.isBatteryHoldSheetPresented = true }
                } else if let deep {
                    SiteDeepHistoryAccessory(presentation: deep) { model.openSolarSystem() }
                } else if showsBanner {
                    SolarSystemBanner(model: banner, clocks: bannerClocks) {
                        model.openSolarSystem(focusingLocation: banner.mode == .needsLocation)
                    }
                } else if let estimate {
                    RateEstimatesAccessory(
                        kind: estimate,
                        utilityName: coordinator.savingsTimeline?.estimates?.utilityName,
                        historyStart: guide?.historyStart,
                        onOpen: { open(estimate) },
                        onDismiss: { dismiss(estimate) }
                    )
                }
            }
            .onChange(of: banner.days, initial: true) { bannerClocks.observe(days: banner.days, now: .now) }
        } else {
            tabView
        }
    }

    private var tabView: some View {
        TabView(selection: Binding(get: { model.selectedTab }, set: { model.selectTab($0) })) {
            ForEach(AppTab.allCases) { tab in
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    // An external launch (widget or Battery Saver control) rebuilds
                    // each tab's stack to drop old paths and modals. The id goes here, never on the
                    // TabView, so the sidebar keeps its shown/collapsed state.
                    stack(for: tab)
                        .id(model.externalNavigationID)
                }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .defaultAdaptableTabBarPlacement(defaultTabPlacement)
        .tabViewSidebarHeader { siteHeader }
        .sheet(item: $coordinator.presentedSheet) { sheet in
            switch sheet {
            case .batteryHold:
                BatteryHoldSheet(coordinator: coordinator, site: site)
            case .confirmCountry:
                estimateSetupSheet(.confirmCountry)
            case .chooseUtility:
                estimateSetupSheet(.pickUtility)
            case .choosePlan:
                estimateSetupSheet(.pickPlan)
            case .rateHistory:
                rateHistorySheet
            }
        }
        .sheet(isPresented: $model.isSitePickerPresented) {
            SitePickerView(sites: model.sites, selectedSiteID: site.id) { selected in
                model.selectSite(selected)
                model.isSitePickerPresented = false
            }
            .presentationDetents(model.sites.count > 4 ? [.medium, .large] : [.medium])
        }
        .sheet(item: billingDayPromptBinding) { prompted in
            BillingDayPromptSheet(
                site: prompted,
                save: { try await model.saveBillingDay($0, siteID: prompted.id) },
                onNotNow: model.dismissBillingDayPrompt
            )
            .presentationDetents([.large])
        }
        .sheet(isPresented: $model.isDemoSheetPresented) {
            DemoModeSheet(
                onSignIn: { demoMode?.exitAndSignIn() },
                onKeepExploring: { model.isDemoSheetPresented = false }
            )
        }
    }

    @ViewBuilder private func stack(for tab: AppTab) -> some View {
        if tab == .settings {
            NavigationStack(path: $model.settingsPath) { content(for: tab) }
        } else {
            NavigationStack { content(for: tab) }
        }
    }

    @ViewBuilder private func content(for tab: AppTab) -> some View {
        switch tab {
        case .home:
            DashboardView(coordinator: coordinator, site: site, onOpenTab: model.selectTab,
                          onRefresh: { await model.refreshDashboard() })
        case .bill:
            BillView(coordinator: coordinator, site: site, isSelected: model.selectedTab == .bill,
                     onOpenSmartShift: { model.selectTab(.smartShift) })
        case .smartShift:
            LoadTimingView(coordinator: coordinator, site: site, isSelected: model.selectedTab == .smartShift,
                           profileStore: model.makeLoadProfileStore())
        case .settings:
            SettingsView(site: site, coordinator: coordinator,
                         onChooseSite: model.openSitePicker,
                         onSignOut: { Task { await model.signOut() } },
                         onExitDemo: model.isDemo ? { demoMode?.exit() } : nil,
                         siteHistory: coordinator.solarLayoutStatus == .disabled ? nil : model.siteHistoryStatus,
                         siteHistoryDebug: siteHistoryDebug,
                         onLocationSaved: model.homeLocationSaved,
                         onSaveBillingDay: { try await model.saveBillingDay($0, siteID: site.id) },
                         onRevealSeen: model.solarSystemRevealSeen,
                         deepHistory: coordinator.solarLayoutStatus == .disabled
                             ? nil : model.historyOnboarding?.deepHistory,
                         solarHealth: coordinator.solarLayoutStatus == .disabled
                             ? nil : (model.historyOnboarding?.solarHealth ?? model.demoSolarHealth),
                         trmnl: TrmnlSettingsAccess(api: model.api))
        }
    }

    private func open(_ accessory: RateEstimatesAccessoryKind) {
        switch accessory {
        case .setup(let prompt): coordinator.presentedSheet = .rateEstimates(prompt)
        case .historyOffer: coordinator.presentedSheet = .rateHistory
        }
    }

    private func dismiss(_ accessory: RateEstimatesAccessoryKind) {
        switch accessory {
        case .setup: accessoryDismissals.dismiss(siteID: site.id)
        case .historyOffer: historyOfferDismissals.dismiss(siteID: site.id)
        }
    }

    private var rateHistorySheet: some View {
        let sync = coordinator.savingsTimeline?.teslaSync
        return RatePlanHistorySheet(
            teslaPlanName: sync?.latestTariffName,
            currency: coordinator.savingsTimeline?.currency ?? "USD",
            // The offer that opens this sheet comes from the loaded timeline, so its reference periods are there.
            referencePeriods: coordinator.savingsTimeline?.referencePeriods ?? [],
            load: { try await coordinator.loadRateHistory() },
            save: { _ = try await coordinator.saveRateHistory($0) }
        )
    }

    private func estimateSetupSheet(_ prompt: RateEstimatesPrompt) -> RateEstimatesSetupSheet {
        RateEstimatesSetupSheet(
            prompt: prompt,
            utilityName: coordinator.savingsTimeline?.estimates?.utilityName,
            actions: .live(coordinator)
        )
    }

    /// A swipe down is the same as Not now: the sheet clears the prompt for this run.
    private var billingDayPromptBinding: Binding<MobileSite?> {
        Binding(
            get: { model.billingDayPromptSite },
            set: { if $0 == nil { model.dismissBillingDayPrompt() } }
        )
    }

    private var siteHistoryDebug: SiteHistoryDebugActions? {
        #if DEBUG
            model.siteHistoryDebugActions
        #else
            nil
        #endif
    }

    /// A convenience switcher only: it is hidden when the sidebar is collapsed
    /// and on iPhone, so Settings stays the canonical place to change site.
    @ViewBuilder private var siteHeader: some View {
        if model.sites.count > 1 {
            Menu {
                ForEach(model.sites) { candidate in
                    Button { model.selectSite(candidate) } label: {
                        if candidate.id == site.id {
                            Label(candidate.name, systemImage: "checkmark")
                        } else {
                            Text(candidate.name)
                        }
                    }
                }
            } label: {
                siteHeaderLabel(showsChevron: true)
            }
            .accessibilityHint("Switch site")
        } else {
            siteHeaderLabel(showsChevron: false)
        }
    }

    private func siteHeaderLabel(showsChevron: Bool) -> some View {
        HStack(spacing: 8) {
            Text(site.name)
                .font(.headline)
                .foregroundStyle(.primary)
                .lineLimit(1)
            if showsChevron {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }
}

#if DEBUG
    /// The signed-in app for an account with several sites. Switching works: the
    /// Settings site row and ⌘K open the picker, and on iPad the sidebar header is
    /// a site menu.
    @MainActor
    private struct MultiSitePreview: View {
        @StateObject private var model: PWUsageAppModel
        private let opensPicker: Bool

        init(tab: AppTab = .home, opensPicker: Bool = false) {
            _model = StateObject(wrappedValue: .preview(tab: tab))
            self.opensPicker = opensPicker
        }

        var body: some View {
            if let coordinator = model.coordinator,
               let site = model.sites.first(where: { $0.id == model.selectedSiteID }) {
                AppTabView(model: model, coordinator: coordinator, site: site)
                    .task {
                        coordinator.scenePhaseChanged(isActive: true)
                        coordinator.authenticationRestored()
                        if opensPicker { model.openSitePicker() }
                    }
            }
        }
    }

    #Preview("Multiple sites · iPhone Settings") {
        MultiSitePreview(tab: .settings)
    }

    #Preview("Multiple sites · iPhone picker") {
        MultiSitePreview(tab: .settings, opensPicker: true)
    }

    #Preview("Multiple sites · iPad sidebar", traits: .landscapeLeft, .fixedLayout(width: 1180, height: 820)) {
        // A fixed layout alone can report a compact size class, so pin it to regular.
        MultiSitePreview()
            .environment(\.horizontalSizeClass, .regular)
    }
#endif
