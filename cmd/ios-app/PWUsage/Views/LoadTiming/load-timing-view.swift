import SwiftUI

enum LoadTimingPresentation {
    struct RecommendationMessage: Equatable {
        let title: String
        let detail: String
    }

    static let noResponseRecommendationMessage = RecommendationMessage(
        title: "Recommendation unavailable",
        detail: "The latest refresh failed and no saved bill data is available, so no recommendation or job estimates can be shown."
    )
    static func profileChipTitle(_ profile: LoadProfile) -> String {
        if profile.kind == .car, let settings = profile.carSettings,
           let estimate = LoadTimingEstimator.carChargeEstimate(settings: settings) {
            return "\(profile.name) · \(estimate.batteryKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kWh battery"
        }
        return "\(profile.name) · \(profile.energyKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kWh"
    }

    static func profileChipAccessibilityLabel(_ profile: LoadProfile) -> String {
        if profile.kind == .car, let settings = profile.carSettings,
           let estimate = LoadTimingEstimator.carChargeEstimate(settings: settings) {
            return "\(profile.name), \(estimate.batteryKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kilowatt-hours to the battery, about \(estimate.wallKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kilowatt-hours from the wall, Level \(settings.chargingLevel == .level1 ? "1" : "2")"
        }
        return "\(profile.name), \(profile.energyKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kilowatt-hours, \(profile.durationHours.formatted(.number.precision(.fractionLength(0 ... 1)))) hours"
    }

    static func sourceTimeSummary(_ energyDataThrough: Date?, timeZone: String) -> String {
        let time = energyDataThrough.map { DashboardPresentation.date($0, timeZoneIdentifier: timeZone, dateStyle: .medium, timeStyle: .short) } ?? "unavailable"
        return "Energy observations through \(time)"
    }

    /// One hour is deliberate, so the verdict and this label age out on the same
    /// tick. It is *not* the same policy as
    /// `LoadTimingForecastEstimator.Projection.maximumBalanceAge` (30 minutes for
    /// a forecast without grid history), which gates whether a forecast may be
    /// produced at all: a forecast that policy already rejects can keep being
    /// described here for up to another 30 minutes. The two are separate on
    /// purpose — one is "can we still trust the basic estimate", the other is
    /// "may we forecast".
    static func sourceStatus(isUnavailable: Bool, energyDataThrough: Date?, now: Date = .now) -> String {
        let freshness = DashboardPresentation.freshness(energyDataThrough, now: now, staleAfter: 60 * 60)
        return isUnavailable ? "Refresh unavailable · \(freshness.lowercased())" : freshness
    }
}

struct LoadTimingView: View {
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite
    let isSelected: Bool

    @StateObject var profileStore: LoadProfileStore
    @State var isProfileSheetPresented = false
    @State var isJobPickerPresented = false
    @State var isSolarForecastSheetPresented = false
    @State var detailsSnapshot: SmartShiftDetailsSnapshot?
    @State var exploredProfileID: String?
    /// Bumped when the comparison goes stale on its own (see `nextRefresh`), to run a body pass.
    @State var staleRefreshes = 0

    init(coordinator: DashboardCoordinator, site: MobileSite, isSelected: Bool = true, profileStore: LoadProfileStore? = nil, initialExploredProfileID: String? = nil) {
        self.coordinator = coordinator
        self.site = site
        self.isSelected = isSelected
        _profileStore = StateObject(wrappedValue: profileStore ?? LoadProfileStore())
        _exploredProfileID = State(initialValue: initialExploredProfileID)
    }

    var response: MobileBillResponse? { coordinator.bill.response }
    var timing: LoadTiming? { response?.loadTiming }
    var currencyCode: String { response?.currentBill.currency ?? "USD" }
    var timeZone: String { response?.site.timezone ?? "UTC" }

    /// The Job on screen: one picked here, else the last one viewed.
    static func initialJobID(store: LoadProfileStore) -> String? {
        store.profile(id: store.selectedProfileID)?.id ?? store.profiles.first?.id
    }

    var selectedProfile: LoadProfile? {
        exploredProfileID.flatMap { profileStore.profile(id: $0) }
            ?? Self.initialJobID(store: profileStore).flatMap { profileStore.profile(id: $0) }
    }

