import Foundation
import PWUsageCore

extension SolarHealthPass {
    /// Runs the pass for a site off the main actor. Nil when the site lacks a location, a time zone,
    /// stored history or any layout to compare with. Cancellable like detection.
    static func run(
        scope: SolarForecastSiteScope, history: SolarHistoryStore, record: SolarLayoutRecord,
        cache: SolarHealthCache = SolarHealthCache(), now: Date = .now
    ) async throws -> SolarHealthResult? {
        guard let location = record.location,
              let timeZone = try await history.timeZone(scope: scope),
              let reference = SolarHealthReference(manual: record.manualLayout, detected: record.result) else {
            return nil
        }
        let samples = try await history.allSamples(scope: scope)
        let place = SolarHealthYearFit.Place(
            reference: reference, latitude: location.latitude, longitude: location.longitude, timeZone: timeZone)
        guard let first = samples.min(by: { $0.timestamp < $1.timestamp }),
              let last = samples.max(by: { $0.timestamp < $1.timestamp }) else { return nil }
        let weather = try await SolarHealthWeatherStore.shared.weather(
            scope: scope, cache: cache, place: .init(location: location, timeZone: timeZone),
            samples: first.timestamp ... last.timestamp, now: now)
        let context = Context(scope: scope, cache: cache, now: now, snowDays: weather.snowDays)
        let task = Task.detached(priority: .utility) {
            var result = try compute(
                samples: samples, place: place, context: context,
                checkCancellation: { try Task.checkCancellation() })
            result.weather = weather
            return result
        }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
}
