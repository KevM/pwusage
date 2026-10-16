import SwiftUI
import WidgetKit

// Views of the battery hold Live Activity. They live in Shared so the app's
// tests can render them; the widget extension's ActivityConfiguration uses them.

/// The pwusage glyph, tinted by the surrounding foreground style.
struct BatteryHoldGlyph: View {
    let size: CGFloat

    var body: some View {
        Image(BatteryHoldActivityPresentation.glyphName)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The drawn battery for a hold: the live charge, and the held reserve until the hold ends.
struct BatteryHoldGauge: View {
    let style: BatteryGaugeStyle
    let state: BatteryHoldActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        BatteryGaugeView(style: style, charge: state.batteryPercent, holdLevel: state.targetReserve,
                         isStale: isStale, isFinal: state.isFinal)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(BatteryHoldActivityAccessibility.summary(state))
    }
}

enum BatteryHoldActivityAccessibility {
    static func summary(_ state: BatteryHoldActivityAttributes.ContentState) -> String {
        [BatteryHoldActivityPresentation.headline(state),
         BatteryHoldActivityPresentation.batteryText(state).map { "battery \($0)" }].compactMap { $0 }.joined(separator: ", ")
    }
}

struct BatteryHoldLockScreenView: View {
    let attributes: BatteryHoldActivityAttributes
    let state: BatteryHoldActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                BatteryHoldGlyph(size: 17)
                Text(attributes.siteName)
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Color.accentColor)
            .lineLimit(1)
            Text(BatteryHoldActivityPresentation.headline(state))
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            BatteryHoldActivitySummary(attributes: attributes, state: state, isStale: isStale)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The text sits inside the drawn outline (inset 8pt, 18pt trailing for the nub).
        .padding(EdgeInsets(top: 14, leading: 20, bottom: 14, trailing: 28))
        .background {
            BatteryGaugeView(style: .card, charge: state.batteryPercent, holdLevel: state.targetReserve,
                             isStale: isStale, isFinal: state.isFinal)
                .accessibilityHidden(true)
        }
        .activityBackgroundTint(Color(uiColor: .secondarySystemBackground))
    }
}

/// The expanded Dynamic Island's bottom region: the full-width battery, then the figures.
struct BatteryHoldExpandedBottom: View {
    let attributes: BatteryHoldActivityAttributes
    let state: BatteryHoldActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            BatteryHoldGauge(style: .bar, state: state, isStale: isStale)
                .frame(height: 22)
            BatteryHoldActivitySummary(attributes: attributes, state: state, isStale: isStale)
        }
    }
}

/// One line of figures (charge, home load, peak) and, only when needed, one status line.
struct BatteryHoldActivitySummary: View {
    let attributes: BatteryHoldActivityAttributes
    let state: BatteryHoldActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        let status = BatteryHoldActivityPresentation.status(attributes, state, isStale: isStale, now: Date())
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 12) {
                if let battery = BatteryHoldActivityPresentation.batteryText(state) {
                    figure(battery, symbol: "bolt.fill", tint: isStale ? .secondary : .green)
                        .accessibilityLabel("Battery \(battery)")
                }
                if let home = BatteryHoldActivityPresentation.homeLoadText(state) {
                    figure(home, symbol: "house.fill", tint: .secondary)
                        .accessibilityLabel("Home load \(home)")
                }
                if let peak = BatteryHoldActivityPresentation.peakText(state) {
                    Text(peak).foregroundStyle(.secondary)
                }
            }
            .font(.subheadline.weight(.medium))
            .monospacedDigit()
            if let status {
                HStack(spacing: 4) {
                    if status.isWarning { Image(systemName: "exclamationmark.triangle.fill") }
                    Text(status.text)
                }
                .font(.caption.weight(status.isWarning ? .semibold : .regular))
                .foregroundStyle(status.isWarning ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.85)
    }

    private func figure(_ text: String, symbol: String, tint: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: symbol).font(.caption).foregroundStyle(tint)
            Text(text)
        }
        .accessibilityElement(children: .ignore)
    }
}
