import SwiftUI

/// What sits behind the header's estimate, kept out of the way until someone asks.
struct BillEstimateDetails {
    let basis: String?
    let periods: [Period]
    let currency: String
}

struct BillEstimateDetailsSheet: View {
    let details: BillEstimateDetails
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let basis = details.basis {
                        Text(basis)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    BillRatePeriodTotals(periods: details.periods, currency: details.currency)
                    Text("Estimates cover energy charges and credits.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(20)
            }
            .background { SectionTheme.groupedBackground.ignoresSafeArea() }
            .navigationTitle("About This Estimate")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

struct BillRatePeriodTotals: View {
    let periods: [Period]
    let currency: String

    var body: some View {
        CardContainer(title: "Rate period totals", symbol: "chart.bar.fill") {
            if periods.isEmpty {
                Text("No period totals are available for this cycle yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(periods.enumerated()), id: \.offset) { index, period in
                        row(period)
                        if index < periods.count - 1 { Divider() }
                    }
                }
            }
        }
    }

    private var multipleTariffs: Bool { Set(periods.map(\.tariffName)).count > 1 }

    /// Dollars lead here, since the charts already show the energy. The dot matches the charts' bands.
    private func row(_ period: Period) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(DashboardPresentation.tariffPeriodTitle(period.periodName))
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: 8)
                Text(DashboardPresentation.currency(period.cost, code: currency))
                    .font(.headline)
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
            }
            HStack(spacing: 6) {
                Circle()
                    .fill(balanceColor(period.netGridKwh))
                    .frame(width: 8, height: 8)
                Text(BillOutlookPresentation.balance(period.netGridKwh))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            if multipleTariffs {
                Text(period.tariffName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 11)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label(period))
    }

    private func label(_ period: Period) -> String {
        let title = DashboardPresentation.tariffPeriodTitle(period.periodName)
        let tariff = multipleTariffs ? "\(period.tariffName), " : ""
        let balance = BillOutlookPresentation.balance(period.netGridKwh)
        let cost = DashboardPresentation.currency(period.cost, code: currency)
        return "\(title), \(tariff)\(balance), estimated cost \(cost)"
    }

    private func balanceColor(_ netGridKwh: Double) -> Color {
        if netGridKwh < 0 { return EnergyWeatherChart.bankedColor }
        if netGridKwh > 0 { return EnergyWeatherChart.owedColor }
        return .secondary
    }
}
