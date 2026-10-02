import SwiftUI

/// A compact control glyph; the percentage is the hold reserve, not live charge.
struct BatteryHoldToolbarLabel: View {
    let state: BatteryHoldState
    let now: Date

    private var reserve: String? {
        BatteryHoldPresentation.toolbarReserve(state: state, at: now)
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "battery.100percent")
            if let reserve {
                Text(reserve).font(.caption).monospacedDigit()
            }
        }
        .foregroundStyle(reserve == nil ? AnyShapeStyle(.primary) : AnyShapeStyle(.tint))
    }
}
