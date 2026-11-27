#if canImport(FoundationEssentials)
    import FoundationEssentials
#else
    import Foundation
#endif

public enum ForecastAvailability: Equatable, Sendable {
    /// This site doesn't use the automatic forecast, so there is none to add.
    case none
    case loading
    /// Connected, but the forecast comparison can't run; carries a one-sentence reason.
    case unusable(String)
    /// Automatic setup is unavailable; the note opens solar forecast settings.
    case automaticUnavailable(String)
    case ready
}

/// The comparison the card shows, and what the forecast layer contributed to it.
public struct SmartShiftEvaluation: Equatable {
    public let result: LoadTimingForecastEstimator.Result
    public let forecast: ForecastAvailability
    /// The projection that priced `result`; `nil` when none could run.
    public var projection: LoadTimingForecastEstimator.Projection.Kind?

    public init(
        result: LoadTimingForecastEstimator.Result,
        forecast: ForecastAvailability,
        projection: LoadTimingForecastEstimator.Projection.Kind? = nil
    ) {
        self.result = result
        self.forecast = forecast
        self.projection = projection
    }
}

/// The pass-wide inputs every Job priced in one evaluation shares.
public struct SmartShiftEvaluationInputs {
    public let now: Date
    public let timing: LoadTiming
    public let forecast: ForecastAvailability
    public let intervals: [SolarForecastInterval]?
    public let context: LoadTimingForecastEstimator.PlanningContext?
    public let balanceSourceTime: Date?
    public let billingCycleEnd: Date
    public let currencyCode: String
    public let timeZone: String
    public let siteTimeZone: SiteTimeZone?

    public init(
        now: Date, timing: LoadTiming, forecast: ForecastAvailability, intervals: [SolarForecastInterval]?,
        context: LoadTimingForecastEstimator.PlanningContext?, balanceSourceTime: Date?, billingCycleEnd: Date,
        currencyCode: String, timeZone: String, siteTimeZone: SiteTimeZone? = nil
    ) {
        self.now = now
        self.timing = timing
        self.forecast = forecast
        self.intervals = intervals
        self.context = context
        self.balanceSourceTime = balanceSourceTime
        self.billingCycleEnd = billingCycleEnd
        self.currencyCode = currencyCode
        self.timeZone = timeZone
        self.siteTimeZone = siteTimeZone
    }
}

/// Chooses the projection that prices a Job: the solar forecast when one is ready, otherwise the
/// site's grid history when the household pattern carries it, otherwise balances held still.
public enum SmartShiftEvaluator {
    /// The one-sentence note a forecast comparison that can't run shows; the app owns the copy.
    public typealias UnusableNote = (LoadTimingForecastEstimator.UnavailableReason) -> String

    /// Prices the Job with the best projection the inputs support. A forecast comparison that can't
    /// run (its stricter 30-minute balance age, say) falls back to the forecast-free one, and
    /// `unusableNote` says why.
    public static func evaluate(
        profile: LoadProfile, inputs: SmartShiftEvaluationInputs, unusableNote: @escaping UnusableNote
    ) -> SmartShiftEvaluation {
        evaluator(inputs, unusableNote: unusableNote)(profile)
    }

    /// Prices Jobs for one pass, as `evaluate` does. The projection work that doesn't depend on the
    /// Job is planned once per projection and shared, so pricing every saved Job for the hint stays
    /// within the per-pass budget.
    public static func evaluator(
        _ inputs: SmartShiftEvaluationInputs, unusableNote: @escaping UnusableNote
    ) -> (LoadProfile) -> SmartShiftEvaluation {
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
                currencyCode: inputs.currencyCode, siteTimeZone: inputs.siteTimeZone))
        }
        return { profile in
            var availability = inputs.forecast
            if inputs.forecast == .ready, let intervals = inputs.intervals, let context = inputs.context {
                let result = LoadTimingForecastEstimator.evaluate(
                    profile: profile, plan: plans.plan(for: .forecast(intervals: intervals, context: context)))
                guard let reason = result.unavailableReason else {
                    return SmartShiftEvaluation(result: result, forecast: .ready, projection: .forecast)
                }
                availability = .unusable(unusableNote(reason))
            } else if inputs.forecast == .ready {
                availability = .unusable(unusableNote(.incompleteContext))
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
}
