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

    static func plan(
        now: Date,
        timing: LoadTiming,
        projection: Projection,
        balanceSourceTime: Date,
        billingCycleEnd: Date,
        currencyCode: String
    ) -> Plan {
        func unavailable(_ reason: UnavailableReason, beforeLoad: Bool = false) -> Plan {
            Plan(state: .unavailable(reason, beforeLoad: beforeLoad))
        }
        guard now.timeIntervalSince1970.isFinite, balanceSourceTime.timeIntervalSince1970.isFinite,
              billingCycleEnd.timeIntervalSince1970.isFinite, balanceSourceTime <= now else {
            return unavailable(.invalidInput, beforeLoad: true)
        }
        if let context = projection.context, !context.asOf.timeIntervalSince1970.isFinite {
            return unavailable(.invalidInput, beforeLoad: true)
        }
        guard now.timeIntervalSince(balanceSourceTime) <= projection.maximumBalanceAge else {
            return unavailable(.staleBalance, beforeLoad: true)
        }
        guard timing.hasTariff, !timing.tariffTimeline.isEmpty else { return unavailable(.missingTariff, beforeLoad: true) }
        if projection.projectsFlow, !timing.hasCycleData { return unavailable(.incompleteBalance, beforeLoad: true) }
        guard let zone = TimeZone(identifier: projection.timeZone) else { return unavailable(.invalidInput, beforeLoad: true) }
        let tariffs = timing.tariffTimeline.sorted { $0.start < $1.start }
        guard validTariffIntervals(tariffs) else { return unavailable(.invalidInput) }
        if case .forecast(let forecast, _) = projection, !validForecast(forecast) { return unavailable(.invalidInput) }

        // The balance already covers observed data through the end of the final
        // five-minute interval, so projection starts there rather than at
        // `balanceSourceTime`, and never after the present.
        let projectionStart = min(balanceSourceTime.addingTimeInterval(Self.observedIntervalDuration), now)

        // Two horizons: starts are searched (and charted) to midnight tomorrow,
        // while balances are projected to the bill date so each start is priced
        // by what it does to the bill.
        let tomorrowEnd = endOfTomorrow(after: now, timeZone: zone)
        guard let tomorrowEnd, tomorrowEnd > now else { return unavailable(.invalidInput) }
        var projectionEnd = billingCycleEnd
        var endsAtRateChange = false
        var forecastStart = projectionStart
        var forecastEnd = projectionStart
        if case .forecast(let forecast, let context) = projection {
            if context.hasGridHistory {
                // The forecast must cover now, or history would stand in silently under
                // its name. A fresh batch starts at the current half hour, often after
                // the latest energy data, so history fills that short gap before it,
                // and after the forecast window or wherever the forecast falls short.
                guard let block = contiguousBlock(of: forecast, containing: now) else {
                    return unavailable(.incompleteCoverage)
                }
                forecastStart = max(block.start, projectionStart)
                forecastEnd = min(block.end, now.addingTimeInterval(Self.forecastWindow))
            } else {
                let coverageEnd = contiguousEnd(of: forecast, startingAt: projectionStart)
                guard coverageEnd > now else { return unavailable(.incompleteCoverage) }
                // Without history there is nothing to project past the forecast, and
                // an older server's context keeps today's horizon exactly.
                forecastEnd = coverageEnd
                projectionEnd = min(projectionEnd, coverageEnd, tomorrowEnd)
            }
        }
        projectionEnd = min(projectionEnd, contiguousTariffEnd(tariffs, startingAt: projectionStart))
        guard projectionEnd > now else { return unavailable(.incompleteCoverage) }
        let clock = WallClock(timeZone: zone, from: projectionStart, to: projectionEnd)
        let model = FlowModel(projection: projection, clock: clock, forecastStart: forecastStart, forecastEnd: forecastEnd,
                              tariffs: tariffs)

        // A rate change for one billing-period balance ends the shared projection.
        // Rates outside the projection do not participate in validation.
        let rateSet = supportedRates(in: tariffs, from: balanceSourceTime, before: projectionEnd)
        guard !rateSet.invalid else { return unavailable(.invalidInput) }
        if let boundary = rateSet.incompatibleBoundary, boundary < projectionEnd {
            projectionEnd = boundary
            endsAtRateChange = true
        }
        guard projectionEnd > now else { return unavailable(.incompleteCoverage) }

        if let contextGap = firstContextGap(from: projectionStart, to: projectionEnd, model: model, tariffs: tariffs),
           contextGap < projectionEnd {
            projectionEnd = contextGap
            endsAtRateChange = false
            guard projectionEnd > now else { return unavailable(.incompleteContext) }
        }

        let finalRateSet = supportedRates(in: tariffs, from: balanceSourceTime, before: projectionEnd)
        guard !finalRateSet.invalid else { return unavailable(.invalidInput) }
        var rates = finalRateSet.rates

        // The forecast-free path reads no balances
        // when the cycle has no data yet, so every period is priced from zero.
        let observedBalances: [String: Double] = timing.hasCycleData
            ? Dictionary(timing.pricingPeriods.map { ($0.name, $0.cycleNetExportKwh) }, uniquingKeysWith: { _, latest in latest })
            : [:]

        var balances: [String: Double] = [:]
        var hasUnobservedBalance = false
        if projection.projectsFlow {
            // A tariff period with no observed balance cannot be projected. If it has
            // not started yet — a seasonal schedule boundary, for example — end the
            // shared projection there instead of discarding the whole comparison. If
            // it is already under way the baseline is unsound, so reject.
            if let firstUnbalanced = rates.keys.compactMap({ key -> Date? in
                guard observedBalances[key] == nil else { return nil }
                return tariffs.first(where: { $0.periodKey == key && $0.start < projectionEnd })?.start
            }).min() {
                guard firstUnbalanced > now else { return unavailable(.incompleteBalance) }
                if firstUnbalanced < projectionEnd {
                    projectionEnd = firstUnbalanced
                    endsAtRateChange = true
                }
                guard projectionEnd > now else { return unavailable(.incompleteCoverage) }
                let truncated = supportedRates(in: tariffs, from: balanceSourceTime, before: projectionEnd)
                guard !truncated.invalid else { return unavailable(.invalidInput) }
                rates = truncated.rates
            }
            for key in rates.keys {
                guard let balance = observedBalances[key] else { return unavailable(.incompleteBalance) }
                guard balance.isFinite else { return unavailable(.incompleteBalance) }
                balances[key] = balance
            }
        } else {
            // Held still, an unobserved period is simply priced from zero and
            // flagged for the UI.
            for key in rates.keys {
                if let balance = observedBalances[key] {
                    guard balance.isFinite else { return unavailable(.incompleteBalance) }
                    balances[key] = balance
                } else {
                    balances[key] = 0
                    hasUnobservedBalance = true
                }
            }
        }
        guard !balances.isEmpty else { return unavailable(.incompleteBalance) }
        let horizonEnd = min(tomorrowEnd, projectionEnd)

        // Forecast/context/tariff coverage from the end of observed data through
        // the projection is needed even when a candidate run starts later.
        guard let steps = Steps(from: projectionStart, to: projectionEnd, model: model, tariffs: tariffs) else {
            return unavailable(.incompleteCoverage)
        }

        let baseBalances: [String: Double]
        switch steps.integrate(from: projectionStart, to: projectionEnd, balances: balances, cautious: false) {
        case .balances(let projected): baseBalances = projected
        case .invalidInput: return unavailable(.invalidInput)
        case .incompleteCoverage: return unavailable(.incompleteCoverage)
        }
        // The cautious run (pv_estimate10, then a 1-in-4 week of history) is read only at the
        // safety window's end: history beyond it never makes a start pass.
        let safetyEnd = min(now.addingTimeInterval(Self.forecastWindow), projectionEnd)
        // Without grid history a forecast projection ends at midnight tomorrow, so
        // the safety window would shrink to one day and count none of the days a
        // bank recovers over. An older server keeps today's behavior: no rule.
        var cautiousBalances: [String: Double]?
        if case .forecast(_, let context) = projection, !context.hasGridHistory {
            cautiousBalances = nil
        } else {
            switch steps.integrate(from: projectionStart, to: safetyEnd, balances: balances, cautious: true) {
            case .balances(let projected): cautiousBalances = projected
            case .invalidInput: return unavailable(.invalidInput)
            case .incompleteCoverage: return unavailable(.incompleteCoverage)
            }
        }
        // The baseline from the end of observed data to now gives each lane's starting balance.
        var nowBalances = balances
        if projectionStart < now {
            guard case .balances(let projected) = steps.integrate(from: projectionStart, to: now, balances: balances,
                                                                  cautious: false) else {
                return unavailable(.invalidInput)
            }
            nowBalances = projected
        }
        return Plan(state: .ready(Prepared(
            now: now, projection: projection, projectionStart: projectionStart, projectionEnd: projectionEnd,
            horizonEnd: horizonEnd, safetyEnd: safetyEnd, endsAtRateChange: endsAtRateChange, tariffs: tariffs,
            model: model, steps: steps, rates: rates, baseBalances: baseBalances, nowBalances: nowBalances,
            cautiousBalances: cautiousBalances, hasUnobservedBalance: hasUnobservedBalance,
            minorUnit: currencyMinorUnit(currencyCode))))
    }

    /// Prices one Job against a plan built for this pass.
}
