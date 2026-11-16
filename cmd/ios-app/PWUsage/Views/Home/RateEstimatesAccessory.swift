import SwiftUI

/// The Home tab bar accessory that offers one estimate setup step. Opens that step's picker;
/// Not now hides the accessory for this site (Bill and Solar System keep the setup).
@available(iOS 26.0, *)
struct RateEstimatesAccessory: View {
    let prompt: RateEstimatesPrompt
    let utilityName: String?
    let onOpen: () -> Void
    let onDismiss: () -> Void
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    var body: some View {
        HStack(spacing: 10) {
            Button(action: onOpen) {
                HStack(spacing: 10) {
                    Image(systemName: symbol)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(RateEstimatesPresentation.accessoryTitle(prompt))
                            .font(.subheadline.weight(.semibold))
                        if placement != .inline {
                            Text(RateEstimatesPresentation.accessorySubtitle(prompt, utilityName: utilityName))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(8)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(RateEstimatesPresentation.notNowLabel)
        }
        .lineLimit(1)
        .padding(.horizontal, 16)
    }

    private var symbol: String {
        switch prompt {
        case .pickUtility: "building.columns"
        case .pickPlan: "list.bullet.rectangle"
        }
    }
}
