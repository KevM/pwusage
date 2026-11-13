import Foundation
@testable import PWUsage
import Testing

/// Local-only degradation backtest on the owner's real history (see DegradationBacktestInputs).
/// Writes report.md into the research folder; prints nothing about the site's readings to the log.
/// Without PWUSAGE_SOLAR_BACKTEST_DIR the suite is disabled.
@Suite("Solar degradation backtest", .serialized)
struct DegradationBacktestTests {
    private static let scope = SolarForecastSiteScope(accountScopeID: "backtest", siteID: "backtest")

    @Test(.enabled(if: DegradationBacktestInputs.isEnabled))
    func writesBacktestReport() throws {
        let inputs = try DegradationBacktestInputs.load()
        let reference = try #require(SolarHealthReference(manual: inputs.config.manual, detected: nil))
        let shipped = try Self.pass(inputs, reference: reference, snowDays: inputs.snowDays)
        let withSnow = try Self.pass(inputs, reference: reference, snowDays: [])

        var lines = ["# Degradation backtest report", ""]
        lines += Self.coverage(inputs, result: shipped)
        let calibration = Self.expectedEnergy(inputs, result: shipped)
        lines += calibration.lines
        lines += DegradationBacktestIrradiance.section(
            inputs, clearSky: shipped, clearSkyFactor: calibration.factor)
        lines += Self.trendSection(inputs, result: shipped, withSnow: withSnow)
        try inputs.write(lines, to: "report.md")
    }

    static func pass(
        _ inputs: DegradationBacktestInputs, reference: SolarHealthReference, snowDays: Set<String>
    ) throws -> SolarHealthResult {
        let folder = FileManager.default.temporaryDirectory.appending(path: "backtest-\(UUID().uuidString)")
        let context = SolarHealthPass.Context(
            scope: scope, cache: SolarHealthCache(directory: folder), now: inputs.config.now, snowDays: snowDays)
        return try SolarHealthPass.compute(
            samples: inputs.samples, place: inputs.place(reference: reference), context: context,
            checkCancellation: {})
    }

    /// The shipped clear days with both energies, from the pass's daily ratios.
    static func clearDays(_ result: SolarHealthResult) -> [DegradationDay] {
        result.years.flatMap(\.dailyRatios).compactMap { ratio in
            guard let expected = ratio.expectedKwh, let actual = ratio.actualKwh, expected > 0 else { return nil }
            return DegradationDay(day: ratio.day, expected: expected, actual: actual)
        }
    }

    // MARK: - 1. Usable history

    private static func coverage(_ inputs: DegradationBacktestInputs, result: SolarHealthResult) -> [String] {
        let calendar = inputs.calendar
        var producing: [String: Set<String>] = [:]
        for sample in inputs.samples where sample.solarWh > 0 {
            let day = DegradationBacktestInputs.dayString(sample.timestamp, calendar: calendar)
            producing[String(day.prefix(7)), default: []].insert(day)
        }
        var fitted: [String: SolarHealthMonth] = [:]
        for year in result.years {
            for month in year.months { fitted[String(format: "%04d-%02d", year.year, month.month)] = month }
        }
        var lines = [
            "## 1. Usable history", "",
            "Clear days are the shipped selection after snowfall exclusion; `-` means fewer than "
                + "\(SolarHealthYearFit.minMonthClearDays) clear days, so no factor. "
                + "E/W are per-direction factors where the fit separates them.", "",
            "month | producing days | snow days | rain days | clear days | site | E | W | matched",
            "--- | --- | --- | --- | --- | --- | --- | --- | ---"
        ]
        for key in producing.keys.sorted() {
            lines.append(coverageRow(key, inputs: inputs, producing: producing[key]?.count ?? 0, fitted: fitted))
        }
        for year in result.years {
            let factor = year.capacity.map { String(format: "%.3f", $0.site) } ?? "-"
            lines.append("")
            lines.append(
                "Year \(year.year): \(year.clearDays) clear days, site factor \(factor), clipping \(year.hasClipping)")
        }
        return lines + [""]
    }

    private static func coverageRow(
        _ key: String, inputs: DegradationBacktestInputs, producing: Int, fitted: [String: SolarHealthMonth]
    ) -> String {
        let month = fitted[key]
        let directions = month?.capacity.directions ?? []
        let factors = directions.count == 2 ? directions.map { String(format: "%.3f", $0.factor) } : ["-", "-"]
        let matched = fitted.keys.count { $0.suffix(2) == key.suffix(2) } > 1
        let cells = [
            key, "\(producing)", "\(inputs.snowDays.count { $0.hasPrefix(key) })",
            "\(inputs.rainDays.count { $0.hasPrefix(key) })",
            month.map { "\($0.capacity.clearDays)" } ?? "-",
            month.map { String(format: "%.3f", $0.capacity.site) } ?? "-",
            factors[0], factors[1], month == nil ? "-" : (matched ? "yes" : "no")
        ]
        return cells.joined(separator: " | ")
    }

