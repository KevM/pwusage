import SwiftUI

enum LoadTimingPresentation {
    struct RecommendationMessage: Equatable {
        let title: String
        let detail: String
    }

    struct EnergyImpact: Equatable {
        let surplusConsumed: String
        let energyBought: String
        let remainingSurplus: String?
    }

    static let noResponseRecommendationMessage = RecommendationMessage(
        title: "Recommendation unavailable",
        detail: "The latest refresh failed and no saved bill data is available, so no recommendation or job estimates can be shown."
    )
    static let noResponseExplorationMessage = "A saved bill response and tariff data are required before a job estimate or calculation is available."

    struct StartNowSummary: Equatable {
        let total: String
        let energy: String
        let finish: String
    }

    struct RunCardSummary: Equatable {
        let total: String
        let finish: String
    }

    struct BreakdownRow: Equatable {
        let periodKey: String
        let wallEnergy: String
        let balance: String
        let total: String
    }

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

    /// Job names are verb phrases ("Charge the car"), so they are used as-is.
    static func actionTitle(for profile: LoadProfile) -> String {
        profile.name
    }

    /// `.incompleteData` is aggregated across every job while the card speaks
    /// about the selected one, so the expired-cycle copy has to say whose run
    /// crosses the billing cycle.
    static func recommendationMessage(
        for recommendation: LoadTimingRecommendation,
        selected: LoadTimingRecommendation.Candidate?,
        refreshUnavailable: Bool = false,
        hasTariff: Bool = true
    ) -> RecommendationMessage {
        let expired = LoadTimingEstimator.StartNowResult.unavailable(.billingCycleExpired)
        let selectedExpired = selected?.result == expired
        let otherExpired = recommendation.candidates.contains {
            $0.profile.id != selected?.profile.id && $0.result == expired
        }
        return recommendationMessage(
            for: recommendation.state,
            refreshUnavailable: refreshUnavailable,
            hasTariff: hasTariff,
            hasExpiredCandidate: selectedExpired,
            hasOtherExpiredCandidate: otherExpired
        )
    }

    static func recommendationMessage(
        for state: LoadTimingRecommendation.State,
        refreshUnavailable: Bool = false,
        hasTariff: Bool = true,
        hasExpiredCandidate: Bool = false,
        hasOtherExpiredCandidate: Bool = false
    ) -> RecommendationMessage {
        switch state {
        case .ready:
            return RecommendationMessage(title: "Good time to start", detail: "Your export cushion covers this job.")
        case .noFit:
            if refreshUnavailable {
                return RecommendationMessage(title: "Recommendation unavailable", detail: "The latest refresh failed, so the saved data cannot confirm whether any saved job fits now.")
            }
            return RecommendationMessage(title: "No saved job fits your export cushion.", detail: "Additional energy would be priced at the grid rate.")
        case .incompleteData:
            if !hasTariff {
                return RecommendationMessage(title: "Add a Rate Plan", detail: "Smart Shift needs your rate plan to compare costs.")
            }
            if hasExpiredCandidate {
                return RecommendationMessage(title: "No safe recommendation", detail: "This job would continue beyond the current billing cycle, so its current export cushion cannot be used for the estimate.")
            }
            if hasOtherExpiredCandidate {
                return RecommendationMessage(title: "No safe recommendation", detail: "Another saved job would continue beyond the current billing cycle, so no job can be recommended from the current export cushion.")
            }
            return RecommendationMessage(title: "Rate Plan Incomplete", detail: "Some rate periods or export balances are missing.")
        case .stale:
            let detail = refreshUnavailable
                ? "The latest refresh failed. This saved estimate may be old, so no recommendation is offered."
                : "Energy observations are older than one hour or have no valid source time, so no recommendation is offered."
            return RecommendationMessage(title: "Recommendation unavailable", detail: detail)
        case .noEnergyNeeded:
            return RecommendationMessage(title: "No energy needed", detail: "Every saved job is already at its target, so no energy is needed right now.")
        case .noCandidates:
            if !hasTariff {
                return RecommendationMessage(title: "Add a Rate Plan and a Job", detail: "Add a job and a rate plan to compare costs.")
            }
            return RecommendationMessage(title: "Add Your First Job", detail: "Add a job to see whether your export cushion covers it.")
        }
    }

    static func energyImpact(_ candidate: LoadTimingRecommendation.Candidate) -> EnergyImpact {
        let surplus = candidate.surplusKwh.formatted(.number.precision(.fractionLength(1)))
        let bought = candidate.boughtKwh.formatted(.number.precision(.fractionLength(1)))
        let remaining = candidate.remainingSurplusKwh.map {
            "\($0.formatted(.number.precision(.fractionLength(1)))) kWh of export cushion remains in these rate periods"
        }
        return EnergyImpact(
            surplusConsumed: "\(surplus) kWh from your export cushion",
            energyBought: "\(bought) kWh at the grid rate",
            remainingSurplus: remaining
        )
    }

