import CryptoKit
import Foundation

/// The health pass: for each calendar year of a site's whole stored history, capacity against the
/// reference, shade per season and daily ratios. Pure computation on the phone; results are cached
/// per completed year and nothing is synced.
enum SolarHealthPass {
    /// Bumped when the pass changes what it computes, so cached years recompute.
    static let version = 2

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
        let context = Context(scope: scope, cache: cache, now: now)
        let task = Task.detached(priority: .utility) {
            try compute(
                samples: samples, place: place, context: context,
                checkCancellation: { try Task.checkCancellation() })
        }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }

    struct Context: Sendable {
        let scope: SolarForecastSiteScope
        let cache: SolarHealthCache
        let now: Date
    }

    /// The pass over `samples` (ascending). A completed year is read from `cache` when its key
    /// matches (reference, location, detector, pass version and the year's data); otherwise, and for
    /// the current year always, it is computed.
    static func compute(
        samples: [(timestamp: Date, solarWh: Double)], place: SolarHealthYearFit.Place,
        context: Context, checkCancellation: () throws -> Void
    ) throws -> SolarHealthResult {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = place.timeZone
        let currentYear = calendar.component(.year, from: context.now)
        var years: [SolarHealthYear] = []
        var recomputed: [Int] = []
        for slice in yearSlices(samples, calendar: calendar) {
            try checkCancellation()
            let key = cacheKey(place: place, slice: slice.samples)
            if slice.year < currentYear,
               let cached = context.cache.year(slice.year, scope: context.scope),
               cached.key == key {
                years.append(cached)
                continue
            }
            let yearFit = try SolarHealthYearFit(
                samples: slice.samples, place: place, checkCancellation: checkCancellation)
            var year = try yearFit?.result(year: slice.year, checkCancellation: checkCancellation)
                ?? SolarHealthYear(
                    year: slice.year, key: key, clearDays: 0, capacity: nil, months: [], shade: [], dailyRatios: [])
            year.key = key
            if slice.year < currentYear { try context.cache.store(year, scope: context.scope) }
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

    private static func cacheKey(
        place: SolarHealthYearFit.Place, slice: [(timestamp: Date, solarWh: Double)]
    ) -> String {
        var hasher = SHA256()
        let header = [
            place.reference.key, "detector\(SolarLayoutDetector.version)", "pass\(version)",
            String(format: "%.3f,%.3f", place.latitude, place.longitude), place.timeZone.identifier,
            String(slice.count)
        ].joined(separator: "|")
        hasher.update(data: Data(header.utf8))
        for sample in slice {
            var timeBits = sample.timestamp.timeIntervalSince1970.bitPattern.littleEndian
            var energyBits = sample.solarWh.bitPattern.littleEndian
            withUnsafeBytes(of: &timeBits) { hasher.update(bufferPointer: $0) }
            withUnsafeBytes(of: &energyBits) { hasher.update(bufferPointer: $0) }
        }
        return hasher.finalize().prefix(10).map { String(format: "%02x", $0) }.joined()
    }

    /// The samples of each site-local calendar year, in order.
    private static func yearSlices(
        _ samples: [(timestamp: Date, solarWh: Double)], calendar: Calendar
    ) -> [(year: Int, samples: [(timestamp: Date, solarWh: Double)])] {
        guard !samples.isEmpty else { return [] }
        let ordered = isSorted(samples) ? samples : samples.sorted { $0.timestamp < $1.timestamp }
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
    private static func isSorted(_ samples: [(timestamp: Date, solarWh: Double)]) -> Bool {
        zip(samples, samples.dropFirst()).allSatisfy { $0.timestamp <= $1.timestamp }
    }
}
