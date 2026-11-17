import SwiftUI

/// Payback section on Solar System, under Savings: what the system has paid back and when it pays for itself.
struct SolarSystemPaybackSection: View {
    let state: SavingsState
    let costs: SystemCostsDTO?
    let change: SolarHealthReport.ChangeOverTime?
    let currency: String
    let timeZone: TimeZone
    let onEditCosts: () -> Void
    var onCaveatAction: (SavingsCaveat.Action) -> Void = { _ in }

    var body: some View {
        if case .ready(let report) = state {
            Section("Payback") {
                if let costs, let result = PaybackCalculator.compute(
                    report: report, costs: costs, change: change, timeZone: timeZone, now: .now
                ) {
                    paybackRows(result)
                } else {
                    emptyRows
                }
            }
        }
    }

    private var emptyRows: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Enter what your system cost to see how much it has paid back and when it should pay for itself.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button("Enter System Costs", action: onEditCosts)
                .emphasisProminentButton()
        }
    }

    @ViewBuilder
    private func paybackRows(_ result: PaybackResult) -> some View {
        if let headline = result.combined ?? result.components.first {
            VStack(alignment: .leading, spacing: 8) {
                Text("Your system")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(PaybackPresentation.headline(headline, currency: currency))
                    .font(.subheadline.weight(.semibold))
                ProgressView(value: PaybackPresentation.progress(headline))
                    .tint(Color.emphasis)
                if let line = PaybackPresentation.breakEvenLine(headline.breakEven, timeZone: timeZone) {
                    Text(line)
                        .font(.subheadline.weight(.semibold))
                }
            }
            .padding(.vertical, 2)
        }
        ForEach(result.components, id: \.component) { payback in
            componentRow(payback)
            if payback.component == .powerwall, let note = PaybackPresentation.powerwallNeverNote(result) {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        if PaybackPresentation.showsAssumptions(result) {
            assumptions(result)
        }
        coverage(result)
        Button("Edit System Costs", action: onEditCosts)
    }

    private func componentRow(_ payback: ComponentPayback) -> some View {
        let lines = PaybackPresentation.componentLines(payback, currency: currency, timeZone: timeZone)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(lines.title)
                    .font(.subheadline)
                Spacer(minLength: 8)
                if let when = lines.when {
                    Text(when)
                        .font(.subheadline.weight(.semibold))
                        .multilineTextAlignment(.trailing)
                }
            }
            Text(lines.amount)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func assumptions(_ result: PaybackResult) -> some View {
        let hasPowerwall = result.components.contains { $0.component == .powerwall }
        return VStack(alignment: .leading, spacing: 3) {
            Text("Assumes")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            let lines = PaybackPresentation.assumptionLines(result.assumptions, hasPowerwall: hasPowerwall)
            ForEach(lines, id: \.self) { line in
                Text(verbatim: line)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func coverage(_ result: PaybackResult) -> some View {
        let parts = [
            SavingsPresentation.coverageLine(result.coverage),
            SavingsPresentation.estimatedShareLine(result.coverage)
        ].compactMap(\.self)
        Text(verbatim: parts.joined(separator: " · "))
            .font(.caption2)
            .foregroundStyle(.tertiary)
        SavingsCaveatRows(caveats: SavingsPresentation.caveats(result.coverage), onAction: onCaveatAction)
    }
}
