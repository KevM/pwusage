@testable import PWUsage
import SwiftUI
import Testing

/// Renders the Live Activity's Lock Screen card and expanded Dynamic Island to PNGs
/// for review. The Simulator's widget gallery is unreliable for Live Activities.
@MainActor
@Suite("Battery hold Live Activity rendering", .serialized)
struct BatteryHoldActivityRenderTests {
    typealias State = BatteryHoldActivityAttributes.ContentState
    private let attributes = BatteryHoldActivityAttributes(
        siteID: "site-1", siteName: "Harrison", holdID: 7, registrationID: UUID(),
        timeZoneIdentifier: TimeZone.current.identifier, activityStartedAt: .now)

    private func active(mode: BatteryHoldMode = .auto, phase: State.Phase = .watching, charge: Double?, hold: Int = 74,
                        home: Double = 1840, peak: Double? = 7240) -> State {
        State(holdId: 7, status: .active, mode: mode, phase: phase, originalReserve: 20, targetReserve: hold,
              estimatedLoadW: nil, startedAt: .now.addingTimeInterval(-1800),
              safetyExpiresAt: .now.addingTimeInterval(mode == .timer ? 3 * 3600 : 6.5 * 3600),
              checkedAt: .now.addingTimeInterval(-120), nextCheckAt: .now.addingTimeInterval(780),
              sampledAt: .now.addingTimeInterval(-150), baselineLoadW: 1600, homeLoadW: home,
              peakLoadW: peak, batteryPercent: charge)
    }

    struct RenderState {
        let name: String
        let state: State
        let isStale: Bool
    }

    private var states: [RenderState] {
        var restored = active(charge: 71)
        restored.status = .restored
        restored.restoreReason = .loadEnded
        restored.endedAt = .now
        return [
            RenderState(name: "above-hold",
                        state: active(charge: 95, hold: 80, home: 1800, peak: 1810), isStale: false),
            RenderState(name: "full-hold",
                        state: active(charge: 100, hold: 100, home: 1800, peak: 1810), isStale: false),
            RenderState(name: "load-running", state: active(phase: .loadRunning, charge: 74, home: 7000),
                        isStale: false),
            RenderState(name: "no-data", state: active(phase: .waitingForData, charge: nil), isStale: false),
            RenderState(name: "stale", state: active(charge: 82), isStale: true),
            RenderState(name: "timer",
                        state: active(mode: .timer, phase: .timer, charge: 76, hold: 80, peak: nil),
                        isStale: false),
            RenderState(name: "restored", state: restored, isStale: false)
        ]
    }

    @Test("Renders the Lock Screen card and expanded Dynamic Island", arguments: [ColorScheme.light, .dark])
    func render(_ scheme: ColorScheme) throws {
        let sheet = VStack(alignment: .leading, spacing: 14) {
            ForEach(states, id: \.name) { item in
                BatteryHoldLockScreenView(attributes: attributes, state: item.state, isStale: item.isStale)
                    .background(Color(uiColor: .secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    HStack(spacing: 6) {
                        BatteryHoldGlyph(size: 20)
                        Text(BatteryHoldActivityPresentation.headline(states[1].state)).font(.headline)
                    }
                    .foregroundStyle(Color.accentColor)
                    Spacer()
                    Text("Harrison").font(.subheadline).foregroundStyle(.secondary)
                }
                BatteryHoldExpandedBottom(attributes: attributes, state: states[1].state, isStale: false)
            }
            .padding(EdgeInsets(top: 16, leading: 20, bottom: 16, trailing: 20))
            .background(Color.black)
            .clipShape(RoundedRectangle(cornerRadius: 40, style: .continuous))
            .environment(\.colorScheme, .dark)
        }
        .frame(width: 364)
        .padding(14)
        .background(scheme == .dark ? Color(white: 0.2) : Color(white: 0.85))
        .environment(\.colorScheme, scheme)
        let renderer = ImageRenderer(content: sheet)
        renderer.scale = 3
        let png = try #require(renderer.uiImage?.pngData())
        let output = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("battery-hold-activity-\(scheme).png")
        try png.write(to: output)
        print("Rendered activity: \(output.path)")
    }
}
