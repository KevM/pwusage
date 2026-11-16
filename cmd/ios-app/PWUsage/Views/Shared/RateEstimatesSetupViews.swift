import SwiftUI

/// Bill's setup card for an estimate step. Choosing a utility also offers adding a rate plan.
struct RateEstimatesSetupCard: View {
    let prompt: RateEstimatesPrompt
    let utilityName: String?
    let onChoose: () -> Void
    var onAddRatePlan: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(RateEstimatesPresentation.cardTitle(prompt))
                .font(.subheadline.weight(.semibold))
            Text(RateEstimatesPresentation.cardMessage(prompt, utilityName: utilityName))
                .font(.caption)
                .foregroundStyle(.secondary)
            Button(RateEstimatesPresentation.buttonTitle(prompt), action: onChoose)
                .emphasisProminentButton()
                .controlSize(.small)
            if let onAddRatePlan {
                Button(RateEstimatesPresentation.addRatePlanButtonTitle, action: onAddRatePlan)
                    .controlSize(.small)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            SectionTheme.secondaryGroupedBackground,
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
    }
}

/// Solar System's setup rows at the top of Savings: a title and message, then the button.
struct RateEstimatesSetupRows: View {
    let prompt: RateEstimatesPrompt
    let utilityName: String?
    let onChoose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(RateEstimatesPresentation.cardTitle(prompt))
                .font(.subheadline.weight(.semibold))
            Text(RateEstimatesPresentation.cardMessage(prompt, utilityName: utilityName))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        Button(RateEstimatesPresentation.buttonTitle(prompt), action: onChoose)
    }
}
