import SwiftUI

extension DashboardSheet {
    /// The root sheet that opens the picker for an estimate setup step.
    static func rateEstimates(_ prompt: RateEstimatesPrompt) -> DashboardSheet {
        switch prompt {
        case .confirmCountry: .confirmCountry
        case .pickUtility: .chooseUtility
        case .pickPlan: .choosePlan
        }
    }
}

/// Presents the country, utility or rate plan picker. A confirmed US country continues to the
/// utility, and the plan step can go back to the utility, so the owner makes one choice at a time.
struct RateEstimatesSetupSheet: View {
    let utilityName: String?
    @State private var prompt: RateEstimatesPrompt
    @State private var utilityModel: UtilityPickerModel
    @State private var planModel: UtilityPlanPickerModel
    @State private var countryModel: SiteCountryPickerModel

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
        _countryModel = State(initialValue: SiteCountryPickerModel(
            inference: { await actions.siteCountryInference() },
            save: { try await actions.setSiteCountry($0) }
        ))
    }

    var body: some View {
        switch prompt {
        case .confirmCountry:
            SiteCountryPickerView(model: countryModel, onPublicPlansAvailable: { prompt = .pickUtility })
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
