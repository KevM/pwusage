import Foundation
@testable import PWUsage
import Testing

@Suite("Open-Meteo automatic provider")
struct OpenMeteoProviderTests {
    @Test func oneWeatherRequestForAllPlanesAndFreshCache() async throws {
        let now = SolarProviderFixture.date("2026-10-28 09:00:00")
        let start = SolarProviderFixture.date("2026-10-28 00:00:00", in: .gmt)
        let transport = OpenMeteoTestTransport(body: try OpenMeteoFixture.body(start: start))
        let clock = MutableSolarClock(now)
        let provider = OpenMeteoProvider(
            client: OpenMeteoClient(transport: transport),
            ledger: ForecastSolarRequestLedger(file: InMemorySolarFile(), clock: clock),
            cache: SolarForecastAutomaticCache(file: InMemorySolarFile()), clock: clock)
        let layout = SolarProviderFixture.layout(planes: [
            SolarLayoutPlane(azimuth: 90, tilt: 20, dcKwp: 4),
            SolarLayoutPlane(azimuth: 270, tilt: 20, dcKwp: 4)])
        let request = SolarProviderFixture.request(now: now, layout: layout)
        let first = await provider.refresh(request)
        #expect(first.outcome == .refreshed)
        #expect(first.batch?.providerID == .openMeteo)
        #expect(await provider.refresh(request).outcome == .fresh)
        #expect(await transport.requests.count == 1)
    }

    @Test func rateLimitDefersNextAttempt() async throws {
        let now = SolarProviderFixture.date("2026-10-28 09:00:00")
        let clock = MutableSolarClock(now)
        let transport = OpenMeteoTestTransport(body: Data(), status: 429)
        let provider = OpenMeteoProvider(
            client: OpenMeteoClient(transport: transport, clock: clock),
            ledger: ForecastSolarRequestLedger(file: InMemorySolarFile(), clock: clock),
            cache: SolarForecastAutomaticCache(file: InMemorySolarFile()), clock: clock)
        let request = SolarProviderFixture.request(now: now)
        let expected = SolarForecastRefreshOutcome.deferred(until: now.addingTimeInterval(3600))
        #expect(await provider.refresh(request).outcome == expected)
        #expect(await provider.refresh(request).outcome == expected)
        #expect(await transport.requests.count == 1)
    }

    @Test func fingerprintIncludesUnroundedPlaneGeometry() async {
        let provider = OpenMeteoProvider()
        let now = SolarProviderFixture.date("2026-10-28 09:00:00")
        let first = SolarProviderFixture.request(now: now, layout: SolarProviderFixture.layout(planes: [
            SolarLayoutPlane(azimuth: 90.1, tilt: 20.1, dcKwp: 4)]))
        let second = SolarProviderFixture.request(now: now, layout: SolarProviderFixture.layout(planes: [
            SolarLayoutPlane(azimuth: 90.2, tilt: 20.2, dcKwp: 4)]))
        #expect(await provider.configuration(for: first).fingerprint != provider.configuration(for: second).fingerprint)
    }
}

actor HeldOpenMeteoTransport: OpenMeteoTransport {
    private var continuation: CheckedContinuation<Void, Never>?
    private var startedWaiter: CheckedContinuation<Void, Never>?
    private var started = false
    let body: Data
    init(body: Data) { self.body = body }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        started = true
        startedWaiter?.resume()
        startedWaiter = nil
        await withCheckedContinuation { continuation = $0 }
        let url = try #require(request.url)
        let response = try #require(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil))
        return (body, response)
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startedWaiter = $0 }
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

extension OpenMeteoProviderTests {
    @Test("A late weather completion after account change cannot repopulate cache")
    func accountChangeFencesWeather() async throws {
        let now = SolarProviderFixture.date("2026-10-28 09:00:00")
        let start = SolarProviderFixture.date("2026-10-28 00:00:00", in: .gmt)
        let transport = HeldOpenMeteoTransport(body: try OpenMeteoFixture.body(start: start))
        let clock = MutableSolarClock(now)
        let provider = OpenMeteoProvider(
            client: OpenMeteoClient(transport: transport),
            ledger: ForecastSolarRequestLedger(file: InMemorySolarFile(), clock: clock),
            cache: SolarForecastAutomaticCache(file: InMemorySolarFile()), clock: clock)
        await provider.activateAccountScope("account-a")
        let request = SolarProviderFixture.request(now: now)
        let fetch = Task { await provider.refresh(request) }
        await transport.waitUntilStarted()
        await provider.activateAccountScope("account-b")
        await transport.release()
        #expect(await fetch.value.outcome == .cancelled)
        #expect(await provider.cachedForecast(for: request) == nil)
    }

    @Test("Expiration cancellation cannot save an uncancellable late transport response")
    func cancelledResponseIsDiscarded() async throws {
        let now = SolarProviderFixture.date("2026-10-28 09:00:00")
        let start = SolarProviderFixture.date("2026-10-28 00:00:00", in: .gmt)
        let transport = HeldOpenMeteoTransport(body: try OpenMeteoFixture.body(start: start))
        let clock = MutableSolarClock(now)
        let provider = OpenMeteoProvider(
            client: OpenMeteoClient(transport: transport),
            ledger: ForecastSolarRequestLedger(file: InMemorySolarFile(), clock: clock),
            cache: SolarForecastAutomaticCache(file: InMemorySolarFile()), clock: clock)
        let request = SolarProviderFixture.request(now: now)
        let fetch = Task { await provider.refresh(request) }
        await transport.waitUntilStarted()
        fetch.cancel()
        await transport.release()
        #expect(await fetch.value.outcome == .cancelled)
        #expect(await provider.cachedForecast(for: request) == nil)
    }
}
