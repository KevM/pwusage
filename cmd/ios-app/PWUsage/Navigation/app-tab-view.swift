import SwiftUI

/// The signed-in root: one tab per `AppTab`, a sidebar on iPad and Mac and a
/// tab bar on iPhone. Sheets that must show over any tab live here, not on a
/// tab's content, so an external launch can clear them from the model.
struct AppTabView: View {
    @ObservedObject var model: PWUsageAppModel
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite

    var body: some View {
        TabView(selection: Binding(get: { model.selectedTab }, set: { model.selectTab($0) })) {
            ForEach(AppTab.allCases) { tab in
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    // An external Battery Saver launch rebuilds each tab's stack to
                    // drop old paths and modals. The id goes here, never on the
                    // TabView, so the sidebar keeps its shown/collapsed state.
                    NavigationStack { content(for: tab) }
                        .id(model.batteryHoldNavigationID)
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
    }

    @ViewBuilder private func content(for tab: AppTab) -> some View {
        switch tab {
        case .home:
            DashboardView(coordinator: coordinator, site: site, onOpenTab: model.selectTab,
                          onRefresh: { await model.refreshDashboard() })
        case .bill:
            BillView(coordinator: coordinator, site: site)
        case .smartShift:
            LoadTimingView(coordinator: coordinator, site: site)
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
            Image(systemName: "house.fill")
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
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
