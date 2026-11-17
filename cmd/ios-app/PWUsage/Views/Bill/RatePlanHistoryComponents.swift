import SwiftUI

/// What every history step shares: an optional lead line, the question, the step's content and a
/// footer pinned above the home indicator.
struct HistoryStepFrame<Content: View, Footer: View>: View {
    let title: String
    var lead: String?
    @ViewBuilder let content: Content
    @ViewBuilder let footer: Footer

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let lead {
                    Text(lead)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Text(title)
                    .font(.title2.bold())
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                content
            }
            .padding(16)
            .frame(maxWidth: SectionTheme.maxContentWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background { SectionTheme.bill.screenBackground }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) { footer }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(maxWidth: SectionTheme.maxContentWidth)
                .frame(maxWidth: .infinity)
                .background(.bar)
        }
    }
}

/// A small tinted label: `Matches your Tesla plan`, `Assumed`.
struct HistoryPill: View {
    let text: String
    var tint: Color = .emphasis

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The rounded card a step's choices sit in.
struct HistoryChoiceCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                SectionTheme.secondaryGroupedBackground,
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
    }
}

/// One choice: a check, a title, an optional detail line and pill.
struct HistoryChoiceRow: View {
    let title: String
    var detail: String?
    var pill: String?
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? Color.emphasis : Color.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .foregroundStyle(.primary)
                    if let detail {
                        Text(detail)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    if let pill {
                        HistoryPill(text: pill)
                    }
                }
                .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 15)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// The Continue button every choice step ends with.
struct HistoryContinueButton: View {
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(RatePlanHistoryPresentation.continueTitle)
                .font(.headline)
                .frame(maxWidth: .infinity)
        }
        .emphasisProminentButton()
        .controlSize(.large)
        .disabled(!isEnabled)
    }
}

/// The quiet `Not sure?` link under a step's choices.
struct HistoryNotSureButton: View {
    let action: () -> Void

    var body: some View {
        Button(RatePlanHistoryPresentation.notSureTitle, action: action)
            .font(.subheadline)
            .padding(.horizontal, 4)
    }
}
