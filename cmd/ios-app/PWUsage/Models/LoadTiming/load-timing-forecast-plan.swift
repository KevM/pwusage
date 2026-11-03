import Foundation

extension LoadTimingForecastEstimator {
    struct Plan {
        let state: PlanState
    }

    enum PlanState {
        case ready(Prepared)
        /// `beforeLoad` reasons were found before a Job's shape is checked, so they outrank an invalid Job.
        case unavailable(UnavailableReason, beforeLoad: Bool)
    }

    struct Prepared {
        let now: Date
        let projection: Projection
        let projectionStart: Date
        let projectionEnd: Date
        let horizonEnd: Date
        let safetyEnd: Date
        let endsAtRateChange: Bool
        let tariffs: [LoadTimingTariffSegment]
        let model: FlowModel
        let steps: Steps
        let rates: [String: PeriodRate]
        /// Typical balances at the projection end, and at `now`.
        let baseBalances: [String: Double]
        let nowBalances: [String: Double]
        /// Cautious balances at the safety window's end, or `nil` when the safety
        /// rule doesn't apply (a forecast without grid history: see `plan`).
        let cautiousBalances: [String: Double]?
        let hasUnobservedBalance: Bool
        let minorUnit: Double
    }

    /// Everything `plan` reads from the pass.
    struct PlanRequest {
        let now: Date
        let timing: LoadTiming
        let projection: Projection
        let balanceSourceTime: Date
        let billingCycleEnd: Date
        let currencyCode: String
    }

    static func plan(_ request: PlanRequest) -> Plan {
        do {
            var build = try PlanBuild.make(request)
            try build.applyForecastWindow()
            let clock = WallClock(timeZone: build.zone, from: build.projectionStart, to: build.projectionEnd)
            let model = FlowModel(projection: request.projection, clock: clock,
                                  forecastStart: build.forecastStart, forecastEnd: build.forecastEnd,
                                  tariffs: build.tariffs)
            try build.applyRates(model: model)
            try build.applyBalances()
            // Forecast/context/tariff coverage from the end of observed data through
            // the projection is needed even when a candidate run starts later.
            guard let steps = Steps(from: build.projectionStart, to: build.projectionEnd,
                                    model: model, tariffs: build.tariffs) else {
                throw PlanFailure(reason: .incompleteCoverage)
            }
            return Plan(state: .ready(try build.prepared(model: model, steps: steps)))
        } catch let failure as PlanFailure {
            return Plan(state: .unavailable(failure.reason, beforeLoad: failure.beforeLoad))
        } catch {
            return Plan(state: .unavailable(.invalidInput, beforeLoad: false))
        }
    }

    /// A refused plan, and whether its reason outranks the Job's shape.
    private struct PlanFailure: Error {
        let reason: UnavailableReason
        let beforeLoad: Bool

        init(reason: UnavailableReason, beforeLoad: Bool = false) {
            self.reason = reason
            self.beforeLoad = beforeLoad
        }
    }

    /// The pass as `plan` builds it: one mutable value carries the window, rates
    /// and balances through each stage rather than a chain of single-use structs.
    private struct PlanBuild {
        let request: PlanRequest
        let zone: TimeZone
        let tariffs: [LoadTimingTariffSegment]
        var projectionStart: Date
        var projectionEnd: Date
        var forecastStart: Date
        var forecastEnd: Date
        var tomorrowEnd: Date
        var endsAtRateChange = false
        var rates: [String: PeriodRate] = [:]
        var balances: [String: Double] = [:]
        var hasUnobservedBalance = false

