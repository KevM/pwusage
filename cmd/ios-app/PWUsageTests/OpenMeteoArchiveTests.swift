import Foundation
@testable import PWUsage
import Testing

@Suite("Open-Meteo historical weather")
struct OpenMeteoArchiveTests {
    @Test func requestsRoundedCoordinatesAndPreservesLocalWeatherDays() async throws {
        let transport = OpenMeteoTestTransport(body: Self.archive, host: "archive-api.open-meteo.com")
        let location = SolarHomeLocation(latitude: 41.8765, longitude: -87.6234, source: .device)
        let weather = try await OpenMeteoClient(transport: transport).weatherHistory(
            location: location, timeZone: SolarProviderFixture.chicago, days: "2024-03-09" ... "2024-03-11")
        let request = try #require(await transport.requests.first)
        let url = try #require(request.url)
        #expect(url.host == "archive-api.open-meteo.com")
        #expect(url.path == "/v1/archive")
        #expect(request.httpShouldHandleCookies == false)
        #expect(request.allowsConstrainedNetworkAccess == false)
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        #expect(query?.contains(URLQueryItem(name: "latitude", value: "41.88")) == true)
        #expect(query?.contains(URLQueryItem(name: "longitude", value: "-87.62")) == true)
        #expect(query?.contains(URLQueryItem(name: "timezone", value: "America/Chicago")) == true)
        #expect(weather.rainDays == ["2024-03-10"])
        #expect(weather.snowDays == ["2024-03-11"])
    }

    @Test func successfulHistoryIsReusedAcrossStoreInstances() async throws {
        let transport = OpenMeteoTestTransport(body: Self.archive, host: "archive-api.open-meteo.com")
        let client = OpenMeteoClient(transport: transport)
        let cache = SolarHealthCache(directory: SolarHealthPassTests.folder())
        let place = SolarHealthWeatherStore.Place(
            location: SolarProviderFixture.location, timeZone: SolarProviderFixture.chicago)
        let first = SolarProviderFixture.date("2024-03-09 12:00:00")
        let last = SolarProviderFixture.date("2024-03-11 12:00:00")
        let now = SolarProviderFixture.date("2024-04-01 12:00:00")
        for _ in 0 ..< 2 {
            let store = SolarHealthWeatherStore(client: client)
            let weather = try await store.weather(
                scope: SolarHealthPassTests.scope, cache: cache, place: place, samples: first ... last, now: now)
            #expect(weather.snowDays == ["2024-03-11"])
        }
        #expect(await transport.requests.count == 1)
    }

    @Test func rateLimitingFallsBackAndDefersAnotherRequest() async throws {
        let transport = OpenMeteoTestTransport(body: Data(), status: 429, host: "archive-api.open-meteo.com")
        let store = SolarHealthWeatherStore(client: OpenMeteoClient(transport: transport))
        let cache = SolarHealthCache(directory: SolarHealthPassTests.folder())
        let place = SolarHealthWeatherStore.Place(
            location: SolarProviderFixture.location, timeZone: SolarProviderFixture.chicago)
        let day = SolarProviderFixture.date("2024-03-10 12:00:00")
        let now = Date.now
        for _ in 0 ..< 2 {
            let weather = try await store.weather(
                scope: SolarHealthPassTests.scope, cache: cache, place: place, samples: day ... day, now: now)
            #expect(weather == SolarHealthWeather())
        }
        #expect(await transport.requests.count == 1)
    }

    private static let archive = Data("""
    {
      "daily_units": {"rain_sum": "mm", "snowfall_sum": "cm"},
      "daily": {
        "time": ["2024-03-09", "2024-03-10", "2024-03-11"],
        "rain_sum": [null, 1.2, 0], "snowfall_sum": [0, null, 0.5]
      }
    }
    """.utf8)
}
