import SwiftUI

/// Solar System in Settings: finding the site's solar system as a picture, then what was found
/// and the home location it was found from. Merges the former Site History and Solar Forecast.
struct SolarSystemView: View {
    @ObservedObject var coordinator: DashboardCoordinator
    /// Nil for a site without the history beta; the screen then shows only what is stored.
    let status: SiteHistoryStatus?
    var debugActions: SiteHistoryDebugActions?
    /// Opened from the banner's location prompt: go straight to the location step.
    var startsAtLocation = false

    @Environment(\.reconnectTesla) private var reconnectTesla
    @State private var isConfirmingLocation = false
    @State private var outcome: SolarLocationShareResult?
    @State private var didStartAtLocation = false

    private var stored: (location: SolarHomeLocation?, layout: SolarLayout?)? {
        guard case .enabled(let location, let layout, _)? = coordinator.solarLayoutStatus else { return nil }
        return (location, layout)
    }

    var body: some View {
        // Waiting text names a time, so re-read the clock now and then.
        TimelineView(.periodic(from: .now, by: 60)) { context in
            content(SiteHistoryPresentation(status: status, now: context.date))
        }
        .navigationTitle("Solar System")
        .inlineNavigationTitle()
        .solarLocationConfirmation(isPresented: $isConfirmingLocation, coordinator: coordinator) { outcome = $0 }
        .onAppear {
            guard startsAtLocation, !didStartAtLocation else { return }
            didStartAtLocation = true
            isConfirmingLocation = true
        }
        .onDisappear { coordinator.solarSurfaceDisappeared(.settings) }
        .task { await coordinator.solarSettingsAppeared() }
    }

    private func content(_ presentation: SiteHistoryPresentation) -> some View {
        let layout = status?.layout ?? stored?.layout
        return List {
            if status != nil || layout != nil {
                Section {
                    SolarSystemVisual(
                        input: SolarSystemSceneInput(
                            status: status, layout: layout, isWaiting: presentation.phase == .waiting),
                        summary: status == nil && layout != nil
                            ? layout.map(SiteHistoryPresentation.describe) ?? "" : presentation.accessibilitySummary)
                        .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 12, trailing: 0))
                    if status != nil { statusRow(presentation) }
                }
            } else if coordinator.solarLayoutStatus == nil {
                Section { Text("Checking solar forecast availability…") }
            } else if stored == nil {
                Section { Text("Solar forecasting isn’t available for this site yet.") }
            }
            if let layout {
                SolarSystemDetailsCard(layout: layout, isImproving: presentation.phase == .foundImproving)
            }
            if stored != nil || status != nil { locationSection }
            #if DEBUG
                if let debugActions { SiteHistoryDebugSection(actions: debugActions) }
            #endif
        }
    }

    private func statusRow(_ presentation: SiteHistoryPresentation) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(presentation.statusLine)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            if let action = presentation.action { actionButton(action) }
        }
    }

    @ViewBuilder private func actionButton(_ action: SiteHistoryPresentation.Action) -> some View {
        switch action {
        case .reconnectTesla:
            if let reconnectTesla {
                Button("Reconnect Tesla") { Task { await reconnectTesla.perform() } }
                    .buttonStyle(.borderedProminent)
            }
        case .addLocation:
            Button("Add Location") { isConfirmingLocation = true }
                .buttonStyle(.borderedProminent)
        case .useExactLocation:
            Button("Use My Exact Home Location") { isConfirmingLocation = true }
        }
    }

    // MARK: - Home location

    private var location: SolarHomeLocation? { stored?.location }

    private var locationSection: some View {
        Section {
            LabeledContent("Home location", value: locationValue)
            if let outcome { SolarLocationOutcomeView(outcome: outcome) }
            Button(locationButtonTitle) { isConfirmingLocation = true }
        } header: {
            Text("Home Location")
        } footer: {
            Text("Used to work out which way your panels face. Stored rounded to about 1 km, on this device "
                + "and in your iCloud.")
        }
    }

    private var locationValue: String {
        switch location?.source {
        case nil: "Not set"
        case .estimated?: "Estimated"
        default: "Exact"
        }
    }

    /// A location action is always available, so a declined or failed attempt can be retried.
    private var locationButtonTitle: String {
        switch location?.source {
        case nil: "Add Location"
        case .estimated?: "Use My Exact Home Location"
        default: "Update Home Location"
        }
    }
}
