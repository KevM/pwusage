import SwiftUI

/// The Settings tab: which site you're on, its Rate Plans, About, and Sign Out.
/// It has no stack of its own; the tab's `NavigationStack` hosts the pushes.
struct SettingsView: View {
    let site: MobileSite
    @ObservedObject var coordinator: DashboardCoordinator
    let onChooseSite: () -> Void
    let onSignOut: () -> Void

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
                NavigationLink(value: SettingsDestination.about) {
                    Label("About", systemImage: "info.circle")
                }
            }
            Section {
                Button("Sign Out", role: .destructive) { isConfirmingSignOut = true }
                    .confirmationDialog("Sign out of pwusage?", isPresented: $isConfirmingSignOut, titleVisibility: .visible) {
                        Button("Sign Out", role: .destructive, action: onSignOut)
                        Button("Cancel", role: .cancel) {}
                    }
            }
        }
        .navigationTitle("Settings")
        .inlineNavigationTitle()
        .navigationDestination(for: SettingsDestination.self) { destination in
            switch destination {
            case .ratePlans:
                TariffSheet(site: site, load: { try await coordinator.fetchTariffs() })
                    .id(site.id)
            case .about:
                AboutSheet()
            }
        }
    }
}

private enum SettingsDestination: Hashable {
    case ratePlans
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
