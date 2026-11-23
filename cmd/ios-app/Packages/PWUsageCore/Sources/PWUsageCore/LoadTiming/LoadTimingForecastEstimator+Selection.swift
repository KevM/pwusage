import Foundation

extension LoadTimingForecastEstimator {
    struct Selection {
        let recommendation: Candidate
        let safety: Safety
        let ruledOut: RuledOut?
        let bestAlternativeSavings: Double
    }

    /// Everything `balanceLanes` needs about the pass and the two runs it charts.
    struct BalanceLaneInputs {
        let now: Date
        let horizonEnd: Date
        let nowBalances: [String: Double]
        let baseBalances: [String: Double]
        let load: (energy: Double, duration: TimeInterval)
        let startNow: Candidate
        let recommended: Candidate
        let steps: Steps
        let tariffs: [LoadTimingTariffSegment]
    }

    /// One run integrated over a window on top of `balances`, for `balanceSeries`.
    struct BalanceSeriesInputs {
        let start: Date
        let end: Date
        let balances: [String: Double]
        let run: (start: Date, end: Date)
        let powerKw: Double
        let steps: Steps
    }

    /// The cheapest start that passes the safety rule (ties: earliest); starting
    /// now unless a passing later start saves more than a minor unit while now
    /// passes too. When nothing passes, the start leaving its bank least short
    /// (ties: cheapest, then earliest).
    static func select(_ assessed: [Assessment], now: Date, minorUnit: Double) -> Selection {
        func cheapest(_ pool: [Assessment]) -> Assessment? {
            pool.min { $0.candidate.cost == $1.candidate.cost ? $0.candidate.start < $1.candidate.start
                : $0.candidate.cost < $1.candidate.cost }
        }
        // `evaluate` only calls this with a scored "now".
        guard let nowAssessment = assessed.first(where: { $0.candidate.start == now }) else {
            preconditionFailure("select requires a scored assessment for now")
        }
        let passing = assessed.filter(\.passes)
        let recommended: Assessment
        let safety: Safety
        if let best = cheapest(passing) {
            if nowAssessment.passes {
                recommended = nowAssessment.candidate.cost - best.candidate.cost > minorUnit ? best : nowAssessment
                safety = .nowSafe
            } else {
                recommended = best
                safety = .nowUnsafe(periodKey: nowAssessment.worst?.periodKey ?? "")
            }
        } else {
            let least = assessed.map(\.shortfall).min() ?? 0
            let pool = assessed.filter { $0.shortfall <= least + 1e-9 }
            let best = cheapest(pool) ?? nowAssessment
            let nowInPool = pool.contains { $0.candidate.start == now }
            recommended = nowInPool && nowAssessment.candidate.cost - best.candidate.cost <= minorUnit
                ? nowAssessment : best
            safety = .noSafeStart(periodKey: recommended.worst?.periodKey ?? "")
        }
        let rejectedCheaper = assessed.filter {
            !$0.passes && recommended.candidate.cost - $0.candidate.cost > minorUnit
        }
        let ruledOut = cheapest(rejectedCheaper).map {
            RuledOut(start: $0.candidate.start, cost: $0.candidate.cost, periodKey: $0.worst?.periodKey ?? "")
        }
        // Raw saving of the cheapest eligible non-now start, before the minor-unit threshold.
        let alternatives = (passing.isEmpty ? assessed : passing).filter { $0.candidate.start != now }
        let bestAlternativeSavings = cheapest(alternatives)
            .map { max(0, nowAssessment.candidate.cost - $0.candidate.cost) } ?? 0
        return Selection(recommendation: recommended.candidate, safety: safety, ruledOut: ruledOut,
                         bestAlternativeSavings: bestAlternativeSavings)
    }

