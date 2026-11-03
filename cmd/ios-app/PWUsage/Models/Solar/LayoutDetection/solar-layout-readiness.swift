import Foundation

/// Whether a site's solar history holds enough producing days for the detector to attempt a fit.
/// It cannot tell whether those days are clear enough, or how confident a fit would be.
struct SolarLayoutReadiness: Equatable, Sendable {
    let producingDays: Int

    var isReady: Bool { producingDays >= SolarLayoutDetector.minHistoryDays }
    var daysNeeded: Int { max(SolarLayoutDetector.minHistoryDays - producingDays, 0) }
}

/// How the clear-day pass sorted one stored site-local day.
enum SolarDayType: String, Codable, Equatable, Sendable {
    case clear
    case cloudy
    /// Stored, but nothing produced after the night baseline is removed.
    case noProduction = "none"
}

/// The clear-day pass's answer: every stored site-local day (`yyyy-MM-dd`) with its type.
struct SolarDayClassification: Equatable, Sendable {
    let days: [String: SolarDayType]

    var clearDays: Int { days.values.count { $0 == .clear } }
    var producingDays: Int { days.values.count { $0 != .noProduction } }
}

/// What a detection result says about importing more history.
enum SolarLayoutHistoryOutlook: String, Codable, Equatable, Sendable {
    /// The forecast can use the layout.
    case usable
    /// The result is limited by the amount or clarity of the history.
    case moreHistoryMayHelp
    /// More history is unlikely to change the result: a location, data or model problem.
    case needsOtherAction
}

extension SolarLayoutDetector {
    /// Site-local days with any production after the night baseline is removed: the days the
    /// detector counts against `minHistoryDays`.
    static func producingDays(in series: LayoutSeries) -> [String] {
        Set(series.points.filter { $0.powerKw > 0 }.map(\.localDay)).sorted()
    }

    /// The detector's history gate alone, without the fit. Needs the location because the night
    /// baseline is taken where the sun is well below the horizon.
    static func readiness(
        samples: [(timestamp: Date, solarWh: Double)], latitude: Double, longitude: Double, timeZone: TimeZone
    ) -> SolarLayoutReadiness {
        let series = layoutSeries(samples: samples, latitude: latitude, longitude: longitude, timeZone: timeZone)
        return SolarLayoutReadiness(producingDays: producingDays(in: series).count)
    }

    /// Whether importing more history may improve `result`. More days add clear days and narrow the
    /// bootstrap's azimuth range; they do not fix a location mismatch, a tilt at the model's limit,
    /// daylight-free production or a failed fit.
    static func historyOutlook(_ result: DetectedSolarLayout) -> SolarLayoutHistoryOutlook {
        if forecastLayout(result, detectedAt: .distantPast) != nil { return .usable }
        switch result.shortfall {
        case .fewProducingDays, .fewClearSamples, .fewUsableClearDays: return .moreHistoryMayHelp
        case .noDaylightProduction, .noPlaneFit: return .needsOtherAction
        case nil: break
        }
        switch result.status {
        case .notEnoughHistory:
            return .moreHistoryMayHelp
        case .failed, .detected:
            return .needsOtherAction
        case .lowConfidence:
            if result.reasons.contains("location-mismatch") { return .needsOtherAction }
            let historyLimited = ["few-clear-days", "azimuth-uncertain"].contains(where: result.reasons.contains)
            return historyLimited ? .moreHistoryMayHelp : .needsOtherAction
        }
    }
}
