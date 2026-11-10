import SwiftUI

struct MetricTile: View {
    /// `card` draws its own tinted squircle; `onFill` sits on a full-bleed tint fill in white.
    enum Surface { case card, onFill }

    let title: String
    let value: String
    var detail: String?
    let symbol: String
    let tint: Color
    var compact = false
    var prominentValue = false
    var reducedPadding = false
    var showsDetail = true
    var symbolPrefix: String?
    var isMuted = false
    var numericValue: Double?
    var spokenRole: String?
    var surface = Surface.card
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: compact ? .center : .leading, spacing: compact ? 2 : 8) {
            metricLabel
                .font((compact
                        ? (prominentValue ? (symbolPrefix == nil ? Font.subheadline : .caption) : .caption2)
                        : .subheadline).weight(.medium))
                .foregroundStyle(labelColor)
                .labelStyle(.titleAndIcon)
            Text(value)
                .contentTransition(
                    reduceMotion || numericValue == nil ? .identity : .numericText(value: numericValue ?? 0))
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: numericValue)
                .font(valueFont)
                .monospacedDigit()
                .foregroundStyle(valueColor)
                .minimumScaleFactor(prominentValue ? 0.6 : 0.8)
                .lineLimit(1)
            if let detail, !compact, showsDetail {
                Text(detail)
                    .font(compact ? .system(size: 9) : .caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: compact ? 38 : (reducedPadding ? 0 : 76),
               maxHeight: compact ? .infinity : nil, alignment: compact ? .center : .leading)
        .padding(.horizontal, compact ? 6 : 12)
        .padding(.vertical, compact ? 4 : (reducedPadding ? 8 : 12))
        .background(backgroundColor, in: RoundedRectangle(cornerRadius: compact ? 10 : 16, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([title, value, detail, spokenRole].compactMap(\.self).joined(separator: ", "))
    }

    private var labelColor: Color {
        switch surface {
        case .card: isMuted ? .secondary : tint
        case .onFill: .white.opacity(isMuted ? 0.7 : 0.9)
        }
    }

    private var valueColor: Color {
        switch surface {
        case .card: isMuted ? .secondary : .primary
        case .onFill: .white.opacity(isMuted ? 0.7 : 1)
        }
    }

    private var valueFont: Font {
        if surface == .onFill { return .system(.title, design: .rounded, weight: .bold) }
        return (compact ? (prominentValue ? Font.title2 : .footnote) : .title3).weight(.bold)
    }

    private var backgroundColor: Color {
        guard surface == .card else { return .clear }
        guard !isMuted else { return Color(uiColor: .tertiarySystemGroupedBackground) }
        return tint.opacity(0.07)
    }

    @ViewBuilder
    private var metricLabel: some View {
        if let symbolPrefix {
            HStack(spacing: compact ? 4 : 6) {
                Text(symbolPrefix).monospacedDigit().fixedSize(horizontal: true, vertical: false)
                Image(systemName: symbol)
                Text(title).lineLimit(1).minimumScaleFactor(0.65)
            }
            .lineLimit(1)
        } else {
            Label(title, systemImage: symbol)
        }
    }
}
