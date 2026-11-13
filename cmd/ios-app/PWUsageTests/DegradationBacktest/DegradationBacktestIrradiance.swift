import Foundation
@testable import PWUsage

/// Section 3: expected energy from ERA5 hourly irradiance on the entered layout, against production
/// over the same UTC hours. The shipped clear-sky reference is evaluated on the same hours (at each
/// 5-minute slot), so both models are calibrated and scored against one measured series.
enum DegradationBacktestIrradiance {
    struct Day {
        /// Irradiance model kWh.
        var expected = 0.0
        /// Shipped clear-sky reference kWh (entered faces at the detector's derate, AC clip applied).
        var clearSky = 0.0
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
                  detected: nil, on: inputs.config.now, detectedAt: nil),
            let reference = SolarHealthReference(manual: inputs.config.manual, detected: nil) else { return [:] }
        let planes = reference.planes(on: inputs.config.now).map {
            LayoutPlane(azimuth: $0.azimuth, tilt: $0.tilt, effectiveKw: $0.effectiveKw)
        }
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
            let clearSky = clearSkyKwh(endingAt: hour.end, planes: planes, clipKw: layout.acClipKw, inputs: inputs)
            let measured = energy[Int((midpoint.timeIntervalSince1970 / 3600).rounded(.down))]
            guard modeled > 0 || clearSky > 0 || (measured?.wattHours ?? 0) > 0 else { continue }
            let day = DegradationBacktestInputs.dayString(midpoint, calendar: calendar)
            out[day, default: Day()].expected += modeled
            out[day, default: Day()].clearSky += clearSky
            out[day, default: Day()].actual += (measured?.wattHours ?? 0) / 1000
            if measured?.samples != 12 { out[day, default: Day()].isComplete = false }
        }
        return out.filter { $0.value.isComplete && !inputs.snowDays.contains($0.key) }
    }

    /// The detector's clear-sky model summed over the hour's twelve 5-minute slots, at each slot's midpoint.
    private static func clearSkyKwh(
        endingAt end: Date, planes: [LayoutPlane], clipKw: Double?, inputs: DegradationBacktestInputs
    ) -> Double {
        (0 ..< 12).reduce(0.0) { total, slot in
            let time = end.addingTimeInterval(Double(slot * 300 + 150) - 3600)
            let sun = layoutSun(at: time, latitude: inputs.latitude, longitude: inputs.longitude)
            guard sun.ghi > 0 else { return total }
            return total + SolarLayoutDetector.modelKw(sun, planes: planes, clipKw: clipKw) / 12
        }
    }

    static func section(_ inputs: DegradationBacktestInputs, clearSky: SolarHealthResult) -> [String] {
        let days: [String: Day]
        do {
            days = try Self.days(inputs)
        } catch {
            return ["## 3. Historical irradiance", "", "Model failed: \(error)", ""]
        }
        let clearDays = Set(DegradationBacktestTests.clearDays(clearSky).map(\.day))
        let calibration = days.filter { clearDays.contains($0.key) && inputs.config.calibration.contains($0.key) }
        let actual = calibration.values.reduce(0) { $0 + $1.actual }
        let irradianceFactor = actual / max(calibration.values.reduce(0) { $0 + $1.expected }, 1e-9)
        let clearSkyFactor = actual / max(calibration.values.reduce(0) { $0 + $1.clearSky }, 1e-9)
        var lines = [
            "## 3. Historical irradiance", "",
            "\(days.count) complete non-snow days with ERA5 hours (\(clearDays.count) shipped clear days overall). "
                + "Both models are scored on the same whole UTC hours against the same production. "
                + String(format: "Frozen factors from %d calibration clear days: ", calibration.count)
                + String(format: "clear-sky %.4f, irradiance %.4f.", clearSkyFactor, irradianceFactor), "",
            "model | scope | days | MAE kWh | bias kWh | mean actual kWh", "--- | --- | --- | --- | --- | ---"
        ]
        let holdout = days.filter { inputs.config.holdout.contains($0.key) }.sorted { $0.key < $1.key }
        let clearHoldout = holdout.filter { clearDays.contains($0.key) }
        func scored(_ rows: [(key: String, value: Day)], _ model: (Day) -> Double) -> [DegradationDay] {
            rows.map { DegradationDay(day: $0.key, expected: model($0.value), actual: $0.value.actual) }
        }
        let latitude = inputs.latitude
        _ = DegradationBacktestTests.scoreRows(
            "shipped 85% reference (clear)", scored(clearHoldout, \.clearSky), latitude: latitude, into: &lines)
        let baseline = DegradationBacktestTests.scoreRows(
            "frozen clear-sky factor (clear)", scored(clearHoldout) { $0.clearSky * clearSkyFactor },
            latitude: latitude, into: &lines)
        let candidate = DegradationBacktestTests.scoreRows(
            "frozen irradiance (clear)", scored(clearHoldout) { $0.expected * irradianceFactor },
            latitude: latitude, into: &lines)
        _ = DegradationBacktestTests.scoreRows(
            "frozen irradiance (not clear)",
            scored(holdout.filter { !clearDays.contains($0.key) }) { $0.expected * irradianceFactor },
            latitude: latitude, into: &lines)
        lines += ["", "Irradiance against the frozen clear-sky factor on the same held-out clear days:"]
        lines += DegradationBacktestTests.decision(baseline: baseline, candidate: candidate)
        lines += trend(inputs, days: days, clearDays: clearDays, clearSky: clearSky)
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
