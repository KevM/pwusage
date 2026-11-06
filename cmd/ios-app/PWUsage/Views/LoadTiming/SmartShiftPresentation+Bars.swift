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
                                  total: SmartShiftPresentation.endLabel(end))
    }
}
