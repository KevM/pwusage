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

    /// Everything `score` needs beyond the candidate run's start and end.
    struct ScoreInput {
        let load: (energy: Double, duration: TimeInterval)
        let baseBalances: [String: Double]
        let rates: [String: PeriodRate]
        let steps: Steps
        let safetyEnd: Date
    }

    /// The run's effect on each bank and on stored solar, accumulated step by step.
    private struct AccumulatedRun {
        let balances: [String: Double]
        let drawsBySafetyEnd: [String: Double]
        let solarContribution: Double
    }

    /// What one integration step does to a bank; `nil` when any value is not finite.
    private struct LoadedStep {
        let balance: Double
        let contribution: Double
        let drawBeforeSafetyEnd: Double
    }

    /// A helper's value, or the `ScoreResult` that ends the scoring early.
    private enum ScoreStep<Value> {
        case value(Value)
        case failed(ScoreResult)
    }

    static func score(start: Date, end: Date, input: ScoreInput) -> ScoreResult {
        guard start < end, let firstStep = input.steps.step(containing: start),
              end <= input.steps.edges[input.steps.edges.count - 1] else { return .incompleteCoverage }
        let powerKw = input.load.energy / (input.load.duration / 3600)
        guard powerKw.isFinite, powerKw > 0 else { return .invalidInput }
        let run: AccumulatedRun
        switch accumulate(start: start, end: end, powerKw: powerKw, firstStep: firstStep, input: input) {
        case .failed(let result): return result
        case .value(let accumulated): run = accumulated
        }
        var total = 0.0
        for (key, loadedBalance) in run.balances where loadedBalance != input.baseBalances[key] {
            guard let baselineBalance = input.baseBalances[key], let rate = input.rates[key] else {
                return .incompleteCoverage
            }
            guard let loadedCost = cost(balance: loadedBalance, rate: rate),
                  let baselineCost = cost(balance: baselineBalance, rate: rate) else { return .invalidInput }
            let delta = loadedCost - baselineCost
            let updatedTotal = total + delta
            guard delta.isFinite, updatedTotal.isFinite else { return .invalidInput }
            total = updatedTotal
        }
        let cappedSolarContribution = min(max(run.solarContribution, 0), input.load.energy)
        guard total.isFinite, cappedSolarContribution.isFinite else { return .invalidInput }
        return .candidate(Candidate(start: start, end: end, cost: total,
                                    solarContribution: cappedSolarContribution,
                                    draws: draws(in: run.balances, from: input.baseBalances),
                                    drawsBySafetyEnd: run.drawsBySafetyEnd))
    }

    /// Each bank's draw, the difference the loaded run made.
    private static func draws(in balances: [String: Double],
                              from baseBalances: [String: Double]) -> [String: Double] {
        var draws: [String: Double] = [:]
        for (key, loadedBalance) in balances {
            if let base = baseBalances[key], loadedBalance != base { draws[key] = base - loadedBalance }
        }
        return draws
    }

    /// Integrates the load over the run's steps, recording what each bank gives up.
    private static func accumulate(start: Date, end: Date, powerKw: Double, firstStep: Int,
                                   input: ScoreInput) -> ScoreStep<AccumulatedRun> {
        var withLoad = input.baseBalances
        var drawsBySafetyEnd: [String: Double] = [:]
        var solarContribution = 0.0
        var index = firstStep
        while index < input.steps.periods.count, input.steps.edges[index] < end {
            let lower = max(input.steps.edges[index], start), upper = min(input.steps.edges[index + 1], end)
            let periodKey = input.steps.periods[index]
            guard let balance = withLoad[periodKey] else { return .failed(.incompleteCoverage) }
            guard let step = loadStep(balance: balance, powerKw: powerKw, flow: input.steps.typical[index],
                                      span: StepSpan(lower: lower, upper: upper, safetyEnd: input.safetyEnd)) else {
                return .failed(.invalidInput)
            }
            let updatedSolarContribution = solarContribution + step.contribution
            guard updatedSolarContribution.isFinite else { return .failed(.invalidInput) }
            withLoad[periodKey] = step.balance
            if lower < input.safetyEnd { drawsBySafetyEnd[periodKey, default: 0] += step.drawBeforeSafetyEnd }
            solarContribution = updatedSolarContribution
            index += 1
        }
        return .value(AccumulatedRun(balances: withLoad, drawsBySafetyEnd: drawsBySafetyEnd,
                                     solarContribution: solarContribution))
    }

    /// The step's span and the safety cutoff it is measured against.
    private struct StepSpan {
        let lower: Date
        let upper: Date
        let safetyEnd: Date
    }

    /// One step of the run: the bank after its draw, the solar it used, and the
    /// part drawn before the safety cutoff.
    private static func loadStep(balance: Double, powerKw: Double, flow: Flow,
                                 span: StepSpan) -> LoadedStep? {
        let seconds = span.upper.timeIntervalSince(span.lower)
        let hours = seconds / 3600
        let energy = powerKw * hours
        let loadedBalance = balance - energy
        let physicalSurplusPower = max(flow.physicalSurplusKw, 0)
        let contribution = min(powerKw, physicalSurplusPower) * hours
        guard seconds.isFinite, hours.isFinite, energy.isFinite, loadedBalance.isFinite,
              flow.physicalSurplusKw.isFinite, physicalSurplusPower.isFinite,
              contribution.isFinite else { return nil }
        // A step straddling the cutoff counts only its part before it.
        let drawBeforeSafetyEnd = span.lower < span.safetyEnd
            ? (span.upper <= span.safetyEnd ? energy : powerKw * span.safetyEnd.timeIntervalSince(span.lower) / 3600)
            : 0
        return LoadedStep(balance: loadedBalance, contribution: contribution, drawBeforeSafetyEnd: drawBeforeSafetyEnd)
    }

    /// Everything about an evaluation that doesn't depend on the Job: the
    /// projection, its coverage, and the typical and cautious baselines. Build
    /// it once per pass and price every Job against it.
    static func evaluate(profile: LoadProfile, plan: Plan) -> Result {
        let prepared: Prepared
        switch preparedState(plan: plan, profile: profile) {
        case .failed(let result): return result
        case .ready(let ready): prepared = ready
        }
        guard let load = loadShape(for: profile) else { return loadUnavailable(profile) }
        let scored: [Candidate]
        switch scoredCandidates(load: load, prepared: prepared) {
        case .failed(let result): return result
        case .scored(let candidates): scored = candidates
        }
        guard let nowCandidate = scored.first(where: { $0.start == prepared.now }) else {
            return unavailable(.noFittingRun)
        }
        guard scored.allSatisfy(\.cost.isFinite) else { return unavailable(.invalidInput) }
        let selection = select(scored.map {
            assess($0, baseBalances: prepared.baseBalances, cautiousBalances: prepared.cautiousBalances)
        }, now: prepared.now, minorUnit: prepared.minorUnit)
        guard let lanes = balanceLanes(.init(now: prepared.now, horizonEnd: prepared.horizonEnd,
                                             nowBalances: prepared.nowBalances,
                                             baseBalances: prepared.baseBalances, load: load,
                                             startNow: nowCandidate, recommended: selection.recommendation,
                                             steps: prepared.steps, tariffs: prepared.tariffs)) else {
            return unavailable(.invalidInput)
        }
        return Result(comparison: comparison(prepared: prepared, scored: scored, nowCandidate: nowCandidate,
                                             selection: selection, lanes: lanes), unavailableReason: nil)
    }

    private enum PreparedState {
        case ready(Prepared)
        case failed(Result)
    }

    /// The plan's state read against the Job: a `beforeLoad` reason outranks an
    /// invalid Job, so the Job's shape is checked only for the other reasons.
    private static func preparedState(plan: Plan, profile: LoadProfile) -> PreparedState {
        switch plan.state {
        case .unavailable(let reason, beforeLoad: true): return .failed(unavailable(reason))
        case .unavailable(let reason, beforeLoad: false):
            guard loadShape(for: profile) != nil else { return .failed(loadUnavailable(profile)) }
            return .failed(unavailable(reason))
        case .ready(let ready): return .ready(ready)
        }
    }

    private enum ScoredCandidates {
        case scored([Candidate])
        case failed(Result)
    }

    /// Prices every start in the search window against the pass's baselines.
    private static func scoredCandidates(load: (energy: Double, duration: TimeInterval),
                                         prepared: Prepared) -> ScoredCandidates {
        let candidates = candidateStarts(now: prepared.now, horizonEnd: prepared.horizonEnd,
                                         duration: load.duration, model: prepared.model,
                                         tariffs: prepared.tariffs)
        let input = ScoreInput(load: load, baseBalances: prepared.baseBalances, rates: prepared.rates,
                               steps: prepared.steps, safetyEnd: prepared.safetyEnd)
        var scored: [Candidate] = []
        for candidateStart in candidates {
            let candidateEnd = candidateStart.addingTimeInterval(load.duration)
            guard candidateStart >= prepared.now, candidateStart < prepared.horizonEnd else { continue }
            guard candidateEnd.timeIntervalSince1970.isFinite else { return .failed(unavailable(.invalidInput)) }
            // A run starts inside the search window but may finish after it, up to the projection end.
            guard candidateEnd <= prepared.projectionEnd else { continue }
            switch score(start: candidateStart, end: candidateEnd, input: input) {
            case .candidate(let candidate): scored.append(candidate)
            case .invalidInput: return .failed(unavailable(.invalidInput))
            case .incompleteCoverage: return .failed(unavailable(.incompleteCoverage))
            }
        }
        return .scored(scored)
    }

    private static func comparison(prepared: Prepared, scored: [Candidate], nowCandidate: Candidate,
                                   selection: Selection, lanes: [BalanceLane]) -> Comparison {
        let recommendation = selection.recommendation
        let savings = recommendation.start == nowCandidate.start ? 0 : max(0, nowCandidate.cost - recommendation.cost)
        return Comparison(
            costNow: nowCandidate.cost,
            recommendedStart: recommendation.start,
            recommendedEnd: recommendation.end,
            recommendedCost: recommendation.cost,
            savings: savings,
            bestAlternativeSavings: selection.bestAlternativeSavings,
            estimatedSolarContribution: recommendation.solarContribution,
            horizonStart: prepared.now,
            horizonEnd: prepared.horizonEnd,
            evaluatedStarts: scored.map(\.start).sorted(),
            assumptions: assumptions(for: prepared.projection),
            hasUnobservedBalance: prepared.hasUnobservedBalance,
            lanes: lanes,
            periodSwitches: periodSwitches(in: prepared.tariffs, after: prepared.now, before: prepared.horizonEnd),
            projectionEnd: prepared.projectionEnd,
            projectionEndsAtRateChange: prepared.endsAtRateChange,
            safetyEnd: prepared.safetyEnd,
            safety: selection.safety,
            ruledOut: selection.ruledOut,
            usesHistory: prepared.projection.context?.hasGridHistory ?? false
        )
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
            guard let typical = baseBalances[key], typical > 1e-9,
                  let cautious = cautiousBalances[key] else { continue }
            // Only the part the typical bank covers is priced at the sell rate and so
            // at risk in a cloudy week; an overdraw is already priced at the buy rate.
            let covered = min(candidate.drawsBySafetyEnd[key] ?? 0, typical)
            let remaining = cautious - covered
            if worst.map({ remaining < $0.kwh }) ?? true { worst = (key, remaining) }
        }
        return Assessment(candidate: candidate, worst: worst)
    }
}
