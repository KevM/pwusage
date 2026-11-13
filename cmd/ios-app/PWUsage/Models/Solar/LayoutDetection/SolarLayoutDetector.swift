import Foundation
#if DEBUG
    import OSLog

    private let classifyLogger = Logger(subsystem: "fm.rodeo.pwusage", category: "solar-layout")
    private let classifySignposter = OSSignposter(logger: classifyLogger)
#endif

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
    /// Which early exit stopped the run; nil when the fit ran to an assessment, and for results
    /// stored before it was recorded. Phone-only: `reasons` keeps the reference's labels.
    var shortfall: Shortfall?

    /// The detector's early exits. The reference labels the last three `few-clear-days`.
    enum Shortfall: String, Codable, Sendable {
        /// Fewer than `minHistoryDays` producing days.
        case fewProducingDays = "few-producing-days"
        /// Producing days, but no production with the sun more than 10° up: usually a wrong location.
        case noDaylightProduction = "no-daylight-production"
        /// Under 200 clear-sky samples.
        case fewClearSamples = "few-clear-samples"
        /// Under 200 samples or 5 days left after the shade mask and clear-day selection.
        case fewUsableClearDays = "few-usable-clear-days"
        /// The plane-count fit chose no layout.
        case noPlaneFit = "no-plane-fit"
    }
}

/// Intermediate values of one detection run, read by the parity tests against each fixture's
/// `stages`. Fields stay at their defaults when the run stops before that stage.
struct SolarLayoutDetectionStages: Sendable {
    var producingDays = 0
    var clipKw: Double?
    var clearDays = 0
    /// The site-local clear days behind `clearDays`.
    var clearDayIds: Set<String> = []
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

        let producingDays = producingDays(in: series)
        var stages = SolarLayoutDetectionStages(producingDays: producingDays.count)
        let summary = RunSummary(producingDays: producingDays)
        guard producingDays.count >= minHistoryDays else { return summary.notEnoughHistory(.fewProducingDays, stages) }

        let selection: ClearDaySelection
        switch try selectClearDays(series, checkCancellation: checkCancellation) {
        case .stopped(let shortfall, let clipKw):
            stages.clipKw = clipKw
            return shortfall == .noDaylightProduction
                ? summary.notEnoughHistory(shortfall, stages) : summary.lowEvidence(shortfall, stages)
        case .selected(let selected): selection = selected
        }
        let (clipKw, clearFit, days) = (selection.clipKw, selection.fit, selection.days)
        let clearDays = days.clear.count
        stages.clipKw = clipKw
        stages.clearDays = clearDays
        stages.clearDayIds = days.clear
        stages.shading = selection.shadeMask.summary()

        let rowCount = clearFit.rows.powerKw.count
        let finalKeep = selection.finalKeep
        let rows = LayoutFit.subsetRows(clearFit.rows) { finalKeep[$0] }
        stages.selectedRows = rows.powerKw.count
        guard rows.powerKw.count >= 200, rows.days.count >= 5 else {
            return summary.lowEvidence(.fewUsableClearDays, acClipKw: clipKw, clearDays: clearDays, stages)
        }
        let keptIndices = (0 ..< rowCount).filter { finalKeep[$0] }
        let cols = clearFit.columns.map { column in keptIndices.map { column[$0] } }
        try checkCancellation()

        let choice = try LayoutFit.planeCountFromRows(
            rows, columns: cols, clipKw: clipKw, rng: rng, checkCancellation: checkCancellation)
        guard let chosen = choice.fits[choice.count] else {
            return summary.lowEvidence(.noPlaneFit, acClipKw: clipKw, clearDays: clearDays, stages)
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

        func notEnoughHistory(
            _ shortfall: DetectedSolarLayout.Shortfall, _ stages: SolarLayoutDetectionStages
        ) -> SolarLayoutDetectorOutcome {
            SolarLayoutDetectorOutcome(result: DetectedSolarLayout(
                status: .notEnoughHistory, confidence: nil, reasons: [], planes: [], acClipKw: nil,
                historyDays: producingDays.count, clearDays: 0,
                firstDay: producingDays.first, lastDay: producingDays.last, shortfall: shortfall), stages: stages)
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
            _ shortfall: DetectedSolarLayout.Shortfall, acClipKw: Double? = nil, clearDays: Int = 0,
            _ stages: SolarLayoutDetectionStages
        ) -> SolarLayoutDetectorOutcome {
            SolarLayoutDetectorOutcome(result: DetectedSolarLayout(
                status: .lowConfidence, confidence: "low", reasons: ["few-clear-days"], planes: [],
                acClipKw: acClipKw, historyDays: producingDays.count, clearDays: clearDays,
                firstDay: producingDays.first, lastDay: producingDays.last, shortfall: shortfall), stages: stages)
        }
    }

    /// The clear-day pass: each stored site-local day as clear, cloudy or without production, from
    /// the same stages `detect` runs before its fit. It writes nothing and needs no minimum history.
    static func classifyDays(
        samples: [(timestamp: Date, solarWh: Double)], latitude: Double, longitude: Double,
        timeZone: TimeZone, checkCancellation: () throws -> Void
    ) throws -> SolarDayClassification {
        #if DEBUG
            let started = ContinuousClock.now
            let signpost = classifySignposter.beginInterval("classifyDays")
            defer {
                classifySignposter.endInterval("classifyDays", signpost)
                classifyLogger.debug(
                    "Clear-day pass: \(samples.count) samples in \(ContinuousClock.now - started, privacy: .public)")
            }
        #endif
        try checkCancellation()
        let series = layoutSeries(samples: samples, latitude: latitude, longitude: longitude, timeZone: timeZone)
        let stored = Set(series.points.filter(\.powerKw.isFinite).map(\.localDay))
        let producing = Set(producingDays(in: series))
        var clear = Set<String>()
        if !producing.isEmpty, case .selected(let selection) = try selectClearDays(
            series, checkCancellation: checkCancellation) {
            clear = selection.days.clear
        }
        var days: [String: SolarDayType] = [:]
        for day in stored {
            days[day] = !producing.contains(day) ? .noProduction : clear.contains(day) ? .clear : .cloudy
        }
        return SolarDayClassification(days: days)
    }
}
