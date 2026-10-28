import Foundation

extension LoadTimingForecastEstimator {
    struct Candidate {
        let start: Date
        let end: Date
        let cost: Double
        let solarContribution: Double
        /// kWh the run takes from each period's balance.
        let draws: [String: Double]
        /// The part of `draws` taken before the safety window ends.
        let drawsBySafetyEnd: [String: Double]
    }

    /// A candidate read against the cautious projection at the safety window's end.
    struct Assessment {
        let candidate: Candidate
        /// The lowest cautious balance among the banks the run dips into, and that bank.
        let worst: (periodKey: String, kwh: Double)?

        var passes: Bool { (worst?.kwh ?? 0) >= -LoadTimingForecastEstimator.safetyShortfallKwh - 1e-9 }
        var shortfall: Double { max(0, -(worst?.kwh ?? 0)) }
    }

    enum BaselineResult {
        case balances([String: Double])
        case invalidInput
        case incompleteCoverage
    }

    /// The site's time zone and its local half-hour boundaries across the whole
    /// search. Integration and candidate starts both need those boundaries, and
    /// re-scanning them minute by minute for every candidate run dominated the
    /// cost of an evaluation, so they are scanned once.
    enum ScoreResult {
        case candidate(Candidate)
        case invalidInput
        case incompleteCoverage
    }

    static func evaluate(
        profile: LoadProfile,
        now: Date,
        timing: LoadTiming,
        forecast: [SolarForecastInterval],
        context: PlanningContext,
        balanceSourceTime: Date,
        billingCycleEnd: Date,
        currencyCode: String
    ) -> Result {
        evaluate(profile: profile, now: now, timing: timing, projection: .forecast(intervals: forecast, context: context),
                 balanceSourceTime: balanceSourceTime, billingCycleEnd: billingCycleEnd, currencyCode: currencyCode)
    }

    static func evaluate(
        profile: LoadProfile,
        now: Date,
        timing: LoadTiming,
        projection: Projection,
        balanceSourceTime: Date,
        billingCycleEnd: Date,
        currencyCode: String
    ) -> Result {
        evaluate(profile: profile, plan: plan(now: now, timing: timing, projection: projection,
                                              balanceSourceTime: balanceSourceTime, billingCycleEnd: billingCycleEnd,
                                              currencyCode: currencyCode))
    }

