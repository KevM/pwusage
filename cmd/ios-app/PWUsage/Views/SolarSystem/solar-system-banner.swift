import SwiftUI

/// The tab bar's accessory while history loads for a site without a usable layout.
@available(iOS 26.0, *)
struct SiteHistoryAccessory: View {
    let checkedDaysText: String
    let onOpen: () -> Void
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                if placement == .inline {
                    Text("Loading history · \(checkedDaysText)").font(.subheadline).lineLimit(1)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(SiteHistoryPresentation.title).font(.subheadline.weight(.semibold))
                        Text(checkedDaysText).font(.caption).foregroundStyle(.secondary)
                    }
                    .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(SiteHistoryPresentation.title), \(checkedDaysText)")
        .accessibilityHint("Opens Site History in Settings")
        .accessibilityAddTraits(.isButton)
    }
}
