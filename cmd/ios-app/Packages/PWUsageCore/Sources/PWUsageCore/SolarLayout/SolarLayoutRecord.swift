import Foundation

public struct SolarLayoutRecord: Codable, Equatable, Sendable {
    public var location: SolarHomeLocation?
    public var locationSetAt: Date?
    public var result: DetectedSolarLayout?
    public var detectedAt: Date?
    public var attemptedAt: Date?
    public var detectorVersion: Int?
    public var resultLocation: SolarHomeLocation?
    /// What the owner entered. Redetection, a detector version bump and a location change never touch it.
    public var manualLayout: ManualSolarLayout?
    /// When the owner last entered or cleared the layout. A clear keeps its date so it wins a merge.
    public var manualSetAt: Date?

    public init(
        location: SolarHomeLocation? = nil, locationSetAt: Date? = nil, result: DetectedSolarLayout? = nil,
        detectedAt: Date? = nil, attemptedAt: Date? = nil, detectorVersion: Int? = nil,
        resultLocation: SolarHomeLocation? = nil, manualLayout: ManualSolarLayout? = nil, manualSetAt: Date? = nil
    ) {
        self.location = location
        self.locationSetAt = locationSetAt
        self.result = result
        self.detectedAt = detectedAt
        self.attemptedAt = attemptedAt
        self.detectorVersion = detectorVersion
        self.resultLocation = resultLocation
        self.manualLayout = manualLayout
        self.manualSetAt = manualSetAt
    }

    /// Whether the stored result is a layout, whichever detector version found it.
    public var hasUsableResult: Bool {
        result.flatMap { SolarLayoutDetector.forecastLayout($0, detectedAt: .distantPast) } != nil
    }

    public func response(historyEnabled: Bool) -> MobileSolarLayoutResponse {
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
