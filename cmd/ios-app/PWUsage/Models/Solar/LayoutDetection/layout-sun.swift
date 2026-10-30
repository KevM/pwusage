import Foundation

/// Sun position and clear-sky irradiance for the on-device layout detector (port of the
/// detector's `sun.ts`). Geometry comes from `SolarPosition`, which matches sun.ts; this file
/// adds Kasten-Young airmass, Ineichen-Perez clear sky at a Linke turbidity of 3.0, and the
/// generic ambient-temperature factor.
struct LayoutSunSample: Equatable, Sendable {
    let apparentZenith: Double
    let elevation: Double
    let azimuth: Double
    let dniExtra: Double
    let ghi: Double
    let dni: Double
    let dhi: Double
    /// Relative efficiency from the generic ambient-temperature prior (sun.ts `tfac`).
    let ambientFactor: Double
}

private let linkeTurbidity = 3.0
private let ambientSeasonAmplitude = 8.0
private let ambientDiurnalAmplitude = 4.0
private let ambientGamma = -0.0037
private let radians = Double.pi / 180

/// Sun geometry and clear-sky irradiance at `time`, for the detector's 5-minute sample grid.
func layoutSun(at time: Date, latitude: Double, longitude: Double) -> LayoutSunSample {
    let position = SolarPosition.at(time, latitude: latitude, longitude: longitude)
    let apparentZenith = position.apparentZenith
    let elevation = 90 - apparentZenith
    let dniExtra = position.extraterrestrialDni
    let tfac = layoutAmbientFactor(time, longitude: longitude)

    let cosZ = max(cos(apparentZenith * radians), 0)
    let airmass = layoutAirmass(apparentZenith)
    guard cosZ > 0, airmass.isFinite else {
        return LayoutSunSample(
            apparentZenith: apparentZenith, elevation: elevation, azimuth: position.azimuth,
            dniExtra: dniExtra, ghi: 0, dni: 0, dhi: 0, ambientFactor: tfac)
    }

    // Ineichen-Perez at altitude 0 (fh1 = fh2 = 1).
    let cg1 = 0.868
    let cg2 = 0.0387
    let ghi = max(cg1 * dniExtra * cosZ * exp(-cg2 * airmass * (1 + (linkeTurbidity - 1))), 0)
    let ineichenB = 0.664 + 0.163
    let bnci = dniExtra * max(ineichenB * exp(-0.09 * airmass * (linkeTurbidity - 1)), 0)
    let bnci2 = ghi * min(max((1 - (0.1 - 0.2 * exp(-linkeTurbidity)) / (0.1 + 0.882)) / cosZ, 0), 1e20)
    let dni = min(bnci, bnci2)
    let dhi = ghi - dni * cosZ
    return LayoutSunSample(
        apparentZenith: apparentZenith, elevation: elevation, azimuth: position.azimuth,
        dniExtra: dniExtra, ghi: ghi, dni: dni, dhi: dhi, ambientFactor: tfac)
}

/// Kasten-Young (1989) relative airmass; NaN below the horizon.
private func layoutAirmass(_ apparentZenith: Double) -> Double {
    guard apparentZenith <= 90 else { return .nan }
    return 1 / (cos(apparentZenith * radians) + 0.50572 * pow(6.07995 + (90 - apparentZenith), -1.6364))
}

/// Seasonal ±8 °C peaking near Jul 19, diurnal ±4 °C peaking at 15 h solar time.
private func layoutAmbientFactor(_ time: Date, longitude: Double) -> Double {
    let day = utcDayOfYear(time)
    let calendar = utcCalendar
    let hour = Double(calendar.component(.hour, from: time))
    let minute = Double(calendar.component(.minute, from: time))
    let solarHour = layoutMod(hour + minute / 60 + longitude / 15, 24)
    let deltaT = ambientSeasonAmplitude * cos(2 * Double.pi * Double(day - 200) / 365)
        + ambientDiurnalAmplitude * cos(2 * Double.pi * (solarHour - 15) / 24)
    return 1 + ambientGamma * deltaT
}

/// Day of year (1-366) in UTC.
private func utcDayOfYear(_ time: Date) -> Int {
    utcCalendar.ordinality(of: .day, in: .year, for: time) ?? 1
}

private let utcCalendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
    return calendar
}()

private func layoutMod(_ value: Double, _ divisor: Double) -> Double {
    let remainder = value.truncatingRemainder(dividingBy: divisor)
    return remainder < 0 ? remainder + divisor : remainder
}
