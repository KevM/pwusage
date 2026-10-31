import Foundation

/// The detector's result on the phone (port of `detect.ts` `SolarLayoutResult`, without the
/// shading profile, which nothing on the phone reads).
struct DetectedSolarLayout: Codable, Equatable, Sendable {
    enum Status: String, Codable, Sendable {
        case detected
        case lowConfidence = "low-confidence"
        case notEnoughHistory = "not-enough-history"
        case failed
    }

    /// One detected plane. Ranges are `[low, high]` in degrees (`azimuthRange90`, `tiltRange90`).
    struct Plane: Codable, Equatable, Sendable {
        let azimuth: Double
        let tilt: Double
        let dcKwp: Double
        let effectiveKw: Double
        let azimuthRange90: [Double]
        let tiltRange90: [Double]
    }

    let status: Status
    /// "high", "medium" or "low"; nil when there was not enough history to judge.
    let confidence: String?
    let reasons: [String]
    let planes: [Plane]
    let acClipKw: Double?
    let historyDays: Int
    let clearDays: Int
    let firstDay: String?
    let lastDay: String?
}

/// Intermediate values of one detection run, read by the parity tests against each fixture's
/// `stages`. Fields stay at their defaults when the run stops before that stage.
struct SolarLayoutDetectionStages: Sendable {
    var producingDays = 0
    var clipKw: Double?
    var clearDays = 0
    var selectedRows = 0
    var shading: [ShadeSegment] = []
    /// nil unless the plane-count fit ran.
    var planeCount: Int?
    var cvNrmse: [Int: Double] = [:]
    var bestPlanes: [LayoutPlane] = []
}

struct SolarLayoutDetectorOutcome: Sendable {
    let result: DetectedSolarLayout
    let stages: SolarLayoutDetectionStages
}

/// Solar layout detection from a site's own 5-minute production history (port of `detect.ts`).
/// The version is 2 on the phone; the TypeScript reference reports 1.
enum SolarLayoutDetector {
    static let version = 2
    static let derate = 0.85
    static let minHistoryDays = 42
    /// Longitude error (degrees) above which the stored location is treated as another place.
    static let locationMismatchDegrees = 3.0

    static func detect(
        samples: [(timestamp: Date, solarWh: Double)], latitude: Double, longitude: Double,
        timeZone: TimeZone, checkCancellation: () throws -> Void
    ) throws -> DetectedSolarLayout {
        try detectWithStages(
            samples: samples, latitude: latitude, longitude: longitude, timeZone: timeZone,
            checkCancellation: checkCancellation).result
    }

    /// The layout the forecast may use: only detected with high or medium confidence (mirrors `toMobileSolarLayout`).
    static func forecastLayout(_ result: DetectedSolarLayout, detectedAt: Date) -> SolarLayout? {
        guard result.status == .detected,
              let confidence = result.confidence.flatMap(SolarLayoutConfidence.init(rawValue:)),
              confidence == .high || confidence == .medium else {
            return nil
        }
        return SolarLayout(
            planes: result.planes.map { SolarLayoutPlane(azimuth: $0.azimuth, tilt: $0.tilt, dcKwp: $0.dcKwp) },
            acClipKw: result.acClipKw, confidence: confidence, detectedAt: detectedAt)
    }

