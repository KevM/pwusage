import SwiftUI

/// Solar System in Settings: finding the site's solar system as a picture, which then becomes the
/// System card with what was found, and the home location it was found from. Merges the former
/// Site History and Solar Forecast.
struct SolarSystemView: View {
    @ObservedObject var coordinator: DashboardCoordinator
    /// Nil when the site has no history available; the screen then shows only what is stored.
    let site: MobileSite
    let status: SiteHistoryStatus?
    var debugActions: SiteHistoryDebugActions?
    /// Opened from the banner's location prompt: go straight to the location step.
    var startsAtLocation = false
    /// After a new home location is saved, so a search that stopped for want of one resumes.
    var onLocationSaved: () -> Void = {}
    /// The reveal owed for a system found while nobody was watching has been seen.
    var onRevealSeen: () -> Void = {}
    /// Loads history older than the layout search reads, on request; nil hides the row.
    var deepHistory: SiteDeepHistoryModel?
    /// On-device health classification and stats; nil hides the health sections.
    var solarHealth: SolarHealthModel?

    private static let visualID = "solar-system-visual"

    @Environment(\.reconnectTesla) private var reconnectTesla
    @State private var isConfirmingLocation = false
    @State private var outcome: SolarLocationShareResult?
    @State private var didStartAtLocation = false
    @State private var record: SolarLayoutRecord?
    @State private var isEditingLayout = false
    @State private var isShowingFindings = false
    @State private var savingsSheet: SolarSavingsSheet?

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
                solarHealth?.reload()
                return true
            }
        }
        .sheet(isPresented: $isShowingFindings) {
            if let report = solarHealth?.report {
                SolarHealthFindingsSheet(
                    report: report,
                    context: inspectionContext(layout: activeLayout))
            }
        }
        .task { record = await coordinator.manualLayoutRecord() }
        .onAppear {
            solarHealth?.markFindingsSeen()
            guard startsAtLocation, !didStartAtLocation else { return }
            didStartAtLocation = true
            isConfirmingLocation = true
        }
        .task { await solarHealth?.reloadIfNeeded() }
        .onChange(of: solarHealth?.hasUnreadFinding) { solarHealth?.markFindingsSeen() }
        .onDisappear { coordinator.solarSurfaceDisappeared(.settings) }
        .task { await coordinator.solarSettingsAppeared() }
        // Older days arrive in slices; each one changes what lifetime and payback count.
        .task(id: deepHistory?.status.daysLoaded) { await coordinator.refreshSavings() }
        .sheet(item: $savingsSheet) { sheet in
            switch sheet {
            case let .fixedRatePlan(existing, suggestion):
                FixedRatePlanForm(
                    existing: existing,
                    defaultStartDate: coordinator.savingsTimeline?.periods.map(\.effectiveFrom).min(),
                    suggestedStartDate: suggestion,
                    estimateCoverageNote: coordinator.fixedPlanEstimateCoverageNote(editing: existing),
                    timeZone: siteTimeZone,
                    currency: coordinator.bill.response?.currentBill.currency ?? "USD",
                    actions: .live(coordinator, onDismiss: { savingsSheet = nil })
                )
            case .systemCosts:
                SystemCostsForm(
                    costs: coordinator.savingsTimeline?.systemCosts,
                    batteryStartDay: batteryStartDay,
                    hasPowerwall: hasPowerwall,
                    timeZone: siteTimeZone,
                    currency: currency,
                    onSave: { request in await coordinator.saveSystemCosts(request) }
                )
            case .ratePlans:
                RatePlansSheet(site: site, actions: .live(coordinator))
            case .rateEstimates(let prompt):
                RateEstimatesSetupSheet(
                    prompt: prompt,
                    utilityName: coordinator.savingsTimeline?.estimates?.utilityName,
                    actions: .live(coordinator)
                )
            }
        }
    }

    /// The savings timeline's zone first, so the payback section matches the savings math; then the bill's zone.
    private var siteTimeZone: TimeZone {
        let identifier = coordinator.savingsTimeline?.timezone ?? coordinator.bill.response?.site.timezone ?? ""
        return TimeZone(identifier: identifier) ?? .current
    }

    private var currency: String {
        coordinator.bill.response?.currentBill.currency ?? "USD"
    }

    /// The Powerwall's first day of battery flow, from the savings report.
    private var batteryStartDay: String? {
        guard case .ready(let report) = coordinator.savings else { return nil }
        return report.batteryStartDay
    }

    private var hasPowerwall: Bool {
        coordinator.savingsTimeline?.battery != nil
            || batteryStartDay != nil
            || coordinator.savingsTimeline?.systemCosts?.powerwall != nil
    }

    private var activeLayout: SolarLayout? {
        status != nil ? status?.layout : stored?.layout
    }

    private func content(_ presentation: SiteHistoryPresentation) -> some View {
        // The status's own layout honors the Debug "Ignore Existing Layout" setting.
        let layout = activeLayout
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
        let overlay = houseHealthOverlay
        return List {
            if status != nil || layout != nil {
                Section {
                    SolarSystemVisual(
                        input: SolarSystemSceneInput(
                            status: status, layout: layout, isWaiting: presentation.phase == .waiting,
                            manualLayout: record?.manualLayout, healthOverlay: overlay, now: .now),
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
            savingsSection
            paybackSection
            panelHealthSection
            if stored != nil || status != nil { locationSection }
            #if DEBUG
                if let debugActions { SiteHistoryDebugSection(actions: debugActions) }
            #endif
        }
    }

    private var savingsSection: some View {
        SolarSystemSavingsSection(
            state: coordinator.savings,
            currency: currency,
            hasReferencePlan: coordinator.activeReferencePeriod != nil,
            onAddFixedRatePlan: { savingsSheet = .fixedRatePlan(nil, suggestion: nil) },
            onEditFixedRatePlan: { savingsSheet = .fixedRatePlan(coordinator.activeReferencePeriod, suggestion: nil) },
            onCaveatAction: routeCaveat,
            estimatePrompt: RateEstimatesPresentation.prompt(coordinator.savingsTimeline?.estimates),
            estimateUtilityName: coordinator.savingsTimeline?.estimates?.utilityName,
            onChooseEstimateSetup: { savingsSheet = .rateEstimates($0) },
            fixedPlanNote: RateEstimatesPresentation.fixedPlanMayBeOutdatedNote(
                coordinator.savingsTimeline?.estimates,
                referencePeriods: coordinator.savingsTimeline?.referencePeriods ?? [],
                periods: coordinator.savingsTimeline?.periods ?? []
            ),
            historyCoverage: historyCoverage,
            timeZone: siteTimeZone,
            onHistoryAction: runHistoryAction
        )
    }

    private var historyCoverage: SavingsHistoryCoverage {
        guard case .ready(let report) = coordinator.savings else { return .complete }
        return SavingsHistoryCoverage(firstStoredDay: report.firstStoredDay, olderHistory: deepHistory?.status)
    }

    private func runHistoryAction(_ action: SiteDeepHistoryPresentation.Action) {
        switch action {
        case .load, .continueLoading: deepHistory?.start()
        case .stop: Task { await deepHistory?.stop() }
        case .reconnectTesla: Task { await reconnectTesla?.perform() }
        }
    }

    private func routeCaveat(_ action: SavingsCaveat.Action) {
        switch action {
        case .editFixedRatePlan(let suggestion):
            savingsSheet = .fixedRatePlan(coordinator.earliestReferencePeriod, suggestion: suggestion)
        case .fixRatePlans: savingsSheet = .ratePlans
        }
    }

    private var paybackSection: some View {
        SolarSystemPaybackSection(
            state: coordinator.savings,
            costs: coordinator.savingsTimeline?.systemCosts,
            change: solarHealth?.report?.changeOverTime,
            currency: currency,
            timeZone: siteTimeZone,
            onEditCosts: { savingsSheet = .systemCosts },
            onCaveatAction: routeCaveat,
            historyCoverage: historyCoverage,
            onHistoryAction: runHistoryAction
        )
    }

    @ViewBuilder
    private var panelHealthSection: some View {
        if let report = solarHealth?.report {
            SolarHealthSection(
                report: report,
                isLoading: solarHealth?.isRunning ?? false,
                onShowFindings: { isShowingFindings = true },
                onEditLayout: { isEditingLayout = true },
                deepHistory: deepHistory,
                healthResult: solarHealth?.result)
        } else if solarHealth?.isRunning == true {
            Section("Panel Health") {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Checking panel health…")
                        .foregroundStyle(.secondary)
                }
            }
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

    private func inspectionContext(layout: SolarLayout?) -> SolarHouseInspectionContext {
        SolarHouseInspectionContext(
            layout: layout,
            manualLayout: record?.manualLayout,
            result: solarHealth?.result,
            latitude: location?.latitude ?? status?.latitude ?? 40.0,
            longitude: location?.longitude ?? 0.0)
    }

    private var houseHealthOverlay: SolarHouseHealthOverlay? {
        guard solarHealth?.report != nil || solarHealth?.result != nil else { return nil }
        let latitude = location?.latitude ?? status?.latitude ?? 40.0
        return SolarHouseHealthOverlay(
            report: solarHealth?.report,
            result: solarHealth?.result,
            state: SolarHouseHealthState(latitude: latitude),
            latitude: latitude,
            longitude: location?.longitude ?? 0.0)
    }

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

private enum SolarSavingsSheet: Identifiable {
    case fixedRatePlan(TariffPeriodDTO?, suggestion: String?)
    case ratePlans
    case rateEstimates(RateEstimatesPrompt)
    case systemCosts

    var id: String {
        switch self {
        case let .fixedRatePlan(period, _): "fixedRatePlan-\(period?.periodId ?? 0)"
        case .ratePlans: "ratePlans"
        case .systemCosts: "systemCosts"
        case .rateEstimates(let prompt): "rateEstimates-\(prompt)"
        }
    }
}
