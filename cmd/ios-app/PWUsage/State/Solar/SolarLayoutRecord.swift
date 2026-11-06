import Foundation

struct SolarLayoutRemoteApplyOutcome: Equatable, Sendable {
    let record: SolarLayoutRecord
    let appliedScopes: [SolarForecastSiteScope]
}

struct SolarLayoutRecord: Codable, Equatable, Sendable {
    var location: SolarHomeLocation?
    var locationSetAt: Date?
    var result: DetectedSolarLayout?
    var detectedAt: Date?
    var attemptedAt: Date?
    var detectorVersion: Int?
    var resultLocation: SolarHomeLocation?

    /// Whether the stored result is a layout, whichever detector version found it.
    var hasUsableResult: Bool {
        result.flatMap { SolarLayoutDetector.forecastLayout($0, detectedAt: .distantPast) } != nil
    }

    func response(historyEnabled: Bool) -> MobileSolarLayoutResponse {
        guard historyEnabled else { return .disabled }
        guard let location else { return .enabled(location: nil, layout: nil, reason: .needsLocation) }
        guard let result, let detectedAt, detectorVersion == SolarLayoutDetector.version,
              solarLocationsShareCoordinates(resultLocation, location) else {
            return .enabled(location: location, layout: nil, reason: .pending)
        }
        switch result.status {
        case .notEnoughHistory:
            return .enabled(location: location, layout: nil, reason: .notEnoughHistory)
        case .lowConfidence:
            return .enabled(location: location, layout: nil, reason: .lowConfidence)
        case .failed:
            return .enabled(location: location, layout: nil, reason: .pending)
        case .detected:
            guard let layout = SolarLayoutDetector.forecastLayout(result, detectedAt: detectedAt) else {
                return .enabled(location: location, layout: nil, reason: .pending)
            }
            return .enabled(location: location, layout: layout, reason: nil)
        }
    }
}
