import SwiftUI

struct MetricTile: View {
    let title: String
    let value: String
    var detail: String? = nil
    let symbol: String
    let tint: Color
    var compact = false
    var prominentValue = false
    var isMuted = false
    var numericValue: Double? = nil
    var spokenRole: String? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: compact ? .center : .leading, spacing: compact ? 2 : 8) {
            Label(title, systemImage: symbol)
                .font((compact && !prominentValue ? Font.caption2 : .subheadline).weight(.medium))
                .foregroundStyle(isMuted ? .secondary : tint)
                .labelStyle(.titleAndIcon)
            Text(value)
                .contentTransition(reduceMotion || numericValue == nil ? .identity : .numericText(value: numericValue ?? 0))
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: numericValue)
                .font((compact ? (prominentValue ? Font.title2 : .footnote) : .title3).weight(.bold))
                .monospacedDigit()
                .foregroundStyle(isMuted ? .secondary : .primary)
                .minimumScaleFactor(prominentValue ? 0.6 : 0.8)
                .lineLimit(1)
            if let detail, !compact {
                Text(detail)
                    .font(compact ? .system(size: 9) : .caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: compact ? 38 : 76,
               maxHeight: compact ? .infinity : nil, alignment: compact ? .center : .leading)
        .padding(.horizontal, compact ? 6 : 12)
        .padding(.vertical, compact ? 4 : 12)
        .background(isMuted ? Color(uiColor: .tertiarySystemGroupedBackground) : tint.opacity(0.07), in: RoundedRectangle(cornerRadius: compact ? 10 : 16, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([title, value, detail, spokenRole].compactMap { $0 }.joined(separator: ", "))
    }
}
