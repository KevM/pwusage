import PWUsageCore
import SwiftUI

/// The fixed plans a row's Change offers, plus Enter rates myself. Fed by the utility's plans in the
/// editor and by the year's fixed plans in the guide; the caller decides what choosing one does.
struct FixedComparisonPicker: View {
    let options: [FixedComparisonOption]
    let currency: String
    let utilityName: String?
    let onChoose: (FixedComparisonOption) -> Void
    let onEnterRates: () -> Void

    /// The utility's fixed plans only, the standard (default) plan first.
    nonisolated static func fixedPlans(_ plans: [UtilityPlanDTO]) -> [UtilityPlanDTO] {
        let fixed = plans.filter { $0.kind == .fixed }
        return fixed.filter { $0.isDefault == true } + fixed.filter { $0.isDefault != true }
    }

    nonisolated static func options(from plans: [UtilityPlanDTO]) -> [FixedComparisonOption] {
        fixedPlans(plans).map(FixedComparisonOption.init(plan:))
    }

    var body: some View {
        Form {
            Section {
                ForEach(options) { option in
                    Button { onChoose(option) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.name).foregroundStyle(.primary)
                            if let rate = option.rateText(currency: currency) {
                                Text(rate).font(.subheadline).foregroundStyle(.secondary)
                            }
                            if option.isDefault {
                                Text(RatePlanHistoryPresentation.standardPill)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } header: {
                Text(utilityName.map { "\($0) Fixed Plans" } ?? "Fixed Plans")
            } footer: {
                Text(FixedComparisonPresentation.pickerFooter)
            }
            Section {
                Button(FixedComparisonPresentation.enterRatesTitle, action: onEnterRates)
            } footer: {
                Text(FixedComparisonPresentation.footer)
            }
        }
    }
}
