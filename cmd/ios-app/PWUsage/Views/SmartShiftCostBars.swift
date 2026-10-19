import SwiftUI

/// "Added to your bill (shorter is better)": one bar per start time, widths
/// proportional to cost, with the saving labelled in the gap after the shorter bar.
struct SmartShiftCostBars: View {
    let verdict: SmartShiftVerdict

    static let laterColor = Color.blue
    static let barHeight: CGFloat = 16

    private var maximum: Double {
        max(verdict.bars.map { max($0.value, 0) }.max() ?? 0, .leastNonzeroMagnitude)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verdict.barsCaption)
                .font(.caption)
                .foregroundStyle(.secondary)
            Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 6) {
                ForEach(Array(verdict.bars.enumerated()), id: \.offset) { _, bar in
                    GridRow {
                        Text(bar.label)
                            .font(.subheadline)
                            .fontWeight(bar.isRecommended ? .semibold : .regular)
                            .foregroundStyle(bar.isRecommended ? Self.laterColor : .secondary)
                            .lineLimit(1)
                            .fixedSize()
                        barTrack(bar)
                            .frame(height: Self.barHeight)
                        Text(bar.amount)
                            .font(.subheadline.weight(.bold))
                            .monospacedDigit()
                            .gridColumnAlignment(.trailing)
                            .fixedSize()
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(bar.label), \(bar.amount)")
                    .accessibilityValue(bar.isRecommended ? (verdict.percentLess ?? "") : "")
                }
            }
        }
    }

    private func barTrack(_ bar: CostBar) -> some View {
        GeometryReader { proxy in
            let fraction = max(bar.value, 0) / maximum
            let filled = proxy.size.width * fraction
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(bar.isRecommended ? Self.laterColor : Color.secondary.opacity(0.35))
                    .frame(width: max(filled, bar.value > 0 ? 2 : 0))
                if bar.isRecommended, verdict.bars.count > 1, let percent = verdict.percentLess {
                    gap(percent)
                        .frame(width: max(proxy.size.width - filled, 0))
                }
            }
        }
    }

    /// The outlined empty space after the shorter bar, labelled with the saving
    /// when the label fits, and left empty when it doesn't.
    private func gap(_ percent: String) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4)
                .strokeBorder(Self.laterColor.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            ViewThatFits(in: .horizontal) {
                Text(percent)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Self.laterColor)
                    .fixedSize()
                    .padding(.horizontal, 4)
                Color.clear
            }
        }
    }
}
