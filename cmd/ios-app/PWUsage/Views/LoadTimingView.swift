import SwiftUI

enum LoadTimingPresentation {
    enum DetailState: Equatable {
        case loading
        case ready
        case unavailable(String)
    }

    static func actionTitle(for affordance: LoadTimingAffordance) -> String {
        switch affordance.state {
        case .allowed(let choice):
            switch choice {
            case .dishwasher: return "Dishwasher"
            case .laundry: return "Laundry"
            case .car: return "Car charge"
            }
        case .caution:
            return "Avoid large loads"
        case .awaitingActiveBalance:
            return "Balance not recorded yet"
        }
    }

    static func actionContext(for affordance: LoadTimingAffordance) -> String {
        guard let periodName = affordance.periodName, let balance = affordance.balanceKwh else {
            return "This period's balance is not recorded yet."
        }
        let direction = balance > 0 ? "Surplus" : (balance < 0 ? "Deficit" : "Balanced")
        let amount = abs(balance).formatted(.number.precision(.fractionLength(0...1)))
        return "\(DashboardPresentation.tariffPeriodTitle(periodName)) · \(direction) \(amount) kWh"
    }

    static func actionNextStep(for affordance: LoadTimingAffordance) -> String? {
        guard let next = affordance.nextUnmet else { return nil }
        let name: String
        switch next.choice {
        case .dishwasher: name = "Dishwasher"
        case .laundry: name = "Laundry"
        case .car: name = "Car charge"
        }
        let shortfall = next.shortfallKwh.formatted(.number.precision(.fractionLength(0...1)))
        return "\(name) needs \(shortfall) kWh more"
    }

    static func actionCheaperAdvice(_ next: NextCheaperPeriod?, currencyCode: String) -> String? {
        guard let next else { return nil }
        let rate = DashboardPresentation.loadRate(next.marginalCost, code: currencyCode)
        return "Cheaper: \(DashboardPresentation.tariffPeriodTitle(next.name)) · \(rate) · \(next.phrase)"
    }

    static func actionAccessibilityLabel(for affordance: LoadTimingAffordance, currencyCode: String = "USD") -> String {
        let title = actionTitle(for: affordance)
        let context: String
        if let periodName = affordance.periodName, let balance = affordance.balanceKwh {
            context = "\(DashboardPresentation.tariffPeriodTitle(periodName)), \(DashboardPresentation.liveLoadBalanceAccessibilityLabel(balance))"
        } else {
            context = actionContext(for: affordance)
        }
        let nextStep = actionNextStep(for: affordance).map { ", \($0)" } ?? ""
        let cheaper: String
        if let next = affordance.nextCheaper {
            let rate = DashboardPresentation.loadRateAccessibilityLabel(next.marginalCost, code: currencyCode)
            cheaper = ", Cheaper in \(DashboardPresentation.tariffPeriodTitle(next.name)), \(rate), \(next.phrase)"
        } else {
            cheaper = ""
        }
        return "Can run now. \(title). \(context)\(nextStep)\(cheaper)"
    }

    static func emptyMessage(hasTariff: Bool, hasCycleData: Bool) -> String? {
        guard hasTariff else { return "No active tariff is configured for this site." }
        guard !hasCycleData else { return nil }
        return "Recommendations will appear after energy is recorded in this billing cycle."
    }

    static func detailState(hasBillResponse: Bool, hasLoadTiming: Bool, isUnavailable: Bool) -> DetailState {
        if hasBillResponse {
            return hasLoadTiming ? .ready : .unavailable("Configure a tariff or check its rates on the website to make load timing available.")
        }
        if isUnavailable {
            return .unavailable("The server could not provide tariff period details. Try again when your connection is available.")
        }
        return .loading
    }

