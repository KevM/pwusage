import Foundation

extension LoadTimingForecastEstimator {
    struct Selection {
        let recommendation: Candidate
        let safety: Safety
        let ruledOut: RuledOut?
        let bestAlternativeSavings: Double
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
        let nowAssessment = assessed.first { $0.candidate.start == now }!
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
            recommended = nowInPool && nowAssessment.candidate.cost - best.candidate.cost <= minorUnit ? nowAssessment : best
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
        let bestAlternativeSavings = cheapest(alternatives).map { max(0, nowAssessment.candidate.cost - $0.candidate.cost) } ?? 0
        return Selection(recommendation: recommended.candidate, safety: safety, ruledOut: ruledOut,
                         bestAlternativeSavings: bestAlternativeSavings)
    }

    static func balanceLanes(now: Date, horizonEnd: Date, nowBalances: [String: Double],
                             baseBalances: [String: Double], load: (energy: Double, duration: TimeInterval),
                             startNow: Candidate, recommended: Candidate, steps: Steps,
                             tariffs: [LoadTimingTariffSegment]) -> [BalanceLane]? {
        let powerKw = load.energy / (load.duration / 3600)
        guard let nowSeries = balanceSeries(from: now, to: horizonEnd, balances: nowBalances,
                                            run: (startNow.start, startNow.end), powerKw: powerKw, steps: steps),
            let recommendedSeries = balanceSeries(from: now, to: horizonEnd, balances: nowBalances,
                                                  run: (recommended.start, recommended.end), powerKw: powerKw,
                                                  steps: steps)
        else { return nil }

        func periods(touching start: Date, _ end: Date) -> Set<String> {
            Set(tariffs.filter { $0.start < end && $0.end > start }.map(\.periodKey))
        }
        var keys = periods(touching: startNow.start, startNow.end).union(periods(touching: recommended.start, recommended.end))
        if let current = tariffs.first(where: { $0.start <= now && now < $0.end }) { keys.insert(current.periodKey) }
        // When starting now wins, every bank it was compared against keeps a (flat)
        // lane, so people can see the run doesn't draw on them.
        if recommended.start == startNow.start { keys.formUnion(periods(touching: now, horizonEnd)) }
        let firstOccurrence = Dictionary(tariffs.filter { $0.end > now && $0.start < horizonEnd }
            .map { ($0.periodKey, max($0.start, now)) }, uniquingKeysWith: min)

        return keys.filter { nowBalances[$0] != nil }
            .sorted { (firstOccurrence[$0] ?? .distantFuture, $0) < (firstOccurrence[$1] ?? .distantFuture, $1) }
            .compactMap { key in
                guard let start = nowBalances[key], let later = recommendedSeries[key], let immediate = nowSeries[key],
                      let projected = baseBalances[key] else {
                    return nil
                }
                return BalanceLane(periodKey: key, startKwh: start, recommended: later, startNow: immediate,
                                   projectedKwh: projected,
                                   projectedAfterRecommendedKwh: projected - (recommended.draws[key] ?? 0),
                                   projectedAfterStartNowKwh: projected - (startNow.draws[key] ?? 0))
            }
    }

    /// Integrates the baseline plus, inside `run`, the load's draw, recording every
    /// period's balance at each integration boundary. `nil` when a value overflows.
    static func balanceSeries(from start: Date, to end: Date, balances: [String: Double],
                              run: (start: Date, end: Date), powerKw: Double,
                              steps: Steps) -> [String: [BalancePoint]]? {
        guard start < end, var index = steps.step(containing: start), end <= steps.edges[steps.edges.count - 1] else {
            return nil
        }
        var current = balances
        var series = current.mapValues { [BalancePoint(date: start, kwh: $0)] }
        func advance(_ a: Date, _ b: Date, flow: Flow, periodKey: String) -> Bool {
            guard let old = current[periodKey] else { return false }
            let hours = b.timeIntervalSince(a) / 3600
            let draw = a >= run.start && b <= run.end ? powerKw * hours : 0
            let updated = old + flow.netExportKw * hours - draw
            guard updated.isFinite else { return false }
            current[periodKey] = updated
            for (key, kwh) in current { series[key, default: []].append(BalancePoint(date: b, kwh: kwh)) }
            return true
        }
        while index < steps.periods.count, steps.edges[index] < end {
            let a = max(steps.edges[index], start), b = min(steps.edges[index + 1], end)
            // The run's own edges split a step so its draw starts and stops on time.
            var cuts = [a]
            for edge in [run.start, run.end] where edge > a && edge < b { cuts.append(edge) }
            cuts.append(b)
            cuts.sort()
            for cut in 0 ..< (cuts.count - 1) {
                guard advance(cuts[cut], cuts[cut + 1], flow: steps.typical[index], periodKey: steps.periods[index]) else {
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
