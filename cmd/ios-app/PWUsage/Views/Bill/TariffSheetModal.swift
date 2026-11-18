import Foundation

/// The sheets the Rate Plans screen presents, one at a time.
enum TariffSheetModal: Identifiable, Equatable {
    case effectiveDates(TariffPeriodDTO)
    case editor(RatePlanEditorMode)
    case estimates(RateEstimatesPrompt)
    case rateHistory
    case changePlan
    case restore(TariffPeriodDTO)

    var id: String {
        switch self {
        case .effectiveDates(let period): "dates-\(period.periodId)"
        case .editor(let mode): "editor-\(mode.id)"
        case .estimates(let prompt): "estimates-\(prompt)"
        case .rateHistory: "rate-history"
        case .changePlan: "change-plan"
        case .restore(let period): "restore-\(period.periodId)"
        }
    }

    /// The change flow this modal opens; a public plan unless it restores Tesla's.
    var changeKind: RatePlanChangeModel.Kind {
        if case .restore(let period) = self {
            return .restoreTesla(selectionID: period.selectionId ?? 0, planName: period.name)
        }
        return .publicPlan
    }

    /// Public plans where they apply; otherwise straight to entering rates.
    static func changePlan(for timeline: SiteTariffsTimelineResponse) -> Self {
        RatePlanSourcePresentation.offersPublicPlans(timeline) ? .changePlan : .editor(.add)
    }
}