        /// Checks everything the pass needs before any projection work.
        static func make(_ request: PlanRequest) throws -> PlanBuild {
            guard request.now.timeIntervalSince1970.isFinite,
                  request.balanceSourceTime.timeIntervalSince1970.isFinite,
                  request.billingCycleEnd.timeIntervalSince1970.isFinite,
                  request.balanceSourceTime <= request.now else {
                throw PlanFailure(reason: .invalidInput, beforeLoad: true)
            }
            if let context = request.projection.context, !context.asOf.timeIntervalSince1970.isFinite {
                throw PlanFailure(reason: .invalidInput, beforeLoad: true)
            }
            guard request.now.timeIntervalSince(request.balanceSourceTime)
                <= request.projection.maximumBalanceAge else {
                throw PlanFailure(reason: .staleBalance, beforeLoad: true)
            }
            guard request.timing.hasTariff, !request.timing.tariffTimeline.isEmpty else {
                throw PlanFailure(reason: .missingTariff, beforeLoad: true)
            }
            if request.projection.projectsFlow, !request.timing.hasCycleData {
                throw PlanFailure(reason: .incompleteBalance, beforeLoad: true)
            }
            guard let zone = TimeZone(identifier: request.projection.timeZone) else {
                throw PlanFailure(reason: .invalidInput, beforeLoad: true)
            }
            let tariffs = request.timing.tariffTimeline.sorted { $0.start < $1.start }
            guard validTariffIntervals(tariffs) else { throw PlanFailure(reason: .invalidInput) }
            if case .forecast(let forecast, _) = request.projection, !validForecast(forecast) {
                throw PlanFailure(reason: .invalidInput)
            }
            // The balance already covers observed data through the end of the final
            // five-minute interval, so projection starts there rather than at
            // `balanceSourceTime`, and never after the present.
            let projectionStart = min(
                request.balanceSourceTime.addingTimeInterval(observedIntervalDuration), request.now
            )
            // Two horizons: starts are searched (and charted) to midnight tomorrow,
            // while balances are projected to the bill date so each start is priced
            // by what it does to the bill.
            guard let tomorrowEnd = endOfTomorrow(after: request.now, timeZone: zone),
                  tomorrowEnd > request.now else { throw PlanFailure(reason: .invalidInput) }
            return PlanBuild(request: request, zone: zone, tariffs: tariffs,
                             projectionStart: projectionStart, projectionEnd: request.billingCycleEnd,
                             forecastStart: projectionStart, forecastEnd: projectionStart,
                             tomorrowEnd: tomorrowEnd)
        }

        /// The forecast's part of the window, and where a forecast without grid
        /// history has to stop the projection.
        mutating func applyForecastWindow() throws {
            if case .forecast(let forecast, let context) = request.projection {
                if context.hasGridHistory {
                    // The forecast must cover now, or history would stand in silently under
                    // its name. A fresh batch starts at the current half hour, often after
                    // the latest energy data, so history fills that short gap before it,
                    // and after the forecast window or wherever the forecast falls short.
                    guard let block = contiguousBlock(of: forecast, containing: request.now) else {
                        throw PlanFailure(reason: .incompleteCoverage)
                    }
                    forecastStart = max(block.start, projectionStart)
                    forecastEnd = min(block.end, request.now.addingTimeInterval(forecastWindow))
                } else {
                    let coverageEnd = contiguousEnd(of: forecast, startingAt: projectionStart)
                    guard coverageEnd > request.now else { throw PlanFailure(reason: .incompleteCoverage) }
                    // Without history there is nothing to project past the forecast, and
                    // an older server's context keeps today's horizon exactly.
                    forecastEnd = coverageEnd
                    projectionEnd = min(projectionEnd, coverageEnd, tomorrowEnd)
                }
            }
            projectionEnd = min(projectionEnd, contiguousTariffEnd(tariffs, startingAt: projectionStart))
            guard projectionEnd > request.now else { throw PlanFailure(reason: .incompleteCoverage) }
        }

        /// Truncates the projection at an incompatible rate change or a context gap.
        mutating func applyRates(model: FlowModel) throws {
            // A rate change for one billing-period balance ends the shared projection.
            // Rates outside the projection do not participate in validation.
            let rateSet = supportedRates(in: tariffs, from: request.balanceSourceTime, before: projectionEnd)
            guard !rateSet.invalid else { throw PlanFailure(reason: .invalidInput) }
            if let boundary = rateSet.incompatibleBoundary, boundary < projectionEnd {
                projectionEnd = boundary
                endsAtRateChange = true
            }
            guard projectionEnd > request.now else { throw PlanFailure(reason: .incompleteCoverage) }
            if let contextGap = firstContextGap(from: projectionStart, to: projectionEnd, model: model,
                                                tariffs: tariffs),
                contextGap < projectionEnd {
                projectionEnd = contextGap
                endsAtRateChange = false
                guard projectionEnd > request.now else { throw PlanFailure(reason: .incompleteContext) }
            }
        }

        /// The final rates and the balances they price, truncating the projection at
        /// the first period that has no observed balance.
        mutating func applyBalances() throws {
            // The forecast-free path reads no balances when the cycle has no data yet,
            // so every period is priced from zero.
            let observed: [String: Double] = request.timing.hasCycleData
                ? Dictionary(request.timing.pricingPeriods.map { ($0.name, $0.cycleNetExportKwh) },
                             uniquingKeysWith: { _, latest in latest })
                : [:]
            try applyRateBoundary(observed: observed)
            let values = try balanceValues(observed: observed)
            balances = values.balances
            hasUnobservedBalance = values.hasUnobserved
        }

