import Foundation
@testable import PWUsage
import Testing

/// A Forecast.Solar adapter over in-memory files and a recording transport.
struct ForecastSolarHarness {
    let clock: MutableSolarClock
    let transport: RecordingForecastSolarTransport
    let ledgerFile: InMemorySolarFile<ForecastSolarLedgerState>
    let cacheFile: InMemorySolarFile<SolarForecastAutomaticCacheState>
    let provider: ForecastSolarProvider

    init(
        clock: MutableSolarClock,
        body: String,
        status: Int = 200,
        ledgerFile: InMemorySolarFile<ForecastSolarLedgerState> = InMemorySolarFile(),
        cacheFile: InMemorySolarFile<SolarForecastAutomaticCacheState> = InMemorySolarFile()
    ) {
        self.init(
            clock: clock,
            transport: .responding(status: status, body: body),
            ledgerFile: ledgerFile, cacheFile: cacheFile
        )
    }

    init(
        clock: MutableSolarClock,
        transport: RecordingForecastSolarTransport,
        ledgerFile: InMemorySolarFile<ForecastSolarLedgerState> = InMemorySolarFile(),
        cacheFile: InMemorySolarFile<SolarForecastAutomaticCacheState> = InMemorySolarFile()
    ) {
        self.clock = clock
        self.transport = transport
        self.ledgerFile = ledgerFile
        self.cacheFile = cacheFile
        provider = ForecastSolarProvider(
            client: ForecastSolarClient(transport: transport, clock: clock),
            ledger: ForecastSolarRequestLedger(file: ledgerFile, clock: clock),
            cache: SolarForecastAutomaticCache(file: cacheFile),
            clock: clock
        )
    }

    /// The same files after a relaunch: a fresh ledger, cache and adapter.
    func relaunched() -> ForecastSolarHarness {
        ForecastSolarHarness(clock: clock, transport: transport, ledgerFile: ledgerFile, cacheFile: cacheFile)
    }
}

@Suite("Forecast.Solar adapter quota and caching")
struct ForecastSolarProviderTests {
    private typealias Fixture = SolarProviderFixture
    private static let now = Fixture.date("2026-10-28 09:00:00")
    private static let twoPlanes = Fixture.layout(planes: [
        SolarLayoutPlane(azimuth: 90, tilt: 18, dcKwp: 5.6),
        SolarLayoutPlane(azimuth: 270, tilt: 18, dcKwp: 4)])

    private static func harness(status: Int = 200) -> ForecastSolarHarness {
        ForecastSolarHarness(clock: MutableSolarClock(now), body: Fixture.forecastSolarBody(now: now), status: status)
    }

    @Test("One request per plane, then fresh for three hours without another request")
    func requestPerPlaneThenFresh() async throws {
        let harness = Self.harness()
        let request = Fixture.request(now: Self.now, layout: Self.twoPlanes)
        let first = await harness.provider.refresh(request)
        #expect(first.outcome == .refreshed)
        #expect(harness.transport.requests.count == 2)
        let summed = try #require(first.batch?.intervals.first { $0.powerKw > 0 })
        #expect(summed.powerKw > 0)
        harness.clock.advance(by: 2 * 3600)
        let second = await harness.provider.refresh(Fixture.request(now: harness.clock.now(), layout: Self.twoPlanes))
        #expect(second.outcome == .fresh)
        #expect(second.batch == first.batch)
        #expect(harness.transport.requests.count == 2)
    }

    @Test("The seventh request in a rolling hour is never sent, across sites, relaunch and sign-out")
    func rollingHourBudget() async {
        let harness = Self.harness()
        for _ in 0 ..< 3 {
            _ = await harness.provider.refresh(Fixture.request(now: Self.now, manual: true))
        }
        _ = await harness.provider.refresh(Fixture.request(scope: Fixture.scopeB, now: Self.now, manual: true))
        let relaunched = harness.relaunched()
        try? await relaunched.provider.clearAccountData()
        _ = await relaunched.provider.refresh(Fixture.request(now: Self.now, manual: true))
        _ = await relaunched.provider.refresh(Fixture.request(scope: Fixture.scopeB, now: Self.now, manual: true))
        #expect(harness.transport.requests.count == 6)
        let refused = await relaunched.provider.refresh(Fixture.request(now: Self.now, manual: true))
        #expect(refused.outcome == .budgetExhausted)
        #expect(harness.transport.requests.count == 6)
        harness.clock.advance(by: 3601)
        _ = await relaunched.provider.refresh(Fixture.request(now: harness.clock.now(), manual: true))
        #expect(harness.transport.requests.count == 7)
    }

    @Test("Concurrent sites reserve whole plane counts against one ledger")
    func concurrentSites() async {
        let harness = Self.harness()
        let provider = harness.provider
        await withTaskGroup(of: Void.self) { group in
            for index in 0 ..< 5 {
                let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-\(index)")
                group.addTask {
                    _ = await provider.refresh(Fixture.request(scope: scope, now: Self.now, layout: Self.twoPlanes))
                }
            }
        }
        #expect(harness.transport.requests.count == 6)
    }

