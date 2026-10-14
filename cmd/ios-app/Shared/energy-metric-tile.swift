import SwiftUI

struct MetricTile: View {
    let title: String
    let value: String
    var detail: String? = nil
    let symbol: String
    let tint: Color
    var compact = false
    var isMuted = false
    var numericValue: Double? = nil
    var spokenRole: String? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 1 : 8) {
            Label(title, systemImage: symbol)
                .font((compact ? Font.caption2 : .subheadline).weight(.medium))
                .foregroundStyle(isMuted ? .secondary : tint)
                .labelStyle(.titleAndIcon)
            Text(value)
                .contentTransition(reduceMotion || numericValue == nil ? .identity : .numericText(value: numericValue ?? 0))
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: numericValue)
                .font((compact ? Font.footnote : .title3).weight(.bold))
                .monospacedDigit()
                .foregroundStyle(isMuted ? .secondary : .primary)
                .minimumScaleFactor(0.8)
                .lineLimit(1)
            if let detail {
                Text(detail)
                    .font(compact ? .system(size: 9) : .caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: compact ? 0 : 76, alignment: .leading)
        .padding(compact ? 4 : 12)
        .background(isMuted ? Color(uiColor: .tertiarySystemGroupedBackground) : tint.opacity(0.07), in: RoundedRectangle(cornerRadius: compact ? 10 : 16, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([title, value, detail, spokenRole].compactMap { $0 }.joined(separator: ", "))
    }
}
