import Foundation
@testable import PWUsage
import Testing

@Suite("Solar forecast service selection and publication")
struct SolarForecastServiceTests {
    private typealias Fixture = SolarProviderFixture
    private static let now = Fixture.date("2026-10-28 09:00:00")

    private struct Setup {
        let service: SolarForecastService
        let automatic: OpenMeteoHarness
        let history: SolarForecastHistory
        let clock: MutableSolarClock
    }

    private static func setup(
        automaticID: SolarForecastProviderID = .openMeteo,
        extra: [any SolarForecastProviding] = [],
        automaticStatus: Int = 200
    ) -> Setup {
        let clock = MutableSolarClock(now)
        let automatic = OpenMeteoHarness(
            clock: clock,
            body: Fixture.openMeteoBody(now: now),
            status: automaticStatus
        )
        let history = SolarForecastHistory(file: InMemorySolarFile(), clock: clock)
        let service = SolarForecastService(
            providers: [automatic.provider] + extra,
            policy: SolarForecastSelectionPolicy(automaticProviderID: automaticID),
            history: history, clock: clock
        )
        return Setup(service: service, automatic: automatic, history: history, clock: clock)
    }

    @Test("Without Solcast, a detected layout publishes the automatic provider")
    func automaticSelected() async throws {
        let setup = Self.setup()
        let request = Fixture.request(now: Self.now)
        let publication = try #require(await setup.service.publication(for: request))
        #expect(publication.descriptor.id == .openMeteo)
        #expect(try #require(publication.intervals.first).periodStart <= request.window.start)
        #expect(try #require(publication.intervals.last).periodEnd >= request.window.end)
        #expect(publication.outcome == .refreshed)
    }

    @Test("A synthetic third provider works through composition alone")
    func syntheticProvider() async throws {
        let synthetic = SyntheticForecastProvider(clock: MutableSolarClock(Self.now))
        let setup = Self.setup(automaticID: SyntheticForecastProvider.id, extra: [synthetic])
        let publication = try #require(await setup.service.publication(for: Fixture.request(now: Self.now)))
        #expect(publication.descriptor.attribution == "Forecast by Synthetic Weather.")
        #expect(publication.intervals.first?.periodEnd.timeIntervalSince(publication.intervals[0].periodStart) == 1800)
        #expect(await setup.automatic.transport.requests.isEmpty)
        #expect(await synthetic.refreshes == 1)
    }

    @Test("No layout falls back to history")
    func historyFallback() async {
        let setup = Self.setup()
        #expect(await setup.service.selectedProviderID(for: Fixture.request(now: Self.now, layout: nil)) == nil)
        #expect(await setup.service.publication(for: Fixture.request(now: Self.now, layout: nil)) == nil)
    }

    @Test("A transient failure keeps a fresh cached batch; an expired one is dropped")
    func transientFailureUsesBoundedCache() async throws {
        let setup = Self.setup()
        _ = try #require(await setup.service.publication(for: Fixture.request(now: Self.now)))
        setup.clock.advance(by: 4 * 3600)
        let later = Fixture.request(now: setup.clock.now(), manual: true)
        let failing = OpenMeteoHarness(
            clock: setup.clock, body: Data(), status: 503,
            ledgerFile: setup.automatic.ledgerFile, cacheFile: setup.automatic.cacheFile
        )
        let service = SolarForecastService(
            providers: [failing.provider], policy: SolarForecastSelectionPolicy(automaticProviderID: .openMeteo),
            history: setup.history, clock: setup.clock
        )
        let kept = try #require(await service.publication(for: later))
        #expect(kept.outcome == .failed(.transient))
        #expect(kept.fetchedAt == Self.now)
        setup.clock.advance(by: 3 * 3600)
        #expect(await service.publication(for: Fixture.request(now: setup.clock.now(), manual: true)) == nil)
    }

