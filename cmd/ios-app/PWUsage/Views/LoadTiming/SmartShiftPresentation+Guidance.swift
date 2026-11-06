import Foundation

extension SmartShiftPresentation.Context {
    var showsGuidance: Bool { claimsSaving || (isNow && comparison.safety == .nowSafe) }

    func costPerKwh(_ draw: SmartShiftPresentation.Draw) -> Double {
        guard draw.kwh > 0 else { return 0 }
        let sell = rateValue(draw.key, sell: true) ?? 0
        let buy = rateValue(draw.key, sell: false) ?? 0
        return (draw.fromBank * sell + (draw.kwh - draw.fromBank) * buy) / draw.kwh
    }

    var checkKey: String? {
        let draws = isNow ? nowDraws : laterDraws
        guard showsGuidance, let largest = draws.max(by: { $0.kwh < $1.kwh }),
              draws.filter({ abs(costPerKwh($0) - costPerKwh(largest)) < 0.000_001 }).count == 1,
              draws.allSatisfy({ costPerKwh(largest) <= costPerKwh($0) }),
              timing.pricingPeriods.contains(where: { $0.buyRate > (rateValue(largest.key, sell: false) ?? 0) })
        else { return nil }
        return largest.key
    }

    var warningKey: String? {
        let draws = nowDraws
        guard showsGuidance, !isNow, let highest = draws.max(by: { costPerKwh($0) < costPerKwh($1) }),
              draws.filter({ abs(costPerKwh($0) - costPerKwh(highest)) < 0.000_001 }).count == 1 else { return nil }
        let total = laterDraws.reduce(0) { $0 + $1.kwh }
        guard total > 0 else { return nil }
        let cost = laterDraws.reduce(0) { $0 + costPerKwh($1) * $1.kwh }
        return costPerKwh(highest) > cost / total ? highest.key : nil
    }

    var guidedBars: [SmartShiftBar] {
        rateBars.map { original in
            var bar = original
            if bar.periodKey == checkKey {
                let lowest = timing.pricingPeriods.map(\.buyRate).min()
                if isNow {
                    bar.now.badge = .cheapest
                    bar.now.badgeLabel = bar.buyRate == lowest ? "Least expensive" : nil
                } else {
                    bar.recommended.badge = .cheapest
                    bar.recommended.badgeLabel = bar.buyRate == lowest ? "Least expensive" : nil
                }
            }
            if bar.periodKey == warningKey {
                bar.now.badge = .priciest
                bar.now.badgeLabel = bar.buyRate == timing.pricingPeriods.map(\.buyRate).max() ? "Most expensive" : nil
            }
            return bar
        }
    }

    var slot: SmartShiftSlot? {
        guard claimsSaving, !isNow else { return nil }
        let candidates = rateBars.filter { $0.recommended.runKwh - $0.now.runKwh > 0.05 }
        guard let best = candidates.min(by: { left, right in
            let leftGain = left.recommended.runKwh - left.now.runKwh
            let rightGain = right.recommended.runKwh - right.now.runKwh
            if abs(leftGain - rightGain) > 0.000_001 { return leftGain > rightGain }
            let leftCost = laterDraws.first { $0.key == left.periodKey }.map(costPerKwh) ?? .infinity
            let rightCost = laterDraws.first { $0.key == right.periodKey }.map(costPerKwh) ?? .infinity
            return leftCost < rightCost
        }) else { return nil }
        let amount = money(comparison.savings)
        return SmartShiftSlot(periodKey: best.periodKey, extraKwh: best.recommended.runKwh - best.now.runKwh,
                              label: "Save \(amount)",
                              accessibilityLabel: "Save about \(amount) by starting "
                                  + when(comparison.recommendedStart))
    }
}
