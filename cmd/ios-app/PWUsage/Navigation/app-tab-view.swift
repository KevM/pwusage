import SwiftUI

/// The signed-in root: one tab per `AppTab`, a sidebar on iPad and Mac and a
/// tab bar on iPhone. Sheets that must show over any tab live here, not on a
/// tab's content, so an external launch can clear them from the model.
struct AppTabView: View {
    @ObservedObject var model: PWUsageAppModel
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite

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
            } else {
                tabs
            }
        }
    }

    private var tabs: some View {
        TabView(selection: Binding(get: { model.selectedTab }, set: { model.selectTab($0) })) {
            ForEach(AppTab.allCases) { tab in
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    // An external launch (widget or Battery Saver control) rebuilds
                    // each tab's stack to drop old paths and modals. The id goes here, never on the
                    // TabView, so the sidebar keeps its shown/collapsed state.
                    NavigationStack { content(for: tab) }
                        .id(model.externalNavigationID)
                }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .defaultAdaptableTabBarPlacement(.sidebar)
        .tabViewSidebarHeader { siteHeader }
        .sheet(item: $coordinator.presentedSheet) { sheet in
            switch sheet {
            case .batteryHold:
                BatteryHoldSheet(coordinator: coordinator, site: site)
            }
        }
        .sheet(isPresented: $model.isSitePickerPresented) {
            SitePickerView(sites: model.sites, selectedSiteID: site.id) { selected in
                model.selectSite(selected)
                model.isSitePickerPresented = false
            }
            .presentationDetents(model.sites.count > 4 ? [.medium, .large] : [.medium])
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
            LoadTimingView(coordinator: coordinator, site: site, isSelected: model.selectedTab == .smartShift)
        case .settings:
            SettingsView(site: site, coordinator: coordinator,
                         onChooseSite: model.openSitePicker,
                         onSignOut: { Task { await model.signOut() } })
        }
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
