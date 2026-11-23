import Foundation

/// A published forecast's provenance for "Copy diagnostics": no credentials, only identity,
/// age, coverage and the correction applied per lead-time cohort.
public struct SmartShiftForecastSource: Codable, Equatable, Sendable {
    public let providerID: String
    public let configurationRevision: String
    public let outcome: String
    public let fetchedAt: Date
    public let ageMinutes: Double
    public let coverageStart: Date
    public let coverageEnd: Date
    public let sameDayFactors: [String: Double]
    public let dayAheadFactors: [String: Double]
    public let sameDaySamples: Int
    public let dayAheadSamples: Int

    public init(publication: SolarForecastPublication, now: Date) {
        providerID = publication.descriptor.id.rawValue
        configurationRevision = publication.configurationRevision
        outcome = "\(publication.outcome)"
        fetchedAt = publication.fetchedAt
        ageMinutes = (now.timeIntervalSince(publication.fetchedAt) / 60 * 10).rounded() / 10
        coverageStart = publication.coverage.start
        coverageEnd = publication.coverage.end
        let byHour = { (factors: [Int: Double]) in
            Dictionary(uniqueKeysWithValues: factors.map { (String(format: "%02d", $0.key), $0.value) })
        }
        sameDayFactors = byHour(publication.correction.sameDayFactors)
        dayAheadFactors = byHour(publication.correction.dayAheadFactors)
        sameDaySamples = publication.correction.sameDaySamples
        dayAheadSamples = publication.correction.dayAheadSamples
    }
}
