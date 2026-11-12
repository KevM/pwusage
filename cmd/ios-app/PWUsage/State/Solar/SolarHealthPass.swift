import CryptoKit
import Foundation

/// The health pass: for each calendar year of a site's whole stored history, capacity against the
/// reference, shade per season and daily ratios. Pure computation on the phone; results are cached
/// per completed year and nothing is synced.
enum SolarHealthPass {
    /// Bumped when the pass changes what it computes, so cached years recompute.
    static let version = 1

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
        let task = Task.detached(priority: .utility) {
            try compute(
                samples: samples, place: place, scope: scope, cache: cache, now: now,
                checkCancellation: { try Task.checkCancellation() })
        }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }

    /// The pass over `samples` (ascending). A completed year is read from `cache` when its key
    /// matches (reference, location, detector, pass version and the year's data); otherwise, and for
    /// the current year always, it is computed.
    static func compute(
        samples: [(timestamp: Date, solarWh: Double)], place: SolarHealthYearFit.Place,
        scope: SolarForecastSiteScope, cache: SolarHealthCache, now: Date, checkCancellation: () throws -> Void
    ) throws -> SolarHealthResult {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = place.timeZone
        let currentYear = calendar.component(.year, from: now)
        var years: [SolarHealthYear] = []
        var recomputed: [Int] = []
        for slice in yearSlices(samples, calendar: calendar) {
            try checkCancellation()
            let key = cacheKey(place: place, slice: slice.samples)
            if slice.year < currentYear, let cached = cache.year(slice.year, scope: scope), cached.key == key {
                years.append(cached)
                continue
            }
            var year = try SolarHealthYearFit(samples: slice.samples, place: place, checkCancellation: checkCancellation)?
                .result(year: slice.year, checkCancellation: checkCancellation)
                ?? SolarHealthYear(
                    year: slice.year, key: key, clearDays: 0, capacity: nil, months: [], shade: [], dailyRatios: [])
            year.key = key
            if slice.year < currentYear { try cache.store(year, scope: scope) }
            years.append(year)
            recomputed.append(slice.year)
        }
        let scale = place.reference.source == .detected ? bestSiteFactor(years) : 1
        return SolarHealthResult(
            reference: place.reference, years: years.map { $0.scaled(by: scale) }, referenceScale: scale,
            recomputedYears: recomputed)
    }

    /// Without entered faces the reference is the detected geometry at the site's best year.
    private static func bestSiteFactor(_ years: [SolarHealthYear]) -> Double {
        years.compactMap { year in
            year.clearDays >= SolarHealthYearFit.minYearClearDays ? year.capacity?.site : nil
        }.max() ?? 1
    }

    private static func cacheKey(place: SolarHealthYearFit.Place, slice: [(timestamp: Date, solarWh: Double)]) -> String {
        let stamp = [
            Double(slice.count), slice.first?.timestamp.timeIntervalSince1970 ?? 0,
            slice.last?.timestamp.timeIntervalSince1970 ?? 0
        ].map { String(Int($0)) }
        let text = ([
            place.reference.key, "detector\(SolarLayoutDetector.version)", "pass\(version)",
            String(format: "%.3f,%.3f", place.latitude, place.longitude), place.timeZone.identifier
        ] + stamp).joined(separator: "|")
        return SHA256.hash(data: Data(text.utf8)).prefix(10).map { String(format: "%02x", $0) }.joined()
    }

    /// The samples of each site-local calendar year, in order.
    private static func yearSlices(
        _ samples: [(timestamp: Date, solarWh: Double)], calendar: Calendar
    ) -> [(year: Int, samples: [(timestamp: Date, solarWh: Double)])] {
        guard !samples.isEmpty else { return [] }
        let ordered = samples.isSorted ? samples : samples.sorted { $0.timestamp < $1.timestamp }
        let first = calendar.component(.year, from: ordered[0].timestamp)
        let last = calendar.component(.year, from: ordered[ordered.count - 1].timestamp)
        var slices: [(year: Int, samples: [(timestamp: Date, solarWh: Double)])] = []
        var start = 0
        for year in first ... last {
            guard let end = calendar.date(from: DateComponents(year: year + 1)) else { continue }
            var stop = start
            while stop < ordered.count, ordered[stop].timestamp < end { stop += 1 }
            if stop > start { slices.append((year, Array(ordered[start ..< stop]))) }
            start = stop
        }
        return slices
    }
}

private extension Array where Element == (timestamp: Date, solarWh: Double) {
    var isSorted: Bool {
        zip(self, dropFirst()).allSatisfy { $0.timestamp <= $1.timestamp }
    }
}
