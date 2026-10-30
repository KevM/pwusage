import Foundation

/// Energy for the period ending at `end`, which began at the previous key of the same day.
struct ForecastSolarPeriod: Equatable, Sendable {
    let end: Date
    let energyWh: Double
}

struct ForecastSolarPowerPoint: Equatable, Sendable {
    let time: Date
    let watts: Double
}

/// One plane's validated Forecast.Solar estimate. Keys are local times in `timeZone`.
struct ForecastSolarPlaneEstimate: Equatable, Sendable {
    let timeZone: TimeZone
    let wattHoursPeriod: [ForecastSolarPeriod]
    let watts: [ForecastSolarPowerPoint]
    /// Daily energy keyed by local `YYYY-MM-DD`.
    let dayWattHours: [String: Double]

    /// Decodes and validates a response. Every day must open with a zero-energy sunrise
    /// marker, start and end with zero power, and add up to its daily total within 1 Wh.
    static func decode(_ data: Data) throws -> ForecastSolarPlaneEstimate {
        guard let body = try? JSONDecoder().decode(ForecastSolarBody.self, from: data),
              let timeZone = TimeZone(identifier: body.message.info.timezone),
              let periods = resolve(body.result.wattHoursPeriod, in: timeZone),
              let power = resolve(body.result.watts, in: timeZone),
              body.result.wattHoursDay.values.allSatisfy({ $0.isFinite && $0 >= 0 }) else {
            throw ForecastSolarClientError.decodingFailure
        }
        let estimate = ForecastSolarPlaneEstimate(
            timeZone: timeZone,
            wattHoursPeriod: periods.map { ForecastSolarPeriod(end: $0.date, energyWh: $0.value) },
            watts: power.map { ForecastSolarPowerPoint(time: $0.date, watts: $0.value) },
            dayWattHours: body.result.wattHoursDay
        )
        guard estimate.hasValidDays(periodDays: periods.map(\.day), powerDays: power.map(\.day)) else {
            throw ForecastSolarClientError.decodingFailure
        }
        return estimate
    }

    private func hasValidDays(periodDays: [String], powerDays: [String]) -> Bool {
        let periodsByDay = Dictionary(grouping: zip(periodDays, wattHoursPeriod), by: \.0)
        let powerByDay = Dictionary(grouping: zip(powerDays, watts), by: \.0)
        guard !periodsByDay.isEmpty else { return false }
        for (day, entries) in periodsByDay {
            let energy = entries.map(\.1.energyWh)
            guard energy.first == 0, let total = dayWattHours[day],
                  abs(energy.reduce(0, +) - total) <= 1,
                  let power = powerByDay[day]?.map(\.1.watts), power.first == 0, power.last == 0 else {
                return false
            }
        }
        return true
    }

    private struct Resolved {
        let day: String
        let date: Date
        let value: Double
    }

    /// Sorted, finite, nonnegative values whose keys name exactly one instant. Keys that fall in
    /// a spring-forward gap or a repeated fall-back hour are rejected rather than guessed.
    private static func resolve(_ values: [String: Double], in timeZone: TimeZone) -> [Resolved]? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var resolved: [Resolved] = []
        for (key, value) in values {
            guard value.isFinite, value >= 0, let components = localComponents(key),
                  let date = calendar.date(from: components),
                  wallClock(date, calendar) == components,
                  wallClock(date.addingTimeInterval(3600), calendar) != components,
                  wallClock(date.addingTimeInterval(-3600), calendar) != components else { return nil }
            resolved.append(Resolved(day: String(key.prefix(10)), date: date, value: value))
        }
        resolved.sort { $0.date < $1.date }
        guard zip(resolved, resolved.dropFirst()).allSatisfy({ $0.0.date < $0.1.date }) else { return nil }
        return resolved
    }

    private static func wallClock(_ date: Date, _ calendar: Calendar) -> DateComponents {
        calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    }

    /// Strict `YYYY-MM-DD HH:MM:SS`.
    private static func localComponents(_ key: String) -> DateComponents? {
        let parts = key.split(separator: " ")
        guard key.count == 19, parts.count == 2 else { return nil }
        let date = parts[0].split(separator: "-").compactMap { Int($0) }
        let time = parts[1].split(separator: ":").compactMap { Int($0) }
        guard date.count == 3, time.count == 3 else { return nil }
        return DateComponents(
            year: date[0], month: date[1], day: date[2], hour: time[0], minute: time[1], second: time[2])
    }
}

private struct ForecastSolarBody: Decodable {
    let result: ForecastSolarResult
    let message: ForecastSolarMessage
}

private struct ForecastSolarResult: Decodable {
    let watts: [String: Double]
    let wattHoursPeriod: [String: Double]
    let wattHoursDay: [String: Double]

    enum CodingKeys: String, CodingKey {
        case watts
        case wattHoursPeriod = "watt_hours_period"
        case wattHoursDay = "watt_hours_day"
    }
}

private struct ForecastSolarMessage: Decodable {
    struct Info: Decodable { let timezone: String }
    let info: Info
}
