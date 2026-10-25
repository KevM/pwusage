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
            return "\(profile.name) · \(estimate.batteryKwh.formatted(.number.precision(.fractionLength(0...1)))) kWh battery"
        }
        return "\(profile.name) · \(profile.energyKwh.formatted(.number.precision(.fractionLength(0...1)))) kWh"
    }

    static func profileChipAccessibilityLabel(_ profile: LoadProfile) -> String {
        if profile.kind == .car, let settings = profile.carSettings,
           let estimate = LoadTimingEstimator.carChargeEstimate(settings: settings) {
            return "\(profile.name), \(estimate.batteryKwh.formatted(.number.precision(.fractionLength(0...1)))) kilowatt-hours to the battery, about \(estimate.wallKwh.formatted(.number.precision(.fractionLength(0...1)))) kilowatt-hours from the wall, Level \(settings.chargingLevel == .level1 ? "1" : "2")"
        }
        return "\(profile.name), \(profile.energyKwh.formatted(.number.precision(.fractionLength(0...1)))) kilowatt-hours, \(profile.durationHours.formatted(.number.precision(.fractionLength(0...1)))) hours"
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

    @StateObject private var profileStore: LoadProfileStore
    @State private var isProfileSheetPresented = false
    @State private var isJobPickerPresented = false
    @State private var isSolarForecastSheetPresented = false
    @State private var detailsSnapshot: SmartShiftDetailsSnapshot?
    @State private var exploredProfileID: String?
    /// Bumped when the comparison goes stale on its own (see `nextRefresh`), to run a body pass.
    @State private var staleRefreshes = 0

    init(coordinator: DashboardCoordinator, site: MobileSite, isSelected: Bool = true, profileStore: LoadProfileStore? = nil, initialExploredProfileID: String? = nil) {
        self.coordinator = coordinator
        self.site = site
        self.isSelected = isSelected
        _profileStore = StateObject(wrappedValue: profileStore ?? LoadProfileStore())
        _exploredProfileID = State(initialValue: initialExploredProfileID)
    }

    private var response: MobileBillResponse? { coordinator.bill.response }
    private var timing: LoadTiming? { response?.loadTiming }
    private var currencyCode: String { response?.currentBill.currency ?? "USD" }
    private var timeZone: String { response?.site.timezone ?? "UTC" }

    /// The Job on screen: one picked here, else the last one viewed.
    static func initialJobID(store: LoadProfileStore) -> String? {
        store.profile(id: store.selectedProfileID)?.id ?? store.profiles.first?.id
    }

    private var selectedProfile: LoadProfile? {
        exploredProfileID.flatMap { profileStore.profile(id: $0) }
            ?? Self.initialJobID(store: profileStore).flatMap { profileStore.profile(id: $0) }
    }

    private struct SmartShiftState {
        let screen: SmartShiftScreen
        let profile: LoadProfile?
        let evaluation: SmartShiftEvaluation?
        let timing: LoadTiming
        let now: Date
        let billingCycleEnd: Date
        let hint: BetterJobHint?
        /// What the pass was offered, kept so "Copy diagnostics" can record it.
        let balanceSourceTime: Date?
        let intervals: [SolarForecastInterval]?
        let context: LoadTimingForecastEstimator.PlanningContext?
    }

    /// Prices the selected Job with the solar forecast when it's usable and with
    /// balances held still otherwise, then turns that into the card's copy.
    private func smartShiftState(now: Date, timing: LoadTiming, response: MobileBillResponse) -> SmartShiftState {
        let profile = selectedProfile
        let availability = LoadTimingForecastPresentation.forecastAvailability(
            state: coordinator.solarForecastState,
            connection: coordinator.solarForecastConnection,
            cause: coordinator.solarForecastUnavailableCause,
            reason: coordinator.solarForecastUnavailableReason,
            forecastFetchedAt: coordinator.solarForecastBatch?.fetchedAt,
            now: now
        )
        // One evaluator per pass, so every Job shares the projection's plan.
        let intervals = coordinator.solarForecastBatch?.intervals
        // Without a usable forecast, the household pattern's grid history still projects the banks.
        let context = coordinator.loadPlanningContext ?? coordinator.householdPattern
        let evaluate = SmartShiftPresentation.evaluator(
            now: now,
            timing: timing,
            forecast: availability,
            intervals: intervals,
            context: context,
            balanceSourceTime: response.sources.energyDataThrough,
            billingCycleEnd: response.currentBill.cycleEnd,
            currencyCode: currencyCode,
            timeZone: timeZone
        )
        let evaluation = profile.map(evaluate)
        let screen = SmartShiftPresentation.make(
            profile: profile,
            result: evaluation?.result ?? .init(comparison: nil, unavailableReason: nil),
            forecast: evaluation?.forecast ?? .none,
            refreshUnavailable: coordinator.bill.isUnavailable,
            timing: timing,
            now: now,
            billingCycleEnd: response.currentBill.cycleEnd,
            currencyCode: currencyCode,
            timeZone: timeZone
        )
        // Every saved Job is priced in this same pass, so the hint costs no extra
        // passes; Jobs with no comparison right now are left out.
        var hint: BetterJobHint?
        if let profile, let savings = evaluation?.result.comparison?.savings, !coordinator.bill.isUnavailable {
            let others = profileStore.profiles.filter { $0.id != profile.id }.compactMap { other in
                evaluate(other).result.comparison.map { (other, $0.savings) }
            }
            hint = SmartShiftPresentation.betterJobHint(selectedID: profile.id, savingsByJob: [(profile, savings)] + others,
                                                        currencyCode: currencyCode)
        }
        return SmartShiftState(screen: screen, profile: profile, evaluation: evaluation, timing: timing, now: now,
                               billingCycleEnd: response.currentBill.cycleEnd, hint: hint,
                               balanceSourceTime: response.sources.energyDataThrough, intervals: intervals, context: context)
    }

    private func detailsSnapshot(_ state: SmartShiftState, verdict: SmartShiftVerdict) -> SmartShiftDetailsSnapshot {
        let comparison = state.evaluation?.result.comparison
        let usedForecast = state.evaluation?.forecast == .ready
        var breakdowns: [CostBreakdown] = []
        var ruledOutNote: String?
        if let comparison, let profile = state.profile {
            breakdowns = SmartShiftPresentation.costBreakdowns(comparison: comparison, profile: profile, timing: state.timing,
                                                               now: state.now, billingCycleEnd: state.billingCycleEnd,
                                                               currencyCode: currencyCode, timeZone: timeZone)
            ruledOutNote = SmartShiftPresentation.ruledOutNote(comparison: comparison, profile: profile, timing: state.timing,
                                                               now: state.now, timeZone: timeZone)
        }
        var diagnostics: SmartShiftDiagnostics?
        if let profile = state.profile, let evaluation = state.evaluation {
            diagnostics = SmartShiftDiagnostics(
                siteId: site.id, app: .current, job: profile, now: state.now, balanceSourceTime: state.balanceSourceTime,
                billingCycleEnd: state.billingCycleEnd, currencyCode: currencyCode, timeZone: timeZone, timing: state.timing,
                evaluation: evaluation, intervals: state.intervals, context: state.context,
                forecastFetchedAt: coordinator.solarForecastBatch?.fetchedAt)
        }
        return SmartShiftDetailsSnapshot(
            verdict: verdict,
            comparison: comparison,
            rows: SmartShiftPresentation.periodRows(timing: state.timing, currencyCode: currencyCode),
            breakdowns: breakdowns,
            ruledOutNote: ruledOutNote,
            forecastFetchedAt: usedForecast ? coordinator.solarForecastBatch?.fetchedAt : nil,
            contextAsOf: usedForecast ? coordinator.loadPlanningContext?.asOf : nil,
            capturedAt: state.now,
            diagnostics: diagnostics
        )
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
        .task(id: "\(coordinator.selectedSiteID):\(coordinator.isForeground)") {
            await refreshBatteryHoldWhileVisible()
        }
        .onChange(of: coordinator.isForeground) { _, isForeground in
            guard isForeground else { return }
            // TabView retains this observer after switching to another tab.
            Task { await coordinator.loadTimingDetailForegrounded(isSelected: isSelected) }
        }
    }

    private func refreshBatteryHoldWhileVisible() async {
        guard coordinator.isForeground else { return }
        var force = true
        while !Task.isCancelled {
            await coordinator.refreshBatteryHold(force: force)
            force = false
            do { try await Task.sleep(for: .seconds(60)) } catch { return }
        }
    }

    private func jobCard(_ state: SmartShiftState) -> some View {
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
    private func jobRows(hint: BetterJobHint?) -> some View {
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

    private func selectJob(_ id: String) {
        exploredProfileID = id
        try? profileStore.selectProfile(id: id)
    }

    private func disclosureRow(_ title: String) -> some View {
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

    private var noResponseJobCard: some View {
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

    private var jobPicker: some View {
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

    private func metadata(_ response: MobileBillResponse) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Billing cycle \(DashboardPresentation.date(response.currentBill.cycleStart, timeZoneIdentifier: timeZone, dateStyle: .short)) – \(DashboardPresentation.date(response.currentBill.cycleEnd, timeZoneIdentifier: timeZone, dateStyle: .short))")
            Text(LoadTimingPresentation.sourceTimeSummary(response.sources.energyDataThrough, timeZone: timeZone))
            Text("Calculated \(DashboardPresentation.date(response.sources.calculatedAt, timeZoneIdentifier: timeZone, dateStyle: .medium, timeStyle: .short))")
            LoadTimingFreshnessLabel(
                isUnavailable: coordinator.bill.isUnavailable,
                energyDataThrough: response.sources.energyDataThrough,
                announcesFreshness: false
            )
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }
}

/// How stale the energy observations are, in words.
///
/// This is one of only two things on the load timing screen that move with the
/// clock, so it owns a minute timeline of its own. Using the timeline's own date
/// keeps the label and the tick that redraws it on the same clock instead of a
/// second one.
private struct LoadTimingFreshnessLabel: View {
    let isUnavailable: Bool
    let energyDataThrough: Date?
    /// Whether the label carries a `"Source freshness: …"` accessibility prefix.
    /// This preserves what each call site announced before the label was
    /// extracted: the recommendation card's caption set that label, and the
    /// metadata footer — already combined with its neighbours into one
    /// accessibility element — did not. It is an announcement choice, not an
    /// attempt to influence how `.combine` groups a nested timeline.
    var announcesFreshness = true

    var body: some View {
        TimelineView(.everyMinute) { context in
            let status = LoadTimingPresentation.sourceStatus(
                isUnavailable: isUnavailable,
                energyDataThrough: energyDataThrough,
                now: context.date
            )
            Text(status)
                .font(.caption)
                .foregroundStyle(isUnavailable ? .orange : .secondary)
                .modifier(LoadTimingFreshnessAnnouncement(announces: announcesFreshness, status: status))
        }
    }
}

/// The recommendation card's caption announced what the label meant and wrapped
/// freely; the metadata footer, already combined into a single accessibility
/// element, announced only the status text and was left to wrap like its
/// neighbours. Restoring each call site exactly means the announcement and that
/// wrapping have to travel together, so they are decided in one place.
private struct LoadTimingFreshnessAnnouncement: ViewModifier {
    let announces: Bool
    let status: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if announces {
            content
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Source freshness: \(status)")
        } else {
            content
        }
    }
}

private struct LoadTimingCard<Content: View>: View {
    var title: String? = nil
    var symbol: String? = nil
    @ViewBuilder let content: Content

    init(title: String? = nil, symbol: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.symbol = symbol
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            if let title, let symbol {
                Label(title, systemImage: symbol)
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
            }
            content
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