    /// Everything about an evaluation that doesn't depend on the Job: the
    /// projection, its coverage, and the typical and cautious baselines. Build
    /// it once per pass and price every Job against it.
    static func evaluate(profile: LoadProfile, plan: Plan) -> Result {
        let prepared: Prepared
        switch plan.state {
        case .unavailable(let reason, beforeLoad: true): return unavailable(reason)
        case .unavailable(let reason, beforeLoad: false):
            guard loadShape(for: profile) != nil else { return loadUnavailable(profile) }
            return unavailable(reason)
        case .ready(let ready): prepared = ready
        }
        guard let load = loadShape(for: profile) else { return loadUnavailable(profile) }
        let now = prepared.now, horizonEnd = prepared.horizonEnd, projectionEnd = prepared.projectionEnd
        let model = prepared.model, tariffs = prepared.tariffs
        let candidates = candidateStarts(now: now, horizonEnd: horizonEnd, duration: load.duration,
                                         model: model, tariffs: tariffs)
        var scored: [Candidate] = []
        for candidateStart in candidates {
            let candidateEnd = candidateStart.addingTimeInterval(load.duration)
            guard candidateStart >= now, candidateStart < horizonEnd else { continue }
            guard candidateEnd.timeIntervalSince1970.isFinite else { return unavailable(.invalidInput) }
            // A run starts inside the search window but may finish after it, up to the projection end.
            guard candidateEnd <= projectionEnd else { continue }
            switch score(start: candidateStart, end: candidateEnd, load: load,
                         baseBalances: prepared.baseBalances, rates: prepared.rates, steps: prepared.steps,
                         safetyEnd: prepared.safetyEnd) {
            case .candidate(let candidate): scored.append(candidate)
            case .invalidInput: return unavailable(.invalidInput)
            case .incompleteCoverage: return unavailable(.incompleteCoverage)
            }
        }
        guard let nowCandidate = scored.first(where: { $0.start == now }) else { return unavailable(.noFittingRun) }
        guard scored.allSatisfy({ $0.cost.isFinite }) else { return unavailable(.invalidInput) }
        let selection = select(scored.map {
            assess($0, baseBalances: prepared.baseBalances, cautiousBalances: prepared.cautiousBalances)
        }, now: now, minorUnit: prepared.minorUnit)
        let recommendation = selection.recommendation
        let savings = recommendation.start == nowCandidate.start ? 0 : max(0, nowCandidate.cost - recommendation.cost)
        guard let lanes = balanceLanes(now: now, horizonEnd: horizonEnd, nowBalances: prepared.nowBalances,
                                       baseBalances: prepared.baseBalances, load: load,
                                       startNow: nowCandidate, recommended: recommendation,
                                       steps: prepared.steps, tariffs: tariffs) else {
            return unavailable(.invalidInput)
        }
        return Result(comparison: Comparison(
            costNow: nowCandidate.cost,
            recommendedStart: recommendation.start,
            recommendedEnd: recommendation.end,
            recommendedCost: recommendation.cost,
            savings: savings,
            bestAlternativeSavings: selection.bestAlternativeSavings,
            estimatedSolarContribution: recommendation.solarContribution,
            horizonStart: now,
            horizonEnd: horizonEnd,
            evaluatedStarts: scored.map(\.start).sorted(),
            assumptions: assumptions(for: prepared.projection),
            hasUnobservedBalance: prepared.hasUnobservedBalance,
            lanes: lanes,
            periodSwitches: periodSwitches(in: tariffs, after: now, before: horizonEnd),
            projectionEnd: projectionEnd,
            projectionEndsAtRateChange: prepared.endsAtRateChange,
            safetyEnd: prepared.safetyEnd,
            safety: selection.safety,
            ruledOut: selection.ruledOut,
            usesHistory: prepared.projection.context?.hasGridHistory ?? false
        ), unavailableReason: nil)
    }

    static func loadUnavailable(_ profile: LoadProfile) -> Result {
        if profile.kind == .car, let settings = profile.carSettings,
           let estimate = LoadTimingEstimator.carChargeEstimate(settings: settings), estimate.wallKwh == 0 {
            return unavailable(.noEnergyNeeded)
        }
        return unavailable(.invalidInput)
    }

    /// A run "dips into" a bank when the typical projection prices some of it at
    /// that period's sell rate: the bank ends the projection banked and the run
    /// draws on it. Each such bank is read in the cautious projection at the
    /// safety window's end, less the bank-covered part of the run's draw before then.
    static func assess(_ candidate: Candidate, baseBalances: [String: Double],
                       cautiousBalances: [String: Double]?) -> Assessment {
        var worst: (periodKey: String, kwh: Double)?
        guard let cautiousBalances else { return Assessment(candidate: candidate, worst: nil) }
        for (key, draw) in candidate.draws.sorted(by: { $0.key < $1.key }) where draw > 0 {
            // Integration can leave a mathematically empty bank a few ULPs above
            // zero. That is no export cushion: it must not activate the safety
            // rule against a potentially large cautious deficit.
            guard let typical = baseBalances[key], typical > 1e-9, let cautious = cautiousBalances[key] else { continue }
            // Only the part the typical bank covers is priced at the sell rate and so
            // at risk in a cloudy week; an overdraw is already priced at the buy rate.
            let covered = min(candidate.drawsBySafetyEnd[key] ?? 0, typical)
            let remaining = cautious - covered
            if worst == nil || remaining < worst!.kwh { worst = (key, remaining) }
        }
        return Assessment(candidate: candidate, worst: worst)
    }
}
