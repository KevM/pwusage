import Foundation

extension SmartShiftPresentation.Context {
    var rateBars: [SmartShiftBar] {
        let indexed: [(offset: Int, bar: SmartShiftBar)] = comparison.lanes.enumerated().map {
            (offset: $0.offset, bar: bar($0.element))
        }
        let sorted = indexed.sorted { left, right in
            if left.bar.buyRate == right.bar.buyRate { return left.offset < right.offset }
            return left.bar.buyRate > right.bar.buyRate
        }
        return sorted.map(\.bar)
    }

    func bar(_ lane: LoadTimingForecastEstimator.BalanceLane) -> SmartShiftBar {
        SmartShiftBar(periodKey: lane.periodKey, name: name(lane.periodKey), rate: rate(lane.periodKey, sell: false),
                      buyRate: rateValue(lane.periodKey, sell: false) ?? 0,
                      baselinePosition: EnergyBalanceAxis.position(forBank: lane.projectedKwh),
                      recommended: barState(lane, for: .recommended), now: barState(lane, for: .now))
    }

    func barState(_ lane: LoadTimingForecastEstimator.BalanceLane, for id: SmartShiftChoiceID) -> SmartShiftBarState {
        let energy = runKwh(lane, for: id)
        let end = id == .now ? lane.projectedAfterStartNowKwh : lane.projectedAfterRecommendedKwh
        let rounded = SmartShiftPresentation.roundedKwh(energy)
        return SmartShiftBarState(runKwh: energy, totalPosition: EnergyBalanceAxis.position(forBank: end),
                                  runLabel: rounded > 0 ? "+\(rounded)" : nil,
                                  total: SmartShiftPresentation.endLabel(end),
                                  explanation: explanation(lane, for: id, energy: rounded,
                                                           total: SmartShiftPresentation.endLabel(end)))
    }

    private func explanation(_ lane: LoadTimingForecastEstimator.BalanceLane, for id: SmartShiftChoiceID,
                             energy: Int, total: String) -> String {
        let period = name(lane.periodKey)
        guard energy > 0 else { return "\(period): \(total). This job adds nothing here." }
        let without = SmartShiftPresentation.endLabel(lane.projectedKwh)
        let opening = "\(period): \(without) without this job, \(total) with it."
        let draws = id == .now ? nowDraws : laterDraws
        guard let draw = draws.first(where: { $0.key == lane.periodKey }) else { return opening }
        return "\(opening) \(reason(draw))"
    }

    private func reason(_ draw: SmartShiftPresentation.Draw) -> String {
        let usesBank = draw.fromBank >= 0.05
        let buys = draw.kwh - draw.fromBank >= 0.05
        if usesBank, buys { return "It uses the bank, then buys the rest at \(rate(draw.key, sell: false))." }
        if usesBank { return "It uses the bank, which costs only the \(rate(draw.key, sell: true)) credit." }
        return "It's bought at \(rate(draw.key, sell: false))."
    }
}
