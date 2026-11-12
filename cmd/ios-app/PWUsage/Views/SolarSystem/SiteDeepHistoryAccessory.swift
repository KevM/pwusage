import SwiftUI

/// The tab bar's accessory while older history loads: its own wording, so it is not mistaken for
/// the layout import. Opens the Solar System screen, where it can be stopped.
@available(iOS 26.0, *)
struct SiteDeepHistoryAccessory: View {
    let presentation: SiteDeepHistoryPresentation
    let onOpen: () -> Void
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                ProgressView()
                if placement == .inline {
                    Text("Loading older history").font(.subheadline.weight(.semibold)).minimumScaleFactor(0.8)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Loading older history").font(.subheadline.weight(.semibold))
                        if !presentation.accessoryDetail.isEmpty {
                            Text(presentation.accessoryDetail).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .lineLimit(1)
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading older history. " + presentation.accessoryDetail)
        .accessibilityHint("Opens Solar System in Settings")
        .accessibilityAddTraits(.isButton)
    }
}
