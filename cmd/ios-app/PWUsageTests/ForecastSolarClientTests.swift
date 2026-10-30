import Foundation
@testable import PWUsage
import Testing

@Suite("Forecast.Solar client and conversion")
struct ForecastSolarClientTests {
    private static let chicago = TimeZone(identifier: "America/Chicago") ?? .gmt
    private static let location = SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .device)
    private static let plane = SolarLayoutPlane(azimuth: 90, tilt: 18.4, dcKwp: 5.6)

    private static func date(_ text: String, in zone: TimeZone = chicago) throws -> Date {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return try #require(formatter.date(from: text))
    }

    // MARK: Request

    @Test("The estimate URL rounds coordinates, tilt, azimuth and size")
    func estimateURL() async throws {
        let body = ForecastSolarFixture.json(days: [.normal("2026-10-28"), .normal("2026-10-29")])
        let transport = RecordingForecastSolarTransport.responding(status: 200, body: body)
        let client = ForecastSolarClient(transport: transport)
        _ = try await client.estimate(location: Self.location, plane: Self.plane)
        let request = try #require(transport.requests.first)
        #expect(request.url?.absoluteString == "https://api.forecast.solar/estimate/43.39/-87.87/18/-90/5.60")
        #expect(request.httpMethod == "GET")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
        #expect(request.httpShouldHandleCookies == false)
    }

    @Test("Compass azimuths convert to Forecast.Solar's south-zero convention")
    func azimuthConversion() {
        #expect(ForecastSolarForecast.forecastSolarAzimuth(compass: 90) == -90)
        #expect(ForecastSolarForecast.forecastSolarAzimuth(compass: 270) == 90)
        #expect(ForecastSolarForecast.forecastSolarAzimuth(compass: 180) == 0)
        #expect([180, -180].contains(ForecastSolarForecast.forecastSolarAzimuth(compass: 0)))
        #expect(ForecastSolarForecast.forecastSolarAzimuth(compass: 350) == 170)
    }

    @Test("Responses from a redirect or another host are rejected")
    func foreignHostRejected() async {
        let body = ForecastSolarFixture.json(days: [.normal("2026-10-28"), .normal("2026-10-29")])
        let transport = RecordingForecastSolarTransport.responding(status: 200, body: body, host: "evil.example")
        await #expect(throws: ForecastSolarClientError.invalidResponse) {
            try await ForecastSolarClient(transport: transport).estimate(location: Self.location, plane: Self.plane)
        }
    }

    // MARK: Rate limits

    private static func rateLimited(
        headers: [String: String], ratelimit: String
    ) async throws -> ForecastSolarClientError {
        let body = #"{"result":null,"message":{"code":429,"type":"error","ratelimit":\#(ratelimit)}}"#
        let now = try date("2026-10-28 10:00:00")
        let client = ForecastSolarClient(
            transport: RecordingForecastSolarTransport.responding(status: 429, body: body, headers: headers),
            clock: FixedSolarForecastClock(date: now))
        do {
            _ = try await client.estimate(location: location, plane: plane)
        } catch let error as ForecastSolarClientError {
            return error
        }
        Issue.record("Expected a rate limit")
        return .invalidResponse
    }

    @Test("A 429 honours Retry-After seconds")
    func retryAfterSeconds() async throws {
        let error = try await Self.rateLimited(headers: ["Retry-After": "120"], ratelimit: "{}")
        #expect(error == .rateLimited(retryAfter: try Self.date("2026-10-28 10:02:00")))
    }

    @Test("A 429 uses the later of the HTTP-date header and the body reset")
    func laterResetWins() async throws {
        let header = ["Retry-After": "Wed, 28 Oct 2026 15:30:00 GMT"]
        let headerLater = try await Self.rateLimited(
            headers: header, ratelimit: #"{"period":3600,"limit":12,"retry-at":"2026-10-28T10:10:00-05:00"}"#)
        #expect(headerLater == .rateLimited(retryAfter: try Self.date("2026-10-28 10:30:00")))
        let bodyLater = try await Self.rateLimited(
            headers: header, ratelimit: #"{"period":3600,"limit":12,"retry-at":"2026-10-28T10:45:00-05:00"}"#)
        #expect(bodyLater == .rateLimited(retryAfter: try Self.date("2026-10-28 10:45:00")))
    }

    @Test("A spent rate limit with only a period defers for that period; nothing usable defers an hour")
    func periodAndDefaultDeferral() async throws {
        let spent = try await Self.rateLimited(headers: [:], ratelimit: #"{"period":1800,"limit":12,"remaining":0}"#)
        #expect(spent == .rateLimited(retryAfter: try Self.date("2026-10-28 10:30:00")))
        let unknown = try await Self.rateLimited(headers: [:], ratelimit: #"{"period":1800,"limit":12,"remaining":3}"#)
        #expect(unknown == .rateLimited(retryAfter: try Self.date("2026-10-28 11:00:00")))
    }

    // MARK: Decoding

    @Test("A synthetic two-day response decodes ordered periods and the provider timezone")
    func decodesEstimate() throws {
        let estimate = try ForecastSolarFixture.estimate(days: [.normal("2026-10-28"), .normal("2026-10-29")])
        #expect(estimate.timeZone.identifier == "America/Chicago")
        let expected = ForecastSolarFixture.Day.normal("2026-10-28").periods.map(\.1)
        #expect(Array(estimate.wattHoursPeriod.prefix(expected.count).map(\.energyWh)) == expected)
        #expect(estimate.wattHoursPeriod.first?.end == (try Self.date("2026-10-28 07:12:00")))
        #expect(estimate.wattHoursPeriod.map(\.end) == estimate.wattHoursPeriod.map(\.end).sorted())
        #expect(estimate.dayWattHours["2026-10-29"] == 5890)
    }

    private static let invalidResponses: [String] = [
        ForecastSolarFixture.json(days: [Day(date: "2026-10-28", periods: [("07:00:00", 0), ("08:00:00", -5)])]),
        ForecastSolarFixture.json(timezone: "Mars/Olympus", days: [.normal("2026-10-28")]),
        ForecastSolarFixture.json(days: [.normal("2026-10-28")], sunriseWatts: 40),
        ForecastSolarFixture.json(days: [Day(date: "2026-10-28", periods: [("07:00:00", 50), ("08:00:00", 100)])]),
        ForecastSolarFixture.json(days: [.normal("2026-10-28")], dayTotals: ["2026-10-28": 6000]),
        ForecastSolarFixture.json(days: [Day(date: "2026-11-01", periods: [("01:30:00", 0), ("08:00:00", 100)])]),
        ForecastSolarFixture.json(days: [Day(date: "2026-03-08", periods: [("02:30:00", 0), ("08:00:00", 100)])])
    ]

    private typealias Day = ForecastSolarFixture.Day

    @Test("Negative energy, unknown timezones, missing markers, bad totals and unresolvable times are rejected",
          arguments: invalidResponses)
    func rejectsInvalid(json: String) {
        #expect(throws: ForecastSolarClientError.decodingFailure) {
            try ForecastSolarPlaneEstimate.decode(Data(json.utf8))
        }
    }
}
