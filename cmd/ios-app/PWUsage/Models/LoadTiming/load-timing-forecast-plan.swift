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
            let inputs = try validate(request)
            let window = try projectionWindow(request, inputs: inputs)
            let clock = WallClock(timeZone: inputs.zone, from: window.projectionStart, to: window.projectionEnd)
            let model = FlowModel(projection: request.projection, clock: clock,
                                  forecastStart: window.forecastStart, forecastEnd: window.forecastEnd,
                                  tariffs: inputs.tariffs)
            let rates = try rateWindow(request, inputs: inputs, window: window, model: model)
            let setup = try balanceSetup(request, inputs: inputs, rates: rates)
            let horizonEnd = min(window.tomorrowEnd, setup.projectionEnd)
            // Forecast/context/tariff coverage from the end of observed data through
            // the projection is needed even when a candidate run starts later.
            guard let steps = Steps(from: window.projectionStart, to: setup.projectionEnd,
                                    model: model, tariffs: inputs.tariffs) else {
                throw PlanFailure(reason: .incompleteCoverage)
            }
            let totals = try integrate(IntegrationRequest(
                steps: steps, balances: setup.balances, projection: request.projection,
                projectionStart: window.projectionStart, projectionEnd: setup.projectionEnd, now: request.now))
            return Plan(state: .ready(Prepared(
                now: request.now, projection: request.projection, projectionStart: window.projectionStart,
                projectionEnd: setup.projectionEnd, horizonEnd: horizonEnd, safetyEnd: totals.safetyEnd,
                endsAtRateChange: setup.endsAtRateChange, tariffs: inputs.tariffs, model: model, steps: steps,
                rates: setup.rates, baseBalances: totals.baseBalances, nowBalances: totals.nowBalances,
                cautiousBalances: totals.cautiousBalances, hasUnobservedBalance: setup.hasUnobservedBalance,
                minorUnit: currencyMinorUnit(request.currencyCode))))
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

    private struct ValidatedInputs {
        let zone: TimeZone
        let tariffs: [LoadTimingTariffSegment]
    }

    private struct Window {
        let projectionStart: Date
        let projectionEnd: Date
        let forecastStart: Date
        let forecastEnd: Date
        let tomorrowEnd: Date
    }

    private struct ForecastRange {
        let start: Date
        let end: Date
        let projectionEnd: Date
    }

    private struct RateWindow {
        let projectionEnd: Date
        let endsAtRateChange: Bool
    }

    private struct RateBoundary {
        let rates: [String: PeriodRate]
        let projectionEnd: Date
        let endsAtRateChange: Bool
    }

    private struct BalanceValues {
        let balances: [String: Double]
        let hasUnobservedBalance: Bool
    }

    private struct BalanceSetup {
        let rates: [String: PeriodRate]
        let balances: [String: Double]
        let hasUnobservedBalance: Bool
        let projectionEnd: Date
        let endsAtRateChange: Bool
    }

    private struct IntegrationRequest {
        let steps: Steps
        let balances: [String: Double]
        let projection: Projection
        let projectionStart: Date
        let projectionEnd: Date
        let now: Date
    }

    private struct ProjectionTotals {
        let baseBalances: [String: Double]
        let nowBalances: [String: Double]
        let cautiousBalances: [String: Double]?
        let safetyEnd: Date
    }

    /// Checks everything the pass needs before any projection work.
    private static func validate(_ request: PlanRequest) throws -> ValidatedInputs {
        guard request.now.timeIntervalSince1970.isFinite,
              request.balanceSourceTime.timeIntervalSince1970.isFinite,
              request.billingCycleEnd.timeIntervalSince1970.isFinite,
              request.balanceSourceTime <= request.now else {
            throw PlanFailure(reason: .invalidInput, beforeLoad: true)
        }
        if let context = request.projection.context, !context.asOf.timeIntervalSince1970.isFinite {
            throw PlanFailure(reason: .invalidInput, beforeLoad: true)
        }
        guard request.now.timeIntervalSince(request.balanceSourceTime) <= request.projection.maximumBalanceAge else {
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
        return ValidatedInputs(zone: zone, tariffs: tariffs)
    }

    /// Where the shared projection starts and ends, and the window the forecast drives.
    private static func projectionWindow(_ request: PlanRequest, inputs: ValidatedInputs) throws -> Window {
        // The balance already covers observed data through the end of the final
        // five-minute interval, so projection starts there rather than at
        // `balanceSourceTime`, and never after the present.
        let projectionStart = min(request.balanceSourceTime.addingTimeInterval(observedIntervalDuration), request.now)
        // Two horizons: starts are searched (and charted) to midnight tomorrow,
        // while balances are projected to the bill date so each start is priced
        // by what it does to the bill.
        guard let tomorrowEnd = endOfTomorrow(after: request.now, timeZone: inputs.zone),
              tomorrowEnd > request.now else { throw PlanFailure(reason: .invalidInput) }
        let range = try forecastRange(request, projectionStart: projectionStart, tomorrowEnd: tomorrowEnd)
        let projectionEnd = min(range.projectionEnd,
                                contiguousTariffEnd(inputs.tariffs, startingAt: projectionStart))
        guard projectionEnd > request.now else { throw PlanFailure(reason: .incompleteCoverage) }
        return Window(projectionStart: projectionStart, projectionEnd: projectionEnd,
                      forecastStart: range.start, forecastEnd: range.end, tomorrowEnd: tomorrowEnd)
    }

    /// The forecast's part of the window, and where a forecast without grid
    /// history has to stop the projection.
    private static func forecastRange(_ request: PlanRequest, projectionStart: Date,
                                      tomorrowEnd: Date) throws -> ForecastRange {
        guard case .forecast(let forecast, let context) = request.projection else {
            return ForecastRange(start: projectionStart, end: projectionStart,
                                 projectionEnd: request.billingCycleEnd)
        }
        if context.hasGridHistory {
            // The forecast must cover now, or history would stand in silently under
            // its name. A fresh batch starts at the current half hour, often after
            // the latest energy data, so history fills that short gap before it,
            // and after the forecast window or wherever the forecast falls short.
            guard let block = contiguousBlock(of: forecast, containing: request.now) else {
                throw PlanFailure(reason: .incompleteCoverage)
            }
            return ForecastRange(start: max(block.start, projectionStart),
                                 end: min(block.end, request.now.addingTimeInterval(forecastWindow)),
                                 projectionEnd: request.billingCycleEnd)
        }
        let coverageEnd = contiguousEnd(of: forecast, startingAt: projectionStart)
        guard coverageEnd > request.now else { throw PlanFailure(reason: .incompleteCoverage) }
        // Without history there is nothing to project past the forecast, and
        // an older server's context keeps today's horizon exactly.
        return ForecastRange(start: projectionStart, end: coverageEnd,
                             projectionEnd: min(request.billingCycleEnd, coverageEnd, tomorrowEnd))
    }

    /// Truncates the projection at an incompatible rate change or a context gap.
    private static func rateWindow(_ request: PlanRequest, inputs: ValidatedInputs,
                                   window: Window, model: FlowModel) throws -> RateWindow {
        // A rate change for one billing-period balance ends the shared projection.
        // Rates outside the projection do not participate in validation.
        let rateSet = supportedRates(in: inputs.tariffs, from: request.balanceSourceTime,
                                     before: window.projectionEnd)
        guard !rateSet.invalid else { throw PlanFailure(reason: .invalidInput) }
        var projectionEnd = window.projectionEnd
        var endsAtRateChange = false
        if let boundary = rateSet.incompatibleBoundary, boundary < projectionEnd {
            projectionEnd = boundary
            endsAtRateChange = true
        }
        guard projectionEnd > request.now else { throw PlanFailure(reason: .incompleteCoverage) }
        if let contextGap = firstContextGap(from: window.projectionStart, to: projectionEnd, model: model,
                                            tariffs: inputs.tariffs),
            contextGap < projectionEnd {
            projectionEnd = contextGap
            endsAtRateChange = false
            guard projectionEnd > request.now else { throw PlanFailure(reason: .incompleteContext) }
        }
        return RateWindow(projectionEnd: projectionEnd, endsAtRateChange: endsAtRateChange)
    }

    /// The final rates and the balances they price, truncating the projection at
    /// the first period that has no observed balance.
    private static func balanceSetup(_ request: PlanRequest, inputs: ValidatedInputs,
                                     rates: RateWindow) throws -> BalanceSetup {
        // The forecast-free path reads no balances when the cycle has no data yet,
        // so every period is priced from zero.
        let observedBalances: [String: Double] = request.timing.hasCycleData
            ? Dictionary(request.timing.pricingPeriods.map { ($0.name, $0.cycleNetExportKwh) },
                         uniquingKeysWith: { _, latest in latest })
            : [:]
        let boundary = try rateBoundary(request, inputs: inputs, rates: rates, observed: observedBalances)
        let values = try balanceValues(rates: boundary.rates, observed: observedBalances,
                                       projectsFlow: request.projection.projectsFlow)
        guard !values.balances.isEmpty else { throw PlanFailure(reason: .incompleteBalance) }
        return BalanceSetup(rates: boundary.rates, balances: values.balances,
                            hasUnobservedBalance: values.hasUnobservedBalance,
                            projectionEnd: boundary.projectionEnd,
                            endsAtRateChange: boundary.endsAtRateChange)
    }

    /// A tariff period with no observed balance cannot be projected. If it has
    /// not started yet — a seasonal schedule boundary, for example — end the
    /// shared projection there instead of discarding the whole comparison. If it
    /// is already under way the baseline is unsound, so reject.
    private static func rateBoundary(_ request: PlanRequest, inputs: ValidatedInputs,
                                     rates: RateWindow, observed: [String: Double]) throws -> RateBoundary {
        var projectionEnd = rates.projectionEnd
        var endsAtRateChange = rates.endsAtRateChange
        let rateSet = supportedRates(in: inputs.tariffs, from: request.balanceSourceTime, before: projectionEnd)
        guard !rateSet.invalid else { throw PlanFailure(reason: .invalidInput) }
        var supported = rateSet.rates
        if request.projection.projectsFlow,
           let firstUnbalanced = firstUnbalancedStart(rates: supported, tariffs: inputs.tariffs,
                                                      observed: observed, before: projectionEnd) {
            guard firstUnbalanced > request.now else { throw PlanFailure(reason: .incompleteBalance) }
            if firstUnbalanced < projectionEnd {
                projectionEnd = firstUnbalanced
                endsAtRateChange = true
            }
            guard projectionEnd > request.now else { throw PlanFailure(reason: .incompleteCoverage) }
            let truncated = supportedRates(in: inputs.tariffs, from: request.balanceSourceTime,
                                           before: projectionEnd)
            guard !truncated.invalid else { throw PlanFailure(reason: .invalidInput) }
            supported = truncated.rates
        }
        return RateBoundary(rates: supported, projectionEnd: projectionEnd, endsAtRateChange: endsAtRateChange)
    }

    private static func firstUnbalancedStart(rates: [String: PeriodRate], tariffs: [LoadTimingTariffSegment],
                                             observed: [String: Double], before end: Date) -> Date? {
        rates.keys.compactMap { key -> Date? in
            guard observed[key] == nil else { return nil }
            return tariffs.first(where: { $0.periodKey == key && $0.start < end })?.start
        }.min()
    }

    private static func balanceValues(rates: [String: PeriodRate], observed: [String: Double],
                                      projectsFlow: Bool) throws -> BalanceValues {
        var balances: [String: Double] = [:]
        var hasUnobservedBalance = false
        if projectsFlow {
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
                    hasUnobservedBalance = true
                }
            }
        }
        return BalanceValues(balances: balances, hasUnobservedBalance: hasUnobservedBalance)
    }

    /// Integrates the typical and cautious baselines, and the baseline at `now`.
    private static func integrate(_ request: IntegrationRequest) throws -> ProjectionTotals {
        let baseBalances: [String: Double]
        switch request.steps.integrate(from: request.projectionStart, to: request.projectionEnd,
                                       balances: request.balances, cautious: false) {
        case .balances(let projected): baseBalances = projected
        case .invalidInput: throw PlanFailure(reason: .invalidInput)
        case .incompleteCoverage: throw PlanFailure(reason: .incompleteCoverage)
        }
        // The cautious run (pv_estimate10, then a 1-in-4 week of history) is read only at the
        // safety window's end: history beyond it never makes a start pass.
        let safetyEnd = min(request.now.addingTimeInterval(forecastWindow), request.projectionEnd)
        // Without grid history a forecast projection ends at midnight tomorrow, so
        // the safety window would shrink to one day and count none of the days a
        // bank recovers over. An older server keeps today's behavior: no rule.
        let cautiousBalances: [String: Double]?
        if case .forecast(_, let context) = request.projection, !context.hasGridHistory {
            cautiousBalances = nil
        } else {
            switch request.steps.integrate(from: request.projectionStart, to: safetyEnd,
                                           balances: request.balances, cautious: true) {
            case .balances(let projected): cautiousBalances = projected
            case .invalidInput: throw PlanFailure(reason: .invalidInput)
            case .incompleteCoverage: throw PlanFailure(reason: .incompleteCoverage)
            }
        }
        // The baseline from the end of observed data to now gives each lane's starting balance.
        var nowBalances = request.balances
        if request.projectionStart < request.now {
            guard case .balances(let projected) = request.steps.integrate(from: request.projectionStart,
                                                                          to: request.now,
                                                                          balances: request.balances,
                                                                          cautious: false) else {
                throw PlanFailure(reason: .invalidInput)
            }
            nowBalances = projected
        }
        return ProjectionTotals(baseBalances: baseBalances, nowBalances: nowBalances,
                                cautiousBalances: cautiousBalances, safetyEnd: safetyEnd)
    }
}
