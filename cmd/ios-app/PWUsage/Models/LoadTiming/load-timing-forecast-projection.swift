import Foundation

extension LoadTimingForecastEstimator {
    enum Projection: Equatable {
        case forecast(intervals: [SolarForecastInterval], context: PlanningContext)
        case history(context: PlanningContext)
        case flat(timeZone: String)

        enum Kind: String, Codable, Equatable {
            case forecast, history, flat
        }

        var kind: Kind {
            switch self {
            case .forecast: .forecast
            case .history: .history
            case .flat: .flat
            }
        }

        var timeZone: String {
            switch self {
            case .forecast(_, let context), .history(let context): context.timeZone
            case .flat(let timeZone): timeZone
            }
        }

        var maximumBalanceAge: TimeInterval {
            switch self {
            // Grid history fills the gap between the energy data and the forecast's
            // first interval, so only a forecast without it needs the 30-minute limit.
            case .forecast(_, let context) where context.hasGridHistory: LoadTimingForecastEstimator.maximumFlatBalanceAge
            case .forecast: LoadTimingForecastEstimator.maximumBalanceAge
            // Like `.flat`, the forecast-free card uses a one-hour balance window.
            case .history, .flat: LoadTimingForecastEstimator.maximumFlatBalanceAge
            }
        }

        /// Solar intervals whose edges are integration and candidate boundaries; none without a forecast.
        var intervals: [SolarForecastInterval] {
            switch self {
            case .forecast(let intervals, _): intervals
            case .history, .flat: []
            }
        }

        var context: PlanningContext? {
            switch self {
            case .forecast(_, let context), .history(let context): context
            case .flat: nil
            }
        }

        /// Balances move with projected household flow, so every period needs an observed balance.
        var projectsFlow: Bool { context != nil }
    }

    struct BalancePoint: Codable, Equatable {
        let date: Date
        let kwh: Double
    }

    /// One rate period's signed balance from `now` to the horizon end, for the
    /// run starting now and for the recommended run, each on top of the baseline.
    struct BalanceLane: Codable, Equatable {
        let periodKey: String
        /// The projected balance at `now`.
        let startKwh: Double
        let recommended: [BalancePoint]
        let startNow: [BalancePoint]
        /// The typical projection at `projectionEnd` without either run.
        let projectedKwh: Double
        /// The typical projection at `projectionEnd` after the recommended run.
        let projectedAfterRecommendedKwh: Double
        /// The typical projection at `projectionEnd` after starting now.
        let projectedAfterStartNowKwh: Double

        /// The projection defaults describe one that ends at the chart edge.
        init(periodKey: String, startKwh: Double, recommended: [BalancePoint], startNow: [BalancePoint],
             projectedKwh: Double? = nil, projectedAfterRecommendedKwh: Double? = nil,
             projectedAfterStartNowKwh: Double? = nil) {
            self.periodKey = periodKey
            self.startKwh = startKwh
            self.recommended = recommended
            self.startNow = startNow
            self.projectedKwh = projectedKwh ?? startKwh
            self.projectedAfterRecommendedKwh = projectedAfterRecommendedKwh ?? recommended.last?.kwh ?? startKwh
            self.projectedAfterStartNowKwh = projectedAfterStartNowKwh ?? startNow.last?.kwh ?? startKwh
        }
    }

    struct Comparison: Codable, Equatable {
        /// The **marginal** cost of running the load now against the projected
        /// household baseline — `Σ (cost(withLoad) − cost(baseline))` over the
        /// run's intervals. This is *not* the absolute cost of the energy
        /// involved. When the load is served by stored surplus the marginal cost
        /// approaches zero, and zero is the right answer, because that energy was
        /// already paid for. A reader assuming "total" will draw the wrong
        /// conclusion, so callers must present it as an addition to the bill.
        let costNow: Double
        let recommendedStart: Date
        let recommendedEnd: Date
        /// The **marginal** cost of running the load at `recommendedStart`, defined
        /// and constrained exactly as `costNow` is. Like `costNow` it is a delta
        /// against the projected household baseline, never the absolute cost of the
        /// run, and a near-zero value means the load is served by stored surplus.
        let recommendedCost: Double
        let savings: Double
        /// Raw saving of the cheapest non-now start, before the minor-unit
        /// threshold. Lets the UI distinguish "nothing cheaper exists" from
        /// "waiting would save a rounding error" without inventing a saving.
        let bestAlternativeSavings: Double
        let estimatedSolarContribution: Double
        let horizonStart: Date
        let horizonEnd: Date
        let evaluatedStarts: [Date]
        let assumptions: [String]
        /// A rate period the runs could touch has no observed balance, so it was
        /// priced from zero (at the buy rate). Only the `.flat` projection allows this.
        let hasUnobservedBalance: Bool
        /// Periods either run touches plus the period in effect now (every period in
        /// the horizon when starting now wins), ordered by first occurrence from now.
        let lanes: [BalanceLane]
        /// Tariff period changes strictly inside (now, horizonEnd).
        let periodSwitches: [Date]
        /// Where every start is priced: the bill date, unless a rate change, a
        /// period with no balance, or the end of tariff, forecast or history
        /// coverage comes first. `horizonEnd` (the search and chart window) never
        /// passes it; a run may finish after `horizonEnd` but not after this.
        let projectionEnd: Date
        /// The projection ended at a rate change or a period with no balance, before the bill date.
        let projectionEndsAtRateChange: Bool
        /// Where the safety rule reads the cautious projection: min(now + forecastWindow, projectionEnd).
        let safetyEnd: Date
        let safety: Safety
        let ruledOut: RuledOut?
        /// The site's grid history moved the banks (with or after the forecast).
        let usesHistory: Bool

        init(costNow: Double, recommendedStart: Date, recommendedEnd: Date, recommendedCost: Double, savings: Double,
             bestAlternativeSavings: Double, estimatedSolarContribution: Double, horizonStart: Date, horizonEnd: Date,
             evaluatedStarts: [Date], assumptions: [String], hasUnobservedBalance: Bool, lanes: [BalanceLane],
             periodSwitches: [Date], projectionEnd: Date? = nil, projectionEndsAtRateChange: Bool = false,
             safetyEnd: Date? = nil, safety: Safety = .nowSafe, ruledOut: RuledOut? = nil, usesHistory: Bool = false) {
            self.costNow = costNow
            self.recommendedStart = recommendedStart
            self.recommendedEnd = recommendedEnd
            self.recommendedCost = recommendedCost
            self.savings = savings
            self.bestAlternativeSavings = bestAlternativeSavings
            self.estimatedSolarContribution = estimatedSolarContribution
            self.horizonStart = horizonStart
            self.horizonEnd = horizonEnd
            self.evaluatedStarts = evaluatedStarts
            self.assumptions = assumptions
            self.hasUnobservedBalance = hasUnobservedBalance
            self.lanes = lanes
            self.periodSwitches = periodSwitches
            self.projectionEnd = projectionEnd ?? horizonEnd
            self.projectionEndsAtRateChange = projectionEndsAtRateChange
            self.safetyEnd = safetyEnd ?? projectionEnd ?? horizonEnd
            self.safety = safety
            self.ruledOut = ruledOut
            self.usesHistory = usesHistory
        }
    }

    struct Result: Codable, Equatable {
        let comparison: Comparison?
        let unavailableReason: UnavailableReason?
    }

    struct PeriodRate: Equatable {
        let buy: Double
        let sell: Double
    }
}
