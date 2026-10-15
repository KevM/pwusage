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
                    Label(BatteryHoldActivityPresentation.reserveText(context.state), systemImage: BatteryHoldActivityPresentation.symbolName)
                        .font(.headline)
                        .monospacedDigit()
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.attributes.siteName)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    // Ended activities leave the Dynamic Island at once, so this is always an active hold.
                    BatteryHoldActivityDetails(attributes: context.attributes, state: context.state,
                                               isStale: context.isStale, showsHeadline: false)
                }
            } compactLeading: {
                Image(systemName: BatteryHoldActivityPresentation.symbolName)
                    .accessibilityLabel("Battery hold")
            } compactTrailing: {
                Text(BatteryHoldActivityPresentation.reserveText(context.state))
                    .monospacedDigit()
                    .foregroundStyle(context.isStale ? .secondary : .primary)
            } minimal: {
                Image(systemName: BatteryHoldActivityPresentation.symbolName)
                    .accessibilityLabel(BatteryHoldActivityPresentation.headline(context.state))
            }
            .widgetURL(BatteryHoldLink.url(siteID: context.attributes.siteID))
        }
    }
}

struct BatteryHoldLockScreenView: View {
    let attributes: BatteryHoldActivityAttributes
    let state: BatteryHoldActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(attributes.siteName, systemImage: BatteryHoldActivityPresentation.symbolName)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            BatteryHoldActivityDetails(attributes: attributes, state: state, isStale: isStale, showsHeadline: true)
        }
        .padding(16)
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
        VStack(alignment: .leading, spacing: 3) {
            if showsHeadline {
                Text(BatteryHoldActivityPresentation.headline(state)).font(.headline)
            }
            Text(BatteryHoldActivityPresentation.detail(state, isStale: isStale))
                .font(.subheadline)
                .foregroundStyle(isStale ? .orange : .primary)
            if let range = BatteryHoldActivityPresentation.loadRange(state, timeZone: zone, now: now) {
                Text(range).font(.caption).monospacedDigit()
            }
            HStack(spacing: 6) {
                if let deadline = BatteryHoldActivityPresentation.deadline(state, timeZone: zone, now: now) {
                    Text(deadline)
                }
                if let checked = BatteryHoldActivityPresentation.checked(state, timeZone: zone, now: now) {
                    Text("·")
                    Text(checked)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if let note = BatteryHoldActivityPresentation.displayLimitNote(attributes, state, now: now) {
                Text(note).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

#Preview("Lock Screen", as: .content, using: BatteryHoldActivityAttributes(
    siteID: "site-1", siteName: "Home", holdID: 7, registrationID: UUID(),
    timeZoneIdentifier: TimeZone.current.identifier, activityStartedAt: .now)
) {
    BatteryHoldLiveActivity()
} contentStates: {
    BatteryHoldActivityAttributes.ContentState(
        holdId: 7, status: .active, mode: .auto, phase: .loadRunning, originalReserve: 20, targetReserve: 100,
        estimatedLoadW: 7200, startedAt: .now.addingTimeInterval(-1800), safetyExpiresAt: .now.addingTimeInterval(6.5 * 3600),
        checkedAt: .now.addingTimeInterval(-300), nextCheckAt: .now.addingTimeInterval(600))
    BatteryHoldActivityAttributes.ContentState(
        holdId: 7, status: .active, mode: .timer, phase: .timer, originalReserve: 20, targetReserve: 80,
        startedAt: .now, safetyExpiresAt: .now.addingTimeInterval(20 * 3600))
    BatteryHoldActivityAttributes.ContentState(
        holdId: 7, status: .restored, mode: .auto, phase: .confirmingEnd, originalReserve: 20, targetReserve: 100,
        startedAt: .now.addingTimeInterval(-7200), safetyExpiresAt: .now.addingTimeInterval(6 * 3600),
        endedAt: .now, restoreReason: .loadEnded)
}
