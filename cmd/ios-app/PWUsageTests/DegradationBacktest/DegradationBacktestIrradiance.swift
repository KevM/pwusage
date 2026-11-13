import Foundation
@testable import PWUsage

/// Section 3: expected energy from ERA5 hourly irradiance on the entered layout, against production
/// over the same UTC hours.
enum DegradationBacktestIrradiance {
    struct Day {
        var expected = 0.0
        var actual = 0.0
        var isComplete = true
    }

    private struct HourEnergy {
        var wattHours = 0.0
        var samples = 0
    }

    private struct MonthSum {
        var expected = 0.0
        var actual = 0.0
        var days = 0
    }

    /// Site-local days built from whole hours: a day counts only when every hour the model lights, or
    /// the array produced in, holds all twelve 5-minute samples. Snowfall days are left out.
    static func days(_ inputs: DegradationBacktestInputs) throws -> [String: Day] {
        guard let layout = inputs.config.manual.solarLayout(
            detected: nil, on: inputs.config.now, detectedAt: nil) else { return [:] }
        var energy: [Int: HourEnergy] = [:]
        for sample in inputs.samples {
            let hour = Int((sample.timestamp.timeIntervalSince1970 / 3600).rounded(.down))
            energy[hour, default: HourEnergy()].wattHours += sample.solarWh
            energy[hour, default: HourEnergy()].samples += 1
        }
        let calendar = inputs.calendar
        var out: [String: Day] = [:]
        for hour in inputs.hours {
            let midpoint = hour.end.addingTimeInterval(-1800)
            let modeled = try OpenMeteoArrayModel.powerKw(
                at: midpoint, radiation: hour.radiation, layout: layout, location: inputs.location)
            let measured = energy[Int((midpoint.timeIntervalSince1970 / 3600).rounded(.down))]
            guard modeled > 0 || (measured?.wattHours ?? 0) > 0 else { continue }
            let day = DegradationBacktestInputs.dayString(midpoint, calendar: calendar)
            out[day, default: Day()].expected += modeled
            out[day, default: Day()].actual += (measured?.wattHours ?? 0) / 1000
            if measured?.samples != 12 { out[day, default: Day()].isComplete = false }
        }
        return out.filter { $0.value.isComplete && !inputs.snowDays.contains($0.key) }
    }

    static func section(
        _ inputs: DegradationBacktestInputs, clearSky: SolarHealthResult, clearSkyFactor: Double
    ) -> [String] {
        let days: [String: Day]
        do {
            days = try Self.days(inputs)
        } catch {
            return ["## 3. Historical irradiance", "", "Model failed: \(error)", ""]
        }
        let clear = Dictionary(
            DegradationBacktestTests.clearDays(clearSky).map { ($0.day, $0) }, uniquingKeysWith: { first, _ in first })
        let calibration = days.filter { clear[$0.key] != nil && inputs.config.calibration.contains($0.key) }
        let factor = calibration.values.reduce(0) { $0 + $1.actual }
            / max(calibration.values.reduce(0) { $0 + $1.expected }, 1e-9)
        var lines = [
            "## 3. Historical irradiance", "",
            "\(days.count) complete non-snow days with ERA5 hours (\(clear.count) shipped clear days overall). "
                + String(format: "Frozen irradiance factor %.4f", factor)
                + " from \(calibration.count) calibration clear days.", "",
            "model | scope | days | MAE kWh | bias kWh | mean actual kWh", "--- | --- | --- | --- | --- | ---"
        ]
        let holdout = days.filter { inputs.config.holdout.contains($0.key) }
        let shared = holdout.keys.sorted().compactMap { clear[$0] }
        let latitude = inputs.latitude
        _ = DegradationBacktestTests.scoreRows(
            "shipped 85% reference (clear)", shared, latitude: latitude, into: &lines)
        let frozenClearSky = shared.map {
            DegradationDay(day: $0.day, expected: $0.expected * clearSkyFactor, actual: $0.actual)
        }
        let baseline = DegradationBacktestTests.scoreRows(
            "frozen clear-sky factor (clear)", frozenClearSky, latitude: latitude, into: &lines)
        let irradianceClear = shared.compactMap { day in
            holdout[day.day].map { DegradationDay(day: day.day, expected: $0.expected * factor, actual: $0.actual) }
        }
        let candidate = DegradationBacktestTests.scoreRows(
            "frozen irradiance (clear)", irradianceClear, latitude: latitude, into: &lines)
        let cloudy = holdout.filter { clear[$0.key] == nil }.map {
            DegradationDay(day: $0.key, expected: $0.value.expected * factor, actual: $0.value.actual)
        }
        _ = DegradationBacktestTests.scoreRows(
            "frozen irradiance (not clear)", cloudy, latitude: latitude, into: &lines)
        lines += ["", "Irradiance against the frozen clear-sky factor on the same held-out clear days:"]
        lines += DegradationBacktestTests.decision(baseline: baseline, candidate: candidate)
        lines += trend(inputs, days: days, clearDays: Set(clear.keys), clearSky: clearSky)
        return lines + [""]
    }

    private static func trend(
        _ inputs: DegradationBacktestInputs, days: [String: Day], clearDays: Set<String>, clearSky: SolarHealthResult
    ) -> [String] {
        let manual = inputs.config.manual
        let now = inputs.config.now
        let shipped = DegradationBacktest.trend(clearSky, manual: manual, now: now)
        var lines = [
            "", "Trends (matched-month median through the shipped estimator):", "",
            "- clear-sky (shipped): \(describe(shipped))"
        ]
        let variants: [(String, (String) -> Bool)] = [
            ("all counted days", { _ in true }), ("clear days only", clearDays.contains)
        ]
        for (name, keep) in variants {
            var monthly: [Int: [Int: MonthSum]] = [:]
            for (day, value) in days where keep(day) && value.expected > 0 {
                let year = DegradationBacktest.year(of: day)
                let month = DegradationBacktest.month(of: day)
                monthly[year, default: [:]][month, default: MonthSum()].expected += value.expected
                monthly[year, default: [:]][month, default: MonthSum()].actual += value.actual
                monthly[year, default: [:]][month, default: MonthSum()].days += 1
            }
            let factors = monthly.mapValues { months in
                months.filter { $0.value.days >= 10 }.mapValues { (factor: $0.actual / $0.expected, days: $0.days) }
            }
            let result = DegradationBacktest.result(reference: clearSky.reference, monthly: factors)
            let analysis = DegradationBacktest.trend(result, manual: manual, now: now)
            lines.append("- irradiance, \(name): \(describe(analysis))")
        }
        return lines
    }

    private static func describe(_ analysis: SolarHealthClassifier.ChangeAnalysis) -> String {
        let changes = DegradationBacktest.pairs(analysis.change.months).map(\.change)
        return DegradationBacktest.describe(analysis)
            + String(format: "; pair IQR %.2f pp/yr", DegradationBacktest.interquartileRange(changes))
    }
}
