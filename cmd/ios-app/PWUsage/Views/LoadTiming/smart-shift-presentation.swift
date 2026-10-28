import Foundation

enum SmartShiftPresentation {
    /// Prices the Job with the solar forecast when one is ready, otherwise with
    /// the site's grid history when the household pattern carries it, otherwise
    /// with balances held still. A forecast comparison that can't run (its
    /// stricter 30-minute balance age, say) falls back to the forecast-free one,
    /// and the card says why in one sentence.
    static func evaluate(
        profile: LoadProfile,
        now: Date,
        timing: LoadTiming,
        forecast: ForecastAvailability,
        intervals: [SolarForecastInterval]?,
        context: LoadTimingForecastEstimator.PlanningContext?,
        balanceSourceTime: Date?,
        billingCycleEnd: Date,
        currencyCode: String,
        timeZone: String
    ) -> SmartShiftEvaluation {
        evaluator(now: now, timing: timing, forecast: forecast, intervals: intervals, context: context,
                  balanceSourceTime: balanceSourceTime, billingCycleEnd: billingCycleEnd,
                  currencyCode: currencyCode, timeZone: timeZone)(profile)
    }

    /// Prices Jobs for one pass, as `evaluate` does. The projection work that
    /// doesn't depend on the Job is planned once per projection and shared, so
    /// pricing every saved Job for the hint stays within the per-pass budget.
    static func evaluator(
        now: Date,
        timing: LoadTiming,
        forecast: ForecastAvailability,
        intervals: [SolarForecastInterval]?,
        context: LoadTimingForecastEstimator.PlanningContext?,
        balanceSourceTime: Date?,
        billingCycleEnd: Date,
        currencyCode: String,
        timeZone: String
    ) -> (LoadProfile) -> SmartShiftEvaluation {
        guard let balanceSourceTime else {
            return { _ in SmartShiftEvaluation(result: .init(comparison: nil, unavailableReason: .staleBalance), forecast: forecast) }
        }
        let plans = PassPlans { projection in
            LoadTimingForecastEstimator.plan(now: now, timing: timing, projection: projection,
                                             balanceSourceTime: balanceSourceTime, billingCycleEnd: billingCycleEnd,
                                             currencyCode: currencyCode)
        }
        return { profile in
            var availability = forecast
            if forecast == .ready, let intervals, let context {
                let result = LoadTimingForecastEstimator.evaluate(
                    profile: profile, plan: plans.plan(for: .forecast(intervals: intervals, context: context)))
                guard let reason = result.unavailableReason else {
                    return SmartShiftEvaluation(result: result, forecast: .ready, projection: .forecast)
                }
                availability = .unusable(LoadTimingForecastPresentation.forecastUnavailableNote(reason))
            } else if forecast == .ready {
                availability = .unusable(LoadTimingForecastPresentation.forecastUnavailableNote(.incompleteContext))
            }
            if let context, context.hasGridHistory {
                let result = LoadTimingForecastEstimator.evaluate(profile: profile, plan: plans.plan(for: .history(context: context)))
                if result.unavailableReason == nil {
                    return SmartShiftEvaluation(result: result, forecast: availability, projection: .history)
                }
            }
            return SmartShiftEvaluation(
                result: LoadTimingForecastEstimator.evaluate(profile: profile, plan: plans.plan(for: .flat(timeZone: timeZone))),
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

    static let connectSolcastNote = "Without a solar forecast, banks are shown as they stand now. Connect Solcast to see today's solar."
    static let connectSolcastHistoryNote = "Without a solar forecast, banks follow your last four weeks. Connect Solcast to see this week's solar."
    static let checkingSolarNote = "Checking today's solar…"
    static let unobservedBalanceNote = "Some rate periods have no bank yet, so they're priced at the full rate."

    static let refreshFailedMessage = "The latest refresh failed, so this saved estimate may be old and no recommendation is offered."
    static let staleMessage = "Energy observations are older than one hour or have no valid source time, so no recommendation is offered."
    static let missingRatePlanMessage = "Add a Rate Plan so Smart Shift can compare costs."
    static let incompleteBalanceMessage = "Some rate periods or bank data are missing, so costs can't be compared."
    static let billingCycleMessage = "This job would continue beyond the current billing cycle, so its current bank can't be used for the estimate."
    static let tooLongMessage = "This job is longer than the time Smart Shift can compare right now."
    static let noEnergyMessage = "This car is already at its target charge, so no energy is needed right now."
    static let cannotCompareMessage = "Smart Shift can't compare start times for this job right now."

    static func make(
        profile: LoadProfile?,
        result: LoadTimingForecastEstimator.Result,
        forecast: ForecastAvailability,
        refreshUnavailable: Bool,
        timing: LoadTiming,
        now: Date,
        billingCycleEnd: Date,
        currencyCode: String,
        timeZone: String
    ) -> SmartShiftScreen {
        guard let profile else { return SmartShiftScreen(content: .noJobs) }
        if let message = blockedMessage(profile: profile, result: result, refreshUnavailable: refreshUnavailable,
                                        timing: timing, now: now, billingCycleEnd: billingCycleEnd) {
            return SmartShiftScreen(content: .blocked(message))
        }
        // A verdict priced without the forecast would flash, then change when it lands.
        if forecast == .loading { return SmartShiftScreen(content: .loading) }
        guard let comparison = result.comparison else { return SmartShiftScreen(content: .blocked(cannotCompareMessage)) }
        let context = Context(profile: profile, comparison: comparison, timing: timing, now: now,
                              billingCycleEnd: billingCycleEnd, currencyCode: currencyCode, timeZone: timeZone)
        return SmartShiftScreen(content: .verdict(context.verdict(forecast: forecast)))
    }
}
