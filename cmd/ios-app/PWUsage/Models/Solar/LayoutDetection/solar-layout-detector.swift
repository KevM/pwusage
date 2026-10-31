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
        let rng = LayoutFit.seededRng(0)
        let series = layoutSeries(samples: samples, latitude: latitude, longitude: longitude, timeZone: timeZone)

        let producingDays = Set(series.points.filter { $0.powerKw > 0 }.map(\.localDay)).sorted()
        var stages = SolarLayoutDetectionStages(producingDays: producingDays.count)
        let summary = RunSummary(producingDays: producingDays)
        guard producingDays.count >= minHistoryDays else { return summary.notEnoughHistory(stages) }

        let peak = quantile(series.points.filter { $0.sun.elevation > 10 }.map(\.powerKw), 0.999)
        guard peak > 0 else { return summary.notEnoughHistory(stages) }
        let clipKw = detectClip(series)?.limitKw
        stages.clipKw = clipKw
        try checkCancellation()

        let clearIndices = selectClearIndices(series, peak: peak, clipKw: clipKw)
        let rowsC = LayoutFit.fitRows(series, selected: mask(of: clearIndices, count: series.points.count))
        guard rowsC.powerKw.count >= 200 else { return summary.lowEvidence(acClipKw: nil, clearDays: 0, stages) }
        let colsC = LayoutFit.gridColumns(rowsC)
        try checkCancellation()

        let clearFit = ClearFit(
            series: series, clearIndices: clearIndices, rows: rowsC, columns: colsC, clipKw: clipKw, peak: peak)
        let (keep, shadeMask) = try clearFit.learnKeepMask(checkCancellation: checkCancellation)
        let days = clearDaySets(series, clearIndices: clearIndices, keep: keep, shadeMask: shadeMask)
        let clearDays = days.clear.count
        stages.clearDays = clearDays
        stages.shading = shadeMask.summary()

        let rowCount = rowsC.powerKw.count
        let finalKeep = (0 ..< rowCount).map { keep[$0] && days.use.contains(clearFit.dayIds[$0]) }
        let rows = LayoutFit.subsetRows(rowsC) { finalKeep[$0] }
        stages.selectedRows = rows.powerKw.count
        guard rows.powerKw.count >= 200, rows.days.count >= 5 else {
            return summary.lowEvidence(acClipKw: clipKw, clearDays: clearDays, stages)
        }
        let keptIndices = (0 ..< rowCount).filter { finalKeep[$0] }
        let cols = colsC.map { column in keptIndices.map { column[$0] } }
        try checkCancellation()

        let choice = try LayoutFit.planeCountFromRows(
            rows, columns: cols, clipKw: clipKw, rng: rng, checkCancellation: checkCancellation)
        guard let chosen = choice.fits[choice.count] else {
            return summary.lowEvidence(acClipKw: clipKw, clearDays: clearDays, stages)
        }
        let best = LayoutFit.toPlanes(chosen.params)
        stages.planeCount = choice.count
        stages.cvNrmse = choice.cvNrmse
        stages.bestPlanes = best
        let boots = try LayoutFit.bootstrapRows(
            rows, clipKw: clipKw, best: best, rounds: 20, rng: rng, checkCancellation: checkCancellation)

        let longitudeError = measureLongitudeError(series, clearDays: days.clear, best: best, clipKw: clipKw)
        let result = summary.detected(
            best: best, boots: boots, clearDays: clearDays, longitudeError: longitudeError, clipKw: clipKw)
        return SolarLayoutDetectorOutcome(result: result, stages: stages)
    }

    /// The detection outcomes, which all share the run's producing days.
    private struct RunSummary {
        let producingDays: [String]

        func notEnoughHistory(_ stages: SolarLayoutDetectionStages) -> SolarLayoutDetectorOutcome {
            SolarLayoutDetectorOutcome(result: DetectedSolarLayout(
                status: .notEnoughHistory, confidence: nil, reasons: [], planes: [], acClipKw: nil,
                historyDays: producingDays.count, clearDays: 0,
                firstDay: producingDays.first, lastDay: producingDays.last), stages: stages)
        }

        func detected(
            best: [LayoutPlane], boots: [[LayoutPlane]], clearDays: Int, longitudeError: Double?, clipKw: Double?
        ) -> DetectedSolarLayout {
            let planes = detectedPlanes(best: best, boots: boots)
            let verdict = assess(
                best: best, planes: planes, clearDays: clearDays, producingDayCount: producingDays.count,
                longitudeError: longitudeError)
            return DetectedSolarLayout(
                status: verdict.confidence == "low" ? .lowConfidence : .detected,
                confidence: verdict.confidence, reasons: verdict.reasons, planes: planes, acClipKw: clipKw,
                historyDays: producingDays.count, clearDays: clearDays,
                firstDay: producingDays.first, lastDay: producingDays.last)
        }

        func lowEvidence(
            acClipKw: Double?, clearDays: Int, _ stages: SolarLayoutDetectionStages
        ) -> SolarLayoutDetectorOutcome {
            SolarLayoutDetectorOutcome(result: DetectedSolarLayout(
                status: .lowConfidence, confidence: "low", reasons: ["few-clear-days"], planes: [],
                acClipKw: acClipKw, historyDays: producingDays.count, clearDays: clearDays,
                firstDay: producingDays.first, lastDay: producingDays.last), stages: stages)
        }
    }

    /// The clear-selected rows with their sun geometry, and the two-plane fit that learns the shade mask.
    private struct ClearFit {
        let rows: LayoutFit.Rows
        let columns: [[Float]]
        let clipKw: Double?
        let peak: Double
        /// Sun azimuth (`saz`), elevation (`sel`) and local day per clear row.
        let azimuths: [Double]
        let elevations: [Double]
        let dayIds: [String]

        init(
            series: LayoutSeries, clearIndices: [Int], rows: LayoutFit.Rows, columns: [[Float]],
            clipKw: Double?, peak: Double
        ) {
            self.rows = rows
            self.columns = columns
            self.clipKw = clipKw
            self.peak = peak
            azimuths = clearIndices.map { series[$0].sun.azimuth }
            elevations = clearIndices.map { series[$0].sun.elevation }
            dayIds = clearIndices.map { series[$0].localDay }
        }

        func fitTwo(_ keep: [Bool]) -> [Double] {
            let gram = LayoutFit.groupGrams(
                columns, powerKw: rows.powerKw,
                group: LayoutFit.fitMaskGroup(rows, clipKw: clipKw) { keep[$0] ? 0 : -1 }, groups: 1)[0]
            let sub = LayoutFit.subsetRows(rows) { keep[$0] }
            return LayoutFit.fitFromGram(sub, gram: gram, clipKw: clipKw, planes: 2, starts: 3).params
        }

        /// The model only learns a persistent-deficit shade mask and drops gross outliers
        /// (snow, curtailment); a tight model-ratio band would hide real extra planes.
        func learnKeepMask(checkCancellation: () throws -> Void) throws -> (keep: [Bool], shadeMask: ShadeMask) {
            let rowCount = rows.powerKw.count
            var keep = [Bool](repeating: true, count: rowCount)
            var pars = fitTwo(keep)
            try checkCancellation()
            var shadeMask = ShadeMask(horizon: [], hotBins: [])
            for _ in 0 ..< 2 {
                let model = LayoutFit.modelRows(pars, rows: rows, clipKw: clipKw)
                let ratio = model.indices.map { model[$0] > 0.02 * peak ? rows.powerKw[$0] / model[$0] : Double.nan }
                shadeMask = learnShade(saz: azimuths, sel: elevations, ratio: ratio, dayIds: dayIds)
                let flat = flatRuns(powerKw: rows.powerKw, model: model, clipKw: clipKw)
                let mask = shadeMask
                keep = (0 ..< rowCount).map { row in
                    abs(rows.powerKw[row] - model[row]) < 0.15 * peak && !flat[row]
                        && !mask.shaded(azimuth: azimuths[row], elevation: elevations[row])
                }
                pars = fitTwo(keep)
                try checkCancellation()
            }
            return (keep, shadeMask)
        }
    }
}
