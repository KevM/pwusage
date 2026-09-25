import SwiftUI

enum LoadTimingPresentation {
    enum RecommendationCue: Equatable {
        case noCycleData
        case nextCheaper(NextCheaperPeriod)
        case cheapestNow
        case message(String)
    }

    static func emptyMessage(hasTariff: Bool, hasCycleData: Bool) -> String? {
        guard hasTariff else { return "No active tariff is configured for this site." }
        guard !hasCycleData else { return nil }
        return "Recommendations will appear after energy is recorded in this billing cycle."
    }

    static func sourceStatus(isUnavailable: Bool, energyDataThrough: Date?, now: Date = .now) -> String {
        let freshness = DashboardPresentation.freshness(energyDataThrough, now: now, staleAfter: 60 * 60)
        if isUnavailable {
            return "Refresh unavailable · \(freshness.lowercased())"
        }
        return freshness
    }

    static func estimate(
        amount: Double,
        period: LoadTimingPeriod,
        selectedProfile: LoadTimingEstimator.Profile?
    ) -> LoadTimingEstimator.Cost {
        guard period.marginalCost != nil || period.basis == "unobserved" else {
            return LoadTimingEstimator.costToRun(amount, pricing: nil)
        }
        return LoadTimingEstimator.costToRun(
            amount,
            pricing: .init(surplusKwh: period.cycleNetExportKwh, buyRate: period.buyRate, sellRate: period.sellRate),
            headroomKwh: selectedProfile?.headroomKwh
        )
    }

    static func coverageSummary(_ cost: LoadTimingEstimator.Cost) -> String {
        guard cost.verdict != .unknown else { return "Coverage unavailable" }
        return "\(cost.coveredKwh.formatted(.number.precision(.fractionLength(1)))) kWh covered · \(cost.boughtKwh.formatted(.number.precision(.fractionLength(1)))) kWh bought"
    }

    static func recommendationCue(_ timing: LoadTiming) -> RecommendationCue {
        guard timing.hasCycleData else { return .noCycleData }
        if let nextCheaper = timing.nextCheaper { return .nextCheaper(nextCheaper) }
        if timing.activeIsCheapest { return .cheapestNow }
        return .message(timing.nextCheaperPhrase ?? "No cheaper period is available in the current schedule.")
    }
}

struct LoadTimingView: View {
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var selectedProfileID: String? = LoadTimingEstimator.profiles.first?.id
    @State private var customAmount = 20.0

