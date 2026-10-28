import Foundation

extension SmartShiftPresentation {
    struct Draw {
        let key: String
        let kwh: Double
        let fromBank: Double
        /// The period's projected bank without this run, when its lane is known.
        let bankWithoutRun: Double?
    }

    /// What a run takes from each period, in the order it reaches them, and how much
    /// of that its bank covers. A lane ends `kwh` lower than it would without the run,
    /// so the bank it drew from is that lane's end plus the draw.
    static func draws(from start: Date, to end: Date, profile: LoadProfile, timing: LoadTiming,
                      laneEnd: (LoadTimingForecastEstimator.BalanceLane) -> Double?,
                      lanes: [LoadTimingForecastEstimator.BalanceLane]) -> [Draw] {
        let hours = end.timeIntervalSince(start) / 3600
        guard hours > 0, let energy = energyKwh(of: profile), energy > 0 else { return [] }
        let powerKw = energy / hours
        return hoursByPeriod(from: start, to: end, timing: timing).map { key, periodHours in
            let drawn = powerKw * periodHours
            let bank = lanes.first { $0.periodKey == key }.flatMap(laneEnd).map { $0 + drawn }
            return Draw(key: key, kwh: drawn, fromBank: bank.map { min(drawn, max($0, 0)) } ?? 0, bankWithoutRun: bank)
        }
    }

    /// Hours a run spends in each rate period, in the order it reaches them.
    static func hoursByPeriod(from start: Date, to end: Date, timing: LoadTiming) -> [(key: String, hours: Double)] {
        var result: [(key: String, hours: Double)] = []
        for segment in timing.tariffTimeline.sorted(by: { $0.start < $1.start }) where segment.start < end && segment.end > start {
            let overlap = min(segment.end, end).timeIntervalSince(max(segment.start, start)) / 3600
            if let index = result.firstIndex(where: { $0.key == segment.periodKey }) {
                result[index].hours += overlap
            } else {
                result.append((segment.periodKey, overlap))
            }
        }
        return result
    }

    // MARK: - A better Job

    /// "Wash the dishes: save about $2.10 by waiting", when another Job's saving
    /// beats the selected one's by more than a minor unit; otherwise `nil`.
    static func betterJobHint(selectedID: String, savingsByJob: [(LoadProfile, Double)], currencyCode: String) -> BetterJobHint? {
        let selected = savingsByJob.first { $0.0.id == selectedID }?.1 ?? 0
        let minorUnit = LoadTimingForecastEstimator.currencyMinorUnit(currencyCode)
        guard let (profile, savings) = savingsByJob
            .filter({ $0.0.id != selectedID && $0.1.isFinite })
            .max(by: { $0.1 < $1.1 }),
            savings > minorUnit, savings - selected > minorUnit else { return nil }
        return BetterJobHint(id: profile.id,
                             text: "\(profile.name): save about \(DashboardPresentation.currency(savings, code: currencyCode)) by waiting")
    }

    // MARK: - Blocked states
}
