import Foundation
import PWUsageCore

enum SmartShiftPresentation {
    typealias EvaluationInputs = SmartShiftEvaluationInputs

    /// What a blocked card needs to know about the Job and the passing clock.
    struct BlockerInputs {
        let profile: LoadProfile
        let result: LoadTimingForecastEstimator.Result
        let refreshUnavailable: Bool
        let timing: LoadTiming
        let now: Date
        let billingCycleEnd: Date
    }

    /// The card's copy inputs, once a Job and its evaluation are known.
    struct ScreenInputs {
        let timing: LoadTiming
        let now: Date
        let billingCycleEnd: Date
        let currencyCode: String
        let timeZone: String
    }

    /// Prices the Job with the best projection; see `SmartShiftEvaluator`. The note comes from this app's copy.
    static func evaluate(profile: LoadProfile, inputs: EvaluationInputs) -> SmartShiftEvaluation {
        SmartShiftEvaluator.evaluate(profile: profile, inputs: inputs, unusableNote: unusableNote)
    }

    /// Prices Jobs for one pass, sharing each projection's plan; see `SmartShiftEvaluator.evaluator`.
    static func evaluator(_ inputs: EvaluationInputs) -> (LoadProfile) -> SmartShiftEvaluation {
        SmartShiftEvaluator.evaluator(inputs, unusableNote: unusableNote)
    }

    private static func unusableNote(_ reason: LoadTimingForecastEstimator.UnavailableReason) -> String {
        LoadTimingForecastPresentation.forecastUnavailableNote(reason)
    }

    /// When the card's comparison goes stale on its own: the recommended start
    /// arriving, or the rate period changing. The comparison is computed once per
    /// body pass, so the view schedules a pass for then rather than ticking.
    static func nextRefresh(comparison: LoadTimingForecastEstimator.Comparison?, now: Date) -> Date? {
        guard let comparison else { return nil }
        return ([comparison.recommendedStart] + comparison.periodSwitches).filter { $0 > now }.min()
    }

    static let noForecastNote = "Solar forecasts aren't available for this home, so banks are shown as they stand now."
    static let noForecastHistoryNote =
        "Solar forecasts aren't available for this home, so banks follow your last four weeks."
    static let detailsTitle = "How this is worked out"
    static let barHint = "Tap a bar to see what it means."
    static let checkingSolarNote = "Checking today's solar…"
    static let unobservedBalanceNote = "Some rate periods have no bank yet, so they're priced at the full rate."

    static let refreshFailedMessage =
        "The latest refresh failed, so this saved estimate may be old and "
            + "no recommendation is offered."
    static let staleMessage =
        "Energy observations are older than one hour or have no valid source time, "
            + "so no recommendation is offered."
    static let missingRatePlanMessage = "Add a Rate Plan so Smart Shift can compare costs."
    static let incompleteBalanceMessage = "Some rate periods or bank data are missing, so costs can't be compared."
    static let billingCycleMessage =
        "This job would continue beyond the current billing cycle, "
            + "so its current bank can't be used for the estimate."
    static let tooLongMessage = "This job is longer than the time Smart Shift can compare right now."
    static let noEnergyMessage = "This car is already at its target charge, so no energy is needed right now."
    static let cannotCompareMessage = "Smart Shift can't compare start times for this job right now."

    static func make(profile: LoadProfile?, result: LoadTimingForecastEstimator.Result,
                     forecast: ForecastAvailability, refreshUnavailable: Bool,
                     inputs: ScreenInputs) -> SmartShiftScreen {
        guard let profile else { return SmartShiftScreen(content: .noJobs) }
        if let message = blockedMessage(BlockerInputs(profile: profile, result: result,
                                                      refreshUnavailable: refreshUnavailable,
                                                      timing: inputs.timing, now: inputs.now,
                                                      billingCycleEnd: inputs.billingCycleEnd)) {
            return SmartShiftScreen(content: .blocked(message))
        }
        // A verdict priced without the forecast would flash, then change when it lands.
        if forecast == .loading { return SmartShiftScreen(content: .loading) }
        guard let comparison = result.comparison else {
            return SmartShiftScreen(content: .blocked(cannotCompareMessage))
        }
        let context = Context(profile: profile, comparison: comparison, timing: inputs.timing, now: inputs.now,
                              billingCycleEnd: inputs.billingCycleEnd, currencyCode: inputs.currencyCode,
                              timeZone: inputs.timeZone)
        return SmartShiftScreen(content: .verdict(context.verdict(forecast: forecast)))
    }
}