    private var response: MobileBillResponse? { coordinator.bill.response }
    private var timing: LoadTiming? { response?.loadTiming }
    private var selectedProfile: LoadTimingEstimator.Profile? {
        LoadTimingEstimator.profiles.first { $0.id == selectedProfileID }
    }
    private var selectedAmount: Double { selectedProfile?.kwh ?? LoadTimingEstimator.customAmount(customAmount) }
    private var currencyCode: String { response?.currentBill.currency ?? "USD" }
    private var timeZone: String { response?.site.timezone ?? "UTC" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if coordinator.bill.isUnavailable {
                    AvailabilityBanner(message: "Load timing could not be refreshed. Showing the last successful cycle snapshot with its original source time.", symbol: "clock.badge.exclamationmark")
                }
                if let response, let timing {
                    if !timing.hasTariff {
                        EmptyCard(symbol: "tag.slash", title: "Load timing unavailable", message: LoadTimingPresentation.emptyMessage(hasTariff: false, hasCycleData: false) ?? "")
                    } else {
                        recommendation(timing)
                        observedPeriods(timing)
                        estimator(timing)
                    }
                    metadata(response)
                } else if coordinator.bill.isUnavailable {
                    EmptyCard(symbol: "chart.bar.xaxis", title: "Load timing unavailable", message: "The server could not provide tariff period details. Try again when your connection is available.")
                } else {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Loading load timing")
                            .foregroundStyle(.secondary)
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
        .refreshable {
            await coordinator.refreshBill()
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Load timing")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func recommendation(_ timing: LoadTiming) -> some View {
        LoadTimingCard(title: "When to run a load", symbol: "clock.arrow.circlepath") {
            switch LoadTimingPresentation.recommendationCue(timing) {
            case .noCycleData:
                Text("Recommendations need energy recorded during this billing cycle.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            case .nextCheaper(let next):
                VStack(alignment: .leading, spacing: 4) {
                    Text("Wait for \(DashboardPresentation.tariffPeriodTitle(next.name))")
                        .font(.headline)
                    Text("\(DashboardPresentation.loadRate(next.marginalCost, code: currencyCode)) · \(next.phrase)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            case .cheapestNow:
                Label("Now is the cheapest observed period", systemImage: "checkmark.circle.fill")
                    .font(.headline)
                    .foregroundStyle(.green)
                    .accessibilityElement(children: .combine)
            case .message(let message):
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func observedPeriods(_ timing: LoadTiming) -> some View {
        LoadTimingCard(title: "Observed this cycle", symbol: "chart.bar.fill") {
            if timing.periods.isEmpty {
                Text("No tariff periods have cycle observations yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                adaptiveGrid(timing.periods.map { period in
                    LoadTimingPeriodTile(period: period, currencyCode: currencyCode)
                })
            }
        }
    }

    private func estimator(_ timing: LoadTiming) -> some View {
        LoadTimingCard(title: "Can I run this now?", symbol: "bolt.fill") {
            VStack(alignment: .leading, spacing: 15) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { presetButtons; customButton }
                    VStack(alignment: .leading, spacing: 8) { presetButtons; customButton }
                }
                if selectedProfile == nil {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text("Custom load")
                            Spacer()
                            Text("\(selectedAmount, specifier: "%.0f") kWh")
                                .monospacedDigit()
                        }
                        Slider(value: $customAmount, in: 1...100, step: 1) {
                            Text("Custom load size")
                        } minimumValueLabel: {
                            Text("1")
                        } maximumValueLabel: {
                            Text("100")
                        }
                        .accessibilityLabel("Custom load size")
                        .accessibilityValue("\(Int(selectedAmount)) kilowatt-hours")
                    }
                }
                Divider()
                if timing.pricingPeriods.isEmpty {
                    Text("Period pricing is unavailable for the current schedule.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(timing.pricingPeriods.enumerated()), id: \.offset) { index, period in
                            estimateRow(period)
                            if index < timing.pricingPeriods.count - 1 { Divider() }
                        }
                    }
                }
            }
        }
    }

    private var presetButtons: some View {
        ForEach(LoadTimingEstimator.profiles) { profile in
            Button {
                selectedProfileID = profile.id
            } label: {
                Text(profile.label)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .foregroundStyle(selectedProfileID == profile.id ? Color.white : Color.primary)
                    .background(selectedProfileID == profile.id ? Color.indigo : Color(uiColor: .tertiarySystemGroupedBackground), in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(profile.label), \(Int(profile.kwh)) kilowatt-hours")
            .accessibilityAddTraits(selectedProfileID == profile.id ? .isSelected : [])
        }
    }

    private var customButton: some View {
        Button {
            selectedProfileID = nil
        } label: {
            Text("Custom")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .foregroundStyle(selectedProfileID == nil ? Color.white : Color.primary)
                .background(selectedProfileID == nil ? Color.indigo : Color(uiColor: .tertiarySystemGroupedBackground), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selectedProfileID == nil ? .isSelected : [])
    }

    private func estimateRow(_ period: LoadTimingPeriod) -> some View {
        let estimate = LoadTimingPresentation.estimate(amount: selectedAmount, period: period, selectedProfile: selectedProfile)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(DashboardPresentation.tariffPeriodTitle(period.name))
                            .font(.subheadline.weight(.semibold))
                        if period.isActive {
                            Text("ACTIVE")
                                .font(.system(size: 9, weight: .bold))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 3)
                                .background(Color.indigo.opacity(0.12), in: Capsule())
                                .foregroundStyle(.indigo)
                        }
                    }
                    let unitRate = period.marginalCost ?? (period.basis == "unobserved" ? period.buyRate : nil)
                    Text("\(period.basis == "unobserved" ? "Buy rate · " : "")\(DashboardPresentation.loadRate(unitRate, code: currencyCode))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let phrase = timing?.nextStartPhraseByKey[period.name] {
                        Text("Starts \(phrase)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if let phrase = period.nextStartPhrase {
                        Text("Starts \(phrase)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                Text(estimate.total.map { DashboardPresentation.currency($0, code: currencyCode) } ?? "Unavailable")
                    .font(.subheadline.weight(.bold))
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
            }
            Text(verdictText(estimate.verdict))
                .font(.caption.weight(.medium))
                .foregroundStyle(verdictColor(estimate.verdict))
            coveredBar(estimate, amount: selectedAmount)
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(DashboardPresentation.tariffPeriodTitle(period.name)), \(verdictText(estimate.verdict)), estimated cost \(estimate.total.map { DashboardPresentation.currency($0, code: currencyCode) } ?? "unavailable")")
    }

    private func coveredBar(_ estimate: LoadTimingEstimator.Cost, amount: Double) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            GeometryReader { geometry in
                let coveredFraction = amount > 0 ? min(max(estimate.coveredKwh / amount, 0), 1) : 0
                HStack(spacing: 0) {
                    if estimate.verdict == .unknown {
                        Rectangle().fill(Color.secondary.opacity(0.18))
                    } else {
                        Rectangle().fill(.green).frame(width: geometry.size.width * coveredFraction)
                        Rectangle().fill(.orange.opacity(0.75))
                    }
                }
            }
            .frame(height: 8)
            .clipShape(Capsule())
            Text(LoadTimingPresentation.coverageSummary(estimate))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(estimate.verdict == .unknown ? "Coverage unavailable" : "\(estimate.coveredKwh.formatted(.number.precision(.fractionLength(1)))) kilowatt-hours covered, \(estimate.boughtKwh.formatted(.number.precision(.fractionLength(1)))) kilowatt-hours bought")
    }

    private func metadata(_ response: MobileBillResponse) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Billing cycle \(DashboardPresentation.date(response.currentBill.cycleStart, timeZoneIdentifier: timeZone, dateStyle: .short)) – \(DashboardPresentation.date(response.currentBill.cycleEnd, timeZoneIdentifier: timeZone, dateStyle: .short))")
            Text("Energy through \(response.sources.energyDataThrough.map { DashboardPresentation.date($0, timeZoneIdentifier: timeZone, dateStyle: .medium, timeStyle: .short) } ?? "time unavailable")")
            Text("Calculated \(DashboardPresentation.date(response.sources.calculatedAt, timeZoneIdentifier: timeZone, dateStyle: .medium, timeStyle: .short))")
            Text(LoadTimingPresentation.sourceStatus(isUnavailable: coordinator.bill.isUnavailable, energyDataThrough: response.sources.energyDataThrough))
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

    private func verdictText(_ verdict: LoadTimingEstimator.Verdict) -> String {
        switch verdict {
        case .covered: "Covered by cycle surplus"
        case .tight: "Surplus covers this load, with limited headroom"
        case .partial: "Partly covered by cycle surplus"
        case .bought: "Purchased at the buy rate"
        case .unknown: "Cost estimate unavailable"
        }
    }

    private func verdictColor(_ verdict: LoadTimingEstimator.Verdict) -> Color {
        switch verdict {
        case .covered: .green
        case .tight: .orange
        case .partial: .orange
        case .bought: .secondary
        case .unknown: .secondary
        }
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
    let title: String
    let symbol: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Label(title, systemImage: symbol)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            content
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