    @Test("Published batches are recorded raw, once per fetch")
    func recordsHistory() async throws {
        let setup = Self.setup()
        let request = Fixture.request(now: Self.now)
        let publication = try #require(await setup.service.publication(for: request))
        _ = await setup.service.publication(for: request)
        let identity = SolarForecastHistoryIdentity(
            accountScopeID: "account-a", siteID: "site-a", providerID: .openMeteo,
            fingerprint: publication.fingerprint
        )
        let noon = Fixture.date("2026-10-28 12:00:00")
        setup.clock.advance(by: 4 * 3600)
        let past = await setup.history.pastForecast(
            identity: identity, cohort: .sameDay, from: noon, to: noon.addingTimeInterval(3600),
            siteTimeZone: Fixture.chicago
        )
        let expected = try SolarForecast.energy(
            in: publication.intervals,
            from: noon,
            to: noon.addingTimeInterval(3600)
        )
        #expect(past[noon] == expected * 1000)
    }

    @Test("Session cleanup clears service history")
    func sessionCleanup() async throws {
        let setup = Self.setup()
        _ = try #require(await setup.service.publication(for: Fixture.request(now: Self.now)))
        let cleanup = SolarSessionCleanup(service: setup.service)
        try await cleanup.signOut()
        #expect(await setup.automatic.provider.cachedForecast(for: Fixture.request(now: Self.now)) == nil)
        let refused = await setup.automatic.provider.refresh(Fixture.request(now: Self.now, manual: true))
        #expect(refused.outcome == .refreshed, "Cleanup keeps the device ledger, which still has room")
        #expect(await setup.automatic.transport.requests.count == 2)
    }

    @Test("Signing out during a refresh publishes and records nothing")
    func signOutFencesPublication() async throws {
        let clock = MutableSolarClock(Self.now)
        let gated = GatedForecastProvider(inner: SyntheticForecastProvider(clock: clock))
        let file = InMemorySolarFile<[SolarForecastHistoryEntry]>()
        let service = SolarForecastService(
            providers: [gated], policy: SolarForecastSelectionPolicy(automaticProviderID: SyntheticForecastProvider.id),
            history: SolarForecastHistory(file: file, clock: clock), clock: clock
        )
        await service.activateAccountScope("account-a")
        let pending = Task { await service.publication(for: Fixture.request(now: Self.now)) }
        await gated.waitUntilEntered()
        try await service.clearAccountData()
        await gated.open()
        #expect(await pending.value == nil)
        #expect((await file.value ?? []).isEmpty)
    }
}

/// Holds `refresh` until the test opens it, then defers to the wrapped provider.
actor GatedForecastProvider: SolarForecastProviding {
    nonisolated let descriptor: SolarForecastProviderDescriptor
    private let inner: SyntheticForecastProvider
    private var waiting: CheckedContinuation<Void, Never>?
    private var entered = false

    init(inner: SyntheticForecastProvider) {
        self.inner = inner
        descriptor = inner.descriptor
    }

    func configuration(for request: SolarForecastRequest) async -> SolarForecastConfiguration {
        await inner.configuration(for: request)
    }

    func refresh(_ request: SolarForecastRequest) async -> SolarForecastProviderResult {
        entered = true
        await withCheckedContinuation { waiting = $0 }
        return await inner.refresh(request)
    }

    func waitUntilEntered() async {
        while !entered { await Task.yield() }
    }

    func open() {
        waiting?.resume()
        waiting = nil
    }

    func cachedForecast(for request: SolarForecastRequest) async -> SolarForecastRawBatch? {
        await inner.cachedForecast(for: request)
    }

    func activateAccountScope(_ accountScopeID: String?) async {}
    func clearAccountData() async throws {}
}

extension SolarForecastServiceTests {
    @Test("Failed automatic refresh retains its outcome even with no usable publication")
    func failedAttemptDiagnostics() async {
        let setup = Self.setup(automaticStatus: 500)
        var request = Fixture.request(now: Self.now)
        request.automaticOnly = true
        let attempt = await setup.service.publicationAttempt(for: request)
        #expect(attempt.publication == nil)
        #expect(attempt.providerID == .openMeteo)
        #expect(attempt.outcome == .failed(.transient))
        #expect(attempt.diagnostic != nil)
    }
}
