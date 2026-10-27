import SwiftUI

struct BillView: View {
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite
    var isSelected = true
    var onOpenSmartShift: (() -> Void)? = nil
    @Environment(\.scenePhase) private var scenePhase

    private var state: DashboardEndpointState<MobileBillResponse> { coordinator.bill }
    private var response: MobileBillResponse? { coordinator.bill.response }
    private var timeZone: String { response?.site.timezone ?? "UTC" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if state.isUnavailable {
                    AvailabilityBanner(message: "The estimate could not be refreshed. Any amount shown keeps its original calculation time.", symbol: "clock.badge.exclamationmark")
                }
                if let response {
                    TimelineView(.periodic(from: .now, by: 60)) { _ in
                        outlook(response, now: .now)
                    }
                    billMetadata(response)
                } else if state.isUnavailable {
                    EmptyCard(symbol: "doc.text.magnifyingglass", title: "Bill estimate unavailable", message: "The server could not provide a current estimate. Try again when your connection is available.")
                } else {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Loading bill estimate")
                            .foregroundStyle(.secondary)
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
            await coordinator.refreshBill(trigger: .userGesture)
            await coordinator.billOutlookAppeared()
        }
        .task(id: "\(site.id)-\(isSelected)") {
            if isSelected { await coordinator.billOutlookAppeared() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && isSelected { Task { await coordinator.billOutlookAppeared() } }
        }
        .background { SectionTheme.bill.screenBackground }
        .navigationTitle("Current Bill")
        .inlineNavigationTitle()
    }

    @ViewBuilder private func outlook(_ response: MobileBillResponse, now: Date) -> some View {
        let context = coordinator.loadPlanningContext ?? coordinator.householdPattern
        let batch = coordinator.solarForecastBatch
        let usesSolar = coordinator.solarForecastState == .enhanced && batch.map {
            now.timeIntervalSince($0.fetchedAt) >= 0 && now.timeIntervalSince($0.fetchedAt) <= LoadTimingForecastPresentation.maximumForecastAge
        } == true
        let forecast = usesSolar ? batch?.intervals ?? [] : []
        let result: BillOutlook.ProjectionResult = {
            guard let history = response.outlook, let context, context.timeZone == timeZone,
                  !state.isUnavailable else { return .empty }
            return BillOutlook.evaluate(history: history, context: context, forecast: forecast, now: now,
                                        cycleEnd: response.currentBill.cycleEnd)
        }()
        let projected = result.points
        estimateCard(response, result: result, now: now)
        if let history = response.outlook, !history.points.isEmpty {
            BillOutlookChart(history: history, projected: projected, cycleStart: response.currentBill.cycleStart,
                             cycleEnd: response.currentBill.cycleEnd, now: now, timeZone: timeZone, currency: response.currentBill.currency,
                             totals: response.currentBill.periods)
            if projected.isEmpty && history.complete {
                Text("Forecast unavailable. Showing recorded energy with its original calculation time.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } else {
            periodsSection(response)
        }
    }

    private func estimateCard(_ response: MobileBillResponse, result: BillOutlook.ProjectionResult, now: Date) -> some View {
        let bill = response.currentBill
        let projected = result.points
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text("So far")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.indigo)
                Spacer(minLength: 8)
                Text(DashboardPresentation.currency(bill.estimatedCost, code: bill.currency))
                    .font(.system(.title, design: .rounded, weight: .bold))
                    .monospacedDigit()
                    .minimumScaleFactor(0.75)
                    .lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            if let end = projected.last {
                VStack(alignment: .leading, spacing: 3) {
                    Text(BillOutlookPresentation.projection(cost: end.estimatedCost, currency: bill.currency,
                                                            projectedEnd: end.date, timeZone: timeZone))
                        .font(.headline).monospacedDigit()
                    Text(result.usesSolar
                        ? (result.usesHistory ? "Solar forecast and typical home use, with recent grid history where the forecast ends." : "Based on the solar forecast and typical home use.")
                        : "Based on your recent grid history.")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
            if let deadline = BillOutlookPresentation.deadline(now: now, end: bill.cycleEnd, timeZone: timeZone) {
                Divider()
                VStack(alignment: .leading, spacing: 6) {
                    Label(deadline, systemImage: "calendar").font(.subheadline.weight(.semibold))
                    if projected.last?.date == bill.cycleEnd,
                       let guidance = BillOutlookPresentation.guidance(observed: response.outlook?.points.last, projected: projected.last) {
                        Text(guidance).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                    }
                    if let onOpenSmartShift { Button("Open Smart Shift", action: onOpenSmartShift).font(.subheadline) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(17)
        .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func periodsSection(_ response: MobileBillResponse) -> some View {
        BillInformationCard(title: "Rate period totals", symbol: "chart.bar.fill") {
            if response.currentBill.periods.isEmpty {
                Text("No period totals are available for this cycle yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
            } else {
                let multipleTariffs = Set(response.currentBill.periods.map(\.tariffName)).count > 1
                VStack(spacing: 0) {
                    ForEach(Array(response.currentBill.periods.enumerated()), id: \.offset) { index, period in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(DashboardPresentation.tariffPeriodTitle(period.periodName))
                                    .font(.subheadline.weight(.semibold))
                                Spacer(minLength: 8)
                                Text(DashboardPresentation.currency(period.cost, code: response.currentBill.currency))
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                                    .multilineTextAlignment(.trailing)
                            }
                            Text(BillOutlookPresentation.balance(period.netGridKwh))
                                .font(.system(.title2, design: .rounded, weight: .bold))
                                .monospacedDigit()
                                .foregroundStyle(balanceColor(period.netGridKwh))
                            if multipleTariffs {
                                Text(period.tariffName)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 11)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(DashboardPresentation.tariffPeriodTitle(period.periodName)), \(multipleTariffs ? "\(period.tariffName), " : "")\(BillOutlookPresentation.balance(period.netGridKwh)), estimated cost \(DashboardPresentation.currency(period.cost, code: response.currentBill.currency))")
                        if index < response.currentBill.periods.count - 1 { Divider() }
                    }
                }
            }
        }
    }

    private func billMetadata(_ response: MobileBillResponse) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Estimates cover energy charges and credits.")
            Text("\(site.name) · Billing cycle \(DashboardPresentation.date(response.currentBill.cycleStart, timeZoneIdentifier: timeZone, dateStyle: .short))–\(DashboardPresentation.date(response.currentBill.cycleEnd, timeZoneIdentifier: timeZone, dateStyle: .short))")
            if let energyDataThrough = response.sources.energyDataThrough {
                Text("Energy through \(DashboardPresentation.date(energyDataThrough, timeZoneIdentifier: timeZone, dateStyle: .short, timeStyle: .short))")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }

    private func balanceColor(_ netGridKwh: Double) -> Color {
        if netGridKwh < 0 { return .green }
        if netGridKwh > 0 { return .red }
        return .secondary
    }
}

private struct BillInformationCard<Content: View>: View {
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
        .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
