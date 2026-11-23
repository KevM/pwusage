import PWUsageCore
import SwiftUI

/// The `Not sure?` help on the kind step: what to look for on a bill, the utility's plan codes, and
/// Still Not Sure, which lets the guide pick the closest plan and mark it Assumed.
struct RatePlanKindHelpSheet: View {
    let utilityName: String
    let plans: [RatePlanHistoryPlanDTO]
    let hasTeslaPlan: Bool
    let onStillNotSure: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(RatePlanHistoryPresentation.helpIntro)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)
                    signsCard(title: RatePlanHistoryPresentation.kindTitle(.timeOfUse),
                              bullets: RatePlanHistoryPresentation.helpTimeOfUseBullets)
                    signsCard(title: RatePlanHistoryPresentation.kindTitle(.fixed),
                              bullets: RatePlanHistoryPresentation.helpFixedBullets)
                    planCodes
                }
                .padding(16)
                .frame(maxWidth: SectionTheme.maxContentWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .background { SectionTheme.bill.screenBackground }
            .safeAreaInset(edge: .bottom) { stillNotSure }
            .navigationTitle(RatePlanHistoryPresentation.helpTitle)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(RatePlanHistoryPresentation.doneTitle) { dismiss() }
                    }
                }
        }
    }

    private func signsCard(title: String, bullets: [String]) -> some View {
        CardContainer(padding: 15, cornerRadius: 16, spacing: 5) {
            Text(title).font(.headline)
            ForEach(bullets, id: \.self) { bullet in
                Text(bullet).font(.subheadline)
            }
        }
    }

    @ViewBuilder private var planCodes: some View {
        if !plans.isEmpty {
            Text(RatePlanHistoryPresentation.planCodesTitle(utilityName: utilityName))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
                .padding(.top, 4)
            HistoryChoiceCard {
                ForEach(Array(plans.enumerated()), id: \.element.id) { index, plan in
                    if index > 0 { Divider().padding(.leading, 15) }
                    Text(RatePlanHistoryPresentation.planCodeRow(plan))
                        .font(.subheadline)
                        .padding(.vertical, 11)
                        .padding(.horizontal, 15)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private var stillNotSure: some View {
        VStack(spacing: 8) {
            Button {
                dismiss()
                onStillNotSure()
            } label: {
                Text(RatePlanHistoryPresentation.stillNotSureTitle)
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(.emphasis)
            .controlSize(.large)
            Text(RatePlanHistoryPresentation.stillNotSureCaption(hasTeslaPlan: hasTeslaPlan))
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }
}