    static func orderedPricingPeriods(_ periods: [LoadTimingPeriod]) -> [LoadTimingPeriod] {
        periods.enumerated()
            .sorted { lhs, rhs in
                if lhs.element.isActive != rhs.element.isActive {
                    return lhs.element.isActive
                }
                return lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    static func shouldShowEstimator(hasCycleData: Bool) -> Bool {
        hasCycleData
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

    static func estimateAccessibilityLabel(
        period: LoadTimingPeriod,
        estimate: LoadTimingEstimator.Cost,
        startPhrase: String?,
        verdict: String,
        currencyCode: String,
        locale: Locale = .current
    ) -> String {
        let title = DashboardPresentation.tariffPeriodTitle(period.name)
        let unitRate = period.marginalCost ?? (period.basis == "unobserved" ? period.buyRate : nil)
        let rate = DashboardPresentation.loadRateAccessibilityLabel(unitRate, code: currencyCode, locale: locale)
        let spokenRate = period.basis == "unobserved" ? "Buy rate, \(rate)" : rate
        let start = period.isActive ? "Currently active" : startPhrase.map { "Starts \($0)" } ?? "Start time unavailable"
        let total = estimate.total.map { DashboardPresentation.currency($0, code: currencyCode, locale: locale) } ?? "unavailable"
        let coverage: String
        if estimate.verdict == .unknown {
            coverage = "Coverage unavailable"
        } else {
            coverage = "\(estimate.coveredKwh.formatted(.number.precision(.fractionLength(1)))) kilowatt-hours covered, \(estimate.boughtKwh.formatted(.number.precision(.fractionLength(1)))) kilowatt-hours bought"
        }
        return "\(title), \(spokenRate), \(start), \(verdict), estimated cost \(total), \(coverage)"
    }

}

struct LoadTimingView: View {
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var isNumericInputFocused: Bool
    @State private var selectedProfileID: String? = "car"
    @State private var customAmount = 20.0
    @State private var batteryCapacityKwh = 60.0
    @State private var currentChargePercent = 20.0
    @State private var targetChargePercent = 80.0

    private var response: MobileBillResponse? { coordinator.bill.response }
    private var timing: LoadTiming? { response?.loadTiming }
    private var selectedProfile: LoadTimingEstimator.Profile? {
        if selectedProfileID == "car" {
            let plannedKwh = selectedAmount
            return .init(id: "car", label: "Car", kwh: plannedKwh, headroomKwh: LoadTimingEstimator.carHeadroomKwh(plannedKwh: plannedKwh))
        }
        return LoadTimingEstimator.profiles.first { $0.id == selectedProfileID }
    }
    private var selectedAmount: Double {
        if selectedProfileID == "car" {
            return LoadTimingEstimator.carChargeKwh(capacityKwh: batteryCapacityKwh, currentPercent: currentChargePercent, targetPercent: wholePercentTargetCharge)
        }
        return selectedProfile?.kwh ?? LoadTimingEstimator.customAmount(customAmount)
    }
    private var plannedCarKwh: Double {
        LoadTimingEstimator.carChargeKwh(capacityKwh: batteryCapacityKwh, currentPercent: currentChargePercent, targetPercent: wholePercentTargetCharge)
    }
    private var wholePercentTargetCharge: Double {
        LoadTimingEstimator.chargeTargetPercent(targetPercent: targetChargePercent, currentPercent: currentChargePercent)
    }
    private var targetChargeSliderValue: Binding<Double> {
        Binding(
            get: { wholePercentTargetCharge },
            set: { targetChargePercent = LoadTimingEstimator.chargeTargetPercent(targetPercent: $0, currentPercent: currentChargePercent) }
        )
    }
    private var isCustomSelected: Bool { selectedProfileID == nil }
    private var currencyCode: String { response?.currentBill.currency ?? "USD" }
    private var timeZone: String { response?.site.timezone ?? "UTC" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if coordinator.bill.isUnavailable {
                    AvailabilityBanner(message: "Load timing could not be refreshed. Showing the last successful cycle snapshot with its original source time.", symbol: "clock.badge.exclamationmark")
                }
                if let response {
                    if let timing {
                        if !timing.hasTariff {
                            EmptyCard(symbol: "tag.slash", title: "Load timing unavailable", message: LoadTimingPresentation.emptyMessage(hasTariff: false, hasCycleData: false) ?? "")
                        } else {
                            actionPanel(timing)
                            observedPeriods(timing)
                            if LoadTimingPresentation.shouldShowEstimator(hasCycleData: timing.hasCycleData) {
                                estimator(timing)
                            }
                        }
                    } else if case .unavailable(let message) = LoadTimingPresentation.detailState(hasBillResponse: true, hasLoadTiming: false, isUnavailable: coordinator.bill.isUnavailable) {
                        EmptyCard(symbol: "tag.slash", title: "Load timing unavailable", message: message)
                    }
                    metadata(response)
                } else if case .unavailable(let message) = LoadTimingPresentation.detailState(hasBillResponse: false, hasLoadTiming: false, isUnavailable: coordinator.bill.isUnavailable) {
                    EmptyCard(symbol: "chart.bar.xaxis", title: "Load timing unavailable", message: message)
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
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { isNumericInputFocused = false }
            }
        }
    }

    private func actionPanel(_ timing: LoadTiming) -> some View {
        let affordance = LoadTimingAffordance.evaluate(timing: timing, plannedCarKwh: plannedCarKwh)
        let tint: Color = {
            switch affordance.state {
            case .allowed: return .green
            case .caution: return .orange
            case .awaitingActiveBalance: return .secondary
            }
        }()
        return VStack(alignment: .leading, spacing: 10) {
            Text("Can run now")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: affordance.state == .caution ? "exclamationmark.triangle.fill" : "bolt.fill")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(tint)
                    .padding(.top, 3)
                Text(LoadTimingPresentation.actionTitle(for: affordance))
                    .font(.largeTitle.weight(.bold))
                    .foregroundStyle(tint)
                    .fixedSize(horizontal: false, vertical: true)
                    .minimumScaleFactor(0.75)
            }
            Text(LoadTimingPresentation.actionContext(for: affordance))
                .font(.subheadline.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
            if let nextStep = LoadTimingPresentation.actionNextStep(for: affordance) {
                Text(nextStep)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let advice = LoadTimingPresentation.actionCheaperAdvice(affordance.nextCheaper, currencyCode: currencyCode) {
                Label(advice, systemImage: "clock.arrow.circlepath")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(LoadTimingPresentation.actionAccessibilityLabel(for: affordance, currencyCode: currencyCode))
    }

    private func observedPeriods(_ timing: LoadTiming) -> some View {
        LoadTimingCard(title: "Your energy balance", symbol: "chart.bar.fill") {
            Text("By rate period this billing cycle")
                .font(.subheadline)
                .foregroundStyle(.secondary)
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
            VStack(alignment: .leading, spacing: 11) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        carButton
                        presetButtons
                        customButton
                    }
                    .fixedSize(horizontal: true, vertical: false)
                }
                if selectedProfileID == "car" {
                    VStack(alignment: .leading, spacing: 7) {
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 12) {
                                compactNumberField("Battery", value: $batteryCapacityKwh, range: 1...200, fallback: 60, unit: "kWh")
                                compactNumberField("Current", value: $currentChargePercent, range: 0...100, fallback: 20, unit: "%")
                            }
                            VStack(alignment: .leading, spacing: 4) {
                                compactNumberField("Battery", value: $batteryCapacityKwh, range: 1...200, fallback: 60, unit: "kWh")
                                compactNumberField("Current", value: $currentChargePercent, range: 0...100, fallback: 20, unit: "%")
                            }
                        }
                        if currentChargePercent < 100 {
                            HStack {
                                Text("Charge to")
                                Spacer()
                                Text("\(Int(wholePercentTargetCharge))%")
                                    .monospacedDigit()
                            }
                            .font(.subheadline)
                            Slider(value: targetChargeSliderValue, in: ((currentChargePercent / 10).rounded(.up) * 10)...100) {
                                Text("Charge to")
                            }
                            .accessibilityLabel("Charge to")
                            .accessibilityValue("\(Int(wholePercentTargetCharge)) percent")
                        } else {
                            Text("At 100% charge")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Text("\(selectedAmount, specifier: "%.1f") kWh energy to add, approximate; charging losses excluded")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("Approximately \(selectedAmount.formatted(.number.precision(.fractionLength(1)))) kilowatt-hours to add; charging losses excluded")
                    }
                    .onChange(of: currentChargePercent) { _, current in
                        targetChargePercent = max(targetChargePercent, current)
                    }
                } else if isCustomSelected {
                    compactNumberField("Custom load", value: $customAmount, range: 1...100, fallback: 20, unit: "kWh")
                }
                if selectedProfileID == "car" && !LoadTimingEstimator.shouldEstimateCarCharge(selectedAmount) {
                    Label("No charging needed at this target", systemImage: "checkmark.circle.fill")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.green)
                        .accessibilityElement(children: .combine)
                } else if timing.pricingPeriods.isEmpty {
                    Divider()
                    Text("Period pricing is unavailable for the current schedule.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    Divider()
                    VStack(spacing: 0) {
                        let orderedPeriods = LoadTimingPresentation.orderedPricingPeriods(timing.pricingPeriods)
                        ForEach(Array(orderedPeriods.enumerated()), id: \.offset) { index, period in
                            estimateRow(period)
                            if index < orderedPeriods.count - 1 { Divider() }
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

    private var carButton: some View {
        Button { selectedProfileID = "car" } label: {
            Text("Car")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .foregroundStyle(selectedProfileID == "car" ? Color.white : Color.primary)
                .background(selectedProfileID == "car" ? Color.indigo : Color(uiColor: .tertiarySystemGroupedBackground), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Car charge estimate")
        .accessibilityAddTraits(selectedProfileID == "car" ? .isSelected : [])
    }

    private func compactNumberField(_ title: String, value: Binding<Double>, range: ClosedRange<Double>, fallback: Double, unit: String) -> some View {
        HStack(spacing: 5) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField(title, value: value, format: .number.precision(.fractionLength(0)))
                .keyboardType(.numberPad)
                .focused($isNumericInputFocused)
                .multilineTextAlignment(.trailing)
                .monospacedDigit()
                .frame(minWidth: 38, maxWidth: 64)
                .padding(.horizontal, 7)
                .padding(.vertical, 6)
                .background(Color(uiColor: .tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 7))
                .accessibilityLabel(title == "Battery" ? "Battery capacity in kilowatt-hours" : title == "Current" ? "Current charge percent" : "Custom load size in kilowatt-hours")
            Text(unit)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .onChange(of: value.wrappedValue) { _, newValue in
            value.wrappedValue = LoadTimingEstimator.boundedInput(newValue, fallback: fallback, range: range)
        }
        .accessibilityValue("\(Int(LoadTimingEstimator.boundedInput(value.wrappedValue, fallback: fallback, range: range))) \(unit == "kWh" ? "kilowatt-hours" : "percent")")
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
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(LoadTimingPresentation.coverageSummary(estimate))
                    .foregroundStyle(.secondary)
                Text("·")
                    .foregroundStyle(.tertiary)
                Text(verdictText(estimate.verdict))
                    .foregroundStyle(verdictColor(estimate.verdict))
            }
            .font(.caption)
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(LoadTimingPresentation.estimateAccessibilityLabel(
            period: period,
            estimate: estimate,
            startPhrase: timing?.nextStartPhraseByKey[period.name] ?? period.nextStartPhrase,
            verdict: verdictText(estimate.verdict),
            currencyCode: currencyCode
        ))
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