    /// `detect`, also returning the stage intermediates for parity testing.
    static func detectWithStages(
        samples: [(timestamp: Date, solarWh: Double)], latitude: Double, longitude: Double,
        timeZone: TimeZone, checkCancellation: () throws -> Void
    ) throws -> SolarLayoutDetectorOutcome {
        try checkCancellation()
        var rng = LayoutFit.seededRng(0)
        let series = layoutSeries(samples: samples, latitude: latitude, longitude: longitude, timeZone: timeZone)

        let producingDays = Set(series.points.filter { $0.kw > 0 }.map(\.localDay)).sorted()
        var stages = SolarLayoutDetectionStages(producingDays: producingDays.count)
        func notEnoughHistory() -> SolarLayoutDetectorOutcome {
            SolarLayoutDetectorOutcome(result: DetectedSolarLayout(
                status: .notEnoughHistory, confidence: nil, reasons: [], planes: [], acClipKw: nil,
                historyDays: producingDays.count, clearDays: 0,
                firstDay: producingDays.first, lastDay: producingDays.last), stages: stages)
        }
        guard producingDays.count >= minHistoryDays else { return notEnoughHistory() }

        let peak = quantile(series.points.filter { $0.sun.elevation > 10 }.map(\.kw), 0.999)
        guard peak > 0 else { return notEnoughHistory() }
        let clipKw = detectClip(series)?.limitKw
        stages.clipKw = clipKw
        try checkCancellation()

        func lowEvidence(acClipKw: Double?, clearDays: Int) -> SolarLayoutDetectorOutcome {
            SolarLayoutDetectorOutcome(result: DetectedSolarLayout(
                status: .lowConfidence, confidence: "low", reasons: ["few-clear-days"], planes: [],
                acClipKw: acClipKw, historyDays: producingDays.count, clearDays: clearDays,
                firstDay: producingDays.first, lastDay: producingDays.last), stages: stages)
        }

        // Model-free clear selection (envelope + smoothness); smooth points on a clip plateau also count.
        var clear = envelopeClear(series, peakKw: peak)
        if let clipKw {
            let curvature = smoothness(series.points.map(\.kw), scale: peak)
            for index in series.points.indices {
                let point = series[index]
                if abs(point.kw - clipKw) < 0.01 * clipKw, curvature[index] < 0.03, point.sun.elevation > 5 {
                    clear[index] = true
                }
            }
        }
        var clearIndices: [Int] = []
        for index in series.points.indices where clear[index] && series[index].sun.elevation > 3 && series[index].kw.isFinite {
            clearIndices.append(index)
        }
        var clearMask = [Bool](repeating: false, count: series.points.count)
        for index in clearIndices { clearMask[index] = true }
        let rowsC = LayoutFit.fitRows(series, selected: clearMask)
        guard rowsC.y.count >= 200 else { return lowEvidence(acClipKw: nil, clearDays: 0) }
        let colsC = LayoutFit.gridColumns(rowsC)
        try checkCancellation()

        func fitTwo(_ keep: [Bool]) -> [Double] {
            let gram = LayoutFit.groupGrams(
                colsC, y: rowsC.y,
                group: LayoutFit.fitMaskGroup(rowsC, clipKw: clipKw) { keep[$0] ? 0 : -1 }, groups: 1)[0]
            let sub = LayoutFit.subsetRows(rowsC) { keep[$0] }
            return LayoutFit.fitFromGram(sub, gram: gram, clipKw: clipKw, planes: 2, starts: 3).params
        }

        // The model only learns a persistent-deficit shade mask and drops gross outliers
        // (snow, curtailment); a tight model-ratio band would hide real extra planes.
        let nC = rowsC.y.count
        let saz = clearIndices.map { series[$0].sun.azimuth }
        let sel = clearIndices.map { series[$0].sun.elevation }
        let dayIds = clearIndices.map { series[$0].localDay }
        var keep = [Bool](repeating: true, count: nC)
        var pars = fitTwo(keep)
        try checkCancellation()
        var shadeMask = ShadeMask(horizon: [], hotBins: [])
        for _ in 0 ..< 2 {
            let model = LayoutFit.modelRows(pars, rows: rowsC, clipKw: clipKw)
            let ratio = model.indices.map { model[$0] > 0.02 * peak ? rowsC.y[$0] / model[$0] : Double.nan }
            shadeMask = learnShade(saz: saz, sel: sel, ratio: ratio, dayIds: dayIds)
            let flat = flatRuns(kw: rowsC.y, model: model, clipKw: clipKw)
            keep = (0 ..< nC).map { r in
                abs(rowsC.y[r] - model[r]) < 0.15 * peak && !flat[r]
                    && !shadeMask.shaded(azimuth: saz[r], elevation: sel[r])
            }
            pars = fitTwo(keep)
            try checkCancellation()
        }

        // Clear days: >= 60% of unshaded elevation > 10° rows selected; partly clear (>= 25%) days contribute.
        var elevationRows: [String: Int] = [:]
        var selectedRows: [String: Int] = [:]
        for point in series.points where point.sun.elevation > 10 && point.kw.isFinite
            && !shadeMask.shaded(azimuth: point.sun.azimuth, elevation: point.sun.elevation) {
            elevationRows[point.localDay, default: 0] += 1
        }
        for (r, index) in clearIndices.enumerated() {
            let point = series[index]
            if keep[r], point.sun.elevation > 10,
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
        let clearDays = clearDaySet.count
        stages.clearDays = clearDays
        stages.shading = shadeMask.summary()

        let finalKeep = (0 ..< nC).map { keep[$0] && useDaySet.contains(dayIds[$0]) }
        let rows = LayoutFit.subsetRows(rowsC) { finalKeep[$0] }
        stages.selectedRows = rows.y.count
        guard rows.y.count >= 200, rows.days.count >= 5 else {
            return lowEvidence(acClipKw: clipKw, clearDays: clearDays)
        }
        let keptIndices = (0 ..< nC).filter { finalKeep[$0] }
        let cols = colsC.map { column in keptIndices.map { column[$0] } }
        try checkCancellation()

        let choice = try LayoutFit.planeCountFromRows(
            rows, columns: cols, clipKw: clipKw, rng: rng, checkCancellation: checkCancellation)
        guard let chosen = choice.fits[choice.count] else { return lowEvidence(acClipKw: clipKw, clearDays: clearDays) }
        let best = LayoutFit.toPlanes(chosen.params)
        stages.planeCount = choice.count
        stages.cvNrmse = choice.cvNrmse
        stages.bestPlanes = best
        let boots = try LayoutFit.bootstrapRows(
            rows, clipKw: clipKw, best: best, rounds: 20, rng: rng, checkCancellation: checkCancellation)

        let planes: [DetectedSolarLayout.Plane] = best.enumerated().map { index, plane in
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

        // Solar-noon location check: the midpoint of each clear day's production rise and fall,
        // against the same midpoint of the fitted layout's model.
        var noonDays: [String: NoonDay] = [:]
        for point in series.points where clearDaySet.contains(point.localDay) && point.sun.elevation > -2 {
            noonDays[point.localDay, default: NoonDay()].append(
                time: point.time.timeIntervalSince1970 * 1000 + 150_000,
                measured: point.kw.isFinite ? point.kw : 0,
                model: modelKw(point.sun, planes: best, clipKw: clipKw))
        }
        let longitudeError = longitudeOffset(Array(noonDays.values))

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
        } else if clearDays >= 40, producingDays.count >= 180, azimuthWidth <= 30 {
            confidence = "high"
        } else {
            confidence = "medium"
        }
        let result = DetectedSolarLayout(
            status: confidence == "low" ? .lowConfidence : .detected,
            confidence: confidence, reasons: reasons, planes: planes, acClipKw: clipKw,
            historyDays: producingDays.count, clearDays: clearDays,
            firstDay: producingDays.first, lastDay: producingDays.last)
        return SolarLayoutDetectorOutcome(result: result, stages: stages)
    }

    /// JavaScript-style `Math.round(value * 10^digits) / 10^digits`.
    private static func roundTo(_ value: Double, _ digits: Int) -> Double {
        let scale = pow(10, Double(digits))
        return floor(value * scale + 0.5) / scale
    }

    private static func rangeWidth(_ range: [Double]) -> Double {
        ((range[1] - range[0]).truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    }

    /// Plane-of-array model kW with the AC clip applied as a smooth cap (`modelKw` in poa.ts).
    private static func modelKw(_ sun: LayoutSunSample, planes: [LayoutPlane], clipKw: Double?) -> Double {
        let total = LayoutPOA.modelKw(sun: sun, planes: planes)
        guard let clipKw else { return total }
        return clipKw * LayoutPOA.softmin(total / clipKw)
    }

    /// One clear day's samples for the solar-noon check: times in epoch milliseconds.
    private struct NoonDay {
        var times: [Double] = []
        var measured: [Double] = []
        var model: [Double] = []

        mutating func append(time: Double, measured kw: Double, model modelKw: Double) {
            times.append(time)
            measured.append(kw)
            model.append(modelKw)
        }
    }

    /// Longitude error in degrees: the median over clear days of the midpoint offset between the
    /// measured and modelled 2%-of-peak crossings (4 minutes per degree). Nil without any day.
    private static func longitudeOffset(_ days: [NoonDay]) -> Double? {
        let offsets = days.compactMap { day -> Double? in
            guard let measured = crossingMidpoint(day.times, day.measured),
                  let model = crossingMidpoint(day.times, day.model) else { return nil }
            return (measured - model) / 60_000 / 4
        }
        return offsets.isEmpty ? nil : median(offsets)
    }

    /// Midpoint (epoch ms) of the interpolated first rise and last fall above 2% of the day's peak.
    private static func crossingMidpoint(_ times: [Double], _ values: [Double]) -> Double? {
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
        let up = times[first - 1]
            + (times[first] - times[first - 1]) * (threshold - values[first - 1]) / (values[first] - values[first - 1])
        let down = times[last]
            + (times[last + 1] - times[last]) * (values[last] - threshold) / (values[last] - values[last + 1])
        return (up + down) / 2
    }
}
