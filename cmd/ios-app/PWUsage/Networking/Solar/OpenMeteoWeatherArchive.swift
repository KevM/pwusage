import Foundation

struct SolarHealthWeather: Codable, Equatable, Sendable {
    var rainDays: Set<String> = []
    var snowDays: Set<String> = []

    var hasPrecipitation: Bool { !rainDays.isEmpty || !snowDays.isEmpty }

    mutating func formUnion(_ other: Self) {
        rainDays.formUnion(other.rainDays)
        snowDays.formUnion(other.snowDays)
    }
}

private struct OpenMeteoArchiveDaily: Decodable {
    let time: [String]
    let rain: [Double?]
    let snow: [Double?]

    enum CodingKeys: String, CodingKey {
        case time
        case rain = "rain_sum"
        case snow = "snowfall_sum"
    }
}

struct OpenMeteoWeatherArchive: Decodable {
    private let daily: OpenMeteoArchiveDaily
    let units: [String: String]

    enum CodingKeys: String, CodingKey {
        case daily
        case units = "daily_units"
    }

    func weather(in days: ClosedRange<String>, timeZone: TimeZone) throws -> SolarHealthWeather {
        guard units["rain_sum"] == "mm", units["snowfall_sum"] == "cm",
              daily.time.count == daily.rain.count, daily.time.count == daily.snow.count,
              let elapsed = SiteLocalDays.days(from: days.lowerBound, to: days.upperBound, timeZone: timeZone),
              daily.time.count == elapsed + 1 else {
            throw OpenMeteoClientError.invalidResponse
        }

        var result = SolarHealthWeather()
        var day = days.lowerBound
        for index in daily.time.indices {
            guard daily.time[index] == day else { throw OpenMeteoClientError.invalidResponse }
            if let rain = daily.rain[index], rain > 0 { result.rainDays.insert(day) }
            if let snow = daily.snow[index], snow > 0 { result.snowDays.insert(day) }
            day = SiteLocalDays.adding(1, to: day, timeZone: timeZone) ?? day
        }
        return result
    }
}
