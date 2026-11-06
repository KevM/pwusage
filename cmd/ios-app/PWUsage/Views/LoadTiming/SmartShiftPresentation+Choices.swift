import Foundation

extension SmartShiftPresentation.Context {
    var title: String {
        "\(profile.name) \(isNow ? "now" : when(comparison.recommendedStart))"
    }

    var subtitle: String {
        if claimsSaving { return "About \(money(comparison.savings)) cheaper than now" }
        switch comparison.safety {
        case .nowSafe:
            return "No cheaper time today"
        case .nowUnsafe(let key):
            let more = max(0, comparison.recommendedCost - comparison.costNow)
            return "About \(money(more)) more than now, but it won't leave \(name(key)) short"
        case .noSafeStart(let key):
            return "The least risky time, but a cloudy week could still leave \(name(key)) short"
        }
    }

    func runKwh(_ lane: LoadTimingForecastEstimator.BalanceLane, for id: SmartShiftChoiceID) -> Double {
        let end = id == .now ? lane.projectedAfterStartNowKwh : lane.projectedAfterRecommendedKwh
        return max(lane.projectedKwh - end, 0)
    }

    var choices: [SmartShiftChoice] {
        let nowChoice = SmartShiftChoice(id: .now, label: "Now", price: money(comparison.costNow),
                                         caption: caption(for: .now))
        guard !isNow else { return [nowChoice] }
        return [SmartShiftChoice(id: .recommended, label: capitalized(when(comparison.recommendedStart)),
                                 price: money(comparison.recommendedCost), caption: caption(for: .recommended)),
                nowChoice]
    }

    func caption(for id: SmartShiftChoiceID) -> String {
        let shares = comparison.lanes.map { (name: name($0.periodKey), kwh: runKwh($0, for: id)) }
            .filter { $0.kwh > 0 }.sorted { $0.kwh > $1.kwh }
        let total = shares.reduce(0) { $0 + $1.kwh }
        guard let first = shares.first, total > 0 else { return "" }
        if first.kwh / total >= 0.95 { return "All \(first.name)" }
        if first.kwh / total > 0.5 { return "Mostly \(first.name)" }
        guard shares.count > 1 else { return "All \(first.name)" }
        return "\(first.name) and \(shares[1].name)"
    }
}
