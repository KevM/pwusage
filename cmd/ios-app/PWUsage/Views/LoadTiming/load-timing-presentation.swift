import Foundation
import SwiftUI

extension LoadTimingView {
    struct SmartShiftState {
        let screen: SmartShiftScreen
        let profile: LoadProfile?
        let evaluation: SmartShiftEvaluation?
        let timing: LoadTiming
        let now: Date
        let billingCycleEnd: Date
        let hint: BetterJobHint?
        /// What the pass was offered, kept so "Copy diagnostics" can record it.
        let balanceSourceTime: Date?
        let intervals: [SolarForecastInterval]?
        let context: LoadTimingForecastEstimator.PlanningContext?
    }

    /// Prices the selected Job with the solar forecast when it's usable and with
    /// balances held still otherwise, then turns that into the card's copy.
    func smartShiftState(now: Date, timing: LoadTiming, response: MobileBillResponse) -> SmartShiftState {
        let profile = selectedProfile
        let availability = LoadTimingForecastPresentation.forecastAvailability(
            state: coordinator.solarForecastState,
            connection: coordinator.forecastConnectionForConsumers,
            cause: coordinator.solarForecastUnavailableCause,
            reason: coordinator.solarForecastUnavailableReason,
            forecastFetchedAt: coordinator.publishedForecastFetchedAt,
            now: now,
            usesAutomaticForecast: coordinator.usesAutomaticSolarForecast,
            automaticStatus: coordinator.solarLayoutStatus
        )
        // One evaluator per pass, so every Job shares the projection's plan.
        let intervals = coordinator.publishedForecastIntervals
        // Without a usable forecast, the household pattern's grid history still projects the banks.
        let context = coordinator.loadPlanningContext ?? coordinator.householdPattern
        let evaluate = SmartShiftPresentation.evaluator(
            now: now,
            timing: timing,
            forecast: availability,
            intervals: intervals,
            context: context,
            balanceSourceTime: response.sources.energyDataThrough,
            billingCycleEnd: response.currentBill.cycleEnd,
            currencyCode: currencyCode,
            timeZone: timeZone
        )
        let evaluation = profile.map(evaluate)
        let screen = SmartShiftPresentation.make(
            profile: profile,
            result: evaluation?.result ?? .init(comparison: nil, unavailableReason: nil),
            forecast: evaluation?.forecast ?? .none,
            refreshUnavailable: coordinator.bill.isUnavailable,
            timing: timing,
            now: now,
            billingCycleEnd: response.currentBill.cycleEnd,
            currencyCode: currencyCode,
            timeZone: timeZone
        )
        // Every saved Job is priced in this same pass, so the hint costs no extra
        // passes; Jobs with no comparison right now are left out.
        var hint: BetterJobHint?
        if let profile, let savings = evaluation?.result.comparison?.savings, !coordinator.bill.isUnavailable {
            let others = profileStore.profiles.filter { $0.id != profile.id }.compactMap { other in
                evaluate(other).result.comparison.map { (other, $0.savings) }
            }
            hint = SmartShiftPresentation.betterJobHint(selectedID: profile.id, savingsByJob: [(profile, savings)] + others,
                                                        currencyCode: currencyCode)
        }
        return SmartShiftState(screen: screen, profile: profile, evaluation: evaluation, timing: timing, now: now,
                               billingCycleEnd: response.currentBill.cycleEnd, hint: hint,
                               balanceSourceTime: response.sources.energyDataThrough, intervals: intervals, context: context)
    }

    func detailsSnapshot(_ state: SmartShiftState, verdict: SmartShiftVerdict) -> SmartShiftDetailsSnapshot {
        let comparison = state.evaluation?.result.comparison
        let usedForecast = state.evaluation?.forecast == .ready
        var breakdowns: [CostBreakdown] = []
        var ruledOutNote: String?
        if let comparison, let profile = state.profile {
            breakdowns = SmartShiftPresentation.costBreakdowns(comparison: comparison, profile: profile, timing: state.timing,
                                                               now: state.now, billingCycleEnd: state.billingCycleEnd,
                                                               currencyCode: currencyCode, timeZone: timeZone)
            ruledOutNote = SmartShiftPresentation.ruledOutNote(comparison: comparison, profile: profile, timing: state.timing,
                                                               now: state.now, timeZone: timeZone)
        }
        var diagnostics: SmartShiftDiagnostics?
        if let profile = state.profile, let evaluation = state.evaluation {
            diagnostics = SmartShiftDiagnostics(
                siteId: site.id, app: .current, job: profile, now: state.now, balanceSourceTime: state.balanceSourceTime,
                billingCycleEnd: state.billingCycleEnd, currencyCode: currencyCode, timeZone: timeZone, timing: state.timing,
                evaluation: evaluation, intervals: state.intervals, context: state.context,
                forecastFetchedAt: coordinator.publishedForecastFetchedAt)
        }
        return SmartShiftDetailsSnapshot(
            verdict: verdict,
            comparison: comparison,
            rows: SmartShiftPresentation.periodRows(timing: state.timing, currencyCode: currencyCode),
            breakdowns: breakdowns,
            ruledOutNote: ruledOutNote,
            forecastFetchedAt: usedForecast ? coordinator.publishedForecastFetchedAt : nil,
            contextAsOf: usedForecast ? coordinator.loadPlanningContext?.asOf : nil,
            capturedAt: state.now,
            diagnostics: diagnostics
        )
    }
}
