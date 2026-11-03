import SwiftUI

/// The Settings tab: site, Rate Plans, Solar System, About, and Sign Out
/// (Exit Demo in the demo).
/// It has no stack of its own; the tab's `NavigationStack` hosts the pushes.
struct SettingsView: View {
    let site: MobileSite
    @ObservedObject var coordinator: DashboardCoordinator
    let onChooseSite: () -> Void
    let onSignOut: () -> Void
    /// Set in the demo, where it replaces Sign Out. Nothing is lost by leaving,
    /// so it asks no confirmation.
    var onExitDemo: (() -> Void)?
    /// The history beta's status for the site, outside the demo; nil otherwise.
    var siteHistory: SiteHistoryStatus?
    var siteHistoryDebug: SiteHistoryDebugActions?
    var onLocationSaved: () -> Void = {}

    @State private var isConfirmingSignOut = false

    var body: some View {
        List {
            Section("Site") {
                Button(action: onChooseSite) {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(site.name).font(.body.weight(.semibold)).foregroundStyle(.primary)
                            Text(site.utility).font(.footnote).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .accessibilityHidden(true)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Choose a different site")
            }
            Section {
                NavigationLink(value: SettingsDestination.ratePlans) {
                    Label("Rate Plans", systemImage: "list.bullet.rectangle")
                }
                NavigationLink(value: SettingsDestination.solarSystem()) {
                    LabeledContent {
                        if siteHistory != nil {
                            Text(SiteHistoryPresentation(status: siteHistory, now: .now).rowValue)
                        }
                    } label: {
                        Label("Solar System", systemImage: "sun.max")
                    }
                }
                NavigationLink(value: SettingsDestination.about) {
                    Label("About", systemImage: "info.circle")
                }
            }
            if let onExitDemo {
                Section {
                    Button("Exit Demo", action: onExitDemo)
                }
            } else {
                signOutSection
            }
        }
        .navigationTitle("Settings")
        .inlineNavigationTitle()
        .navigationDestination(for: SettingsDestination.self) { destination in
            switch destination {
            case .ratePlans:
                TariffSheet(site: site, load: { try await coordinator.fetchTariffs() })
                    .id(site.id)
            case .solarSystem(let startsAtLocation):
                SolarSystemView(
                    coordinator: coordinator, status: siteHistory, debugActions: siteHistoryDebug,
                    startsAtLocation: startsAtLocation, onLocationSaved: onLocationSaved)
            case .about:
                AboutSheet()
            }
        }
    }

    private var signOutSection: some View {
        Section {
            Button("Sign Out", role: .destructive) { isConfirmingSignOut = true }
                .confirmationDialog("Sign out of pwusage?", isPresented: $isConfirmingSignOut,
                                    titleVisibility: .visible) {
                    Button("Sign Out", role: .destructive, action: onSignOut)
                    Button("Cancel", role: .cancel) {}
                }
        }
    }
}

enum SettingsDestination: Hashable {
    case ratePlans
    /// `startsAtLocation` opens straight into the home location step.
    case solarSystem(startsAtLocation: Bool = false)
    case about
}

#if DEBUG
    #Preview("Settings") {
        NavigationStack {
            SettingsView(
                site: MobileSite(id: "preview-home", name: "Cedar House", utility: "Demo utility"),
                coordinator: DashboardCoordinator(siteID: "preview-home", api: DashboardPreviewAPI(mode: .normal), timerInterval: nil),
                onChooseSite: {},
                onSignOut: {}
            )
        }
    }
#endif
