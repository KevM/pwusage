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
        detail: "The latest refresh failed and no saved bill data is available, so no recommendation or load estimates can be shown."
    )
    static let noResponseExplorationMessage = "A saved bill response and tariff data are required before a load estimate or calculation is available."

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

    static func actionTitle(for profile: LoadProfile) -> String {
        "\(profile.kind == .car ? "Charge" : "Run") \(profile.name)"
    }

    static func explorationTitle(for profile: LoadProfile) -> String {
        "What if you \(profile.kind == .car ? "charge" : "run") \(profile.name)?"
    }

    static func recommendationMessage(
        for state: LoadTimingRecommendation.State,
        refreshUnavailable: Bool = false,
        hasTariff: Bool = true,
        hasExpiredCandidate: Bool = false
    ) -> RecommendationMessage {
        switch state {
        case .ready:
            return RecommendationMessage(title: "Good fit now", detail: "Your observed tariff surplus covers this run’s estimated energy.")
        case .noFit:
            if refreshUnavailable {
                return RecommendationMessage(title: "Recommendation unavailable", detail: "The latest refresh failed, so the saved data cannot confirm whether any load fits now.")
            }
            return RecommendationMessage(title: "Your surplus won’t cover a full load.", detail: "No configured load fits entirely within the observed surplus for the tariff periods it would use.")
        case .incompleteData:
            if !hasTariff {
                return RecommendationMessage(title: "Tariff data needed", detail: "An active tariff is missing, so load costs and surplus coverage cannot be estimated.")
            }
            if hasExpiredCandidate {
                return RecommendationMessage(title: "No safe recommendation", detail: "This run would continue beyond the current billing cycle, so its current-cycle surplus cannot be used for the estimate.")
            }
            return RecommendationMessage(title: "Tariff data incomplete", detail: "Some tariff periods or billing-cycle balances are missing, so a full-load recommendation is unavailable.")
        case .stale:
            let detail = refreshUnavailable
                ? "The latest refresh failed. This saved estimate may be old, so no recommendation is offered."
                : "Energy observations are older than one hour or have no valid source time, so no recommendation is offered."
            return RecommendationMessage(title: "Recommendation unavailable", detail: detail)
        case .noEnergyNeeded:
            return RecommendationMessage(title: "No energy needed", detail: "Every configured load is already at its target, so no energy is needed right now.")
        case .noCandidates:
            if !hasTariff {
                return RecommendationMessage(title: "Tariff and load profiles needed", detail: "Add a load profile and configure an active tariff to compare estimates with observed surplus.")
            }
            return RecommendationMessage(title: "No load profiles yet", detail: "Add a load profile to compare its estimate with your observed tariff surplus.")
        }
    }

    static func energyImpact(_ candidate: LoadTimingRecommendation.Candidate) -> EnergyImpact {
        let surplus = candidate.surplusKwh.formatted(.number.precision(.fractionLength(1)))
        let bought = candidate.boughtKwh.formatted(.number.precision(.fractionLength(1)))
        let remaining = candidate.remainingSurplusKwh.map {
            "\($0.formatted(.number.precision(.fractionLength(1)))) kWh surplus remains across the tariff periods used"
        }
        return EnergyImpact(
            surplusConsumed: "Uses \(surplus) kWh of observed surplus",
            energyBought: "Buys \(bought) kWh at tariff rates",
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

    static func showsBackToSuggestion(explicitID: String?, suggestedID: String?) -> Bool {
        guard let explicitID, let suggestedID else { return false }
        return explicitID != suggestedID
    }

    static let runDetailsAccessibilityLabel = "Load run details"

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
        return "Some tariff periods have no observed billing-cycle balance; those portions are estimated at the buy rate."
    }

    static func unavailableMessage(_ reason: LoadTimingEstimator.StartNowUnavailableReason) -> String {
        switch reason {
        case .invalidInput: return "Profile or tariff values are invalid, so a start-now estimate is unavailable."
        case .incompleteTimeline: return "Tariff timing is incomplete, so a start-now cost estimate is unavailable."
        case .billingCycleExpired: return "This run extends beyond the current billing cycle, so its surplus cannot be estimated safely."
        }
    }

    static let noChargeMessage = "No charging needed at this target."

    static func cycleObservationMessage(hasCycleData: Bool) -> String? {
        guard !hasCycleData else { return nil }
        return "Billing-cycle observations are unavailable. The start-now estimate uses buy rates where no balance has been observed."
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

    static func sourceStatus(isUnavailable: Bool, energyDataThrough: Date?, now: Date = .now) -> String {
        let freshness = DashboardPresentation.freshness(energyDataThrough, now: now, staleAfter: 60 * 60)
        return isUnavailable ? "Refresh unavailable · \(freshness.lowercased())" : freshness
    }
}

struct LoadTimingView: View {
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @StateObject private var profileStore: LoadProfileStore
    @State private var isProfileSheetPresented = false
    @State private var isSolarForecastSheetPresented = false
    @State private var runDetailsSnapshot: LoadRunDetailsSnapshot?
    @State private var exploredProfileID: String?

    init(coordinator: DashboardCoordinator, site: MobileSite, profileStore: LoadProfileStore? = nil, initialExploredProfileID: String? = nil) {
        self.coordinator = coordinator
        self.site = site
        _profileStore = StateObject(wrappedValue: profileStore ?? LoadProfileStore())
        _exploredProfileID = State(initialValue: initialExploredProfileID)
    }

    private var response: MobileBillResponse? { coordinator.bill.response }
    private var timing: LoadTiming? { response?.loadTiming }
    private var currencyCode: String { response?.currentBill.currency ?? "USD" }
    private var timeZone: String { response?.site.timezone ?? "UTC" }

    /// The forecast overlay is derived fresh from coordinator state. It can only
    /// add an enhanced section and one note; the basic estimate below is rendered
    /// regardless, and is never replaced by a forecast value.
    private func forecastOverlay(
        now: Date,
        timing: LoadTiming,
        response: MobileBillResponse,
        profile: LoadProfile?
    ) -> LoadTimingForecastPresentation.Overlay {
        let enhancedState = coordinator.solarForecastState
        let result: LoadTimingForecastEstimator.Result
        if enhancedState == .enhanced,
           let profile,
           let batch = coordinator.solarForecastBatch,
           let context = coordinator.loadPlanningContext,
           let balanceSourceTime = response.sources.energyDataThrough {
            result = LoadTimingForecastEstimator.evaluate(
                profile: profile,
                now: now,
                timing: timing,
                forecast: batch.intervals,
                context: context,
                balanceSourceTime: balanceSourceTime,
                billingCycleEnd: response.currentBill.cycleEnd,
                currencyCode: currencyCode
            )
        } else {
            result = LoadTimingForecastEstimator.Result(comparison: nil, unavailableReason: .incompleteCoverage)
        }
        return LoadTimingForecastPresentation.overlay(
            enhancement: enhancedState,
            connection: coordinator.solarForecastConnection,
            failure: coordinator.solarForecastFailure,
            result: result,
            forecastFetchedAt: coordinator.solarForecastBatch?.fetchedAt,
            contextAsOf: coordinator.loadPlanningContext?.asOf,
            currencyCode: currencyCode,
            timeZone: timeZone,
            now: now
        )
    }

    var body: some View {
        TimelineView(.everyMinute) { _ in
            let now = Date()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if coordinator.bill.isUnavailable {
                        AvailabilityBanner(message: "Load timing could not be refreshed. Showing the last successful cycle snapshot with its original source time.", symbol: "clock.badge.exclamationmark")
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
                        let recommendation = LoadTimingRecommendation.evaluate(
                            profiles: profileStore.profiles,
                            start: now,
                            timing: timingForDisplay,
                            energyDataThrough: response.sources.energyDataThrough,
                            cycleEnd: response.currentBill.cycleEnd,
                            refreshUnavailable: coordinator.bill.isUnavailable
                        )
                        recommendationCard(recommendation, timing: timingForDisplay, response: response, now: now)
                        explorerCard(recommendation, timing: timingForDisplay, response: response, now: now)
                        observedPeriods(timingForDisplay)
                        metadata(response, now: now)
                    } else if coordinator.bill.isUnavailable {
                        LoadTimingCard(title: "Recommendation", symbol: "bolt.fill") {
                            Text(LoadTimingPresentation.noResponseRecommendationMessage.title)
                                .font(.title3.weight(.bold))
                                .fixedSize(horizontal: false, vertical: true)
                            Text(LoadTimingPresentation.noResponseRecommendationMessage.detail)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        noResponseExplorerCard
                    } else {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Loading load timing").foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(22)
                        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
                    }
                }
                .padding(20)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .refreshable { await coordinator.refreshBill() }
            .background(Color(uiColor: .systemGroupedBackground))
        }
        .navigationTitle("Load timing")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { isSolarForecastSheetPresented = true } label: { Image(systemName: "sun.max") }
                    .accessibilityLabel("Solar forecast settings")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { isProfileSheetPresented = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Manage load profiles")
            }
        }
        .sheet(isPresented: $isProfileSheetPresented) {
            LoadProfilesSheet(store: profileStore)
        }
        .sheet(isPresented: $isSolarForecastSheetPresented) {
            SolarForecastSettingsSheet(coordinator: coordinator)
        }
        .sheet(item: $runDetailsSnapshot) { snapshot in
            LoadRunDetailsSheet(snapshot: snapshot)
        }
        .onChange(of: profileStore.profiles) { _, profiles in
            coordinator.loadProfileDidEdit()
            if let exploredProfileID, !profiles.contains(where: { $0.id == exploredProfileID }) {
                self.exploredProfileID = nil
            }
        }
        .task { await coordinator.loadTimingDetailAppeared() }
        .onChange(of: coordinator.isForeground) { _, isForeground in
            guard isForeground else { return }
            Task { await coordinator.loadTimingDetailAppeared() }
        }
    }

    private func recommendationCard(_ recommendation: LoadTimingRecommendation, timing: LoadTiming, response: MobileBillResponse, now: Date) -> some View {
        let hasExpiredCandidate = recommendation.candidates.contains { $0.result == .unavailable(.billingCycleExpired) }
        let copy = LoadTimingPresentation.recommendationMessage(
            for: recommendation.state,
            refreshUnavailable: coordinator.bill.isUnavailable,
            hasTariff: timing.hasTariff,
            hasExpiredCandidate: hasExpiredCandidate
        )
        let overlay = forecastOverlay(now: now, timing: timing, response: response,
                                      profile: recommendation.suggested?.profile)
        return LoadTimingCard(title: "Recommendation", symbol: "bolt.fill") {
            Text(copy.title)
                .font(.title3.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
            if recommendation.state == .ready, let candidate = recommendation.suggested, let estimate = candidate.estimate {
                Label(LoadTimingPresentation.actionTitle(for: candidate.profile), systemImage: "play.fill")
                    .font(.title2.weight(.bold))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel(LoadTimingPresentation.actionTitle(for: candidate.profile))
                Text(copy.detail)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                let summary = LoadTimingPresentation.runCardSummary(estimate, currencyCode: currencyCode, timeZone: timeZone)
                Text(summary.total)
                    .font(.headline)
                    .monospacedDigit()
                Text(summary.finish)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(copy.detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            forecastSection(overlay)
            Text("Estimates use billing-cycle balances, not live solar. Each load is evaluated independently from the same snapshot.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(LoadTimingPresentation.sourceStatus(isUnavailable: coordinator.bill.isUnavailable, energyDataThrough: response.sources.energyDataThrough, now: now))
                .font(.caption)
                .foregroundStyle(coordinator.bill.isUnavailable ? .orange : .secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Source freshness: \(LoadTimingPresentation.sourceStatus(isUnavailable: coordinator.bill.isUnavailable, energyDataThrough: response.sources.energyDataThrough, now: now))")
        }
    }

    @ViewBuilder
    private func forecastSection(_ overlay: LoadTimingForecastPresentation.Overlay) -> some View {
        if let note = overlay.note {
            Label(note, systemImage: "sun.max.trianglebadge.exclamationmark")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let enhanced = overlay.enhanced {
            VStack(alignment: .leading, spacing: 5) {
                Text("Solar forecast")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(enhanced.headline)
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Text(enhanced.recommendedCost)
                    .font(.headline)
                    .monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
                Text(enhanced.costNow)
                    .font(.subheadline)
                    .monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
                if let savings = enhanced.savings {
                    Text(savings)
                        .font(.subheadline)
                        .foregroundStyle(.green)
                        .monospacedDigit()
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(enhanced.window)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(enhanced.solarContribution)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(enhanced.horizon)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(enhanced.sourceAges, id: \.self) { age in
                    Text(age)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(overlay.detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 4)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(overlay.accessibilityLabel)
        }
    }

    private func explorerCard(_ recommendation: LoadTimingRecommendation, timing: LoadTiming, response: MobileBillResponse, now: Date) -> some View {
        let candidate = recommendation.exploredProfile(explicitID: exploredProfileID)
        return LoadTimingCard(title: "Explore another load", symbol: "slider.horizontal.3") {
            if !profileStore.profiles.isEmpty {
                Picker("Load profile", selection: Binding(
                    get: { candidate?.profile.id ?? profileStore.profiles[0].id },
                    set: { exploredProfileID = $0 }
                )) {
                    ForEach(profileStore.profiles) { profile in
                        Text(profile.name).tag(profile.id)
                    }
                }
                .pickerStyle(.menu)
                .frame(minHeight: 44)
                .accessibilityHint("Choose a saved load to estimate independently")

                if let candidate {
                    explorerCandidate(candidate, recommendation: recommendation, timing: timing, response: response, now: now)
                }
            } else {
                Text("Add a load profile to explore estimates.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var noResponseExplorerCard: some View {
        let selectedProfile = exploredProfileID.flatMap { profileStore.profile(id: $0) } ?? profileStore.profiles.first
        return LoadTimingCard(title: "Explore another load", symbol: "slider.horizontal.3") {
            if !profileStore.profiles.isEmpty {
                Picker("Load profile", selection: Binding(
                    get: { selectedProfile?.id ?? profileStore.profiles[0].id },
                    set: { exploredProfileID = $0 }
                )) {
                    ForEach(profileStore.profiles) { profile in
                        Text(profile.name).tag(profile.id)
                    }
                }
                .pickerStyle(.menu)
                .frame(minHeight: 44)
                .accessibilityHint("Choose a saved load to explore when bill and tariff data are available")

                if let selectedProfile {
                    Text(LoadTimingPresentation.explorationTitle(for: selectedProfile))
                        .font(.title3.weight(.bold))
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text("Add a load profile to explore estimates.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Text(LoadTimingPresentation.noResponseExplorationMessage)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func explorerCandidate(_ candidate: LoadTimingRecommendation.Candidate, recommendation: LoadTimingRecommendation, timing: LoadTiming, response: MobileBillResponse, now: Date) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(LoadTimingPresentation.explorationTitle(for: candidate.profile))
                .font(.title3.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button {
                runDetailsSnapshot = LoadRunDetailsSnapshot(
                    profile: candidate.profile,
                    timing: timing,
                    response: response,
                    result: candidate.result,
                    currencyCode: currencyCode,
                    timeZone: timeZone,
                    capturedAt: now
                )
            } label: {
                Image(systemName: "info.circle")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(LoadTimingPresentation.runDetailsAccessibilityLabel)
            .accessibilityHint("Shows the estimate and tariff calculation details")
        }

        switch candidate.result {
        case .estimate(let estimate):
            let summary = LoadTimingPresentation.runCardSummary(estimate, currencyCode: currencyCode, timeZone: timeZone)
            Text(summary.total)
                .font(.title3.weight(.bold))
                .monospacedDigit()
            Text(summary.finish)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            let impact = LoadTimingPresentation.energyImpact(candidate)
            VStack(alignment: .leading, spacing: 5) {
                Text(impact.surplusConsumed)
                Text(impact.energyBought)
                if let remaining = impact.remainingSurplus { Text(remaining) }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            if estimate.hasUnobservedBalance, let note = LoadTimingPresentation.missingBalanceNote(hasUnobservedBalance: true) {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .unavailable(let reason):
            Label(LoadTimingPresentation.unavailableMessage(reason), systemImage: "exclamationmark.triangle")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        case .noCharge:
            Label(LoadTimingPresentation.noChargeMessage, systemImage: "checkmark.circle")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }

        if let suggested = recommendation.suggested,
           LoadTimingPresentation.showsBackToSuggestion(explicitID: exploredProfileID, suggestedID: suggested.profile.id) {
            if let alternativeEstimate = candidate.estimate, let suggestedEstimate = suggested.estimate,
               let difference = LoadTimingPresentation.costDifference(alternativeCost: alternativeEstimate.total, suggestedCost: suggestedEstimate.total, currencyCode: currencyCode) {
                Text(difference)
                    .font(.subheadline.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Back to suggestion") { exploredProfileID = nil }
                .font(.body.weight(.semibold))
                .frame(minHeight: 44)
                .accessibilityHint("Return to the currently recommended load")
        }
    }

    private func observedPeriods(_ timing: LoadTiming) -> some View {
        LoadTimingCard(title: "Your energy periods", symbol: "chart.bar.fill") {
            if !timing.hasTariff {
                Text("No active tariff is configured for this site.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else if timing.periods.isEmpty {
                Text("Billing-cycle observation unavailable for all rate periods.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                adaptiveGrid(timing.periods.map { LoadTimingPeriodTile(period: $0, currencyCode: currencyCode) })
            }
        }
    }

    private func metadata(_ response: MobileBillResponse, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Billing cycle \(DashboardPresentation.date(response.currentBill.cycleStart, timeZoneIdentifier: timeZone, dateStyle: .short)) – \(DashboardPresentation.date(response.currentBill.cycleEnd, timeZoneIdentifier: timeZone, dateStyle: .short))")
            Text(LoadTimingPresentation.sourceTimeSummary(response.sources.energyDataThrough, timeZone: timeZone))
            Text("Calculated \(DashboardPresentation.date(response.sources.calculatedAt, timeZoneIdentifier: timeZone, dateStyle: .medium, timeStyle: .short))")
            Text(LoadTimingPresentation.sourceStatus(isUnavailable: coordinator.bill.isUnavailable, energyDataThrough: response.sources.energyDataThrough, now: now))
                .foregroundStyle(coordinator.bill.isUnavailable ? .orange : .secondary)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }

    private func adaptiveGrid(_ tiles: [LoadTimingPeriodTile]) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            AnyView(VStack(spacing: 9) { ForEach(tiles.indices, id: \.self) { tiles[$0] } })
        } else {
            AnyView(LazyVGrid(columns: [GridItem(.flexible(), spacing: 9), GridItem(.flexible(), spacing: 9)], spacing: 9) { ForEach(tiles.indices, id: \.self) { tiles[$0] } })
        }
    }
}

struct LoadRunDetailsSnapshot: Identifiable {
    let id = UUID()
    let profile: LoadProfile
    let timing: LoadTiming
    let response: MobileBillResponse?
    let result: LoadTimingEstimator.StartNowResult
    let currencyCode: String
    let timeZone: String
    let capturedAt: Date
}

private struct LoadRunDetailsSheet: View {
    let snapshot: LoadRunDetailsSnapshot

    private var profile: LoadProfile { snapshot.profile }
    private var timing: LoadTiming { snapshot.timing }
    private var response: MobileBillResponse? { snapshot.response }
    private var result: LoadTimingEstimator.StartNowResult { snapshot.result }
    private var currencyCode: String { snapshot.currencyCode }
    private var timeZone: String { snapshot.timeZone }

    @Environment(\.dismiss) private var dismiss

    private var observedBalances: [String: Double] { LoadTimingPresentation.observedBalances(timing) }
    private var unobservedKeys: Set<String> { Set(timing.tariffTimeline.map(\.periodKey)).subtracting(observedBalances.keys) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(profile.name)
                        .font(.title2.weight(.bold))
                    resultDetails
                    Text("How the estimate works")
                        .font(.headline)
                    Text("The estimate uses your current billing-cycle balance as a snapshot. That balance can change while the load is running.")
                        .foregroundStyle(.secondary)
                    if let message = LoadTimingPresentation.cycleObservationMessage(hasCycleData: timing.hasCycleData) {
                        detailLabel(message, symbol: "info.circle")
                    }
                    if let balance = LoadTimingPresentation.activeBalanceSummary(timing) {
                        detailLabel(balance, symbol: "bolt.circle")
                    }
                    if let response {
                        detailLabel(LoadTimingPresentation.sourceTimeSummary(response.sources.energyDataThrough, timeZone: timeZone), symbol: "clock")
                    }
                    if profile.kind == .car, let car = profile.carSettings {
                        carDetails(car)
                    }
                    if let cheaper = timing.nextCheaper {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Cheaper time")
                                .font(.headline)
                            Text("Lower marginal rate in \(DashboardPresentation.tariffPeriodTitle(cheaper.name)) · \(cheaper.phrase)")
                                .foregroundStyle(.secondary)
                            Text("This compares rates only; it does not promise a lower total cost.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Load run details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private var resultDetails: some View {
        switch result {
        case .estimate(let estimate):
            VStack(alignment: .leading, spacing: 10) {
                let summary = LoadTimingPresentation.startNowSummary(estimate, currencyCode: currencyCode, timeZone: timeZone)
                VStack(alignment: .leading, spacing: 5) {
                    Text(summary.total)
                        .font(.title3.weight(.bold))
                        .monospacedDigit()
                    Text(summary.finish)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Text(summary.energy)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let note = LoadTimingPresentation.missingBalanceNote(hasUnobservedBalance: estimate.hasUnobservedBalance) {
                    detailLabel(note, symbol: "info.circle")
                }
                if !estimate.segments.isEmpty {
                    Text("Tariff breakdown")
                        .font(.subheadline.weight(.semibold))
                    ForEach(Array(LoadTimingPresentation.breakdownRows(estimate.segments, currencyCode: currencyCode, unobservedPeriodKeys: unobservedKeys).enumerated()), id: \.offset) { index, row in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(DashboardPresentation.tariffPeriodTitle(row.periodKey)).fontWeight(.semibold)
                                Spacer()
                                Text(row.total).fontWeight(.bold).monospacedDigit()
                            }
                            Text("\(row.wallEnergy) · \(row.balance)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 6)
                        if index < estimate.segments.count - 1 { Divider() }
                    }
                }
            }
        case .unavailable(let reason):
            detailLabel(LoadTimingPresentation.unavailableMessage(reason), symbol: "exclamationmark.triangle")
        case .noCharge:
            detailLabel(LoadTimingPresentation.noChargeMessage, symbol: "checkmark.circle.fill")
        }
    }

    private func carDetails(_ car: CarLoadSettings) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Car charge")
                .font(.headline)
            Text("Current \(car.initialStateOfCharge.formatted(.number.precision(.fractionLength(0...1))))% · target \(car.targetStateOfCharge.formatted(.number.precision(.fractionLength(0...1))))% · Level \(car.chargingLevel == .level1 ? "1" : "2")")
                .foregroundStyle(.secondary)
            if let estimate = LoadTimingEstimator.carChargeEstimate(settings: car) {
                Text("About \(estimate.batteryKwh.formatted(.number.precision(.fractionLength(1)))) kWh added to the battery from \(estimate.wallKwh.formatted(.number.precision(.fractionLength(1)))) kWh at the wall.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func detailLabel(_ text: String, symbol: String) -> some View {
        Label(text, systemImage: symbol)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct LoadTimingPeriodTile: View {
    let period: LoadTimingPeriod
    let currencyCode: String

    private var balanceKwh: Double { -period.cycleNetExportKwh }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(DashboardPresentation.tariffPeriodTitle(period.name))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 4)
                if period.isActive {
                    Text("ACTIVE")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.indigo)
                }
            }
            Text(DashboardPresentation.loadRate(period.marginalCost, code: currencyCode))
                .font(.title3.weight(.bold))
                .foregroundStyle(period.marginalCost == nil ? .secondary : .primary)
                .minimumScaleFactor(0.75)
                .lineLimit(1)
            Text(DashboardPresentation.loadBalance(balanceKwh))
                .font(.caption)
                .foregroundStyle(balanceKwh < 0 ? .green : (balanceKwh > 0 ? .orange : .secondary))
            if let phrase = period.nextStartPhrase {
                Text("Next starts \(phrase)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 104, alignment: .leading)
        .padding(12)
        .background(Color.indigo.opacity(0.06), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(DashboardPresentation.tariffPeriodTitle(period.name))\(period.isActive ? ", active period" : ""), \(DashboardPresentation.loadRateAccessibilityLabel(period.marginalCost, code: currencyCode)), \(DashboardPresentation.loadBalanceAccessibilityLabel(balanceKwh))\(period.nextStartPhrase.map { ", next starts \($0)" } ?? "")")
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
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