    static func costDifference(alternativeCost: Double?, suggestedCost: Double?, currencyCode: String) -> String? {
        guard let alternativeCost, let suggestedCost,
              alternativeCost.isFinite, suggestedCost.isFinite else { return nil }
        let difference = alternativeCost - suggestedCost
        guard difference.isFinite else { return nil }
        if abs(difference) < 0.01 { return "About the same estimated cost as the suggestion" }
        let amount = DashboardPresentation.currency(abs(difference), code: currencyCode)
        return difference > 0
            ? "Estimated \(amount) more than the suggestion"
            : "Estimated \(amount) less than the suggestion"
    }

    static func activeBalanceSummary(_ timing: LoadTiming) -> String? {
        guard timing.hasCycleData, let active = timing.periods.first(where: \.isActive) else { return nil }
        let balance = active.cycleNetExportKwh
        let direction = balance > 0 ? "surplus" : (balance < 0 ? "deficit" : "balanced")
        return "Current \(DashboardPresentation.tariffPeriodTitle(active.name)) billing-cycle balance: \(abs(balance).formatted(.number.precision(.fractionLength(0...1)))) kWh \(direction)."
    }

    static func observedBalances(_ timing: LoadTiming) -> [String: Double] {
        guard timing.hasCycleData else { return [:] }
        return timing.periods.reduce(into: [:]) { balances, period in
            balances[period.name] = period.cycleNetExportKwh
        }
    }

    static func sourceTimeSummary(_ energyDataThrough: Date?, timeZone: String) -> String {
        let time = energyDataThrough.map { DashboardPresentation.date($0, timeZoneIdentifier: timeZone, dateStyle: .medium, timeStyle: .short) } ?? "unavailable"
        return "Energy observations through \(time)"
    }

    static func startNowSummary(_ estimate: LoadTimingEstimator.StartNowEstimate, currencyCode: String, timeZone: String) -> StartNowSummary {
        StartNowSummary(
            total: "Estimated \(DashboardPresentation.currency(estimate.total, code: currencyCode)) to start now",
            energy: "About \(estimate.wallKwh.formatted(.number.precision(.fractionLength(1)))) kWh from the wall",
            finish: "Finishes \(DashboardPresentation.date(estimate.finishTime, timeZoneIdentifier: timeZone, dateStyle: .medium, timeStyle: .short)) · about \(estimate.durationHours.formatted(.number.precision(.fractionLength(1)))) hours"
        )
    }

    static func runCardSummary(_ estimate: LoadTimingEstimator.StartNowEstimate, currencyCode: String, timeZone: String) -> RunCardSummary {
        let summary = startNowSummary(estimate, currencyCode: currencyCode, timeZone: timeZone)
        return RunCardSummary(total: summary.total, finish: summary.finish)
    }

    static func missingBalanceNote(hasUnobservedBalance: Bool) -> String? {
        guard hasUnobservedBalance else { return nil }
        return "Missing rate-period balances are estimated at the grid rate."
    }

    static func unavailableMessage(_ reason: LoadTimingEstimator.StartNowUnavailableReason) -> String {
        switch reason {
        case .invalidInput: return "Job settings or rate plan values are invalid, so a start-now estimate is unavailable."
        case .incompleteTimeline: return "Rate plan timing is incomplete, so a start-now cost estimate is unavailable."
        case .billingCycleExpired: return "This job extends beyond the current billing cycle, so its export cushion cannot be estimated safely."
        }
    }

    static let noChargeMessage = "No charging needed at this target."

    static func cycleObservationMessage(hasCycleData: Bool) -> String? {
        guard !hasCycleData else { return nil }
        return "Billing-cycle observations are unavailable. The start-now estimate uses grid rates where no balance has been observed."
    }

    static func breakdownRows(_ segments: [LoadTimingEstimator.StartNowSegment], currencyCode: String, unobservedPeriodKeys: Set<String> = []) -> [BreakdownRow] {
        segments.map { segment in
            let balance = unobservedPeriodKeys.contains(segment.periodKey)
                ? "No observed balance · estimated at buy rate"
                : "\(segment.surplusKwh.formatted(.number.precision(.fractionLength(1)))) kWh observed surplus · \(segment.boughtKwh.formatted(.number.precision(.fractionLength(1)))) kWh at buy rate"
            return BreakdownRow(
                periodKey: segment.periodKey,
                wallEnergy: "\(segment.wallKwh.formatted(.number.precision(.fractionLength(1)))) kWh",
                balance: balance,
                total: DashboardPresentation.currency(segment.total, code: currencyCode)
            )
        }
    }

    /// One hour is deliberate and matches `LoadTimingRecommendation.detailFreshnessWindow`,
    /// so the verdict and this label age out on the same tick. It is *not* the
    /// same policy as `LoadTimingForecastEstimator.maximumBalanceAge` (30
    /// minutes), which gates whether a forecast may be produced at all: a
    /// forecast that policy already rejects can keep being described here for
    /// up to another 30 minutes. The two are separate on purpose — one is
    /// "can we still trust the basic estimate", the other is "may we forecast".
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
                    jobCard(smartShiftState(now: Date(), timing: timingForDisplay, response: response))
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
            .frame(maxWidth: 760)
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
            ToolbarItem(placement: .topBarLeading) {
                Button("Solar Forecast Settings", systemImage: "sun.max") { isSolarForecastSheetPresented = true }
                    .accessibilityLabel("Solar forecast settings")
            }
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
            SmartShiftDetailsView(snapshot: snapshot)
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