    @Test("A 429 defers every later request until the reset")
    func rateLimitDefers() async {
        let transport = RecordingForecastSolarTransport.responding(
            status: 429, body: #"{"message":{"ratelimit":{"period":3600,"remaining":0}}}"#
        )
        let harness = ForecastSolarHarness(clock: MutableSolarClock(Self.now), transport: transport)
        let first = await harness.provider.refresh(Fixture.request(now: Self.now))
        #expect(first.outcome == .deferred(until: Self.now.addingTimeInterval(3600)))
        #expect(first.batch == nil)
        let second = await harness.relaunched().provider.refresh(Fixture.request(now: Self.now, manual: true))
        #expect(second.outcome == .deferred(until: Self.now.addingTimeInterval(3600)))
        #expect(transport.requests.count == 1)
    }

    @Test("A reservation that cannot be saved sends nothing")
    func unsavedReservationSendsNothing() async {
        let harness = Self.harness()
        await harness.ledgerFile.setFailingSaves(true)
        let result = await harness.provider.refresh(Fixture.request(now: Self.now))
        #expect(result.outcome == .failed(.transient))
        #expect(harness.transport.requests.isEmpty)
    }

    @Test("A failed plane publishes no partial batch")
    func partialPlaneFailure() async {
        let body = Fixture.forecastSolarBody(now: Self.now)
        let transport = RecordingForecastSolarTransport { request in
            let status = request.url?.path.contains("/90/") == true ? 500 : 200
            let response = HTTPURLResponse(
                url: request.url ?? URL(fileURLWithPath: "/"),
                statusCode: status,
                httpVersion: nil,
                headerFields: nil
            )
            return (Data(body.utf8), response ?? URLResponse())
        }
        let harness = ForecastSolarHarness(clock: MutableSolarClock(Self.now), transport: transport)
        let request = Fixture.request(now: Self.now, layout: Self.twoPlanes)
        let result = await harness.provider.refresh(request)
        #expect(result.batch == nil)
        #expect(result.outcome == .failed(.transient))
        #expect(await harness.provider.cachedForecast(for: request) == nil)
    }

    @Test("Cached batches survive relaunch, and unknown providers in the file are ignored")
    func cachePersistence() async throws {
        let harness = Self.harness()
        let request = Fixture.request(now: Self.now)
        let batch = try #require(await harness.provider.refresh(request).batch)
        var state = try #require(await harness.cacheFile.value)
        let foreign = SolarForecastRawBatch(
            providerID: SolarForecastProviderID(rawValue: "future-provider"), fingerprint: "f", cacheRevision: "f",
            intervals: batch.intervals, fetchedAt: Self.now, acClipKw: nil
        )
        state.entries.append(SolarForecastAutomaticCacheState.Entry(scope: Fixture.scopeA, batch: foreign))
        try await harness.cacheFile.save(state)
        #expect(await harness.relaunched().provider.cachedForecast(for: request) == batch)
    }

    @Test("A fresh batch that no longer covers the window after midnight is refetched")
    func freshButUncoveredAfterMidnight() async {
        let clock = MutableSolarClock(Fixture.date("2026-10-28 23:30:00"))
        let transport = RecordingForecastSolarTransport { request in
            let response = HTTPURLResponse(url: request.url ?? URL(fileURLWithPath: "/"), statusCode: 200,
                                           httpVersion: nil, headerFields: nil)
            return (Data(Fixture.forecastSolarBody(now: clock.now()).utf8), response ?? URLResponse())
        }
        let harness = ForecastSolarHarness(clock: clock, transport: transport)
        #expect(await harness.provider.refresh(Fixture.request(now: clock.now())).outcome == .refreshed)
        clock.advance(by: 3600)
        let afterMidnight = Fixture.request(now: clock.now())
        let result = await harness.provider.refresh(afterMidnight)
        #expect(result.outcome == .refreshed)
        #expect(transport.requests.count == 2)
        #expect(result.batch.map { $0.coverage.end >= afterMidnight.window.end } == true)
    }

    @Test("A completion after the account changes is neither cached nor returned")
    func accountChangeFencesCompletion() async {
        let harness = Self.harness()
        let gate = AsyncGate()
        let body = Fixture.forecastSolarBody(now: Self.now)
        let gated = ForecastSolarHarness(
            clock: harness.clock,
            transport: RecordingForecastSolarTransport { request in
                gate.waitSynchronously()
                let response = HTTPURLResponse(
                    url: request.url ?? URL(fileURLWithPath: "/"),
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: nil
                )
                return (Data(body.utf8), response ?? URLResponse())
            }
        )
        await gated.provider.activateAccountScope("account-a")
        let request = Fixture.request(now: Self.now)
        let pending = Task { await gated.provider.refresh(request) }
        await gate.waitUntilEntered()
        await gated.provider.activateAccountScope("account-b")
        gate.open()
        let result = await pending.value
        #expect(result.batch == nil)
        #expect(result.outcome == .cancelled)
        #expect(await gated.provider.cachedForecast(for: request) == nil)
    }
}

/// Holds a synchronous transport handler until the test opens it.
final class AsyncGate: @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var entered = false

    func waitSynchronously() {
        lock.withLock { entered = true }
        semaphore.wait()
    }

    func waitUntilEntered() async {
        while !lock.withLock({ entered }) {
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    func open() { semaphore.signal() }
}
