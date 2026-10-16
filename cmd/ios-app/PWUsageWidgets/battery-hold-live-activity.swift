import ActivityKit
import SwiftUI
import WidgetKit

/// Lock Screen and Dynamic Island presentations of a battery hold. Every tap
/// opens the existing Battery Hold sheet for the site, where stopping the hold
/// goes through the sheet's own confirmation.
struct BatteryHoldLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BatteryHoldActivityAttributes.self) { context in
            BatteryHoldLockScreenView(attributes: context.attributes, state: context.state, isStale: context.isStale)
                .widgetURL(BatteryHoldLink.url(siteID: context.attributes.siteID))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        BatteryHoldGlyph(size: 20)
                        Text(BatteryHoldActivityPresentation.headline(context.state))
                            .font(.headline)
                            .monospacedDigit()
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .foregroundStyle(Color.accentColor)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.attributes.siteName)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    // Ended activities leave the Dynamic Island at once, so this is always an active hold.
                    VStack(alignment: .leading, spacing: 8) {
                        BatteryHoldGauge(style: .bar, state: context.state, isStale: context.isStale)
                            .frame(height: 26)
                        BatteryHoldActivityDetails(attributes: context.attributes, state: context.state,
                                                   isStale: context.isStale, showsHeadline: false)
                    }
                }
            } compactLeading: {
                BatteryHoldGlyph(size: 20)
                    .foregroundStyle(Color.accentColor)
                    .accessibilityLabel("Battery hold")
            } compactTrailing: {
                BatteryHoldGauge(style: .mini, state: context.state, isStale: context.isStale)
                    .frame(width: 30, height: 21)
            } minimal: {
                BatteryHoldGauge(style: .mini, state: context.state, isStale: context.isStale)
                    .frame(width: 24, height: 17)
            }
            .widgetURL(BatteryHoldLink.url(siteID: context.attributes.siteID))
        }
    }
}

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
            .accessibilityLabel([BatteryHoldActivityPresentation.headline(state),
                                 BatteryHoldActivityPresentation.batteryText(state)].compactMap { $0 }.joined(separator: ", "))
    }
}

struct BatteryHoldLockScreenView: View {
    let attributes: BatteryHoldActivityAttributes
    let state: BatteryHoldActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                BatteryHoldGlyph(size: 18)
                Text(attributes.siteName)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.accentColor)
            .lineLimit(1)
            BatteryHoldActivityDetails(attributes: attributes, state: state, isStale: isStale, showsHeadline: true)
        }
        // The text sits inside the drawn outline (inset 8pt, 18pt trailing for the nub).
        .padding(EdgeInsets(top: 15, leading: 20, bottom: 15, trailing: 28))
        .background {
            BatteryGaugeView(style: .card, charge: state.batteryPercent, holdLevel: state.targetReserve,
                             isStale: isStale, isFinal: state.isFinal)
                .accessibilityHidden(true)
        }
        .activityBackgroundTint(Color(uiColor: .secondarySystemBackground))
    }
}

struct BatteryHoldActivityDetails: View {
    let attributes: BatteryHoldActivityAttributes
    let state: BatteryHoldActivityAttributes.ContentState
    let isStale: Bool
    let showsHeadline: Bool

    var body: some View {
        let now = Date()
        let zone = BatteryHoldActivityPresentation.timeZone(attributes)
        let deadline = BatteryHoldActivityPresentation.deadline(state, timeZone: zone, now: now)
        let checked = BatteryHoldActivityPresentation.checked(state, timeZone: zone, now: now)
        VStack(alignment: .leading, spacing: 3) {
            if showsHeadline {
                Text(BatteryHoldActivityPresentation.headline(state))
                    .font(.headline)
                    .foregroundStyle(Color.accentColor)
            }
            Text(BatteryHoldActivityPresentation.detail(state, isStale: isStale))
                .font(.subheadline)
                .foregroundStyle(isStale ? .orange : .primary)
            if let range = BatteryHoldActivityPresentation.loadRange(state, timeZone: zone, now: now) {
                Text(range).font(.caption).monospacedDigit()
            }
            if deadline != nil || checked != nil {
                Text([deadline, checked].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let note = BatteryHoldActivityPresentation.displayLimitNote(attributes, state, now: now) {
                Text(note).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private enum BatteryHoldActivityPreviews {
    static let attributes = BatteryHoldActivityAttributes(
        siteID: "site-1", siteName: "Harrison", holdID: 7, registrationID: UUID(),
        timeZoneIdentifier: TimeZone.current.identifier, activityStartedAt: .now)

    static func active(mode: BatteryHoldMode = .auto, phase: BatteryHoldActivityAttributes.ContentState.Phase = .watching,
                       charge: Double?, hold: Int = 74, safetyIn: TimeInterval = 6.5 * 3600) -> BatteryHoldActivityAttributes.ContentState {
        .init(holdId: 7, status: .active, mode: mode, phase: phase, originalReserve: 20, targetReserve: hold,
              estimatedLoadW: phase == .loadRunning ? 5400 : nil, startedAt: .now.addingTimeInterval(-1800),
              safetyExpiresAt: .now.addingTimeInterval(safetyIn), checkedAt: .now.addingTimeInterval(-120),
              nextCheckAt: .now.addingTimeInterval(780), sampledAt: .now.addingTimeInterval(-150),
              baselineLoadW: mode == .auto ? 1600 : nil, homeLoadW: phase == .loadRunning ? 7000 : 1800,
              peakLoadW: mode == .auto ? 7200 : nil, batteryPercent: charge)
    }

    static let aboveHold = active(charge: 82)
    static let atHold = active(phase: .loadRunning, charge: 74, safetyIn: 40 * 60)
    static let unknownCharge = active(phase: .waitingForData, charge: nil)
    static let timer = active(mode: .timer, phase: .timer, charge: 76, hold: 80, safetyIn: 3 * 3600)
    static let restored: BatteryHoldActivityAttributes.ContentState = {
        var state = active(phase: .confirmingEnd, charge: 71)
        state.status = .restored
        state.restoreReason = .loadEnded
        state.endedAt = .now
        return state
    }()
}

#Preview("Lock Screen", as: .content, using: BatteryHoldActivityPreviews.attributes) {
    BatteryHoldLiveActivity()
} contentStates: {
    BatteryHoldActivityPreviews.aboveHold
    BatteryHoldActivityPreviews.atHold
    BatteryHoldActivityPreviews.unknownCharge
    BatteryHoldActivityPreviews.timer
    BatteryHoldActivityPreviews.restored
}

#Preview("Lock Screen, stale") {
    BatteryHoldLockScreenView(attributes: BatteryHoldActivityPreviews.attributes,
                              state: BatteryHoldActivityPreviews.aboveHold, isStale: true)
        .background(Color(uiColor: .secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 22))
        .padding()
}

#Preview("Island expanded", as: .dynamicIsland(.expanded), using: BatteryHoldActivityPreviews.attributes) {
    BatteryHoldLiveActivity()
} contentStates: {
    BatteryHoldActivityPreviews.aboveHold
    BatteryHoldActivityPreviews.unknownCharge
}

#Preview("Island compact", as: .dynamicIsland(.compact), using: BatteryHoldActivityPreviews.attributes) {
    BatteryHoldLiveActivity()
} contentStates: {
    BatteryHoldActivityPreviews.aboveHold
    BatteryHoldActivityPreviews.atHold
}

#Preview("Island minimal", as: .dynamicIsland(.minimal), using: BatteryHoldActivityPreviews.attributes) {
    BatteryHoldLiveActivity()
} contentStates: {
    BatteryHoldActivityPreviews.aboveHold
}
