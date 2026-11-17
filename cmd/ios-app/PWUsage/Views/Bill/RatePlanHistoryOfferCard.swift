import SwiftUI

/// Rate Plans' offer to walk the owner through their past rate plans.
struct RatePlanHistoryOfferCard: View {
    let historyStart: String
    let onFind: () -> Void
    let onNotNow: () -> Void

    var body: some View {
        CardContainer(padding: 15, cornerRadius: 16, spacing: 10) {
            Text(RatePlanHistoryPresentation.offerMessage(historyStart: historyStart))
                .font(.headline)
            Button(action: onFind) {
                Text(RatePlanHistoryPresentation.findButtonTitle)
                    .frame(maxWidth: .infinity)
            }
            .emphasisProminentButton()
            .controlSize(.large)
            Button(action: onNotNow) {
                Text(RatePlanHistoryPresentation.notNowButtonTitle)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.emphasis)
            .padding(.vertical, 6)
        }
    }
}
