import Foundation
@testable import PWUsage
import Testing

actor OpenMeteoTestTransport: OpenMeteoTransport {
    var requests: [URLRequest] = []
    let body: Data
    let status: Int
    let host: String
    init(body: Data, status: Int = 200, host: String = "api.open-meteo.com") {
        self.body = body
        self.status = status
        self.host = host
    }
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let url = try #require(URL(string: "https://\(host)/v1/forecast"))
        let response = try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil))
        return (body, response)
    }
}

// swiftlint:disable nesting
enum OpenMeteoFixture {
    static func body(start: Date, hours: Int = 72, missing: Bool = false) throws -> Data {
        let time = (0 ..< hours).map { start.addingTimeInterval(Double($0) * 3600).timeIntervalSince1970 }
        let values: [Double?] = (0 ..< hours).map { missing && $0 == 1 ? nil : 400 }
        return try JSONEncoder().encode(Body(
            utcOffsetSeconds: 0,
            units: ["time": "unixtime", "shortwave_radiation": "W/m²",
                    "direct_normal_irradiance": "W/m²", "diffuse_radiation": "W/m²"],
            hourly: Hourly(time: time, ghi: values,
                           dni: values, dhi: values)))
    }
    struct Body: Encodable {
        let utcOffsetSeconds: Int
        let units: [String: String]
        let hourly: Hourly
        enum CodingKeys: String, CodingKey {
            case utcOffsetSeconds = "utc_offset_seconds"
            case units = "hourly_units"
            case hourly
        }
    }
    struct Hourly: Encodable {
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
}

// swiftlint:enable nesting

@Suite("Open-Meteo weather transport and interval alignment")
struct OpenMeteoClientTests {
    @Test func requestsOnlyWeatherAndRespectsLowDataMode() async throws {
        let start = Date(timeIntervalSince1970: 1_790_035_200)
        let transport = OpenMeteoTestTransport(body: try OpenMeteoFixture.body(start: start))
        _ = try await OpenMeteoClient(transport: transport).forecast(location: SolarProviderFixture.location)
        let request = try #require(await transport.requests.first)
        #expect(request.url?.host == "api.open-meteo.com")
        #expect(request.allowsConstrainedNetworkAccess == false)
        #expect(request.httpShouldHandleCookies == false)
        let url = try #require(request.url)
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.queryItems?.contains(URLQueryItem(name: "timeformat", value: "unixtime")) == true)
        #expect(components.queryItems?.contains(where: { $0.name == "tilt" || $0.name == "azimuth" }) == false)
    }

    @Test func radiationBelongsToPrecedingHour() async throws {
        let end = Date(timeIntervalSince1970: 1_790_035_200)
        let transport = OpenMeteoTestTransport(body: try OpenMeteoFixture.body(start: end, hours: 2))
        let weather = try await OpenMeteoClient(transport: transport).forecast(location: SolarProviderFixture.location)
        let window = DateInterval(start: end.addingTimeInterval(-3600), end: end.addingTimeInterval(3600))
        let intervals = try weather.intervals(
            layout: SolarProviderFixture.layout(), location: SolarProviderFixture.location, window: window)
        #expect(intervals.count == 2)
        #expect(intervals.first?.periodStart == window.start)
        #expect(intervals.last?.periodEnd == window.end)
    }

    @Test func missingHoursNeverBecomeZeroProduction() async throws {
        let end = Date(timeIntervalSince1970: 1_790_035_200)
        let transport = OpenMeteoTestTransport(body: try OpenMeteoFixture.body(start: end, missing: true))
        let weather = try await OpenMeteoClient(transport: transport).forecast(location: SolarProviderFixture.location)
        #expect(throws: OpenMeteoClientError.self) {
            try weather.intervals(layout: SolarProviderFixture.layout(), location: SolarProviderFixture.location,
                                  window: DateInterval(start: end.addingTimeInterval(-3600), duration: 7200))
        }
    }

    @Test func rejectsWrongHost() async throws {
        let transport = OpenMeteoTestTransport(body: Data(), host: "example.com")
        await #expect(throws: OpenMeteoClientError.self) {
            try await OpenMeteoClient(transport: transport).forecast(location: SolarProviderFixture.location)
        }
    }
    @Test("Site-local two-day coverage preserves DST hours", arguments: ["2024-03-10", "2024-11-03"])
    func daylightSavingCoverage(_ day: String) async throws {
        let start = SolarProviderFixture.date(day + " 00:00:00")
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = SolarProviderFixture.chicago
        let end = try #require(calendar.date(byAdding: .day, value: 2, to: start))
        let count = Int(end.timeIntervalSince(start) / 3600)
        let transport = OpenMeteoTestTransport(
            body: try OpenMeteoFixture.body(start: start.addingTimeInterval(3600), hours: count))
        let weather = try await OpenMeteoClient(transport: transport).forecast(location: SolarProviderFixture.location)
        let intervals = try weather.intervals(
            layout: SolarProviderFixture.layout(), location: SolarProviderFixture.location,
            window: DateInterval(start: start, end: end))
        #expect(intervals.count == (day == "2024-03-10" ? 47 : 49))
        #expect(intervals.last?.periodEnd == end)
    }

    @Test("Rejects duplicate timestamps, mismatched arrays and wrong units")
    func malformedWeather() throws {
        let stamp = 1_790_035_200.0
        let variants = [
            OpenMeteoWeather.Hourly(time: [stamp, stamp], ghi: [0, 0], dni: [0, 0], dhi: [0, 0]),
            OpenMeteoWeather.Hourly(time: [stamp], ghi: [], dni: [0], dhi: [0]),
            OpenMeteoWeather.Hourly(time: [stamp], ghi: [-1], dni: [0], dhi: [0])]
        let units = ["time": "unixtime", "shortwave_radiation": "W/m²",
                     "direct_normal_irradiance": "W/m²", "diffuse_radiation": "W/m²"]
        let window = DateInterval(start: Date(timeIntervalSince1970: stamp - 3600), duration: 3600)
        for hourly in variants {
            let weather = OpenMeteoWeather(utcOffsetSeconds: 0, units: units, hourly: hourly)
            #expect(throws: OpenMeteoClientError.self) {
                try weather.intervals(layout: SolarProviderFixture.layout(),
                                      location: SolarProviderFixture.location, window: window)
            }
        }
        let weather = OpenMeteoWeather(utcOffsetSeconds: 0, units: [:], hourly: variants[0])
        #expect(throws: OpenMeteoClientError.self) {
            try weather.intervals(layout: SolarProviderFixture.layout(),
                                  location: SolarProviderFixture.location, window: window)
        }
    }
}
