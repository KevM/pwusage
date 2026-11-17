import SwiftUI

/// The Home tab bar accessory that offers one estimate setup step, or the rate plan history guide.
/// Opens that step's picker or the guide; Not now hides the accessory for this site (Bill and Solar System
/// keep the setup, Rate Plans keeps the guide's offer until it is dismissed there too).
@available(iOS 26.0, *)
struct RateEstimatesAccessory: View {
    let kind: RateEstimatesAccessoryKind
    let utilityName: String?
    /// The history guide's first day, for the offer's subtitle.
    var historyStart: String?
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
                        Text(title)
                            .font(.subheadline.weight(.semibold))
                        if placement != .inline {
                            Text(subtitle)
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

    private var title: String {
        switch kind {
        case .setup(let prompt): RateEstimatesPresentation.accessoryTitle(prompt)
        case .historyOffer: RatePlanHistoryPresentation.accessoryTitle
        }
    }

    private var subtitle: String {
        switch kind {
        case .setup(let prompt): RateEstimatesPresentation.accessorySubtitle(prompt, utilityName: utilityName)
        case .historyOffer:
            RatePlanHistoryPresentation.accessorySubtitle(utilityName: utilityName, historyStart: historyStart ?? "")
        }
    }

    private var symbol: String {
        switch kind {
        case .setup(.pickUtility): "building.columns"
        case .setup(.pickPlan): "list.bullet.rectangle"
        case .historyOffer: RatePlanHistoryPresentation.accessorySymbol
        }
    }
}
