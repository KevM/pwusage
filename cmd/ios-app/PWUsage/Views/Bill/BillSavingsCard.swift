import SwiftUI

/// Card on the Bill tab showing current-cycle savings or a setup prompt for a fixed rate plan.
struct BillSavingsCard: View {
    let state: SavingsState
    let currency: String
    let onAddFixedRatePlan: () -> Void
    let onEditFixedRatePlan: () -> Void

    var body: some View {
        switch state {
        case .ready(let report):
            if report.cycle.daysWithData > 0 {
                readyCard(report.cycle)
            }
        case .notReady(.noReferencePlan):
            setupCard
        case .notReady:
            EmptyView()
        }
    }

    private func readyCard(_ figures: SavingsFigures) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(SavingsPresentation.cycleHeadline(figures, currency: currency))
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: 8)
                Button("Edit Plan", action: onEditFixedRatePlan)
                    .font(.caption.weight(.medium))
            }
            Text(SavingsPresentation.breakdownLine(figures, currency: currency))
                .font(.caption)
                .foregroundStyle(.secondary)
            if figures.daysWithData < figures.daysInPeriod {
                Text(SavingsPresentation.coverageLine(figures))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            SectionTheme.secondaryGroupedBackground,
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
    }

    private var setupCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("See what you’ve saved")
                .font(.subheadline.weight(.semibold))
            Text("Add the fixed rate plan you’d pay without solar or Time-of-Use pricing.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Add Fixed Rate Plan", action: onAddFixedRatePlan)
                .emphasisProminentButton()
                .controlSize(.small)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            SectionTheme.secondaryGroupedBackground,
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
    }
}

#Preview("Ready") {
    let figures = SavingsFigures(
        costs: ScenarioCosts(recorded: 40, batteryFixed: 40, solarAlone: 86, noSolar: 182),
        daysWithData: 18,
        daysInPeriod: 18
    )
    let report = SavingsReport(
        cycle: figures,
        year: figures,
        lifetime: figures,
        cycleStart: .now
    )
    return BillSavingsCard(
        state: .ready(report),
        currency: "USD",
        onAddFixedRatePlan: {},
        onEditFixedRatePlan: {}
    )
    .padding()
}

#Preview("Setup") {
    BillSavingsCard(
        state: .notReady(.noReferencePlan),
        currency: "USD",
        onAddFixedRatePlan: {},
        onEditFixedRatePlan: {}
    )
    .padding()
}
