import SwiftUI

/// The Smart Shift bar title. Once the verdict scrolls under the bar it swaps the name for the
/// recommendation, like `HomeLiveTitle` does with the scoreboard.
struct SmartShiftBarTitle: View {
    let verdict: SmartShiftVerdict?

    var body: some View {
        // Stacked, not side by side: in portrait the toolbar buttons leave a narrow slot, so the
        // job and time take the first line and the saving (or the name) the second. Both shrink
        // and truncate rather than vanish.
        VStack(spacing: 0) {
            if let verdict {
                Text(verdict.title)
                    .font(.subheadline.weight(.semibold))
                    .minimumScaleFactor(0.75)
                    .lineLimit(1)
                Text(verdict.barSaving ?? "Smart Shift")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(verdict.barSaving == nil ? Color.secondary : Color.emphasis)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            } else {
                Text("Smart Shift")
                    .font(.headline)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.isHeader)
        .animation(.easeInOut(duration: 0.25), value: verdict == nil)
        // Two lines must fit the inline bar; larger sizes read through the large content viewer.
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .accessibilityShowsLargeContentViewer()
    }

    private var accessibilityLabel: String {
        guard let verdict else { return "Smart Shift" }
        return "Smart Shift, \(verdict.title)" + (verdict.barSaving.map { ", \($0)" } ?? "")
    }
}

#if DEBUG
    extension SmartShiftVerdict {
        static func barPreview(saving: String?) -> SmartShiftVerdict {
            SmartShiftVerdict(title: "Dishwasher at 9:00 PM", subtitle: "", barSaving: saving, choices: [],
                              chartTitle: "", chartSubtitle: "", rateBars: [], slot: nil, why: "", notes: [])
        }
    }

    #Preview("Smart Shift bar · plain, saving, narrow") {
        VStack(spacing: 24) {
            SmartShiftBarTitle(verdict: nil)
            SmartShiftBarTitle(verdict: .barPreview(saving: "$0.42 cheaper"))
            SmartShiftBarTitle(verdict: .barPreview(saving: "$0.42 cheaper")).frame(width: 150)
        }
        .padding()
    }
#endif
