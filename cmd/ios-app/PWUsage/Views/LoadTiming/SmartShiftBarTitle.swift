import SwiftUI

/// The Smart Shift bar title. Once the verdict scrolls under the bar it swaps the name for the
/// recommendation (job and time), like `HomeLiveTitle` does with the scoreboard. One line at
/// headline size: in portrait the toolbar buttons leave a narrow slot, and it shrinks a little
/// and truncates rather than vanishing.
struct SmartShiftBarTitle: View {
    /// The verdict headline, or nil while the verdict is on screen.
    let recommendation: String?

    var body: some View {
        Text(recommendation ?? "Smart Shift")
            .font(.headline)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity, alignment: .center)
            .accessibilityAddTraits(.isHeader)
            .animation(.easeInOut(duration: 0.25), value: recommendation)
            .dynamicTypeSize(...DynamicTypeSize.xLarge)
            .accessibilityShowsLargeContentViewer()
    }
}

#if DEBUG
    #Preview("Smart Shift bar · plain, recommendation, narrow") {
        VStack(spacing: 24) {
            SmartShiftBarTitle(recommendation: nil)
            SmartShiftBarTitle(recommendation: "Dishwasher at 9:00 PM")
            SmartShiftBarTitle(recommendation: "Dishwasher at 9:00 PM").frame(width: 150)
        }
        .padding()
    }
#endif
