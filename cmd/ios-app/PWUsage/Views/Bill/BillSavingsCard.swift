import SwiftUI

/// Card on the Bill tab showing current-cycle savings or a setup prompt that opens Rate Plans.
struct BillSavingsCard: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let state: SavingsState
    let currency: String
    let hasRatePlans: Bool?
    let onOpenRatePlans: () -> Void
    var onCaveatAction: (SavingsCaveat.Action) -> Void = { _ in }

    var body: some View {
        switch state {
        case .ready(let report):
            if SavingsPresentation.showsCard(report.cycle) {
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
            if figures.daysWithData > 0 {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 6) {
                        headline(figures)
                        editButton
                    }
                } else {
                    HStack(alignment: .firstTextBaseline) {
                        headline(figures)
                        Spacer(minLength: 8)
                        editButton
                    }
                }
                Text(SavingsPresentation.breakdownLine(figures, currency: currency))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("See what you’ve saved")
                    .font(.subheadline.weight(.semibold))
            }
            if figures.daysWithData < figures.daysInPeriod {
                Text(SavingsPresentation.coverageLine(figures))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if let share = SavingsPresentation.estimatedShareLine(figures) {
                Text(share)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            SavingsCaveatRows(caveats: SavingsPresentation.caveats(figures), onAction: onCaveatAction)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            SectionTheme.secondaryGroupedBackground,
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
    }

    private func headline(_ figures: SavingsFigures) -> some View {
        Text(SavingsPresentation.cycleHeadline(figures, currency: currency))
            .font(.subheadline.weight(.semibold))
    }

    private var editButton: some View {
        Button(SavingsPresentation.ratePlansEntry(hasRatePlans: hasRatePlans).title, action: onOpenRatePlans)
            .font(.caption.weight(.medium))
    }

    private var setupCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("See what you’ve saved")
                .font(.subheadline.weight(.semibold))
            Text(SavingsPresentation.billSetupPrompt)
                .font(.caption)
                .foregroundStyle(.secondary)
            Button(SavingsPresentation.ratePlansEntry(hasRatePlans: hasRatePlans).title, action: onOpenRatePlans)
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
        cycleStart: .now,
        solarSinceInstall: figures,
        powerwallSinceInstall: nil,
        cycles: [],
        recentCycles: [],
        batteryStartDay: nil,
        rateGrowth: .typical
    )
    return BillSavingsCard(
        state: .ready(report),
        currency: "USD",
        hasRatePlans: true,
        onOpenRatePlans: {}
    )
    .padding()
}

#Preview("Setup") {
    BillSavingsCard(
        state: .notReady(.noReferencePlan),
        currency: "USD",
        hasRatePlans: false,
        onOpenRatePlans: {}
    )
    .padding()
}
