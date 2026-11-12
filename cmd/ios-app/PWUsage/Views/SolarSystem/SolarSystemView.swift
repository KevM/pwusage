import SwiftUI

/// Solar System in Settings: finding the site's solar system as a picture, which then becomes the
/// System card with what was found, and the home location it was found from. Merges the former
/// Site History and Solar Forecast.
struct SolarSystemView: View {
    @ObservedObject var coordinator: DashboardCoordinator
    /// Nil for a site without the history beta; the screen then shows only what is stored.
    let status: SiteHistoryStatus?
    var debugActions: SiteHistoryDebugActions?
    /// Opened from the banner's location prompt: go straight to the location step.
    var startsAtLocation = false
    /// After a new home location is saved, so a search that stopped for want of one resumes.
    var onLocationSaved: () -> Void = {}
    /// The reveal owed for a system found while nobody was watching has been seen.
    var onRevealSeen: () -> Void = {}

    private static let visualID = "solar-system-visual"

    @Environment(\.reconnectTesla) private var reconnectTesla
    @State private var isConfirmingLocation = false
    @State private var outcome: SolarLocationShareResult?
    @State private var didStartAtLocation = false
    @State private var record: SolarLayoutRecord?
    @State private var isEditingLayout = false

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
        .sheet(isPresented: $isConfirmingLocation) {
            HomeLocationSheet(coordinator: coordinator) { result in
                outcome = result
                onLocationSaved()
            }
        }
        .sheet(isPresented: $isEditingLayout) {
            ManualLayoutEditor(initial: record?.manualLayout, detected: record?.result) { layout in
                guard await coordinator.saveManualLayout(layout) else { return false }
                record = await coordinator.manualLayoutRecord()
                return true
            }
        }
        .task { record = await coordinator.manualLayoutRecord() }
        .onAppear {
            guard startsAtLocation, !didStartAtLocation else { return }
            didStartAtLocation = true
            isConfirmingLocation = true
        }
        .onDisappear { coordinator.solarSurfaceDisappeared(.settings) }
        .task { await coordinator.solarSettingsAppeared() }
    }

    private func content(_ presentation: SiteHistoryPresentation) -> some View {
        // The status's own layout honors the Debug "Ignore Existing Layout" setting.
        let layout = status != nil ? status?.layout : stored?.layout
        return ScrollViewReader { proxy in
            list(presentation, layout: layout)
                // The screen keeps its place between visits, and an owed reveal plays only once.
                .onAppear { scrollToRevealIfOwed(proxy) }
                .onChange(of: status?.isRevealOwed) { withAnimation { scrollToRevealIfOwed(proxy) } }
        }
    }

    private func scrollToRevealIfOwed(_ proxy: ScrollViewProxy) {
        guard status?.isRevealOwed == true else { return }
        proxy.scrollTo(Self.visualID, anchor: .top)
    }

    private func list(_ presentation: SiteHistoryPresentation, layout: SolarLayout?) -> some View {
        List {
            if status != nil || layout != nil {
                Section {
                    SolarSystemVisual(
                        input: SolarSystemSceneInput(
                            status: status, layout: layout, isWaiting: presentation.phase == .waiting),
                        summary: status == nil && layout != nil
                            ? layout.map(SiteHistoryPresentation.describe) ?? "" : presentation.accessibilitySummary,
                        onRevealSeen: onRevealSeen)
                        .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 12, trailing: 0))
                        .id(Self.visualID)
                    if status != nil, !presentation.statusLine.isEmpty { statusRow(presentation) }
                    if let layout {
                        SolarSystemDetailsRows(
                            layout: layout, manual: record?.manualLayout,
                            isImproving: presentation.phase == .foundImproving)
                    }
                } header: {
                    systemHeader(hasLayout: layout != nil)
                }
            } else if coordinator.solarLayoutStatus == nil {
                Section { Text("Checking solar forecast availability…") }
            } else if stored == nil {
                Section { Text("Solar forecasting isn’t available for this site yet.") }
            }
            if stored != nil || status != nil { locationSection }
            #if DEBUG
                if let debugActions { SiteHistoryDebugSection(actions: debugActions) }
            #endif
        }
    }

    /// The card's title, with Edit at the top right once a system is found, as Smart Shift's cards do.
    private func systemHeader(hasLayout: Bool) -> some View {
        HStack {
            Text(hasLayout ? "System" : "Find Your Solar System")
            Spacer()
            if hasLayout {
                Button("Edit") { isEditingLayout = true }
                    .textCase(nil)
                    .font(.subheadline.weight(.medium))
            }
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
                    .emphasisProminentButton()
            }
        case .addLocation:
            Button("Add Location") { isConfirmingLocation = true }
                .emphasisProminentButton()
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

    /// The coordinator's record when it has one, else the status's (read from the same record).
    private var locationState: SiteHistoryStatus.LocationState {
        if let source = location?.source { return source.isExact ? .exact : .estimated }
        return status?.location ?? .none
    }

    private var locationValue: String {
        switch locationState {
        case .none: "Not set"
        case .estimated: "Estimated"
        case .exact: "Exact"
        }
    }

    /// A location action is always available, so a declined or failed attempt can be retried.
    private var locationButtonTitle: String {
        switch locationState {
        case .none: "Add Location"
        case .estimated: "Use My Exact Home Location"
        case .exact: "Update Home Location"
        }
    }
}
