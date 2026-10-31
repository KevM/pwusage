import Foundation

/// Helpers of the detection run: clear-day selection, plane assembly, the solar-noon location
/// check and the confidence verdict.
extension SolarLayoutDetector {
    /// A boolean mask of `count` entries that is true at `indices`.
    static func mask(of indices: [Int], count: Int) -> [Bool] {
        var mask = [Bool](repeating: false, count: count)
        for index in indices { mask[index] = true }
        return mask
    }

    /// Model-free clear selection (envelope + smoothness); smooth points on a clip plateau also
    /// count. Returns the series indices of daylight rows with a finite measurement.
    static func selectClearIndices(_ series: LayoutSeries, peak: Double, clipKw: Double?) -> [Int] {
        var clear = envelopeClear(series, peakKw: peak)
        if let clipKw {
            let curvature = smoothness(series.points.map(\.powerKw), scale: peak)
            for index in series.points.indices {
                let point = series[index]
                if abs(point.powerKw - clipKw) < 0.01 * clipKw, curvature[index] < 0.03, point.sun.elevation > 5 {
                    clear[index] = true
                }
            }
        }
        return series.points.indices.filter { index in
            clear[index] && series[index].sun.elevation > 3 && series[index].powerKw.isFinite
        }
    }

    /// Clear days: >= 60% of unshaded elevation > 10° rows selected; partly clear (>= 25%) days contribute.
    static func clearDaySets(
        _ series: LayoutSeries, clearIndices: [Int], keep: [Bool], shadeMask: ShadeMask
    ) -> (clear: Set<String>, use: Set<String>) {
        var elevationRows: [String: Int] = [:]
        var selectedRows: [String: Int] = [:]
        for point in series.points where point.sun.elevation > 10 && point.powerKw.isFinite
            && !shadeMask.shaded(azimuth: point.sun.azimuth, elevation: point.sun.elevation) {
            elevationRows[point.localDay, default: 0] += 1
        }
        for (position, index) in clearIndices.enumerated() {
            let point = series[index]
            if keep[position], point.sun.elevation > 10,
               !shadeMask.shaded(azimuth: point.sun.azimuth, elevation: point.sun.elevation) {
                selectedRows[point.localDay, default: 0] += 1
            }
        }
        var clearDaySet = Set<String>()
        var useDaySet = Set<String>()
        for (day, total) in elevationRows {
            let fraction = Double(selectedRows[day, default: 0]) / Double(total)
            if fraction >= 0.6 { clearDaySet.insert(day) }
            if fraction >= 0.25 { useDaySet.insert(day) }
        }
        return (clearDaySet, useDaySet)
    }

    /// The fitted planes with their bootstrap ranges, rounded for display.
    static func detectedPlanes(best: [LayoutPlane], boots: [[LayoutPlane]]) -> [DetectedSolarLayout.Plane] {
        best.enumerated().map { index, plane in
            let bootAzimuths = boots.map { $0[index].azimuth }
            let bootTilts = boots.map { $0[index].tilt }
            let azimuthRange = boots.isEmpty
                ? (low: plane.azimuth, high: plane.azimuth)
                : LayoutFit.azimuthRange90(bootAzimuths, reference: plane.azimuth)
            let tiltRange = boots.isEmpty
                ? [roundTo(plane.tilt, 1), roundTo(plane.tilt, 1)]
                : [roundTo(quantile(bootTilts, 0.05), 1), roundTo(quantile(bootTilts, 0.95), 1)]
            return DetectedSolarLayout.Plane(
                azimuth: roundTo(plane.azimuth, 1),
                tilt: roundTo(plane.tilt, 1),
                dcKwp: roundTo(plane.effectiveKw / derate, 2),
                effectiveKw: roundTo(plane.effectiveKw, 2),
                azimuthRange90: [roundTo(azimuthRange.low, 1), roundTo(azimuthRange.high, 1)],
                tiltRange90: tiltRange)
        }
    }

