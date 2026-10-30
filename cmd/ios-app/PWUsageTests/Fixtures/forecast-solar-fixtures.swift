import Foundation
@testable import PWUsage

/// Wholly synthetic Forecast.Solar responses: no captured data, coordinates or household details.
enum ForecastSolarFixture {
    struct Day {
        let date: String
        /// Local `HH:MM:SS` keys with the Wh for the period ending there. The first is the
        /// zero-energy sunrise marker; the last is sunset, which may carry energy.
        let periods: [(String, Double)]

        var totalWh: Double { periods.reduce(0) { $0 + $1.1 } }

        static func normal(_ date: String, scale: Double = 1) -> Day {
            let shape: [(String, Double)] = [
                ("07:12:00", 0), ("08:00:00", 120), ("09:00:00", 400), ("10:00:00", 700), ("11:00:00", 900),
                ("12:00:00", 1000), ("13:00:00", 950), ("14:00:00", 800), ("15:00:00", 600), ("16:00:00", 300),
                ("17:00:00", 100), ("17:40:00", 20)]
            return Day(date: date, periods: shape.map { ($0.0, $0.1 * scale) })
        }
    }

    static func json(
        timezone: String = "America/Chicago",
        days: [Day],
        dayTotals: [String: Double]? = nil,
        sunriseWatts: Double = 0
    ) -> String {
        var watts: [String] = []
        var periods: [String] = []
        var totals: [String] = []
        for day in days {
            for (index, period) in day.periods.enumerated() {
                let key = "\(day.date) \(period.0)"
                let isEndpoint = index == 0 || index == day.periods.count - 1
                let power = index == 0 ? sunriseWatts : (isEndpoint ? 0 : period.1)
                watts.append(#""\#(key)":\#(power)"#)
                periods.append(#""\#(key)":\#(period.1)"#)
            }
            totals.append(#""\#(day.date)":\#(dayTotals?[day.date] ?? day.totalWh)"#)
        }
        return """
        {"result":{"watts":{\(watts.joined(separator: ","))},
        "watt_hours_period":{\(periods.joined(separator: ","))},
        "watt_hours_day":{\(totals.joined(separator: ","))}},
        "message":{"code":0,"type":"success","text":"",
        "info":{"timezone":"\(timezone)"},"ratelimit":{"period":3600,"limit":12,"remaining":11}}}
        """
    }

    static func estimate(timezone: String = "America/Chicago", days: [Day]) throws -> ForecastSolarPlaneEstimate {
        try ForecastSolarPlaneEstimate.decode(Data(json(timezone: timezone, days: days).utf8))
    }
}

final class RecordingForecastSolarTransport: ForecastSolarTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [URLRequest] = []
    private let handler: @Sendable (URLRequest) throws -> (Data, URLResponse)

    init(handler: @escaping @Sendable (URLRequest) throws -> (Data, URLResponse)) {
        self.handler = handler
    }

    var requests: [URLRequest] { lock.withLock { recorded } }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        lock.withLock { recorded.append(request) }
        return try handler(request)
    }

    static func responding(
        status: Int,
        body: String,
        headers: [String: String] = [:],
        host: String? = nil
    ) -> RecordingForecastSolarTransport {
        RecordingForecastSolarTransport { request in
            var url = request.url ?? URL(fileURLWithPath: "/")
            if let host, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
                components.host = host
                url = components.url ?? url
            }
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers)
            return (Data(body.utf8), response ?? URLResponse())
        }
    }
}

struct FixedSolarForecastClock: SolarForecastClock {
    let date: Date
    func now() -> Date { date }
}
