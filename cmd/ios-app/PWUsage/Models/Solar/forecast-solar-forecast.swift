import Foundation

enum ForecastSolarForecast {
    /// Compass degrees (0 = north, 90 = east) to Forecast.Solar's convention (0 = south,
    /// −90 = east, 90 = west), rounded to whole degrees.
    static func forecastSolarAzimuth(compass: Double) -> Int {
        var azimuth = (compass - 180).truncatingRemainder(dividingBy: 360)
        if azimuth > 180 { azimuth -= 360 }
        if azimuth < -180 { azimuth += 360 }
        return Int(azimuth.rounded())
    }

    /// One-hour intervals from local midnight today to local midnight after tomorrow at the
    /// site. Each period's energy is spread over the hours it overlaps, planes are summed, then
    /// capped at the AC limit. Hours outside the day's sunrise-to-sunset periods are zero.
    static func intervals(
        estimates: [ForecastSolarPlaneEstimate],
        acClipKw: Double?,
        siteTimeZone: TimeZone,
        now: Date
    ) throws -> [SolarForecastInterval] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = siteTimeZone
        let start = calendar.startOfDay(for: now)
        guard !estimates.isEmpty,
              let tomorrow = calendar.date(byAdding: .day, value: 1, to: start),
              let end = calendar.date(byAdding: .day, value: 2, to: start) else {
            throw SolarForecastError.incompleteCoverage
        }
        let hours = Int((end.timeIntervalSince(start) / 3600).rounded())
        var bucketsWh = [Double](repeating: 0, count: hours)
        var expectedWh = 0.0
        for estimate in estimates {
            guard estimate.timeZone.identifier == siteTimeZone.identifier else {
                throw SolarForecastError.incompleteCoverage
            }
            let days = Dictionary(grouping: estimate.wattHoursPeriod) { calendar.startOfDay(for: $0.end) }
            guard let today = days[start], let next = days[tomorrow] else {
                throw SolarForecastError.incompleteCoverage
            }
            for periods in [today, next] {
                for (previous, period) in zip(periods, periods.dropFirst()) {
                    expectedWh += period.energyWh
                    spread(period.energyWh, from: previous.end, until: period.end, start: start, into: &bucketsWh)
                }
            }
        }
        let totalWh = bucketsWh.reduce(0, +)
        guard totalWh.isFinite, abs(totalWh - expectedWh) <= max(expectedWh * 0.001, 0.001) else {
            throw SolarForecastError.nonFiniteValue
        }
        return bucketsWh.enumerated().map { index, energyWh in
            let periodStart = start.addingTimeInterval(TimeInterval(index) * 3600)
            let power = energyWh / 1000
            return SolarForecastInterval(
                periodStart: periodStart,
                periodEnd: periodStart.addingTimeInterval(3600),
                powerKw: acClipKw.map { min(power, $0) } ?? power
            )
        }
    }

    /// Adds `energyWh`, spread evenly over (from, end], to the hour buckets it overlaps.
    private static func spread(
        _ energyWh: Double, from: Date, until end: Date, start: Date, into buckets: inout [Double]
    ) {
        let duration = end.timeIntervalSince(from)
        guard duration > 0, energyWh > 0 else { return }
        var cursor = from
        while cursor < end {
            let index = Int(floor(cursor.timeIntervalSince(start) / 3600))
            let bucketEnd = start.addingTimeInterval(TimeInterval(index + 1) * 3600)
            let segmentEnd = min(bucketEnd, end)
            if buckets.indices.contains(index) {
                buckets[index] += energyWh * segmentEnd.timeIntervalSince(cursor) / duration
            }
            cursor = segmentEnd
        }
    }
}