        /// Rates for the final projection end, shortened at the first unbalanced period.
        private mutating func applyRateBoundary(observed: [String: Double]) throws {
            let rateSet = supportedRates(in: tariffs, from: request.balanceSourceTime, before: projectionEnd)
            guard !rateSet.invalid else { throw PlanFailure(reason: .invalidInput) }
            rates = rateSet.rates
            if request.projection.projectsFlow,
               let firstUnbalanced = firstUnbalancedStart(rates: rates, tariffs: tariffs,
                                                          observed: observed, before: projectionEnd) {
                guard firstUnbalanced > request.now else { throw PlanFailure(reason: .incompleteBalance) }
                if firstUnbalanced < projectionEnd {
                    projectionEnd = firstUnbalanced
                    endsAtRateChange = true
                }
                guard projectionEnd > request.now else { throw PlanFailure(reason: .incompleteCoverage) }
                let truncated = supportedRates(in: tariffs, from: request.balanceSourceTime,
                                               before: projectionEnd)
                guard !truncated.invalid else { throw PlanFailure(reason: .invalidInput) }
                rates = truncated.rates
            }
        }

        /// Each priced period's observed balance, or zero when held still without one.
        private func balanceValues(
            observed: [String: Double]
        ) throws -> (balances: [String: Double], hasUnobserved: Bool) {
            var balances: [String: Double] = [:]
            var hasUnobserved = false
            if request.projection.projectsFlow {
                for key in rates.keys {
                    guard let balance = observed[key], balance.isFinite else {
                        throw PlanFailure(reason: .incompleteBalance)
                    }
                    balances[key] = balance
                }
            } else {
                // Held still, an unobserved period is simply priced from zero and
                // flagged for the UI.
                for key in rates.keys {
                    if let balance = observed[key] {
                        guard balance.isFinite else { throw PlanFailure(reason: .incompleteBalance) }
                        balances[key] = balance
                    } else {
                        balances[key] = 0
                        hasUnobserved = true
                    }
                }
            }
            guard !balances.isEmpty else { throw PlanFailure(reason: .incompleteBalance) }
            return (balances, hasUnobserved)
        }

        /// Integrates the typical and cautious baselines, and the baseline at `now`.
        func prepared(model: FlowModel, steps: Steps) throws -> Prepared {
            let baseBalances: [String: Double]
            switch steps.integrate(from: projectionStart, to: projectionEnd,
                                   balances: balances, cautious: false) {
            case .balances(let projected): baseBalances = projected
            case .invalidInput: throw PlanFailure(reason: .invalidInput)
            case .incompleteCoverage: throw PlanFailure(reason: .incompleteCoverage)
            }
            // The cautious run (pv_estimate10, then a 1-in-4 week of history) is read only at the
            // safety window's end: history beyond it never makes a start pass.
            let safetyEnd = min(request.now.addingTimeInterval(forecastWindow), projectionEnd)
            // Without grid history a forecast projection ends at midnight tomorrow, so
            // the safety window would shrink to one day and count none of the days a
            // bank recovers over. An older server keeps today's behavior: no rule.
            let cautiousBalances: [String: Double]?
            if case .forecast(_, let context) = request.projection, !context.hasGridHistory {
                cautiousBalances = nil
            } else {
                switch steps.integrate(from: projectionStart, to: safetyEnd, balances: balances, cautious: true) {
                case .balances(let projected): cautiousBalances = projected
                case .invalidInput: throw PlanFailure(reason: .invalidInput)
                case .incompleteCoverage: throw PlanFailure(reason: .incompleteCoverage)
                }
            }
            // The baseline from the end of observed data to now gives each lane's starting balance.
            var nowBalances = balances
            if projectionStart < request.now {
                guard case .balances(let projected) = steps.integrate(from: projectionStart, to: request.now,
                                                                      balances: balances, cautious: false) else {
                    throw PlanFailure(reason: .invalidInput)
                }
                nowBalances = projected
            }
            return Prepared(now: request.now, projection: request.projection, projectionStart: projectionStart,
                            projectionEnd: projectionEnd, horizonEnd: min(tomorrowEnd, projectionEnd),
                            safetyEnd: safetyEnd, endsAtRateChange: endsAtRateChange, tariffs: tariffs,
                            model: model, steps: steps, rates: rates, baseBalances: baseBalances,
                            nowBalances: nowBalances, cautiousBalances: cautiousBalances,
                            hasUnobservedBalance: hasUnobservedBalance,
                            minorUnit: currencyMinorUnit(request.currencyCode))
        }
    }

    private static func firstUnbalancedStart(rates: [String: PeriodRate], tariffs: [LoadTimingTariffSegment],
                                             observed: [String: Double], before end: Date) -> Date? {
        rates.keys.compactMap { key -> Date? in
            guard observed[key] == nil else { return nil }
            return tariffs.first(where: { $0.periodKey == key && $0.start < end })?.start
        }.min()
    }
}
