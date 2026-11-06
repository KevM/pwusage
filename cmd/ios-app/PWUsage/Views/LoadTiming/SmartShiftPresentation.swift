import Foundation

enum SmartShiftPresentation {
    /// The pass-wide inputs every Job priced in one evaluation shares.
    struct EvaluationInputs {
        let now: Date
        let timing: LoadTiming
        let forecast: ForecastAvailability
        let intervals: [SolarForecastInterval]?
        let context: LoadTimingForecastEstimator.PlanningContext?
        let balanceSourceTime: Date?
        let billingCycleEnd: Date
        let currencyCode: String
        let timeZone: String
    }

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

    /// Prices the Job with the solar forecast when one is ready, otherwise with
    /// the site's grid history when the household pattern carries it, otherwise
    /// with balances held still. A forecast comparison that can't run (its
    /// stricter 30-minute balance age, say) falls back to the forecast-free one,
    /// and the card says why in one sentence.
    static func evaluate(profile: LoadProfile, inputs: EvaluationInputs) -> SmartShiftEvaluation {
        evaluator(inputs)(profile)
    }

    /// Prices Jobs for one pass, as `evaluate` does. The projection work that
    /// doesn't depend on the Job is planned once per projection and shared, so
    /// pricing every saved Job for the hint stays within the per-pass budget.
    static func evaluator(_ inputs: EvaluationInputs) -> (LoadProfile) -> SmartShiftEvaluation {
        guard let balanceSourceTime = inputs.balanceSourceTime else {
            return { _ in
                SmartShiftEvaluation(result: .init(comparison: nil, unavailableReason: .staleBalance),
                                     forecast: inputs.forecast)
            }
        }
        let plans = PassPlans { projection in
            LoadTimingForecastEstimator.plan(LoadTimingForecastEstimator.PlanRequest(
                now: inputs.now, timing: inputs.timing, projection: projection,
                balanceSourceTime: balanceSourceTime, billingCycleEnd: inputs.billingCycleEnd,
                currencyCode: inputs.currencyCode))
        }
        return { profile in
            var availability = inputs.forecast
            if inputs.forecast == .ready, let intervals = inputs.intervals, let context = inputs.context {
                let result = LoadTimingForecastEstimator.evaluate(
                    profile: profile, plan: plans.plan(for: .forecast(intervals: intervals, context: context)))
                guard let reason = result.unavailableReason else {
                    return SmartShiftEvaluation(result: result, forecast: .ready, projection: .forecast)
                }
                availability = .unusable(LoadTimingForecastPresentation.forecastUnavailableNote(reason))
            } else if inputs.forecast == .ready {
                availability = .unusable(LoadTimingForecastPresentation.forecastUnavailableNote(.incompleteContext))
            }
            if let context = inputs.context, context.hasGridHistory {
                let result = LoadTimingForecastEstimator.evaluate(profile: profile,
                                                                  plan: plans.plan(for: .history(context: context)))
                if result.unavailableReason == nil {
                    return SmartShiftEvaluation(result: result, forecast: availability, projection: .history)
                }
            }
            return SmartShiftEvaluation(
                result: LoadTimingForecastEstimator.evaluate(
                    profile: profile, plan: plans.plan(for: .flat(timeZone: inputs.timeZone))),
                forecast: availability, projection: .flat)
        }
    }

    /// Each projection's plan for one pass, built the first time a Job needs it.
    private final class PassPlans {
        let make: (LoadTimingForecastEstimator.Projection) -> LoadTimingForecastEstimator.Plan
        var built: [(LoadTimingForecastEstimator.Projection, LoadTimingForecastEstimator.Plan)] = []

        init(make: @escaping (LoadTimingForecastEstimator.Projection) -> LoadTimingForecastEstimator.Plan) {
            self.make = make
        }

        func plan(for projection: LoadTimingForecastEstimator.Projection) -> LoadTimingForecastEstimator.Plan {
            if let hit = built.first(where: { $0.0 == projection }) { return hit.1 }
            let plan = make(projection)
            built.append((projection, plan))
            return plan
        }
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
