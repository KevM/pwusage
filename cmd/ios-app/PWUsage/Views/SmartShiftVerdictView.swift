import SwiftUI

/// The verdict, cost bars, why line, legend, energy weather chart and notes, in
/// reading order. Renders a `SmartShiftVerdict` and nothing else, so previews and
/// `LoadTimingView` show the same card.
struct SmartShiftVerdictView: View {
    let verdict: SmartShiftVerdict
    let timeZone: String
    var onConnectSolcast: () -> Void = {}

    /// Bar column width beside the why line: about a phone's worth, so a small
    /// saving still shows as a visible gap.
    static let sideBySideBars: ClosedRange<CGFloat> = 300...380
    /// Narrowest the why line gets beside the bars; below this they stack.
    static let sideBySideWhyMinWidth: CGFloat = 420
    static let sideBySideSpacing: CGFloat = 24

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var width: CGFloat = 0

    /// Wide enough for a prose column with the bars beside it, where
    /// full-width bars would stretch a small saving into an unreadable sliver.
    /// Accessibility text sizes stay stacked: the breakpoint assumes default-size labels.
    private var barsBesideWhy: Bool {
        !dynamicTypeSize.isAccessibilitySize
            && width >= Self.sideBySideWhyMinWidth + Self.sideBySideSpacing + Self.sideBySideBars.lowerBound
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verdict.headline)
                .font(.title3.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if barsBesideWhy {
                HStack(alignment: .top, spacing: Self.sideBySideSpacing) {
                    why
                    SmartShiftCostBars(verdict: verdict)
                        .frame(minWidth: Self.sideBySideBars.lowerBound, maxWidth: Self.sideBySideBars.upperBound)
                        // Bars before the why line, as when stacked.
                        .accessibilitySortPriority(1)
                }
                .accessibilityElement(children: .contain)
            } else {
                SmartShiftCostBars(verdict: verdict)
                why
            }
            EnergyWeatherLegend(verdict: verdict)
            EnergyWeatherChart(verdict: verdict, timeZone: timeZone)
            ForEach(Array(verdict.notes.enumerated()), id: \.offset) { _, note in
                noteView(note)
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    private var why: some View {
        Text(verdict.why)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: SectionTheme.maxProseWidth, alignment: .leading)
    }

    @ViewBuilder
    private func noteView(_ note: SmartShiftVerdict.Note) -> some View {
        switch note {
        case .connectSolcast(let usesHistory):
            VStack(alignment: .leading, spacing: 6) {
                noteText(usesHistory ? SmartShiftPresentation.connectSolcastHistoryNote : SmartShiftPresentation.connectSolcastNote)
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
            .frame(maxWidth: SectionTheme.maxProseWidth, alignment: .leading)
    }
}
