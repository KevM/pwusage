import SwiftUI

/// The Smart Shift bar title. Once the verdict scrolls under the bar the name slides up to a
/// small top line and the recommendation rises in beneath it, like `HomeLiveTitle`.
struct SmartShiftBarTitle: View {
    let verdict: SmartShiftVerdict?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            Text("Smart Shift")
                .font(verdict == nil ? .headline : .footnote.weight(.semibold))
                .foregroundStyle(verdict == nil ? .primary : .secondary)
                .lineLimit(1)
            if let verdict {
                ViewThatFits(in: .horizontal) {
                    line(verdict.title, saving: verdict.barSaving)
                    line(verdict.title, saving: nil)
                    // Nothing fits: the name alone, never a row pushed past the bar.
                    EmptyView()
                }
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
                .id("smart-shift-recommendation")
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

    private func line(_ title: String, saving: String?) -> some View {
        HStack(spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            if let saving {
                Text(saving)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.emphasis)
                    .lineLimit(1)
            }
        }
        .fixedSize(horizontal: true, vertical: false)
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
            SmartShiftBarTitle(verdict: .barPreview(saving: "$0.42 cheaper")).frame(width: 190)
        }
        .padding()
    }
#endif
