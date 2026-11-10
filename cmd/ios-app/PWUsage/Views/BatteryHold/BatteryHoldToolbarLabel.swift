import SwiftUI

/// The shield glyph, with "Battery holding at 80%" beside it while a hold is on. The percentage is the
/// hold reserve, not live charge.
struct BatteryHoldToolbarLabel: View {
    let state: BatteryHoldState
    let now: Date

    private var title: String? {
        BatteryHoldPresentation.toolbarTitle(state: state, at: now)
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "bolt.shield")
            if let title {
                Text(title)
                    .font(.caption)
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .foregroundStyle(title == nil ? AnyShapeStyle(.primary) : AnyShapeStyle(.tint))
    }
}