    // MARK: - 2. Expected daily energy

    private static func expectedEnergy(
        _ inputs: DegradationBacktestInputs, result: SolarHealthResult
    ) -> (lines: [String], factor: Double) {
        let days = clearDays(result)
        let calibration = days.filter { inputs.config.calibration.contains($0.day) }
        let factor = calibration.reduce(0) { $0 + $1.actual } / max(calibration.reduce(0) { $0 + $1.expected }, 1e-9)
        let holdout = days.filter { inputs.config.holdout.contains($0.day) }
        let frozen = holdout.map { DegradationDay(day: $0.day, expected: $0.expected * factor, actual: $0.actual) }
        let window = inputs.config.calibration
        var lines = [
            "## 2. Expected daily energy (clear days)", "",
            "Calibration \(window.from)..\(window.through): \(calibration.count) clear days; frozen factor "
                + String(format: "%.4f", factor) + " (actual over the shipped reference).", "",
            "model | scope | days | MAE kWh | bias kWh | mean actual kWh", "--- | --- | --- | --- | --- | ---"
        ]
        let baseline = scoreRows("shipped 85% reference", holdout, latitude: inputs.latitude, into: &lines)
        let candidate = scoreRows("frozen site factor", frozen, latitude: inputs.latitude, into: &lines)
        lines += perYearBias(calibration + holdout, factor: factor)
        lines += decision(baseline: baseline, candidate: candidate)
        return (lines + [""], factor)
    }

    /// Appends one table row per scope and returns the scores by scope.
    static func scoreRows(
        _ name: String, _ days: [DegradationDay], latitude: Double, into lines: inout [String]
    ) -> [String: DegradationDailyScore] {
        var scores: [String: DegradationDailyScore] = [:]
        for (scope, subset) in DegradationDailyScore.scopes(days, latitude: latitude) {
            let score = DegradationDailyScore(subset)
            scores[scope] = score
            lines.append("\(name) | \(scope) | \(score.row)")
        }
        return scores
    }

    private static func perYearBias(_ days: [DegradationDay], factor: Double) -> [String] {
        var lines = [
            "", "Frozen-factor bias by year (actual - expected, % of expected; decline shows as falling bias):", ""
        ]
        let byYear = Dictionary(grouping: days) { DegradationBacktest.year(of: $0.day) }
        for (year, subset) in byYear.sorted(by: { $0.key < $1.key }) {
            let expected = subset.reduce(0) { $0 + $1.expected * factor }
            let actual = subset.reduce(0) { $0 + $1.actual }
            lines.append(String(
                format: "- %d: %d days, %+.2f%%", year, subset.count, (actual - expected) / expected * 100))
        }
        return lines
    }

    static func decision(
        baseline: [String: DegradationDailyScore], candidate: [String: DegradationDailyScore]
    ) -> [String] {
        guard let base = baseline["all"], let cand = candidate["all"], base.mae > 0 else { return [] }
        let gain = (base.mae - cand.mae) / base.mae
        var material: [String] = []
        var inconclusive: [String] = []
        for season in SolarSeason.allCases.map({ "\($0)" }) {
            guard let seasonBase = baseline[season], let seasonCand = candidate[season] else { continue }
            guard seasonCand.count >= DegradationBacktest.minSeasonDays else {
                inconclusive.append(season)
                continue
            }
            let growth = abs(seasonCand.bias) - abs(seasonBase.bias)
            if growth > DegradationBacktest.materialBiasShare * seasonCand.meanActual { material.append(season) }
        }
        let advance = gain >= DegradationBacktest.minMaeGain && material.isEmpty
        let needed = DegradationBacktest.minMaeGain * 100
        return [
            "",
            String(format: "Decision: MAE change %+.1f%% (needs ≤ -%.0f%%); ", -gain * 100, needed)
                + "material seasonal bias: \(material.isEmpty ? "none" : material.joined(separator: ", ")); "
                + "inconclusive seasons: \(inconclusive.isEmpty ? "none" : inconclusive.joined(separator: ", ")). "
                + "**\(advance ? "Advance" : "Do not advance")**."
        ]
    }
}
