import SwiftUI

struct BillView: View {
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite

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
                    estimateCard(response)
                    periodsSection(response)
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
                    .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
                }
            }
            .padding(20)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .refreshable {
            await coordinator.refreshBill(trigger: .userGesture)
        }
        .background { SectionTheme.bill.screenBackground }
        .navigationTitle("Current Bill")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func estimateCard(_ response: MobileBillResponse) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Estimated bill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.indigo)
                Text(site.name)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Text(DashboardPresentation.currency(response.currentBill.estimatedCost, code: response.currentBill.currency))
                .font(.system(.title2, design: .rounded, weight: .bold))
                .monospacedDigit()
                .minimumScaleFactor(0.75)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private func periodsSection(_ response: MobileBillResponse) -> some View {
        BillInformationCard(title: "Tariff period balances", symbol: "chart.bar.fill") {
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
                            Text(DashboardPresentation.tariffBalance(period.netGridKwh))
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
                        .accessibilityLabel("\(DashboardPresentation.tariffPeriodTitle(period.periodName)), \(multipleTariffs ? "\(period.tariffName), " : "")\(DashboardPresentation.tariffBalance(period.netGridKwh)), estimated cost \(DashboardPresentation.currency(period.cost, code: response.currentBill.currency))")
                        if index < response.currentBill.periods.count - 1 { Divider() }
                    }
                }
            }
        }
    }

    private func billMetadata(_ response: MobileBillResponse) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Billing cycle \(DashboardPresentation.date(response.currentBill.cycleStart, timeZoneIdentifier: timeZone, dateStyle: .short))–\(DashboardPresentation.date(response.currentBill.cycleEnd, timeZoneIdentifier: timeZone, dateStyle: .short))")
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
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
