import PWUsageCore
import SwiftUI

/// Rate Plans' estimate rows: the out-of-date notice when Tesla's plan is behind, then the utility
/// row. A plan step appears only when the site still needs a rate plan on its utility.
struct RateEstimatesRatePlanSection: View {
    let estimates: SiteRateEstimatesDTO?
    /// The first day of the history guide's range while its offer shows; nil hides the offer card.
    var historyStart: String?
    var onFindHistory: () -> Void = {}
    var onDismissHistory: () -> Void = {}
    let onAddRatePlan: () -> Void
    /// "Change Plan" where the server reviews changes; "Add Rate Plan" on older servers.
    var addRatePlanTitle = RateEstimatesPresentation.addRatePlanButtonTitle
    let onChooseUtility: () -> Void
    let onChoosePlan: () -> Void

    var body: some View {
        if let notice = RateEstimatesPresentation.outOfDateNotice(estimates) {
            CardContainer(padding: 14, cornerRadius: 14, spacing: 10) {
                Label {
                    Text(notice)
                        .font(.subheadline)
                } icon: {
                    Image(systemName: "bolt.badge.clock")
                }
                Button(addRatePlanTitle, action: onAddRatePlan)
                    .emphasisProminentButton()
                    .controlSize(.small)
            }
        }
        if let historyStart {
            RatePlanHistoryOfferCard(historyStart: historyStart, onFind: onFindHistory, onNotNow: onDismissHistory)
        }
        if let estimates {
            utilityRow(estimates)
            if estimates.status == .needsPlan {
                Button(RateEstimatesPresentation.buttonTitle(.pickPlan), action: onChoosePlan)
                    .emphasisProminentButton()
            }
        }
    }

    private func utilityRow(_ estimates: SiteRateEstimatesDTO) -> some View {
        Button(action: onChooseUtility) {
            CardContainer(padding: 15, cornerRadius: 16, spacing: 6) {
                HStack {
                    Text("Utility")
                        .font(.headline)
                    Spacer(minLength: 8)
                    Text(RateEstimatesPresentation.utilityRowValue(estimates))
                        .foregroundStyle(.secondary)
                    Image(systemName: "chevron.forward")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .buttonStyle(.plain)
    }
}
