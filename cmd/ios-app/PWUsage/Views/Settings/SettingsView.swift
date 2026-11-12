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
    /// Saves the site's billing day; the row is hidden in the demo, which cannot save.
    var onSaveBillingDay: (Int) async throws -> Void = { _ in }
    var onRevealSeen: () -> Void = {}
    /// Where the Trmnl screen reads from; nil hides the row, as in the demo, which has no devices.
    var trmnl: TrmnlSettingsAccess?

    @State private var isConfirmingSignOut = false
    /// Loaded when Settings opens, for the row's device count, and handed to the Trmnl screen.
    @State private var trmnlModel: TrmnlSettingsModel?
    /// Whether the owner edited the solar system; read again on return from the Solar System screen.
    @State private var hasManualLayout = false

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
                if onExitDemo == nil {
                    NavigationLink(value: SettingsDestination.billingDay) {
                        LabeledContent {
                            Text(BillingDayPresentation.rowValue(day: site.billingDay))
                        } label: {
                            Label(BillingDayPresentation.settingTitle, systemImage: "calendar")
                        }
                    }
                    .accessibilityIdentifier("settings.billing-day")
                }
                NavigationLink(value: SettingsDestination.ratePlans) {
                    Label("Rate Plans", systemImage: "list.bullet.rectangle")
                }
                NavigationLink(value: SettingsDestination.solarSystem()) {
                    LabeledContent {
                        if siteHistory != nil || hasManualLayout {
                            Text(SiteHistoryPresentation(
                                status: siteHistory, now: .now, hasManualLayout: hasManualLayout).rowValue)
                        }
                    } label: {
                        Label("Solar System", systemImage: "sun.max")
                    }
                }
                .accessibilityIdentifier("settings.solar-system")
                if trmnl != nil {
                    NavigationLink(value: SettingsDestination.trmnl) {
                        LabeledContent {
                            if let count = trmnlModel?.connectedDeviceCount {
                                Text(TrmnlPresentation.deviceCountLabel(count))
                            }
                        } label: {
                            Label(TrmnlPresentation.title, systemImage: "rectangle.on.rectangle")
                        }
                    }
                    .accessibilityIdentifier("settings.trmnl")
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
        .task(id: site.id) { await loadTrmnlDevices() }
        .onAppear { Task { hasManualLayout = await coordinator.manualLayoutRecord()?.manualLayout != nil } }
        .navigationDestination(for: SettingsDestination.self) { destination in
            switch destination {
            case .ratePlans:
                TariffSheet(
                    site: site,
                    actions: TariffTimelineActions(
                        load: { try await coordinator.fetchTariffTimeline() },
                        refreshFromTesla: { try await coordinator.refreshTariffsFromTesla() },
                        createPeriod: { body in try await coordinator.createTariffPeriod(body) },
                        updatePeriod: { periodID, body in
                            try await coordinator.updateTariffPeriod(periodID: periodID, body: body)
                        },
                        deletePeriod: { periodID in try await coordinator.deleteTariffPeriod(periodID: periodID) },
                        retryReattribution: { try await coordinator.retryTariffReattribution() }
                    )
                )
                .id(site.id)
            case .solarSystem(let startsAtLocation):
                SolarSystemView(
                    coordinator: coordinator, status: siteHistory, debugActions: siteHistoryDebug,
                    startsAtLocation: startsAtLocation, onLocationSaved: onLocationSaved,
                    onRevealSeen: onRevealSeen)
            case .billingDay:
                BillingDaySettingsView(site: site, save: onSaveBillingDay)
                    .id(site.id)
            case .trmnl:
                if trmnl != nil, let trmnlModel {
                    TrmnlSettingsView(model: trmnlModel)
                        .id(site.id)
                }
            case .about:
                AboutSheet()
            }
        }
    }

    /// Counts the site's Trmnl devices for the row. Only devices: the previews wait for the Trmnl screen.
    private func loadTrmnlDevices() async {
        guard let trmnl else { return }
        let model = TrmnlSettingsModel(siteID: site.id, api: trmnl.api)
        trmnlModel = model
        await model.reloadDevices()
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
    case billingDay
    /// `startsAtLocation` opens straight into the home location step.
    case solarSystem(startsAtLocation: Bool = false)
    case trmnl
    case about
}

#if DEBUG
    #Preview("Settings") {
        NavigationStack {
            SettingsView(
                site: MobileSite(id: "preview-home", name: "Cedar House", utility: "Demo utility"),
                coordinator: DashboardCoordinator(siteID: "preview-home",
                                                  api: DashboardPreviewAPI(mode: .normal),
                                                  timerInterval: nil),
                onChooseSite: {},
                onSignOut: {}
            )
        }
    }
#endif
