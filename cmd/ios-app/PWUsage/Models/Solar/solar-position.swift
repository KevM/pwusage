import Foundation

/// NOAA/Meeus solar geometry with SPA's atmospheric-refraction approximation.
/// Matches the detector's geometry; pvlib SPA fixtures bound the forecast error.
struct SolarPosition: Sendable {
    let apparentZenith: Double
    let azimuth: Double
    let extraterrestrialDni: Double

    private static let radians = Double.pi / 180

    static func at(_ date: Date, latitude: Double, longitude: Double) -> SolarPosition {
        let time = date.timeIntervalSince1970
        let century = (time / 86_400 + 2_440_587.5 - 2_451_545) / 36_525
        let meanLongitude = mod(280.46646 + century * (36_000.76983 + century * 0.0003032), by: 360)
        let anomaly = 357.52911 + century * (35_999.05029 - 0.0001537 * century)
        let eccentricity = 0.016708634 - century * (0.000042037 + 0.0000001267 * century)
        let anomalyRadians = anomaly * radians
        let center = sin(anomalyRadians) * (1.914602 - century * (0.004817 + 0.000014 * century))
            + sin(2 * anomalyRadians) * (0.019993 - 0.000101 * century)
            + sin(3 * anomalyRadians) * 0.000289
        let omega = (125.04 - 1934.136 * century) * radians
        let apparentLongitude = (meanLongitude + center - 0.00569 - 0.00478 * sin(omega)) * radians
        let obliquity = (23 + (26 + (21.448 - century
            * (46.815 + century * (0.00059 - century * 0.001813))) / 60) / 60
            + 0.00256 * cos(omega)) * radians
        let declination = asin(sin(obliquity) * sin(apparentLongitude))
        let equation = equationOfTime(
            longitude: meanLongitude * radians, anomaly: anomalyRadians,
            obliquity: obliquity, eccentricity: eccentricity)
        let utcMinutes = mod(time, by: 86_400) / 60
        let solarMinutes = mod(utcMinutes + equation + 4 * longitude, by: 1440)
        let hourAngle = (solarMinutes / 4 - 180) * radians
        let lat = latitude * radians
        let cosineZenith = sin(lat) * sin(declination) + cos(lat) * cos(declination) * cos(hourAngle)
        let zenith = acos(min(1, max(-1, cosineZenith))) / radians
        let azimuth = mod(atan2(sin(hourAngle), cos(hourAngle) * sin(lat)
            - tan(declination) * cos(lat)) / radians + 180, by: 360)
        let elevation = 90 - zenith
        return SolarPosition(
            apparentZenith: zenith - refraction(elevation), azimuth: azimuth,
            extraterrestrialDni: extraterrestrialDni(date))
    }

    private static func equationOfTime(
        longitude: Double, anomaly: Double, obliquity: Double, eccentricity: Double
    ) -> Double {
        let obliquityTerm = pow(tan(obliquity / 2), 2)
        return 4 / radians * (obliquityTerm * sin(2 * longitude) - 2 * eccentricity * sin(anomaly)
            + 4 * eccentricity * obliquityTerm * sin(anomaly) * cos(2 * longitude)
            - 0.5 * obliquityTerm * obliquityTerm * sin(4 * longitude)
            - 1.25 * eccentricity * eccentricity * sin(2 * anomaly))
    }

    /// 1013.25 mbar, 12°C: the pvlib solarposition defaults used by the backtest.
    private static func refraction(_ elevation: Double) -> Double {
        guard elevation >= -(0.26667 + 0.5667) else { return 0 }
        return (1013.25 / 1010) * (283 / (273 + 12)) * 1.02
            / (60 * tan((elevation + 10.3 / (elevation + 5.11)) * radians))
    }

    /// Spencer (1971), UTC day-of-year, as in pvlib get_extra_radiation.
    private static func extraterrestrialDni(_ date: Date) -> Double {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        let day = calendar.ordinality(of: .day, in: .year, for: date) ?? 1
        let angle = 2 * Double.pi / 365 * Double(day - 1)
        return 1366.1 * (1.00011 + 0.034221 * cos(angle) + 0.00128 * sin(angle)
            + 0.000719 * cos(2 * angle) + 0.000077 * sin(2 * angle))
    }

    private static func mod(_ value: Double, by divisor: Double) -> Double {
        let remainder = value.truncatingRemainder(dividingBy: divisor)
        return remainder < 0 ? remainder + divisor : remainder
    }
}
