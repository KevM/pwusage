import SwiftUI

/// The verdict, cost bars, why line, legend, energy weather chart and notes, in
/// reading order. Renders a `SmartShiftVerdict` and nothing else, so previews and
/// `LoadTimingView` show the same card.
struct SmartShiftVerdictView: View {
    let verdict: SmartShiftVerdict
    let timeZone: String
    var onConnectSolcast: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verdict.headline)
                .font(.title3.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            SmartShiftCostBars(verdict: verdict)
            Text(verdict.why)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            EnergyWeatherLegend(verdict: verdict)
            EnergyWeatherChart(verdict: verdict, timeZone: timeZone)
            ForEach(Array(verdict.notes.enumerated()), id: \.offset) { _, note in
                noteView(note)
            }
        }
    }

    @ViewBuilder
    private func noteView(_ note: SmartShiftVerdict.Note) -> some View {
        switch note {
        case .connectSolcast:
            VStack(alignment: .leading, spacing: 6) {
                noteText(SmartShiftPresentation.connectSolcastNote)
                Button("Connect Solcast", systemImage: "sun.max", action: onConnectSolcast)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderless)
            }
        case .forecastState(let message):
            noteText(message)
        case .unobservedBalance:
            noteText(SmartShiftPresentation.unobservedBalanceNote)
        }
    }

    private func noteText(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