    /// Solar-noon location check: the midpoint of each clear day's production rise and fall,
    /// against the same midpoint of the fitted layout's model.
    static func measureLongitudeError(
        _ series: LayoutSeries, clearDays: Set<String>, best: [LayoutPlane], clipKw: Double?
    ) -> Double? {
        var noonDays: [String: NoonDay] = [:]
        for point in series.points where clearDays.contains(point.localDay) && point.sun.elevation > -2 {
            noonDays[point.localDay, default: NoonDay()].append(
                time: point.time.timeIntervalSince1970 * 1000 + 150_000,
                measured: point.powerKw.isFinite ? point.powerKw : 0,
                model: modelKw(point.sun, planes: best, clipKw: clipKw))
        }
        return longitudeOffset(Array(noonDays.values))
    }

    /// The confidence label and the reasons behind it.
    static func assess(
        best: [LayoutPlane], planes: [DetectedSolarLayout.Plane], clearDays: Int, producingDayCount: Int,
        longitudeError: Double?
    ) -> (reasons: [String], confidence: String) {
        var reasons: [String] = []
        if clearDays < 15 { reasons.append("few-clear-days") }
        if best.contains(where: { $0.tilt >= LayoutPOA.maxTilt - 2 }) { reasons.append("plane-at-tilt-limit") }
        // `planes` is never empty: the plane count is at least one.
        let largest = planes.dropFirst().reduce(planes[0]) { $1.effectiveKw > $0.effectiveKw ? $1 : $0 }
        let azimuthWidth = rangeWidth(largest.azimuthRange90)
        if azimuthWidth > 60 { reasons.append("azimuth-uncertain") }
        if let longitudeError, abs(longitudeError) > locationMismatchDegrees { reasons.append("location-mismatch") }

        let confidence: String
        if !reasons.isEmpty {
            confidence = "low"
        } else if clearDays >= 40, producingDayCount >= 180, azimuthWidth <= 30 {
            confidence = "high"
        } else {
            confidence = "medium"
        }
        return (reasons, confidence)
    }

    /// JavaScript-style `Math.round(value * 10^digits) / 10^digits`.
    static func roundTo(_ value: Double, _ digits: Int) -> Double {
        let scale = pow(10, Double(digits))
        return floor(value * scale + 0.5) / scale
    }

    static func rangeWidth(_ range: [Double]) -> Double {
        ((range[1] - range[0]).truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    }

    /// Plane-of-array model kW with the AC clip applied as a smooth cap (`modelKw` in poa.ts).
    static func modelKw(_ sun: LayoutSunSample, planes: [LayoutPlane], clipKw: Double?) -> Double {
        let total = LayoutPOA.modelKw(sun: sun, planes: planes)
        guard let clipKw else { return total }
        return clipKw * LayoutPOA.softmin(total / clipKw)
    }

    /// One clear day's samples for the solar-noon check: times in epoch milliseconds.
    struct NoonDay {
        var times: [Double] = []
        var measured: [Double] = []
        var model: [Double] = []

        mutating func append(time: Double, measured measuredKw: Double, model modelKw: Double) {
            times.append(time)
            measured.append(measuredKw)
            model.append(modelKw)
        }
    }

    /// Longitude error in degrees: the median over clear days of the midpoint offset between the
    /// measured and modelled 2%-of-peak crossings (4 minutes per degree). Nil without any day.
    static func longitudeOffset(_ days: [NoonDay]) -> Double? {
        let offsets = days.compactMap { day -> Double? in
            guard let measured = crossingMidpoint(day.times, day.measured),
                  let model = crossingMidpoint(day.times, day.model) else { return nil }
            return (measured - model) / 60_000 / 4
        }
        return offsets.isEmpty ? nil : median(offsets)
    }

    /// Midpoint (epoch ms) of the interpolated first rise and last fall above 2% of the day's peak.
    static func crossingMidpoint(_ times: [Double], _ values: [Double]) -> Double? {
        var peak = 0.0
        for value in values where value > peak { peak = value }
        guard peak > 0 else { return nil }
        let threshold = 0.02 * peak
        var first = -1
        var last = -1
        for index in values.indices where values[index] > threshold {
            if first < 0 { first = index }
            last = index
        }
        if first < 1 || last >= values.count - 1 { return nil }
        let rise = times[first - 1]
            + (times[first] - times[first - 1]) * (threshold - values[first - 1]) / (values[first] - values[first - 1])
        let fall = times[last]
            + (times[last + 1] - times[last]) * (values[last] - threshold) / (values[last] - values[last + 1])
        return (rise + fall) / 2
    }
}
