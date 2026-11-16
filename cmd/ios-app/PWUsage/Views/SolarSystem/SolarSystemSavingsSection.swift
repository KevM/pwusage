import SwiftUI

/// Section in Solar System settings showing Past Year and Lifetime savings and fixed rate plan management.
struct SolarSystemSavingsSection: View {
    let state: SavingsState
    let currency: String
    let hasReferencePlan: Bool
    let onAddFixedRatePlan: () -> Void
    let onEditFixedRatePlan: () -> Void
    var onCaveatAction: (SavingsCaveat.Action) -> Void = { _ in }
    /// The estimate setup step still needed; its rows stay here even when the Home accessory is dismissed.
    var estimatePrompt: RateEstimatesPrompt?
    var estimateUtilityName: String?
    var onChooseEstimateSetup: (RateEstimatesPrompt) -> Void = { _ in }
    /// The may-be-outdated note for a fixed plan that covers today on estimated rates.
    var fixedPlanNote: String?

    var body: some View {
        Section("Savings") {
            if let estimatePrompt {
                RateEstimatesSetupRows(
                    prompt: estimatePrompt,
                    utilityName: estimateUtilityName,
                    onChoose: { onChooseEstimateSetup(estimatePrompt) }
                )
            }
            switch state {
            case .ready(let report):
                readyRows(report)
            case .notReady(.noReferencePlan):
                Text(
                    "Add a fixed rate plan to see how much your solar and Powerwall saved "
                        + "over the past year and lifetime."
                )
                .font(.subheadline)
                .foregroundStyle(.secondary)
                Button("Add Fixed Rate Plan", action: onAddFixedRatePlan)
            case .notReady(.flowsMissing):
                Text("Savings will appear once daily energy history has synced.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                planActionButton
            case .notReady(.noTimeline):
                Text("Add a rate plan to calculate savings.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func readyRows(_ report: SavingsReport) -> some View {
        if report.year.daysWithData > 0 {
            periodBlock(title: "Past Year", figures: report.year, alwaysShowCoverage: false)
        }
        if SavingsPresentation.showsCard(report.lifetime) {
            periodBlock(title: "Lifetime", figures: report.lifetime, alwaysShowCoverage: true)
        }
        if report.year.daysWithData == 0, !SavingsPresentation.showsCard(report.lifetime) {
            Text("No savings data for recorded days yet.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        if !SavingsPresentation.caveats(report.lifetime).contains(where: { $0.id == "fixed" }) {
            planActionButton
        }
    }

    private func periodBlock(
        title: String,
        figures: SavingsFigures,
        alwaysShowCoverage: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if figures.daysWithData > 0 {
                Text(SavingsPresentation.periodHeadline(figures, currency: currency))
                    .font(.subheadline.weight(.semibold))
                Text(SavingsPresentation.breakdownLine(figures, currency: currency))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(SavingsPresentation.fixedRateComparisonLine(figures, currency: currency))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let share = SavingsPresentation.estimatedShareLine(figures) {
                    Text(share)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if alwaysShowCoverage || figures.daysWithData < figures.daysInPeriod {
                Text(SavingsPresentation.coverageLine(figures))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if alwaysShowCoverage {
                SavingsCaveatRows(caveats: SavingsPresentation.caveats(figures), onAction: onCaveatAction)
            }
        }
        .padding(.vertical, 2)
    }

    private var planActionButton: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(
                hasReferencePlan ? "Edit Fixed Rate Plan" : "Add Fixed Rate Plan",
                action: hasReferencePlan ? onEditFixedRatePlan : onAddFixedRatePlan
            )
            if let fixedPlanNote {
                Text(fixedPlanNote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

#Preview("Ready") {
    let year = SavingsFigures(
        costs: ScenarioCosts(recorded: 500, batteryFixed: 500, solarAlone: 1060, noSolar: 2180),
        daysWithData: 365,
        daysInPeriod: 365
    )
    let life = SavingsFigures(
        costs: ScenarioCosts(recorded: 2000, batteryFixed: 2000, solarAlone: 5240, noSolar: 11420),
        daysWithData: 2914,
        daysInPeriod: 2950
    )
    return List {
        SolarSystemSavingsSection(
            state: .ready(SavingsReport(
                cycle: year,
                year: year,
                lifetime: life,
                cycleStart: .now,
                solarSinceInstall: life,
                powerwallSinceInstall: nil,
                recentCycles: [],
                batteryStartDay: nil
            )),
            currency: "USD",
            hasReferencePlan: true,
            onAddFixedRatePlan: {},
            onEditFixedRatePlan: {}
        )
    }
}
