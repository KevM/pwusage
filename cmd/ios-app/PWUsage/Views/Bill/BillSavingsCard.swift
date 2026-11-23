import PWUsageCore
import SwiftUI

/// Card on the Bill tab showing current-cycle savings or a setup prompt that opens Rate Plans.
struct BillSavingsCard: View {
    let state: SavingsState
    let currency: String
    let hasRatePlans: Bool?
    let onOpenRatePlans: () -> Void
    var onCaveatAction: (SavingsCaveat.Action) -> Void = { _ in }

    var body: some View {
        switch state {
        case .ready(let report):
            if SavingsPresentation.showsCard(report.cycle) {
                ReadyBillSavingsCard(
                    figures: report.cycle,
                    currency: currency,
                    hasRatePlans: hasRatePlans,
                    onOpenRatePlans: onOpenRatePlans,
                    onCaveatAction: onCaveatAction
                )
            }
        case .notReady(.noReferencePlan):
            setupCard
        case .notReady:
            EmptyView()
        }
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

private struct ReadyBillSavingsCard: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let figures: SavingsFigures
    let currency: String
    let hasRatePlans: Bool?
    let onOpenRatePlans: () -> Void
    let onCaveatAction: (SavingsCaveat.Action) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if figures.daysWithData > 0 {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 6) {
                        headline
                        editButton
                    }
                } else {
                    HStack(alignment: .firstTextBaseline) {
                        headline
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

    private var headline: some View {
        Text(SavingsPresentation.cycleHeadline(figures, currency: currency))
            .font(.subheadline.weight(.semibold))
    }

    private var editButton: some View {
        Button(SavingsPresentation.ratePlansEntry(hasRatePlans: hasRatePlans).title, action: onOpenRatePlans)
            .font(.caption.weight(.medium))
    }
}

#Preview("Ready") {
    ReadyBillSavingsCard(
        figures: SavingsFigures(
            costs: ScenarioCosts(recorded: 40, batteryFixed: 40, solarAlone: 86, noSolar: 182),
            daysWithData: 18,
            daysInPeriod: 18
        ),
        currency: "USD",
        hasRatePlans: true,
        onOpenRatePlans: {},
        onCaveatAction: { _ in }
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
