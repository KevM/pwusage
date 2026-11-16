import SwiftUI

extension DashboardSheet {
    /// The root sheet that opens the picker for an estimate setup step.
    static func rateEstimates(_ prompt: RateEstimatesPrompt) -> DashboardSheet {
        switch prompt {
        case .pickUtility: .chooseUtility
        case .pickPlan: .choosePlan
        }
    }
}

/// Presents the utility picker, or the rate plan picker on the chosen utility. Its plan step can go
/// back to the utility, so the owner makes one choice at a time.
struct RateEstimatesSetupSheet: View {
    let utilityName: String?
    @State private var prompt: RateEstimatesPrompt
    @State private var utilityModel: UtilityPickerModel
    @State private var planModel: UtilityPlanPickerModel

    init(prompt: RateEstimatesPrompt, utilityName: String?, actions: TariffTimelineActions) {
        self.utilityName = utilityName
        _prompt = State(initialValue: prompt)
        _utilityModel = State(initialValue: UtilityPickerModel(
            search: { try await actions.searchUtilities($0) },
            setUtility: { try await actions.setUtility($0) },
            skipUtility: { try await actions.skipUtility() }
        ))
        _planModel = State(initialValue: UtilityPlanPickerModel(
            loadPlans: { try await actions.utilityPlans() },
            selectPlan: { try await actions.setUtilityPlan($0) }
        ))
    }

    var body: some View {
        switch prompt {
        case .pickUtility:
            UtilityPickerView(model: utilityModel)
        case .pickPlan:
            UtilityPlanPickerView(
                utilityName: RateEstimatesPresentation.planPickerUtilityName(utilityName),
                model: planModel,
                onChangeUtility: { prompt = .pickUtility }
            )
        }
    }
}