    static func balanceLanes(_ inputs: BalanceLaneInputs) -> [BalanceLane]? {
        let powerKw = inputs.load.energy / (inputs.load.duration / 3600)
        guard let nowSeries = balanceSeries(.init(start: inputs.now, end: inputs.horizonEnd,
                                                  balances: inputs.nowBalances,
                                                  run: (inputs.startNow.start, inputs.startNow.end),
                                                  powerKw: powerKw, steps: inputs.steps)),
            let recommendedSeries = balanceSeries(.init(start: inputs.now, end: inputs.horizonEnd,
                                                        balances: inputs.nowBalances,
                                                        run: (inputs.recommended.start, inputs.recommended.end),
                                                        powerKw: powerKw, steps: inputs.steps))
        else { return nil }

        var keys = periods(touching: inputs.startNow.start, inputs.startNow.end, in: inputs.tariffs)
            .union(periods(touching: inputs.recommended.start, inputs.recommended.end, in: inputs.tariffs))
        if let current = inputs.tariffs.first(where: { $0.start <= inputs.now && inputs.now < $0.end }) {
            keys.insert(current.periodKey)
        }
        // When starting now wins, every bank it was compared against keeps a (flat)
        // lane, so people can see the run doesn't draw on them.
        if inputs.recommended.start == inputs.startNow.start {
            keys.formUnion(periods(touching: inputs.now, inputs.horizonEnd, in: inputs.tariffs))
        }
        let firstOccurrence = Dictionary(inputs.tariffs.filter { $0.end > inputs.now && $0.start < inputs.horizonEnd }
            .map { ($0.periodKey, max($0.start, inputs.now)) }, uniquingKeysWith: min)

        return keys.filter { inputs.nowBalances[$0] != nil }
            .sorted { (firstOccurrence[$0] ?? .distantFuture, $0) < (firstOccurrence[$1] ?? .distantFuture, $1) }
            .compactMap { key in
                guard let start = inputs.nowBalances[key], let later = recommendedSeries[key],
                      let immediate = nowSeries[key], let projected = inputs.baseBalances[key] else {
                    return nil
                }
                return BalanceLane(periodKey: key, startKwh: start, recommended: later, startNow: immediate,
                                   projectedKwh: projected,
                                   projectedAfterRecommendedKwh: projected - (inputs.recommended.draws[key] ?? 0),
                                   projectedAfterStartNowKwh: projected - (inputs.startNow.draws[key] ?? 0))
            }
    }

    /// The tariff periods a window touches.
    private static func periods(touching start: Date, _ end: Date,
                                in tariffs: [LoadTimingTariffSegment]) -> Set<String> {
        Set(tariffs.filter { $0.start < end && $0.end > start }.map(\.periodKey))
    }

    /// Integrates the baseline plus, inside `run`, the load's draw, recording every
    /// period's balance at each integration boundary. `nil` when a value overflows.
    static func balanceSeries(_ inputs: BalanceSeriesInputs) -> [String: [BalancePoint]]? {
        guard inputs.start < inputs.end, var index = inputs.steps.step(containing: inputs.start),
              inputs.end <= inputs.steps.edges[inputs.steps.edges.count - 1] else {
            return nil
        }
        var current = inputs.balances
        var series = current.mapValues { [BalancePoint(date: inputs.start, kwh: $0)] }
        func advance(_ lower: Date, _ upper: Date, flow: Flow, periodKey: String) -> Bool {
            guard let old = current[periodKey] else { return false }
            let hours = upper.timeIntervalSince(lower) / 3600
            let draw = lower >= inputs.run.start && upper <= inputs.run.end ? inputs.powerKw * hours : 0
            let updated = old + flow.netExportKw * hours - draw
            guard updated.isFinite else { return false }
            current[periodKey] = updated
            for (key, kwh) in current { series[key, default: []].append(BalancePoint(date: upper, kwh: kwh)) }
            return true
        }
        while index < inputs.steps.periods.count, inputs.steps.edges[index] < inputs.end {
            let lower = max(inputs.steps.edges[index], inputs.start)
            let upper = min(inputs.steps.edges[index + 1], inputs.end)
            // The run's own edges split a step so its draw starts and stops on time.
            var cuts = [lower]
            for edge in [inputs.run.start, inputs.run.end] where edge > lower && edge < upper { cuts.append(edge) }
            cuts.append(upper)
            cuts.sort()
            for cut in 0 ..< (cuts.count - 1) {
                guard advance(cuts[cut], cuts[cut + 1], flow: inputs.steps.typical[index],
                              periodKey: inputs.steps.periods[index]) else {
                    return nil
                }
            }
            index += 1
        }
        return series
    }

    /// The tariff segment containing `date` (the timeline is sorted and non-overlapping).
    static func segment(at date: Date, in tariffs: [LoadTimingTariffSegment]) -> LoadTimingTariffSegment? {
        let index = tariffs.partitionPoint { $0.end > date }
        guard index < tariffs.count, tariffs[index].start <= date else { return nil }
        return tariffs[index]
    }
}
