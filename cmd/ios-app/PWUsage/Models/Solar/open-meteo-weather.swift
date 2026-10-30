import Foundation

struct OpenMeteoWeather: Decodable, Sendable {
    let utcOffsetSeconds: Int
    let units: [String: String]
    let hourly: Hourly

    // swiftlint:disable nesting
    struct Hourly: Decodable, Sendable {
        let time: [Double]
        let ghi: [Double?]
        let dni: [Double?]
        let dhi: [Double?]
        enum CodingKeys: String, CodingKey {
            case time
            case ghi = "shortwave_radiation"
            case dni = "direct_normal_irradiance"
            case dhi = "diffuse_radiation"
        }
    }

    // swiftlint:enable nesting

    enum CodingKeys: String, CodingKey {
        case utcOffsetSeconds = "utc_offset_seconds"
        case units = "hourly_units"
        case hourly
    }

    /// Radiation labelled h is mean W/m² during [h−1h,h). UTC avoids DST ambiguities.
    func intervals(
        layout: SolarLayout,
        location: SolarHomeLocation,
        window: DateInterval
    ) throws -> [SolarForecastInterval] {
        let count = hourly.time.count
        let radiationFields = ["shortwave_radiation", "direct_normal_irradiance", "diffuse_radiation"]
        guard utcOffsetSeconds == 0, units["time"] == "unixtime",
              radiationFields.allSatisfy({ units[$0] == "W/m²" }),
              count > 0, count <= 240,
              hourly.ghi.count == count, hourly.dni.count == count, hourly.dhi.count == count,
              window.duration > 0 else { throw OpenMeteoClientError.invalidResponse }
        var result: [SolarForecastInterval] = []
        for index in 0 ..< count {
            let stamp = hourly.time[index]
            guard stamp.isFinite, abs(stamp) < 100_000_000_000,
                  stamp.truncatingRemainder(dividingBy: 3600) == 0,
                  index == 0 || stamp - hourly.time[index - 1] == 3600 else {
                throw OpenMeteoClientError.invalidResponse
            }
            let end = Date(timeIntervalSince1970: stamp)
            let start = end.addingTimeInterval(-3600)
            guard end > window.start && start < window.end else { continue }
            guard let ghi = hourly.ghi[index], let dni = hourly.dni[index], let dhi = hourly.dhi[index],
                  [ghi, dni, dhi].allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 2000 }) else {
                throw OpenMeteoClientError.invalidResponse
            }
            let power = try OpenMeteoArrayModel.powerKw(
                at: start.addingTimeInterval(1800), ghi: ghi, dni: dni, dhi: dhi, layout: layout, location: location
            )
            guard power.isFinite, power >= 0 else { throw OpenMeteoClientError.invalidResponse }
            result.append(SolarForecastInterval(periodStart: start, periodEnd: end, powerKw: power))
        }
        guard let first = result.first, let last = result.last,
              first.periodStart <= window.start, last.periodEnd >= window.end else {
            throw OpenMeteoClientError.invalidResponse
        }
        return result
    }
}
