import Foundation
@testable import PWUsage

extension DegradationBacktestTests {
    // MARK: - 4. Annual decline (real history)

    static func trendSection(
        _ inputs: DegradationBacktestInputs, result: SolarHealthResult, withSnow: SolarHealthResult
    ) -> [String] {
        let manual = inputs.config.manual
        let now = inputs.config.now
        let shipped = DegradationBacktest.trend(result, manual: manual, now: now)
        let expected = shipped.change.expectedAgingPercentPerYear.map { String(format: "%+.2f%%/yr", $0) } ?? "none"
        var lines = [
            "## 4. Annual decline", "",
            "Shipped estimate: \(DegradationBacktest.describe(shipped)); expected aging \(expected).", "",
            "month | from | to | change %/yr | clear days (from, to)", "--- | --- | --- | --- | ---"
        ]
        let pairs = DegradationBacktest.pairs(shipped.change.months)
        for pair in pairs {
            lines.append(String(
                format: "%d | %d | %d | %+.2f | %d, %d", pair.month, pair.earlier.year, pair.later.year, pair.change,
                pair.earlier.clearDays, pair.later.clearDays))
        }
        let changes = pairs.map(\.change)
        lines.append("")
        lines.append(String(
            format: "Pair changes: median %+.2f, IQR %.2f pp/yr.",
            DegradationBacktest.median(changes), DegradationBacktest.interquartileRange(changes)))
        lines += ["", "Sensitivity:", ""]
        for (name, variant) in sensitivityVariants(result, latitude: inputs.latitude) {
            let analysis = DegradationBacktest.trend(variant, manual: manual, now: now)
            lines.append("- \(name): \(DegradationBacktest.describe(analysis))")
        }
        let snow = DegradationBacktest.trend(withSnow, manual: manual, now: now)
        lines.append("- including snowfall days: \(DegradationBacktest.describe(snow))")
        lines.append("- excluding known shading or hardware changes: none recorded for this site, so no run.")
        return lines + [""]
    }

    private static func sensitivityVariants(
        _ result: SolarHealthResult, latitude: Double
    ) -> [(String, SolarHealthResult)] {
        var variants: [(String, SolarHealthResult)] = SolarSeason.allCases.map { season in
            ("without \(season)", DegradationBacktest.reshaped(result) { _, month in
                SolarSeason.of(month: month.month, latitude: latitude) == season ? nil : month
            })
        }
        let directions = result.reference.directions
        if directions.count == 2 {
            for (index, direction) in directions.enumerated() {
                let kept = directions[1 - index]
                let name = String(
                    format: "omitting the %.0f° direction (trend from the %.0f° factor)",
                    direction.azimuth, kept.azimuth)
                variants.append((name, DegradationBacktest.reshaped(result) { _, month in
                    guard month.capacity.directions.count == 2 else { return nil }
                    let capacity = SolarHealthCapacity(
                        site: month.capacity.directions[1 - index].factor, directions: [],
                        clearDays: month.capacity.clearDays)
                    return SolarHealthMonth(month: month.month, capacity: capacity)
                }))
            }
        }
        variants.append(("months with at least 8 clear days", DegradationBacktest.reshaped(result) { _, month in
            month.capacity.clearDays >= 8 ? month : nil
        }))
        return variants
    }
}
