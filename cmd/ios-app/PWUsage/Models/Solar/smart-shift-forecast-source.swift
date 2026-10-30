import Foundation

/// A published forecast's provenance for "Copy diagnostics": no credentials, only identity,
/// age, coverage and the correction applied per lead-time cohort.
struct SmartShiftForecastSource: Codable, Equatable {
    let providerID: String
    let configurationRevision: String
    let outcome: String
    let fetchedAt: Date
    let ageMinutes: Double
    let coverageStart: Date
    let coverageEnd: Date
    let sameDayFactors: [String: Double]
    let dayAheadFactors: [String: Double]
    let sameDaySamples: Int
    let dayAheadSamples: Int

    init(publication: SolarForecastPublication, now: Date) {
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
