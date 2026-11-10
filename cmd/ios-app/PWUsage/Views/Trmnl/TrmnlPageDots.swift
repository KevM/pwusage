import SwiftUI

/// Which device's page is showing. The system page dots take their color from the background behind the
/// pages and vanish on the dark card, so these are drawn here: the emphasis color for the current page and a
/// secondary one for the rest.
struct TrmnlPageDots: View {
    let count: Int
    let selected: Int
    /// The color of the pages not showing; over black the default gray would vanish, so callers there pass a light one.
    var inactive: Color = .secondary.opacity(0.5)

    var body: some View {
        HStack(spacing: 8) {
            ForEach(0 ..< count, id: \.self) { index in
                Circle()
                    .fill(index == selected ? Color.emphasis : inactive)
                    .frame(width: 8, height: 8)
            }
        }
        .accessibilityHidden(true)
    }
}