    /// The comparison is a multi-candidate search over the horizon, so it is
    /// resolved once per body pass, outside any timeline: only the freshness
    /// label moves with the minute tick. The scroll view and its refresh control
    /// sit outside a timeline too, so neither the estimator nor a pull-to-refresh
    /// is at the mercy of the tick.
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if coordinator.bill.isUnavailable {
                    AvailabilityBanner(message: "Smart Shift could not be refreshed. Showing saved data.", symbol: "clock.badge.exclamationmark")
                }
                if let response {
                    let timingForDisplay = timing ?? LoadTiming(
                        hasTariff: false,
                        hasCycleData: false,
                        activeIsCheapest: false,
                        periods: [],
                        pricingPeriods: [],
                        tariffTimeline: [],
                        nextCheaper: nil,
                        nextCheaperPhrase: nil,
                        nextStartPhraseByKey: [:]
                    )
                    // Read so a scheduled refresh re-runs this pass.
                    let _ = staleRefreshes
                    let state = smartShiftState(now: Date(), timing: timingForDisplay, response: response)
                    jobCard(state)
                        .task(id: SmartShiftPresentation.nextRefresh(comparison: state.evaluation?.result.comparison, now: state.now)) {
                            guard let refresh = SmartShiftPresentation.nextRefresh(
                                comparison: state.evaluation?.result.comparison, now: state.now) else { return }
                            // A second past the boundary, so the next pass sees it as passed.
                            let delay = max(0, refresh.timeIntervalSinceNow) + 1
                            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                            staleRefreshes &+= 1
                        }
                    metadata(response)
                } else if coordinator.bill.isUnavailable {
                    noResponseJobCard
                } else {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Loading Smart Shift").foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(22)
                    .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 20))
                }
            }
            .padding(20)
            .frame(maxWidth: SectionTheme.maxContentWidth)
            .frame(maxWidth: .infinity)
        }
        .refreshable {
            await coordinator.loadTimingDetailRefreshed()
            await coordinator.refreshBatteryHold()
        }
        .background { SectionTheme.loadTiming.screenBackground }
        .navigationTitle("Smart Shift")
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    coordinator.isBatteryHoldSheetPresented = true
                } label: {
                    BatteryHoldToolbarLabel(state: coordinator.batteryHold, now: .now)
                }
                .accessibilityLabel(BatteryHoldPresentation.toolbarAccessibilityLabel(state: coordinator.batteryHold, at: .now))
                .accessibilityIdentifier("battery-hold-toolbar")
                Button("Manage Jobs", systemImage: "gearshape") { isProfileSheetPresented = true }
                    .accessibilityLabel("Manage Jobs")
            }
        }
        .sheet(isPresented: $isJobPickerPresented) {
            jobPicker
        }
        .sheet(isPresented: $isProfileSheetPresented) {
            LoadProfilesSheet(store: profileStore)
        }
        .sheet(isPresented: $isSolarForecastSheetPresented) {
            SolarForecastSettingsSheet(coordinator: coordinator)
        }
        .sheet(item: $detailsSnapshot) { snapshot in
            SmartShiftDetailsView(snapshot: snapshot, solarForecast: { await coordinator.solarForecastDiagnostics() })
        }
        .onChange(of: profileStore.profiles) { _, profiles in
            if let exploredProfileID, !profiles.contains(where: { $0.id == exploredProfileID }) {
                self.exploredProfileID = nil
            }
        }
        .task { await coordinator.loadTimingDetailAppeared() }
        .onDisappear { coordinator.solarSurfaceDisappeared() }
        .task(id: "\(coordinator.selectedSiteID):\(coordinator.isForeground)") {
            await refreshBatteryHoldWhileVisible()
        }
        .onChange(of: coordinator.isForeground) { _, isForeground in
            guard isForeground else { return }
            // TabView retains this observer after switching to another tab.
            Task { await coordinator.loadTimingDetailForegrounded(isSelected: isSelected) }
        }
    }

    func refreshBatteryHoldWhileVisible() async {
        guard coordinator.isForeground else { return }
        var force = true
        while !Task.isCancelled {
            await coordinator.refreshBatteryHold(force: force)
            force = false
            do { try await Task.sleep(for: .seconds(60)) } catch { return }
        }
    }

    func jobCard(_ state: SmartShiftState) -> some View {
        LoadTimingCard {
            switch state.screen.content {
            case .verdict(let verdict):
                SmartShiftVerdictView(verdict: verdict, timeZone: timeZone) {
                    isSolarForecastSheetPresented = true
                }
                Divider()
                Button {
                    detailsSnapshot = detailsSnapshot(state, verdict: verdict)
                } label: {
                    disclosureRow("How this is worked out")
                }
                .buttonStyle(.plain)
                jobRows(hint: state.hint)
            case .blocked(let message):
                if let profile = selectedProfile {
                    Text(profile.name)
                        .font(.title3.weight(.bold))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                jobRows(hint: nil)
            case .loading:
                HStack(spacing: 12) {
                    ProgressView()
                    Text(SmartShiftPresentation.checkingSolarNote).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 120, alignment: .leading)
            case .noJobs:
                Text("Add a Job").font(.headline)
                Text("Add a job to see when it's cheapest to run.").foregroundStyle(.secondary)
                Button("Add a Job", systemImage: "plus") { isProfileSheetPresented = true }
                    .frame(minHeight: 44)
            }
        }
    }

    @ViewBuilder
    func jobRows(hint: BetterJobHint?) -> some View {
        if profileStore.profiles.count > 1 {
            Divider()
            Button {
                isJobPickerPresented = true
            } label: {
                disclosureRow("Try another job")
            }
            .buttonStyle(.plain)
            if let hint {
                Button {
                    selectJob(hint.id)
                } label: {
                    Label(hint.text, systemImage: "lightbulb")
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.tint)
                .accessibilityHint("Switches to this job")
            }
        }
    }

    func selectJob(_ id: String) {
        exploredProfileID = id
        try? profileStore.selectProfile(id: id)
    }

    func disclosureRow(_ title: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .foregroundStyle(.tint)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    var noResponseJobCard: some View {
        let selected = selectedProfile
        return LoadTimingCard {
            if let selected {
                Text(selected.name).font(.title2.bold())
            }
            Text(LoadTimingPresentation.noResponseRecommendationMessage.title).font(.headline)
            Text(LoadTimingPresentation.noResponseRecommendationMessage.detail)
                .foregroundStyle(.secondary)
            if profileStore.profiles.count > 1 {
                Button("Try Another Job", systemImage: "arrow.left.arrow.right") { isJobPickerPresented = true }
                    .frame(minHeight: 44)
            } else if selected == nil {
                Button("Add a Job", systemImage: "plus") { isProfileSheetPresented = true }
                    .frame(minHeight: 44)
            }
        }
    }

    var jobPicker: some View {
        NavigationStack {
            List {
                ForEach(profileStore.profiles) { profile in
                    Button {
                        selectJob(profile.id)
                        isJobPickerPresented = false
                    } label: {
                        Text(LoadTimingPresentation.profileChipTitle(profile))
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                    .accessibilityLabel(LoadTimingPresentation.profileChipAccessibilityLabel(profile))
                }
            }
            .navigationTitle("Choose a Job")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isJobPickerPresented = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    func metadata(_ response: MobileBillResponse) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Billing cycle \(DashboardPresentation.date(response.currentBill.cycleStart, timeZoneIdentifier: timeZone, dateStyle: .short)) – \(DashboardPresentation.date(response.currentBill.cycleEnd, timeZoneIdentifier: timeZone, dateStyle: .short))")
            Text(LoadTimingPresentation.sourceTimeSummary(response.sources.energyDataThrough, timeZone: timeZone))
            Text("Calculated \(DashboardPresentation.date(response.sources.calculatedAt, timeZoneIdentifier: timeZone, dateStyle: .medium, timeStyle: .short))")
            LoadTimingFreshnessLabel(
                isUnavailable: coordinator.bill.isUnavailable,
                energyDataThrough: response.sources.energyDataThrough,
                announcesFreshness: false
            )
            if let attribution = coordinator.solarForecastAttribution { Text(attribution) }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }
}
