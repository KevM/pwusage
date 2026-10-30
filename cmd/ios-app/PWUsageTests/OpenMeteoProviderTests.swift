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
    private(set) var cancellations = 0
    let body: Data
    init(body: Data) { self.body = body }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        started = true
        startedWaiter?.resume()
        startedWaiter = nil
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation = $0 }
        } onCancel: { Task { await self.didCancel() } }
        let url = try #require(request.url)
        let response = try #require(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil))
        return (body, response)
    }

    private func didCancel() { cancellations += 1 }

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

extension OpenMeteoProviderTests {
    @MainActor
    private func eventuallyAsync(_ predicate: @escaping @Sendable () async -> Bool) async throws {
        var matched = false
        let observer = Task { @MainActor in
            while !Task.isCancelled {
                if await predicate() { matched = true; return }
                await Task.yield()
            }
        }
        defer { observer.cancel() }
        try await eventually { matched }
    }

    @MainActor
    @Test("Cancelling one coalesced caller promptly detaches it while the other completes")
    func cancellingOneWaiterPreservesOthers() async throws {
        let now = SolarProviderFixture.date("2026-10-28 09:00:00")
        let start = SolarProviderFixture.date("2026-10-28 00:00:00", in: .gmt)
        let transport = HeldOpenMeteoTransport(body: try OpenMeteoFixture.body(start: start))
        let clock = MutableSolarClock(now)
        let ledgerFile = InMemorySolarFile<ForecastSolarLedgerState>()
        let provider = OpenMeteoProvider(
            client: OpenMeteoClient(transport: transport),
            ledger: ForecastSolarRequestLedger(file: ledgerFile, clock: clock),
            cache: SolarForecastAutomaticCache(file: InMemorySolarFile()), clock: clock)
        let request = SolarProviderFixture.request(now: now)
        var cancelled: SolarForecastProviderResult?
        let first = Task { @MainActor in cancelled = await provider.refresh(request) }
        await transport.waitUntilStarted()
        let second = Task { await provider.refresh(request) }
        defer { first.cancel(); second.cancel() }
        try await eventuallyAsync { await provider.activeRefreshWaiterCount == 2 }
        first.cancel()
        do { try await eventually { cancelled != nil } } catch {
            await transport.release()
            await first.value
            _ = await second.value
            throw error
        }
        #expect(cancelled?.outcome == .cancelled)
        #expect(await transport.cancellations == 0)
        await transport.release()
        #expect(await second.value.outcome == .refreshed)
        #expect(await ledgerFile.value?.requests.count == 1, "A sent request remains charged exactly once")
        #expect(await provider.cachedForecast(for: request) != nil)
    }

    @MainActor
    @Test("The final waiter cancels transport and returns before an uncancellable response arrives")
    func finalWaiterReturnsPromptly() async throws {
        let now = SolarProviderFixture.date("2026-10-28 09:00:00")
        let start = SolarProviderFixture.date("2026-10-28 00:00:00", in: .gmt)
        let transport = HeldOpenMeteoTransport(body: try OpenMeteoFixture.body(start: start))
        let clock = MutableSolarClock(now)
        let provider = OpenMeteoProvider(
            client: OpenMeteoClient(transport: transport),
            ledger: ForecastSolarRequestLedger(file: InMemorySolarFile(), clock: clock),
            cache: SolarForecastAutomaticCache(file: InMemorySolarFile()), clock: clock)
        let request = SolarProviderFixture.request(now: now)
        var result: SolarForecastProviderResult?
        let caller = Task { @MainActor in result = await provider.refresh(request) }
        await transport.waitUntilStarted()
        caller.cancel()
        do {
            try await eventually { result != nil }
            try await eventuallyAsync { await transport.cancellations == 1 }
        } catch {
            await transport.release()
            await caller.value
            throw error
        }
        #expect(result?.outcome == .cancelled)
        #expect(await provider.activeRefreshWaiterCount == 0)
        await transport.release()
        #expect(await provider.cachedForecast(for: request) == nil)
    }
}

extension OpenMeteoProviderTests {
    @Test("Elapsed intervals support projection but cannot become same-day forecast training")
    func retainedElapsedHoursDoNotTrainCorrection() async throws {
        let now = SolarProviderFixture.date("2026-10-28 09:04:00")
        let start = SolarProviderFixture.date("2026-10-28 00:00:00", in: .gmt)
        let transport = OpenMeteoTestTransport(body: try OpenMeteoFixture.body(start: start))
        let clock = MutableSolarClock(now)
        let provider = OpenMeteoProvider(
            client: OpenMeteoClient(transport: transport),
            ledger: ForecastSolarRequestLedger(file: InMemorySolarFile(), clock: clock),
            cache: SolarForecastAutomaticCache(file: InMemorySolarFile()), clock: clock)
        let request = SolarProviderFixture.request(now: now)
        let result = await provider.refresh(request)
        let batch = try #require(result.batch)
        let dayStart = SolarProviderFixture.date("2026-10-28 00:00:00")
        #expect(batch.coverage.start == dayStart.addingTimeInterval(-3600))
        let history = SolarForecastHistory(file: InMemorySolarFile(), clock: clock)
        let identity = SolarForecastHistoryIdentity(
            accountScopeID: request.scope.accountScopeID, siteID: request.scope.siteID,
            providerID: .openMeteo, fingerprint: batch.fingerprint)
        await history.record(identity: identity, intervals: batch.intervals, fetchedAt: now)
        let past = await history.pastForecast(
            identity: identity, cohort: .sameDay, from: dayStart,
            to: dayStart.addingTimeInterval(12 * 3600), siteTimeZone: request.siteTimeZone)
        #expect(past[dayStart.addingTimeInterval(9 * 3600)] == nil)
        #expect(past[dayStart.addingTimeInterval(10 * 3600)] != nil)
    }
}
