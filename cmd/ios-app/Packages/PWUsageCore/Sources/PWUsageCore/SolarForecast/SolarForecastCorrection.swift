import Foundation

/// Scales a forecast by how it has compared with measured production, per site-local hour.
/// Trained only on raw forecasts and complete measured hours, never on corrected output.
public struct SolarForecastCorrection: Equatable, Sendable {
    /// Factor by site-local hour of day, 0–23.
    public let hourFactors: [Int: Double]
    public let fallbackFactor: Double
    /// Qualifying hours behind the factors, for diagnostics.
    public let samples: Int

    public static let identity = SolarForecastCorrection(hourFactors: [:], fallbackFactor: 1, samples: 0)
    public static let factorRange = 0.5 ... 1.5
    public static let minimumHourSamples = 5
    public static let minimumForecastWh = 50.0
    public static let trainingDays = 14

    public init(hourFactors: [Int: Double], fallbackFactor: Double, samples: Int) {
        self.hourFactors = hourFactors
        self.fallbackFactor = fallbackFactor
        self.samples = samples
    }

    /// Pairs UTC-hour forecasts with complete actuals from the 14 site-local days before
    /// today and today so far.
    public static func derive(
        pastForecastWh: [Date: Double],
        actuals: [MobileSolarActualsHour],
        siteTimeZone: TimeZone,
        now: Date
    ) -> SolarForecastCorrection {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = siteTimeZone
        guard let cutoff = calendar.date(byAdding: .day, value: -trainingDays, to: calendar.startOfDay(for: now)) else {
            return .identity
        }
        var byHour: [Int: Ratio] = [:]
        var total = Ratio()
        for actual in actuals where actual.complete && actual.hourStart >= cutoff
            && actual.hourStart.addingTimeInterval(3600) <= now {
            guard let forecast = pastForecastWh[actual.hourStart], forecast.isFinite,
                  forecast > minimumForecastWh else { continue }
            let hour = calendar.component(.hour, from: actual.hourStart)
            byHour[hour, default: Ratio()].add(actual: actual.energyWh, forecast: forecast)
            total.add(actual: actual.energyWh, forecast: forecast)
        }
        guard total.count >= 1 else { return .identity }
        let fallback = clamp(total.actual / total.forecast)
        let factors = byHour.compactMapValues { sums in
            sums.count >= minimumHourSamples ? clamp(sums.actual / sums.forecast) : nil
        }
        return SolarForecastCorrection(hourFactors: factors, fallbackFactor: fallback, samples: total.count)
    }

    public func factor(forLocalHour hour: Int) -> Double { hourFactors[hour] ?? fallbackFactor }

    /// Scales median and cautious power by the factor for each interval's local start hour,
    /// then caps at the AC limit.
    public func apply(
        to intervals: [SolarForecastInterval],
        siteTimeZone: TimeZone,
        acClipKw: Double?
    ) -> [SolarForecastInterval] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = siteTimeZone
        return intervals.map { interval in
            scaled(
                interval,
                by: factor(forLocalHour: calendar.component(.hour, from: interval.periodStart)),
                clip: acClipKw
            )
        }
    }

    func scaled(_ interval: SolarForecastInterval, by factor: Double, clip: Double?) -> SolarForecastInterval {
        let cap: (Double) -> Double = { value in clip.map { min(value, $0) } ?? value }
        return SolarForecastInterval(
            periodStart: interval.periodStart, periodEnd: interval.periodEnd,
            powerKw: cap(interval.powerKw * factor), cautiousPowerKw: interval.cautiousPowerKw.map { cap($0 * factor) }
        )
    }

    private struct Ratio {
        var actual = 0.0
        var forecast = 0.0
        var count = 0

        mutating func add(actual: Double, forecast: Double) {
            self.actual += actual
            self.forecast += forecast
            count += 1
        }
    }

    private static func clamp(_ ratio: Double) -> Double {
        guard ratio.isFinite else { return 1 }
        return min(max(ratio, factorRange.lowerBound), factorRange.upperBound)
    }
}

/// Separate factors by forecast lead. A batch's intervals on its fetch date use same-day
/// factors, the next date day-ahead factors; longer leads are not yet evaluated, so stay raw.
public struct SolarForecastCohortCorrection: Equatable, Sendable {
    public let sameDay: SolarForecastCorrection
    public let dayAhead: SolarForecastCorrection

    public static let identity = SolarForecastCohortCorrection(sameDay: .identity, dayAhead: .identity)

    public init(sameDay: SolarForecastCorrection, dayAhead: SolarForecastCorrection) {
        self.sameDay = sameDay
        self.dayAhead = dayAhead
    }

    public func apply(
        to intervals: [SolarForecastInterval],
        fetchedAt: Date,
        siteTimeZone: TimeZone,
        acClipKw: Double?
    ) -> [SolarForecastInterval] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = siteTimeZone
        let fetchDay = calendar.startOfDay(for: fetchedAt)
        return intervals.map { interval in
            let lead = calendar.dateComponents(
                [.day],
                from: fetchDay,
                to: calendar.startOfDay(for: interval.periodStart)
            ).day
            let correction: SolarForecastCorrection = switch lead {
            case .some(...0): sameDay
            case .some(1): dayAhead
            default: .identity
            }
            let hour = calendar.component(.hour, from: interval.periodStart)
            return correction.scaled(interval, by: correction.factor(forLocalHour: hour), clip: acClipKw)
        }
    }
}
