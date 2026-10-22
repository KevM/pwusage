import ActivityKit
import SwiftUI
import WidgetKit

/// Lock Screen and Dynamic Island presentations of a battery hold. Every tap
/// opens the existing Battery Hold sheet for the site, where stopping the hold
/// goes through the sheet's own confirmation.
struct BatteryHoldLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BatteryHoldActivityAttributes.self) { context in
            BatteryHoldActivityContent(context: context)
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
                    BatteryHoldExpandedBottom(attributes: context.attributes, state: context.state, isStale: context.isStale)
                }
            } compactLeading: {
                BatteryHoldGlyph(size: 20)
                    .foregroundStyle(Color.accentColor)
                    .accessibilityLabel("Battery Saver")
            } compactTrailing: {
                BatteryHoldGauge(style: .mini, state: context.state, isStale: context.isStale)
                    .frame(width: 30, height: 21)
            } minimal: {
                BatteryHoldGauge(style: .mini, state: context.state, isStale: context.isStale)
                    .frame(width: 24, height: 17)
            }
            .widgetURL(BatteryHoldLink.url(siteID: context.attributes.siteID))
        }
        .supplementalActivityFamilies([.small])
    }
}

/// Picks the Lock Screen card or the `.small` layout (CarPlay, watch Smart Stack).
private struct BatteryHoldActivityContent: View {
    let context: ActivityViewContext<BatteryHoldActivityAttributes>
    @Environment(\.activityFamily) private var family

    var body: some View {
        switch family {
        case .small:
            BatteryHoldSmallView(attributes: context.attributes, state: context.state, isStale: context.isStale)
        default:
            BatteryHoldLockScreenView(attributes: context.attributes, state: context.state, isStale: context.isStale)
        }
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

#Preview("Small (CarPlay, watch)") {
    // The smallest documented small-family heights: CarPlay 78pt, Apple Watch 69.5pt.
    VStack {
        ForEach([CGSize(width: 170, height: 78), CGSize(width: 155, height: 69.5)], id: \.height) { size in
            BatteryHoldSmallView(attributes: BatteryHoldActivityPreviews.attributes,
                                 state: BatteryHoldActivityPreviews.atHold, isStale: false)
                .frame(width: size.width, height: size.height)
                .background(Color(uiColor: .secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 16))
        }
    }
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
