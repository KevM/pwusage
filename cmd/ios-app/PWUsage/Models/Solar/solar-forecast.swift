import Foundation

struct SolarForecastInterval: Codable, Equatable, Sendable {
    let periodStart: Date
    let periodEnd: Date
    let powerKw: Double
    /// Summed `pv_estimate10` across the selected arrays, for the cautious
    /// projection. `nil` when any array lacks it, and in batches stored by
    /// builds that did not keep it.
    var cautiousPowerKw: Double? = nil
    func energyKwh() throws -> Double {
        let duration = periodEnd.timeIntervalSince(periodStart)
        let energy = powerKw * (duration / 3600)
        guard periodStart.timeIntervalSince1970.isFinite, periodEnd.timeIntervalSince1970.isFinite,
              duration.isFinite, duration > 0, powerKw.isFinite, powerKw >= 0, energy.isFinite else {
            throw SolarForecastError.nonFiniteValue
        }
        return energy
    }
}

enum SolarForecastError: Error, Equatable {
    case duplicateInterval
    case incompleteCoverage
    case nonFiniteValue
}

enum SolarForecast {
    static func energy(in intervals: [SolarForecastInterval], from start: Date, to end: Date) throws -> Double {
        guard start.timeIntervalSince1970.isFinite, end.timeIntervalSince1970.isFinite else {
            throw SolarForecastError.nonFiniteValue
        }
        guard start < end else { throw SolarForecastError.incompleteCoverage }
        let ordered = intervals.filter { $0.periodEnd > start && $0.periodStart < end }.sorted { $0.periodStart < $1.periodStart }
        guard ordered.allSatisfy({
            $0.periodStart.timeIntervalSince1970.isFinite && $0.periodEnd.timeIntervalSince1970.isFinite &&
                $0.periodStart < $0.periodEnd && $0.powerKw.isFinite && $0.powerKw >= 0
        }) else {
            throw SolarForecastError.nonFiniteValue
        }
        try validateNoOverlap(ordered.map { IntervalKey(start: $0.periodStart, end: $0.periodEnd) })
        var cursor = start
        var energy = 0.0
        for interval in ordered where interval.periodEnd > cursor && interval.periodStart < end {
            guard interval.periodStart <= cursor else { throw SolarForecastError.incompleteCoverage }
            let overlapEnd = min(interval.periodEnd, end)
            guard overlapEnd > cursor else { continue }
            let segmentEnergy = interval.powerKw * (overlapEnd.timeIntervalSince(cursor) / 3600)
            guard segmentEnergy.isFinite else { throw SolarForecastError.nonFiniteValue }
            energy += segmentEnergy
            guard energy.isFinite else { throw SolarForecastError.nonFiniteValue }
            cursor = overlapEnd
            if cursor == end { return energy }
        }
        throw SolarForecastError.incompleteCoverage
    }

    private static func validateNoOverlap<S: Sequence>(_ keys: S) throws where S.Element == IntervalKey {
        let sorted = Array(keys).sorted { $0.start < $1.start }
        for pair in zip(sorted, sorted.dropFirst()) where pair.0.end > pair.1.start {
            throw SolarForecastError.incompleteCoverage
        }
    }
}

private struct IntervalKey: Hashable {
    let start: Date
    let end: Date
}
